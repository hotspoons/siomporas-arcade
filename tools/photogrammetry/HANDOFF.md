# Handoff: the 3D pipeline, and what already exists

*Written for the agent picking up photogrammetry. Read `README.md` first — it is the design and it
is still correct. This is the state of the world underneath it: what exists, what is measured, what
is guessed, and where the seams are.*

Three agents are on this game. **ROM side** drives arcade boards headlessly in MAME and pulls out
frame data and sprites. **Art side** (me) generates original character art against a diffusion model
on the cluster. **You** turn the 2D art into rigged 3D characters. We pass notes through
`/tmp/messages/inbox`, and move them to `/tmp/messages/read` on receipt.

---

## What you have been handed, concretely

### 1. A character with 54 packed sprite frames

```
apps/fighter/public/assets/crown/chars/kestrel/
  atlas.png      every frame, keyed, transparent
  frames.json    per frame: x, y, w, h in the atlas, and ax/ay — the anchor
  portrait.png   96x96 select-screen mugshot
```

Nine animations: `idle`, `walk-fwd`, `walk-back`, `stand-hp`, `stand-hk`, `crouch-hk`, `hit-high`,
`knockdown`, `win`. Six frames each except `hit-high`.

**`ax, ay` is the anchor and it is the thing that makes these usable to you.** Every frame is
trimmed to its own content, so a sweep is wide and short and an uppercut is tall and narrow;
`ax, ay` is where the fighter's *position* sits inside that frame — `ay` the floor between the feet,
`ax` the centre of the stance. Two frames of one animation are in the same world position when their
anchors coincide, not when their top-left corners do. If your keypoints are in frame-local pixels,
subtract the anchor to get them into a common space before you fit anything.

Scale: the game runs at **arcade pixels on a 384x224 screen**, a fighter stands about **90px**, and
`frames.json` carries `pixelScale` (0.133 for Kestrel) recording how far the masters were reduced.

### 2. Turnarounds for the reconstruction

```
ext/art/kestrel-turnaround/
  a-00.png … a-07.png    A-pose, eight angles, 45-degree increments
  t-00.png … t-07.png    T-pose, same eight angles
```

1024 square, flat chroma-green, camera at chest height and level, 45 degrees apart starting from
front and going anticlockwise: front, front-left, left profile, back-left, back, back-right, right
profile, front-right.

**Treat these as generated, not photographed.** They are eight separate generations of the same
described character, not eight cameras around one object, so they will not be perfectly consistent —
a fold of cloth moves, the rope wraps differently, and in these the vest gained a panel it does not
have on the sprites.

**And the ring is not really eight angles — it is three cameras, and one flank of her does not
exist.** My first pass at this said "roughly four distinct cameras", which was wrong; the
photogrammetry agent audited it and the correction is theirs. Measured by head-band width (rows
60-200, which excludes the arms, since a head in profile is about 60% the width of one facing you):

| A-pose | head-band | what it is |
|---|---|---|
| `a-00` `a-01` `a-03` `a-05` `a-07` | 264-266 px | **all five are the front.** One camera, sampled five times |
| `a-02` `a-06` | 158, 155 px | profile — and *the same* profile |
| `a-04` | 125 px | back |

`a-02` and `a-06` are supposed to be opposite flanks. They are not: mirroring one should bring them
together and instead it doubles the error (RMSE 0.049 direct against 0.111 mirrored), so `a-06` is
the same side rendered twice, facing the same way. **Kestrel's other flank has never been drawn.**

The T set is thinner again. By hip band (rows 600-750, excluding the outstretched arms): five views
at 273-274 px, `t-02` at 256 and `t-06` at 200 which is a three-quarter at most, `t-04` at 191 for
the back. **Front and back and no side at all.**

So the earlier claim here that "the T-poses are the more useful set for rigging" needs qualifying:
their limbs are unambiguous, which is real and does matter, but they carry **no depth information**.
The A set is the one with a flank in it.

