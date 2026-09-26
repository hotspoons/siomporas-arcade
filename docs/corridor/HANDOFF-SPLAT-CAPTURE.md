# Handoff: turn the Arrowhead Farms capture into a splat world

**For:** the capture agent (the `splats` lane). **From:** the corridor agent (the `viewer` lane),
2026-09-26. **Read first:** [PLAN-SPLAT-CORRIDORS.md](PLAN-SPLAT-CORRIDORS.md) — it is the design
this serves, and §2 explains why the alignment numbers you record matter more than they look.

Your job is **Track A**: footage → a geo-aligned, chunked splat world, with its numbers written
down. Mine is Track B: putting it inside the driving world and fading between the two. The two do
not block each other and they meet at exactly one place, the **contract** in §5.

---

## 1. What has landed

`ext/data/100GOPRO/` (still copying as of 19:57; check for files that arrived after this was
written):

| file | size | what it is |
|---|---|---|
| `GS010002.360` | 11.5 GB | recording 0002, chapter 1 |
| `GS020002.360` | 11.5 GB | recording 0002, chapter 2 |
| `GS030002.360` | 8.8 GB | recording 0002, chapter 3 |
| `GS010001.360`, `GS010003.360` | 29 MB each | seconds long — test clips, not drives |
| `*.LRV`, `*.THM`, `*.36P` | — | GoPro's proxies and thumbnails. **Ingest the `.360`.** |

GoPro Max 2, so the profile is `gopro-max2` (`ext/gaussworks/splatpipe/data/profiles/`), which is
marked `status: validated` and expects **two** video tracks of `5952 × 1920` EAC. Confirm that per
file rather than trusting it — `splatpipe profiles <video> --plan` prints the detection and the
view plan, and a Max *2* body is newer than the note that profile was written against.

The roads Rich named are Patuxent River Rd (PRR), the Arrowhead Farms neighbourhood, and Gosheff —
i.e. the streets around `arrowhead-farms` and the west end of `crofton-crownsville`. Both sites are
already baked under `tools/corridor/data/sites/`, which is what the world has to line up with.

### Disk: read this before you run anything

This devcontainer has **96 GB free** and the footage is already 31 GB of it. Ingest writes a
full-resolution JPEG per kept frame per view, which for a 40-minute drive is tens of gigabytes, and
COLMAP's database and sparse models are more. **Do the work on the cluster PVC, not in the
container.** `ext/gaussworks/deploy/devpod.yaml` asks for 500 Gi of cephfs; the training queue
wants that volume anyway.

---

## 2. The cluster

`kubectl` here points at `gh200-1`: **8 nodes, 1 GPU each** (GH200). Chunk training is one GPU per
chunk pulling from a claim-based queue on shared storage (`splatpipe/workqueue.py`), so all eight
can work the same world if the volume is **RWX** — the devpod spec is RWO because it was written
for a single interactive pod. That is the one infrastructure decision you have to make early;
say which way you went in a message.

Poses (COLMAP/GLOMAP) is CPU-and-GPU mixed and is usually the long pole on a neighbourhood
capture, not training.

---

## 3. The pipeline, in the order it runs

```
splatpipe profiles ext/data/100GOPRO/GS010002.360 --plan      # confirm the camera and the views
splatpipe ingest   <the three .360 chapters> --out <work>/frames --config configs/arrowhead.yaml
splatpipe chunk    --frames <work>/frames --out <work>/chunks
splatpipe poses    --chunks <work>/chunks                     # spatial matching, then model_aligner to ENU
splatpipe train    --chunks <work>/chunks                     # one GPU per chunk, claim-based
splatpipe merge    --chunks <work>/chunks --out <work>/world --prune-corridor
splatpipe route    --world <work>/world                       # optional: the stage centreline
```

Write `ext/gaussworks/configs/arrowhead.yaml` beside `md-backroads.yaml`. Start from that file —
it is the same camera, the same county and the same protocol — and change the campaign block, the
roads, and anything the neighbourhood needs (a 200 m cell is sized for open back roads; a dense
subdivision with a house every 20 m may want smaller, and that is a judgement worth measuring
rather than guessing: `chunk` prints frames per cell).

**Verify as you go**, because every stage is expensive and the failures are quiet:

- after `ingest`: how many frames, and **how good is the GPS**? `frames.jsonl` carries lat/lon per
  frame. A neighbourhood under canopy is exactly where GPS goes worst, and `poses`' spatial
  matching leans on those priors. Plot or print the track and look at it. If there are long
  straight jumps or a drift onto the wrong street, say so in a message before spending GPU hours.
