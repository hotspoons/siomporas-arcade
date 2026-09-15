# `lift_poses.py` has been run

*2026-09-14, photogrammetry agent. The header of `lift_poses.py` and the top of `README.md` both
warn that nothing here had ever been executed. That is no longer true, and this is what happened.*

**Verdict: the solver is correct and the defaults are well chosen.** It does what it claims. The
part it cannot do is the part `README.md` already says it cannot do, and I now have a number for
how much that costs.

Run on a GH200 pod (`vllm/vllm-omni:nightly-aarch64`, torch 2.13.0+cu130, aarch64) because the
devcontainer has no `pip`. It is CPU maths and wants no GPU: 6 frames × 17 joints × 4 restarts ×
600 iterations is **about 13 seconds on CPU**. The whole 54-frame roster is a couple of minutes, as
the README predicted.

## Method

No annotation was needed to test the solver, and waiting for annotation would have been the wrong
order. Instead, a **round-trip**: synthesise a known pose, push it through the module's own
`forward_kinematics` and `project`, hand the resulting 2D points to `solve`, and ask how much of the
original came back. If it cannot invert its own forward model, no keypoints would have saved it.

Scripts are in the scratch dir, not committed — they are throwaway harnesses, not tooling.

## What came back

Poses drawn near-planar, which is how a sprite is drawn, with 1.5px of keypoint noise:

| | total 3D error | in-plane (x, y) | depth (z) |
|---|---|---|---|
| fully planar | 19.3% | **3.5%** | 18.3% |
| slightly off-plane | 20.8% | **2.7%** | 20.1% |
| a punch toward camera | 25.8% | **3.0%** | 24.7% |

Percentages are of body scale, after normalising both skeletons.

**In-plane recovery is 3%, and it does not degrade as the pose gets harder.** The solver recovers
what the drawing contains, accurately, every time. 2D residual sits at 1.1–1.5px on a ~300px figure,
comfortably inside the "under 4px is a good fit" band in the README.

**Every bit of the remaining error is depth, and depth is at chance.** Sign agreement on whether a
joint is in front of or behind the body ran 30–53% across every condition — a coin flip. For a
near-planar pose that costs almost nothing, because there is barely any true depth to get wrong:
comparing against a depth-mirrored ground truth scores 18.8% against the honest 19.3%, i.e. the two
readings of the drawing are indistinguishable, which is the reflection ambiguity being exactly as
real as advertised. For a limb genuinely reaching toward the camera it is not a clean mirror and the
answer is simply wrong (49.3% against a mirrored truth versus 25.8% honest).

This is the README's own warning, confirmed and quantified. It is a property of the problem.

## Three things worth knowing before you use it

**1. `residual_px` cannot detect a depth error, so `--report` cannot flag the frames to hand-fix.**
The residual held at 1.1–1.5px whether depth was recovered correctly or inverted — it measures the
fit to the drawing, and both readings fit the drawing equally well. That is not a bug, but it does
undercut the workflow in the README, which says to read the per-frame residual and hand-fix the
frames where a limb crosses the body. The residual will not name those frames. Finding them wants a
separate geometric test over the 2D keypoints — does a limb overlap the torso — rather than the
residual, and no 2D signal can ever resolve them, only locate them.

**2. The shipped defaults are right; do not spend compute on more.** `restarts=4` and `iters=600`
are enough. 16 restarts at 1500 iterations bought nothing (3D error 39.6% versus 38.1% for a single
restart on the same input). `prior=0.02` is near-optimal: the 2D residual degrades steadily above it
(1.08px at prior 0, 1.75px at 0.05, 3.06px at 0.3).

**3. The rest-pose prior does *not* shrink the pose.** Worth stating because it is the obvious thing
to suspect and it is wrong — I suspected it and tested it. Recovered limb extension came back at
**98–99% of truth at every prior from 0 to 0.3.** A heavy attack will not solve under-extended, so
the solver will not manufacture the "does not extend" defect that `fighter-contact.mjs` checks for
in the art. If an attack looks short after lifting, the sprite was short.

## One change I would make

`solve` normalises the keypoints internally and the `cam` it returns is in **normalised space**, but
it returns neither the centre nor the spread it used. So a caller cannot reproject the fitted
skeleton back onto the sprite to look at it. Returning those two tensors — or the pixel-space camera
— is a few lines and is the difference between a fit you can eyeball over the art and a fit you can
only take on trust. I have not made the change; the file is as handed over.

(Checked and *not* a problem: `write_template` expects `blob["frames"]` to be a flat dict keyed by
frame name, and the real `frames.json` is exactly that — 54 keys like `crouch-hk-0`. It also falls
back to the parent directory name for the character, which happens to be right. The real file uses
`id`, not `character`.)

## Next

Hand-annotate six frames of `idle` as ground truth, per the handoff's option 3, and fit them. That
is the first fit against real art rather than against the module's own forward model, and the
in-plane number above is what it should be measured against.