The mechanism matters for anyone generating the next ring: these are honest re-generations of the
same camera rather than mirrored or misapplied angles, which means **the angle words in the prompt
are being ignored**, not misunderstood. Eight files fed to a multiview model as eight views would
tell it the character is front-facing from five directions, and it would believe it.

`README.md` already warns that eight nearly-consistent views often reconstruct worse than one clean
one, and that warning was written before these existed. **Try the single A-pose front view first.**

Ask me for more angles, a different pose, or a cleaner single view — a view is about 35 seconds.

### 3. `lift_poses.py`, unrun

Self-contained maths: a `Skeleton`, forward kinematics, a projection, and a `solve` that fits joint
angles to 2D keypoints with a rest-pose prior and a hinge penalty at elbows and knees.

```bash
python lift_poses.py --template apps/fighter/public/assets/crown/chars/kestrel/frames.json --out kp.json
# fill kp.json in — a 2D pose detector over the sprite PNGs, or by hand
python lift_poses.py --keypoints kp.json --out poses.json --report
```

**Nobody has run it.** The container it was written in had no GPU, no CUDA and no package manager.
It imports torch. Read it before you trust it, and `--report` prints a per-frame residual, which is
the first thing to look at.

---

## The seam nobody has built: 2D keypoints

`lift_poses.py` takes keypoints and gives you joint angles. **Producing the keypoints is the gap.**
Options, roughly in order of how much I would trust them:

1. **A 2D pose detector over the sprite PNGs.** The obvious route. These are painted figures on
   transparency, not photographs, and most detectors are trained on photographs — worth an early
   test on six frames of `idle` before committing.
2. **Generate with the pose known.** A skeleton-conditioned generator (ControlNet-style) would give
   keypoints for free because we chose them. Not available on our current serving stack; would
   change the art pipeline rather than sit alongside it.
3. **By hand for one animation.** Six frames of `idle` is maybe twenty minutes and gives you ground
   truth to check the other two approaches against. If you do nothing else first, do this.

Tell me if a different art form would make your life easier. I can render frames without the keying
step, at higher resolution, with a consistent camera, or one limb at a time — the pipeline is
scripts and the model is up.

---

## Things that will bite you, learned the hard way tonight

- **The sprites are drawn at naturalistic proportions (~8 heads); the arcade sprites they sit beside
  are caricatures (~5).** We have a fix — attaching a proportion reference image — but it only works
  for single-figure generations, and the shipped Kestrel does not have it yet. **Her build may
  change.** Rig against the skeleton, not against her silhouette, and expect to re-fit.
- **Some frames have the feet clipped** at the edge of the box they were drawn in, so the lowest row
  is the crop and not the sole. `pack.json` carries `"floorY": "frame"` to cope, but a foot that was
  never drawn cannot be recovered — do not read those as ground contact.
- **Do not trust a contact sheet.** Every cell is the same size and every figure fills it, so a pose
  drawn at twice the scale looks correct there. `node scripts/fighter-contact.mjs kestrel` places
  the packed frames on a common floor by their anchors, which is the view that shows the truth.
- **The A-pose arms are flat against her thighs**, with no daylight between wrist and hip. That is
  the wrist-welded-to-hip case `README.md` warns about, and an image-to-3D model will fuse them. The
  pose needs arms 35-45 degrees out with visible air under them; it is the first thing to fix about
  the ring and it is independent of the angle problem.
- **`win[2]` is a known bad frame** — a torso close-up at roughly double scale. It will be
  regenerated. Do not fit to it.

## Where the numbers live

`apps/fighter/src/data/chars/*.json` — characters are tables of numbers, measured off the arcade
board where they could be, with `$rom` provenance on measured values and `$comment` on invented
ones. The ROM agent is starting reconnaissance on the 3D boards (Tekken, Virtua Fighter) for the
movement and combat dynamics a 3D fighter needs — sidestep, tracking, juggles, ring-outs, camera.
That is the other half of what you are building: your models will need something to do, and it
should arrive in the same shape.

— image generator
