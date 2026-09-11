#!/usr/bin/env python3
"""Solve 3D joint rotations that put a rigged character into the pose a 2D sprite frame is in.

This is the bridge between the two halves of the game. The sprites are generated art and the 3D
model is reconstructed from the same art, but nothing so far makes the model *do* what the sprite
does. Given 2D keypoints picked off each sprite frame and the character's rest skeleton, this fits
joint rotations by gradient descent through a differentiable forward-kinematics chain, so the rig
ends up in the pose the sprite is drawn in. Twenty-four sprites in, twenty-four keyframes out, and
a 2D->3D transition mid-fight can land in the same pose on both sides.

    # 1. blank keypoint file listing every frame and every joint, ready to fill in
    python3 lift_poses.py --template apps/fighter/public/chars/kestrel/frames.json \
                          --out ext/kestrel-keypoints.json

    # 2. fill it in: a 2D pose detector over the sprite PNGs, or by hand
    # 3. solve
    python3 lift_poses.py --keypoints ext/kestrel-keypoints.json \
                          --skeleton ext/kestrel-skeleton.json \
                          --out apps/fighter/public/chars/kestrel/poses.json --report

CPU only, and it wants nothing but torch. The whole roster is minutes. Do not book a GPU for it.

WHAT IT CANNOT DO. A side-on sprite does not contain depth: whether the far arm passes in front of
the body or behind it is not in the picture. The pose prior resolves that plausibly, not correctly.
Read the residuals --report prints and expect to hand-fix frames where a limb crosses the torso.
That is the problem being under-determined, not the solver being wrong.

NOT RUN. Written in a container with no GPU and no package manager, so this file has never been
executed. Read it before you trust it.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

try:
    import torch
except ImportError:
    sys.exit("lift_poses: needs torch (CPU build is enough):  pip install -r requirements.txt")


# --------------------------------------------------------------------------------------------
# The skeleton
#
# A generic humanoid, used when no --skeleton is given. Offsets are the bone vector in the PARENT's
# local frame, in metres, with +y up, +x the character's own left, +z the direction they face at
# rest. Parents always come before children, which is what lets forward kinematics be a single
# forward pass over the list.
#
# Replace it. These are averages, and a fit against the wrong limb lengths quietly bends the
# rotations to compensate. Export the real rest pose out of whatever rigged the model in step 2 of
# the README; the names below are the ones the rest of the tooling expects.
# --------------------------------------------------------------------------------------------

DEFAULT_SKELETON = [
    ("pelvis", None, (0.00, 0.00, 0.00)),
    ("spine", "pelvis", (0.00, 0.11, 0.00)),
    ("chest", "spine", (0.00, 0.17, 0.00)),
    ("neck", "chest", (0.00, 0.16, 0.00)),
    ("head", "neck", (0.00, 0.14, 0.02)),
    ("l_shoulder", "chest", (0.17, 0.13, 0.00)),
    ("l_elbow", "l_shoulder", (0.00, -0.28, 0.00)),
    ("l_wrist", "l_elbow", (0.00, -0.25, 0.00)),
    ("r_shoulder", "chest", (-0.17, 0.13, 0.00)),
    ("r_elbow", "r_shoulder", (0.00, -0.28, 0.00)),
    ("r_wrist", "r_elbow", (0.00, -0.25, 0.00)),
    ("l_hip", "pelvis", (0.09, 0.00, 0.00)),
    ("l_knee", "l_hip", (0.00, -0.42, 0.00)),
    ("l_ankle", "l_knee", (0.00, -0.41, 0.00)),
    ("r_hip", "pelvis", (-0.09, 0.00, 0.00)),
    ("r_knee", "r_hip", (0.00, -0.42, 0.00)),
    ("r_ankle", "r_knee", (0.00, -0.41, 0.00)),
]

# Joints that are hinges: a real elbow and a real knee have one degree of freedom, not three. We do
# not know which way round yours bends without knowing your rig's axis convention, so this only
# penalises the two components a hinge certainly does not have (twist and splay) and leaves the sign
# of the flexion free. If your rig has a settled convention, adding a one-sided penalty on the
# flexion axis here is the single cheapest improvement to the fits.
HINGE_JOINTS = ("l_elbow", "r_elbow", "l_knee", "r_knee")
HINGE_AXIS = 0  # x: flexion. The other two components get penalised.


class Skeleton:
    def __init__(self, joints):
        self.names = [j[0] for j in joints]
        index = {n: i for i, n in enumerate(self.names)}
        self.parents = []
        for name, parent, _ in joints:
            if parent is None:
                self.parents.append(-1)
            else:
                if parent not in index:
                    raise ValueError(f"joint {name!r} has unknown parent {parent!r}")
                if index[parent] >= index[name]:
                    raise ValueError(f"joint {name!r} comes before its parent {parent!r}; sort parents first")
                self.parents.append(index[parent])
        self.offsets = torch.tensor([j[2] for j in joints], dtype=torch.float32)
        self.index = index

    def __len__(self):
        return len(self.names)

    @staticmethod
    def load(path: Path | None) -> "Skeleton":
        if path is None:
            return Skeleton(DEFAULT_SKELETON)
        blob = json.loads(path.read_text())
        return Skeleton([(j["name"], j.get("parent"), tuple(j["offset"])) for j in blob["joints"]])


# --------------------------------------------------------------------------------------------
# Forward kinematics
# --------------------------------------------------------------------------------------------


def axis_angle_to_matrix(v: torch.Tensor) -> torch.Tensor:
    """Rodrigues, batched. `v` is (..., 3) where the direction is the axis and the length the angle.

    The epsilon inside the square root keeps the gradient finite at v = 0, which the optimiser will
    otherwise wander into; combined with a non-zero random init that is enough to never see a NaN.
    """
    theta = torch.sqrt((v * v).sum(-1, keepdim=True) + 1e-8)
    k = v / theta
    kx, ky, kz = k[..., 0], k[..., 1], k[..., 2]
    zero = torch.zeros_like(kx)
    K = torch.stack(
        [
            torch.stack([zero, -kz, ky], dim=-1),
            torch.stack([kz, zero, -kx], dim=-1),
            torch.stack([-ky, kx, zero], dim=-1),
        ],
        dim=-2,
    )
    eye = torch.eye(3, dtype=v.dtype, device=v.device).expand(K.shape)
    s = torch.sin(theta).unsqueeze(-1)
    c = torch.cos(theta).unsqueeze(-1)
    return eye + s * K + (1.0 - c) * (K @ K)


def forward_kinematics(skel: Skeleton, pose: torch.Tensor) -> torch.Tensor:
    """Joint world positions, (B, J, 3), from per-joint local rotations (B, J, 3) in axis-angle.

    The root sits at the origin: in an orthographic projection a root translation is indistinguishable
    from the camera's own offset, so letting both move just gives the optimiser a flat direction to
    slide along. The camera carries it instead.
    """
    rot = axis_angle_to_matrix(pose)  # (B, J, 3, 3)
    B = pose.shape[0]
    world_r: list[torch.Tensor] = []
    world_p: list[torch.Tensor] = []
    for j, parent in enumerate(skel.parents):
        if parent < 0:
            world_r.append(rot[:, j])
            world_p.append(torch.zeros(B, 3, dtype=pose.dtype, device=pose.device))
        else:
            offset = skel.offsets[j].to(pose.device).expand(B, 3).unsqueeze(-1)  # (B,3,1)
            world_p.append(world_p[parent] + (world_r[parent] @ offset).squeeze(-1))
            world_r.append(world_r[parent] @ rot[:, j])
    return torch.stack(world_p, dim=1)


def project(points: torch.Tensor, cam: torch.Tensor) -> torch.Tensor:
    """Weak-perspective: drop z, scale, offset. `cam` is (B, 3) as (log_scale, tx, ty).

    Orthographic rather than perspective because the game's camera is effectively orthographic and
    because a perspective term is not recoverable from a drawing. The character's facing is not baked
    in here — the root joint's own rotation is free, so the fit turns them to face the way the sprite
    does and this stays a plain projection onto the xy plane.

    Scale is carried as a log so it cannot go negative and mirror the character, which is a local
    minimum the optimiser is otherwise very fond of.
    """
    s = torch.exp(cam[:, 0]).unsqueeze(-1)
    u = s * points[..., 0] + cam[:, 1].unsqueeze(-1)
    v = -s * points[..., 1] + cam[:, 2].unsqueeze(-1)  # image y grows downward
    return torch.stack([u, v], dim=-1)


# --------------------------------------------------------------------------------------------
# The fit
# --------------------------------------------------------------------------------------------


def solve(
    skel: Skeleton,
    targets: torch.Tensor,  # (B, J, 2) in pixels
    conf: torch.Tensor,  # (B, J)
    *,
    iters: int = 600,
    restarts: int = 4,
    prior: float = 0.02,
    hinge: float = 0.05,
    seed: int = 0,
):
    """Fit pose and camera per frame. Returns (pose, cam, per-frame residual in pixels).

    Keypoints are normalised to zero mean and unit spread per frame before fitting, so the loss is
    dimensionless and the same weights work on a 200px sprite and a 900px one. The residual is
    converted back to pixels at the end, because pixels are the only unit anyone can judge.
    """
    B, J = conf.shape
    device = targets.device

    weight = conf.clamp(min=0.0)
    total = weight.sum(dim=1, keepdim=True).clamp(min=1e-6)
    centre = (targets * weight.unsqueeze(-1)).sum(dim=1) / total  # (B, 2)
    centred = targets - centre.unsqueeze(1)
    spread = torch.sqrt(((centred**2).sum(-1) * weight).sum(dim=1) / total.squeeze(-1)).clamp(min=1e-6)
    norm_targets = centred / spread.view(B, 1, 1)

    hinge_idx = [skel.index[n] for n in HINGE_JOINTS if n in skel.index]
    off_axis = [a for a in (0, 1, 2) if a != HINGE_AXIS]

    best = None
    for r in range(restarts):
        g = torch.Generator(device="cpu").manual_seed(seed + r)
        # Never exactly zero: the Rodrigues gradient is well behaved there but uninformative, and a
        # symmetric start makes left and right limbs fight over the same keypoints.
        pose = (torch.randn(B, J, 3, generator=g) * 0.15).to(device).requires_grad_(True)
        cam = torch.zeros(B, 3, device=device)
        cam[:, 0] = math.log(2.0)  # a body is roughly 1.7 units tall; normalised spread is ~1
        cam = cam.requires_grad_(True)

        opt = torch.optim.Adam([pose, cam], lr=0.05)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=iters)
        for _ in range(iters):
            opt.zero_grad()
            pred = project(forward_kinematics(skel, pose), cam)
            err = ((pred - norm_targets) ** 2).sum(-1)  # (B, J)
            data = (err * weight).sum() / total.sum()

            # Toward the rest pose: the only thing standing between the solver and a character
            # folded inside out along the axis the drawing has no information about.
            reg = prior * (pose[:, 1:] ** 2).mean()

            bend = torch.zeros((), device=device)
            if hinge_idx:
                bend = hinge * (pose[:, hinge_idx][:, :, off_axis] ** 2).mean()

            (data + reg + bend).backward()
            opt.step()
            sched.step()

        with torch.no_grad():
            pred = project(forward_kinematics(skel, pose), cam)
            err = ((pred - norm_targets) ** 2).sum(-1)
            score = ((err * weight).sum() / total.sum()).item()
            if best is None or score < best[0]:
                # Per-frame RMS, back in pixels.
                per = torch.sqrt((err * weight).sum(dim=1) / total.squeeze(-1)) * spread
                best = (score, pose.detach().clone(), cam.detach().clone(), per.clone(), r)

    _, pose, cam, residual, which = best
    return pose, cam, residual, which


# --------------------------------------------------------------------------------------------
# Files
# --------------------------------------------------------------------------------------------


def write_template(frames_json: Path, skel: Skeleton, out: Path) -> None:
    blob = json.loads(frames_json.read_text())
    frames = blob.get("frames", {})
    if not frames:
        sys.exit(f"lift_poses: {frames_json} has no frames — cut a sheet first (see apps/fighter/ART.md)")
    doc = {
        "character": blob.get("character", frames_json.parent.name),
        "_note": "x, y in pixels within the trimmed frame; conf 0 means 'not visible, ignore me'.",
        "frames": {
            name: {"keypoints": {j: [0.0, 0.0, 0.0] for j in skel.names}} for name in frames
        },
    }
    out.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"{out}  {len(frames)} frames x {len(skel)} joints, all at zero confidence — fill it in")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--template", type=Path, help="a frames.json to emit a blank keypoint file for")
    ap.add_argument("--keypoints", type=Path, help="the filled-in keypoint file to fit")
    ap.add_argument("--skeleton", type=Path, help="rest skeleton JSON; omit for the generic humanoid")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--iters", type=int, default=600)
    ap.add_argument("--restarts", type=int, default=4)
    ap.add_argument("--prior", type=float, default=0.02, help="pull toward the rest pose")
    ap.add_argument("--hinge", type=float, default=0.05, help="penalty on twist/splay at elbows and knees")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--report", action="store_true", help="print a per-frame residual")
    args = ap.parse_args()

    skel = Skeleton.load(args.skeleton)

    if args.template:
        write_template(args.template, skel, args.out)
        return
    if not args.keypoints:
        sys.exit("lift_poses: give --keypoints to fit, or --template to start one")

    blob = json.loads(args.keypoints.read_text())
    names = list(blob["frames"].keys())
    if not names:
        sys.exit("lift_poses: no frames in the keypoint file")

    B, J = len(names), len(skel)
    targets = torch.zeros(B, J, 2)
    conf = torch.zeros(B, J)
    for b, name in enumerate(names):
        kps = blob["frames"][name].get("keypoints", {})
        for joint, value in kps.items():
            j = skel.index.get(joint)
            if j is None:
                continue
            targets[b, j, 0], targets[b, j, 1], conf[b, j] = float(value[0]), float(value[1]), float(value[2])

    seen = (conf > 0).sum(dim=1)
    thin = [names[b] for b in range(B) if seen[b] < 6]
    if thin:
        print(f"warning: fewer than 6 confident keypoints on {', '.join(thin)} — those fits are guesses")
    if int(seen.sum()) == 0:
        sys.exit("lift_poses: every keypoint has confidence 0 — the template has not been filled in")

    pose, cam, residual, which = solve(
        skel, targets, conf,
        iters=args.iters, restarts=args.restarts,
        prior=args.prior, hinge=args.hinge, seed=args.seed,
    )

    doc = {
        "character": blob.get("character", args.out.parent.name),
        "skeleton": skel.names,
        "_note": "rotations are per-joint local axis-angle, radians, in skeleton order",
        "poses": {},
    }
    for b, name in enumerate(names):
        doc["poses"][name] = {
            "rotations": [[round(v, 5) for v in r] for r in pose[b].tolist()],
            "residual_px": round(float(residual[b]), 2),
            "keypoints_used": int(seen[b]),
        }
    args.out.write_text(json.dumps(doc, indent=2) + "\n")

    if args.report:
        print(f"restart {which} won; residuals in pixels, on the frame's own scale:")
        for b, name in sorted(enumerate(names), key=lambda t: -float(residual[t[0]])):
            px = float(residual[b])
            flag = "  <- look at this one" if px > 12 else ""
            print(f"  {name:<18} {px:6.2f} px   {int(seen[b])} keypoints{flag}")
    print(f"{args.out}  {B} poses")


if __name__ == "__main__":
    main()
