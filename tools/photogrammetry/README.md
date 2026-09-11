# From sprite art to a rigged 3D fighter

The 2D game needs sprites and the 3D game needs models, and generating the character twice is how
you end up with two characters. This is the path from one set of generated art to both.

> **None of the Python in this directory has been run.** The container it was written in has no GPU,
> no CUDA, and no Python package manager, so it could not be. `lift_poses.py` is self-contained
> maths and `check.py` is a few lines of introspection, but treat both as unrun code and read them
> before you trust them. The sizing numbers below are from model cards and published benchmarks, not
> from runs on your hardware — check them against the repo you end up using, and expect to be within
> a factor rather than exact.

## The short version

**Do not book the 8×H200 node.** Every step here is single-GPU inference on a 1–2B parameter model.
One L40S, one A100, or honestly one RTX Pro 4000 Blackwell runs the entire twelve-character roster
in well under an hour. The big node is only worth it if you decide to fine-tune a 3D generator on
your own character art, which is a real option and a much larger project — see the last section.

## The pipeline

```
  character bible  ──►  sheet A + B  ──►  24 keyed sprite frames      the 2D game
  (ART.md)              (ART.md)          + anchors (frames.json)
        │
        │  full-figure A-pose panel, or the 8-view turnaround
        ▼
   image-to-3D  ──►  statue mesh  ──►  decimate  ──►  auto-rig  ──►  rigged character
   (one GPU)         + texture        + UV          (A-pose)              │
                                                                          │
   24 sprite frames ──► 2D keypoints ──► lift_poses.py ──► 24 joint poses ─┘
                        (detector or                       matching the sprites
                         by hand)
```

The last row is the part worth having and the part nobody ships. Everything above it is off-the-
shelf inference. Below it, the 3D character performs the same twenty-four moves as the sprite,
because the poses were solved *from* the sprite. When the game shifts from 2D to 3D mid-fight, the
fighter is in the same pose on both sides of the transition — which is the whole trick.

---

## Step 1 — image to 3D

Feed-forward image-to-3D. Pick one and stick with it; the failure modes differ and you do not want
to learn two sets.

| Model | Input | VRAM | Roughly | Notes |
|---|---|---|---|---|
| **TRELLIS** (`TRELLIS-image-large`, ~1.2B) | 1 or more views | ~16 GB | ~30 s / asset on A100 | Best all-round. Outputs mesh, 3DGS or radiance field. **Start here** |
| **Hunyuan3D 2.x** | 1 view | ~24–40 GB with texture | ~1–2 min / asset | Separate shape and texture stages; texture quality is the draw |
| **InstantMesh** | 6 views | ~20 GB | ~20 s / asset | Wants Zero123++ multiview in front of it; the 8-view turnaround can substitute |
| **SF3D / Stable Fast 3D** | 1 view | ~8 GB | ~1 s / asset | Fast and rough. Good for checking a silhouette works before committing |

**Which input — the A-pose panel or the turnaround?** Try the single A-pose panel from the character
bible first. One-view models have got good enough that eight *inconsistent* views are often worse
than one clean one, and eight views out of a chat generator will be inconsistent — a buckle moves,
a strap changes shoulder, the back of the head is invented differently each time. Reconstruction
tolerates a little of that and turns a lot of it into mush.

Generate the turnaround anyway. It costs one image per character, it is the correct input if you
later move to a proper multiview model, and it is the best reference you will have for fixing the
back of a character by hand.

Cut the A-pose panel out of the bible with the same script everything else uses:

```bash
node scripts/fighter-sheet.mjs ext/kestrel-bible.png kestrel reference --only figure
```

That writes a keyed, trimmed, transparent PNG — which is what every one of these models wants
anyway. They all run background removal as their first step, and ours is better than theirs because
we controlled the background.

**Sizing:** one GPU with 24 GB. 12 characters is 12 runs. If you want a mesh per pose as well —
you mostly do not, see step 3 — that is 12 × 24 = 288 runs, still comfortably an afternoon on one
card. Batching across 8 GPUs turns an afternoon into twenty minutes and is not worth the pod setup
unless the node is already yours and idle.

## Step 2 — make it riggable

What comes out of step 1 is a **statue**: one watertight-ish mesh, 200k–1M triangles, an unhelpful
UV layout, no skeleton, and frequently the hands fused to the thighs. It is not a game asset yet.

1. **Decimate** to 15–30k triangles. Blender's Decimate modifier, or `pymeshlab` quadric edge
   collapse. Keep the silhouette; you will be seeing this from a fixed side-on-ish camera much of
   the time.