- after `chunk`: cells, frames per cell, and cells dropped for `min_frames`.
- after `poses`: registered images per chunk, and whether `model_aligner` succeeded. A chunk that
  failed alignment is not in ENU and will land in the wrong place.
- after `train`: `splatpipe eval` per chunk (PSNR/SSIM).
- after `merge`: gaussians kept vs source, and how many tiles.

---

## 4. Traps, all of them known rather than theoretical

1. **The lens seam** (`ext/gaussworks/docs/SEAM.md`). Every training view is rendered through ONE
   lens; the view plan guarantees it. Do not override `fov`/`pitch` casually — widen them and views
   start crossing the seam, which puts stitched ghosts into the reconstruction that no later stage
   removes.
2. **One road driven twice is one chunk, not two.** The locality grid is deliberate: every pass
   through a cell feeds that cell. Do not split the capture by video file.
3. **`--prune-corridor` on merge.** Floaters outside the observed envelope are the first thing a
   driver sees, because they hang over the road.
4. **Altitude semantics.** Record whether the GPS altitude in these files is ellipsoidal (WGS84) or
   MSL. It is a 33–35 m difference in Maryland and it is my problem to correct, but only if you
   tell me which one it is.
5. **Camera height above the road.** Ask Rich for the rig height on the car (roof mount on the
   Rivian, per the md-backroads protocol note). It is degenerate with the vertical fit, so knowing
   it is worth more than fitting it.
6. **Nothing under `ext/` is committed** — it is gitignored, and the footage must stay out of git.
   The world you produce under `tools/corridor/data/splats/` is also data, not source: put the
   numbers in `REPORT.md` and tell me the path; do not `git add` the tiles.
7. **`tools/corridor/data` is shared with other lanes.** `splats/<world>/` is yours alone. Do not
   touch `sites/`.
8. **Never `git add -A`** in this tree, and never create a symlink under `/workspaces/apex-conduit`.

---

## 5. The contract: what I need back

```
tools/corridor/data/splats/arrowhead-2026-09/
  world.json        frame "enu", origin {lat, lon}, cell_m, tiles[{tile, bounds_enu_m, centre, gaussians}]
  corridor.json     radius_m, height_band_m, passes[{points: [[e,n,u], ...]}]
  route.json        (optional but welcome)
  tiles/*.spz       .ply is acceptable for a first pass — see below
  REPORT.md         the numbers from §3, plus altitude semantics and camera height
```

**On the format.** `merge` writes `.ply`. Raw PLY is roughly ten times the bytes of `.spz`, and
these tiles stream to a browser over a Cloudflare tunnel, so `.spz` is what production needs — but
**do not block on it**: ship `.ply` first so I can build the seam against real data, and add the
conversion after. If you do write the converter, it belongs in gaussworks next to `merge`.

**A far LOD** (a decimated copy per tile, say 1/8 by opacity × scale) is the next thing after that,
because driving shows the corridor ahead as well as the cell you are in.

**A sanity check you can do without me.** Your `corridor.json` passes are ENU about your origin;
the site's anchor is in `tools/corridor/data/sites/arrowhead-farms/web/manifest.json` under
`frame.anchor`. Composing the two frames through ECEF is ten lines —
`tools/corridor/splats/frame-error.mjs` is a worked example using the engine's pyproj-checked
helpers. If the transformed passes do not land on the right streets, something is wrong upstream
(alignment, GPS, or the origin) and it is much cheaper to find now. **Do not try to fix the fit
yourself** — the 4-DOF fit against the road network is mine, and a second correction applied
upstream would fight it.

---

## 6. How we talk

`/tmp/messages/PROTOCOL.md` has the conventions. Briefly: one file per message,
`NNN-slug.md`, first line `subject:`, written atomically, dropped in
`/tmp/messages/viewer/inbox/` for me (copy in your own `outbox/`), and read mail gets **moved** to
`/tmp/messages/archive/`. I am watching my inbox.

Worth a message: the GPS verdict after ingest, the RWX decision, the altitude semantics and camera
height, anything that changes the contract in §5, and "done, here is the path". Everything else
belongs in your `REPORT.md`.

---

## 7. Done looks like

- every `.360` chapter ingested, with the frame count and the GPS verdict written down;
- chunks trained, with a per-chunk PSNR in the report, and no chunk silently missing;
- `world.json` + `corridor.json` + tiles under `tools/corridor/data/splats/arrowhead-2026-09/`;
- the capture passes, transformed into `arrowhead-farms`' ENU frame, land on the streets they were
  driven down;
- a message in my inbox with the path, the altitude semantics, and the camera height.

Then I fit it, attach it, and build the fade. If you want to see where it is going, §3 of the plan
is the seam design and §9 is the order of work.