2. **Separate anything fused.** This is the step that needs a human. An A-pose with arms well clear
   of the body is why the bible asks for arms held away from the body and palms forward — it is not
   an aesthetic choice, it is so the reconstruction does not weld the wrists to the hips.
3. **Auto-rig.** Blender's Rigify with automatic weights is free and adequate. A humanoid auto-rig
   service will be better and faster if you do not mind the round trip. Either way you want a
   standard humanoid skeleton, because step 3 and every animation library assume one.
4. **Export** the rest skeleton to JSON for step 3:
   `{ "joints": [{ "name": "l_elbow", "parent": "l_shoulder", "offset": [x, y, z] }, ...] }`
   with offsets in the parent's local frame, metres.

No GPU needed for any of this. It is the slowest part in wall-clock and the only part that is not
automatable end to end.

## Step 3 — lift the sprite poses onto the rig

`lift_poses.py`. This is the custom piece.

Given 2D keypoints for each of the twenty-four sprite frames and the rest skeleton from step 2, it
solves for the joint rotations that put the 3D character into the same pose the sprite is in. Plain
gradient descent through a differentiable forward-kinematics chain — Adam, a few hundred iterations,
a handful of random restarts. **It runs on a CPU in seconds.** Do not book a GPU for it.

```bash
# 1. emit a blank keypoint file listing every frame and joint, to fill in
python3 lift_poses.py --template apps/fighter/public/chars/kestrel/frames.json \
                      --out ext/kestrel-keypoints.json

# 2. fill it in — a 2D pose detector over the sprite PNGs, or by hand
# 3. solve
python3 lift_poses.py --keypoints ext/kestrel-keypoints.json \
                      --skeleton ext/kestrel-skeleton.json \
                      --out apps/fighter/public/chars/kestrel/poses.json --report
```

Where the keypoints come from: run any 2D human-pose detector over the cut sprite frames. They are
trained on photographs and our sprites are painted photographs, which is near enough — expect it to
work on the standing poses and to need help on the sweep, the KO and anything inverted. Fix those by
hand. Twenty-four frames per character is an hour of annotation at worst, once.

**What it cannot do.** A single side-on sprite does not contain depth. Whether the far arm is in
front of or behind the body is genuinely not in the image, and the solver resolves it with a pose
prior — plausibly, not correctly. Read the per-frame residual that `--report` prints, and expect to
hand-fix the frames where an arm crosses the body. This is a property of the problem, not of the
program.

`--report` also prints a residual in pixels per frame. Under ~4 px on a 300 px figure is a good fit;
over ~12 px means the keypoints are wrong or the pose is one the prior hates.

## Step 4 — what the game gets

```
apps/fighter/public/chars/kestrel/
  *.webp  frames.json     the 2D game
  kestrel.glb             the 3D game: rigged mesh
  poses.json              24 joint poses that match the 24 sprites, by name
```

The 2D→3D transition reads `poses.json` for whatever the fighter is doing at that instant and starts
the 3D rig there. In the other direction it picks the sprite frame whose pose is nearest. See
[DESIGN.md](../../apps/fighter/DESIGN.md).

---

## GPU sizing, plainly

| What | Hardware | Time |
|---|---|---|
| Image-to-3D, 12 characters | **one** 24 GB card — RTX Pro 4000 Blackwell, L40S, A100, any of them | under an hour |
| Image-to-3D, 288 pose-meshes (if you insist) | same one card | an afternoon |
| Decimate, rig, clean | CPU, and your attention | the real cost |
| `lift_poses.py`, whole roster | CPU. Four cores | minutes |
| Fine-tuning a 3D generator on your own art | this is where 8×H200 earns its keep | days |

A DGX Spark is a fine place to do all of the inference — 128 GB unified means nothing here will OOM,
and being slower than an L40S does not matter for a job measured in minutes. Use it for iterating on
prompts and settings, and only move to a datacentre card if you end up doing hundreds of runs.

**The one thing that would justify the big node** is fine-tuning. If after twelve characters the
reconstructions are consistently wrong in the same way — and they will be, generators have opinions
about hands — a LoRA on a multiview diffusion model, trained on your own turnarounds, fixes it
across the whole roster at once. That is an 8×H200 job and a multi-day one. It is also premature
until you have generated at least the first four characters and can describe the failure precisely.

## Install

```bash
pip install -r requirements.txt
python3 check.py     # what am I on, and what fits in it
```

`lift_poses.py` needs only `torch`, and only the CPU build. The image-to-3D repos have their own and
substantially heavier requirements — install those in their own environment, not this one.
