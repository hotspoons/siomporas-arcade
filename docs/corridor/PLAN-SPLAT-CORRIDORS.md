# Splat corridors: putting a captured world inside the built one

**Status:** design, 2026-09-26. Rich: *"I have 360° footage of the Arrowhead Farms area, the entire
neighborhood … make it so we can insert splatted corridors into these map worlds, and where there
are splats we hide the rendered map objects and maybe fade the splats out as you drive through
them and fade the map objects into existence."*

This is the design for that handover. It is written against both halves as they actually stand:
`ext/gaussworks` (cloned 2026-09-26) and the corridor viewer at `cd6983c`.

---

## 1. What each side already gives us

**gaussworks** (`splatpipe`) turns car-mounted 360 footage into a *geo-aligned, chunked* world:

| file | what is in it |
|---|---|
| `world/world.json` | `frame: "enu"`, `origin: {lat, lon}`, `cell_m` (~200 m), and a `tiles[]` list: `{tile, chunk, bounds_enu_m: [x0,y0,x1,y1], centre, gaussians}` |
| `world/tiles/chunk_xN_yN.ply` | that cell's gaussians, already pruned to the cell it owns and to the capture envelope |
| `world/corridor.json` | `{frame: "enu", origin: {lat, lon}, radius_m, height_band_m: [lo, hi], passes: [{video, seq_range, points: [[e,n,u], …]}]}` — **where the camera actually was** |
| `world/route.json` | an ordered, deduped chain of passes: a one-way stage centreline |

Two facts make this fit corridor at all, and they are not luck: the frame is **ENU about a stated
lat/lon**, and the corridor envelope is a first-class output rather than something we would have to
infer from the gaussians.

**The corridor viewer** brings the other half:

- a **geodetic frame** (`docs/corridor/FRAME.md`): WGS84 authority, ENU render about
  `manifest.frame.anchor = {lon, lat, h}`, floating origin. Two ENU frames compose through ECEF
  exactly, and `packages/engine/src/geo/wgs84.ts` is tested against pyproj rather than itself.
- **streaming by locality** that already works for 1 km packs and KTX2 imagery
  (`ImageryStream`, byte-budgeted, nearest-first, evicting), and a **lazy build pump**
  (`gradeNear`, `STREAM_BUILD_M`/`STREAM_BUDGET_MS`) that builds strips, roads and buildings
  around the eye. A splat tile is the same shape of problem.
- **a ground that is a formula, not a mesh** (`gradedHeight`, `edgeDistance`, `treesNear`).
  This is what makes the whole idea safe: *the splat never has to carry collision*.

---

## 2. The one hard part: putting it exactly where the road is

Everything else in this document is easy. This is not, and it is worth being exact about why.

### 2.1 Two ENU frames are not the same ENU frame

gaussworks anchors at the capture's own origin; a site anchors at
`manifest.frame.anchor` (arrowhead-farms: `-76.69057, 38.98138`). Both are "east/north/up in
metres", which invites treating the difference as a translation. It is not: the tangent planes are
tilted with respect to each other by the angle subtended at the Earth's centre. Measured against
arrowhead-farms' own anchor with the engine's pyproj-checked helpers
(`tools/corridor/splats/frame-error.mjs`), for a point 2 km out inside the capture:

| capture anchor from the site anchor | error if you treat it as a translation |
|---|---|
| 0.5 km | 0.24 m |
| 1 km | 0.47 m |
| 3 km | **1.41 m** |
| 6 km | **2.83 m** |

A metre and a half puts a splatted house across a road at the far end of a capture while the near
end looks perfect — the classic "it lines up where I checked it" failure.

The correct transform is a rigid one through ECEF, which we already have the pieces for:

```
p_site_enu = R_site · ( ECEF(anchor_gauss) + R_gaussᵀ · p_gauss_enu − ECEF(anchor_site) )
```

with `R` the ENU basis at each anchor (`enuBasis(lon, lat)` in `packages/engine/src/geo/wgs84.ts`).
Cost: one 3×3 and one translation, computed once when the splat world is attached. There is no
reason to approximate it.

### 2.2 The vertical is a different problem, and it must be measured

The horizontal is solved by 2.1. The vertical is not, because the two sides do not share a datum
**or a reference surface**:

| | corridor viewer | gaussworks |
|---|---|---|
| height source | USGS lidar DTM, **NAVD88 orthometric** | GPS altitude from EXIF, fed to COLMAP `model_aligner` |
| what the number describes | the ground | **the camera**, ~1.5–2.5 m above the ground, in the driven lane |
| geoid separation in Maryland | — | ≈ **−33 to −35 m** if the GPS altitude is ellipsoidal |

So a naïve attach can be thirty-five metres out vertically and nobody should be surprised. Worse,
the error we care about is not constant: COLMAP's aligner fits a similarity to a noisy GPS track,
so there can be a slow drift along the capture.

**The fit, not the assumption.** Both sides independently observed *the middle of the same roads*:
gaussworks as `corridor.json` passes, the viewer as the spine and branch splines. So:

1. bring the passes into site ENU with 2.1;
2. for each pass point, find the nearest point on the viewer's road network (`edgeInfo` already
   returns distance, which road, its surface height and along-track `s`);
3. solve a 4-DOF least squares — `Δx, Δy, Δz, Δyaw` — minimising the horizontal distance to the
   road centreline and the vertical distance to the road surface **plus the rig's camera height**;
4. iterate two or three times (it is an ICP with a very good starting guess);
5. **report RMS before and after, and refuse to attach above a threshold.**

The camera height is the one number worth asking Rich for rather than fitting (a roof mount on a
particular car), because fitting it is degenerate with `Δz`. If it is unknown, it can be recovered
from the splat itself: take the 5th percentile of gaussian height within 2 m of each pass point —
that is the road surface under the camera — and the difference is the rig height. Either way it is
**measured and written down**, never typed.

Expected residual: a lane offset (the camera drove in a lane, the centreline is the middle) of
1.5–3 m laterally. That is not an error and must not be fitted away — the fit is along-track and
vertical; the lateral term should be fitted as a *signed offset per pass* and then discarded.

### 2.3 What "aligned" has to mean to pass

`probes/corridor-splatfit.mjs`: after the fit, sample 200 points along the capture passes and
report the distance from each to the nearest road centreline and to the road surface. **Fails** if
the vertical RMS is worse than 0.3 m or the along-track drift exceeds 1 m over the length of the
capture. A splat that is 0.5 m high reads as a hovering world; 0.3 m is under the suspension.

---

## 3. The seam: how the two worlds hand over

This is the part Rich described, and the design goal is that **at no point is there a hole, and at
no point are both worlds visibly present as two versions of the same house.**

### 3.1 One scalar decides everything

Define, per world point, the **splat weight** `w(x, z) ∈ [0, 1]`:

```
d      = distance to the nearest capture pass (guardrail.py's `distance`, ported to TS)
w_env  = 1 − smoothstep(r_core, r_core + FADE, d)        the envelope, softened
w_have = 1 if the covering tile is resident, else 0      never blank the world for a missing tile
w      = w_env · w_have
```

`r_core` comes from `corridor.json`'s own `radius_m` (what the capture actually saw), and `FADE` is
a knob (~15 m: half a second at 30 mph, long enough not to snap, short enough not to be a smear).
The height band clamps it too, so a splat corridor does not swallow the world above a bridge.

Everything else is a consumer of `w`:

| layer | at `w = 0` | at `w = 1` | how |
|---|---|---|---|
| splat tiles | not drawn | full | per-tile opacity multiplier in the splat material |
| terrain + strip | full | hidden | dither in the existing terrain/strip shaders |
| road surface + markings | full | hidden | same dither (the splat has the real road in it) |
| buildings, trees, furniture, walls | full | hidden | per-instance: skip inside, dither in the band |
| grass | full | hidden | it is regenerated per tile anyway — `w` is one more rejection |
| **sky, horizon, weather** | full | **full** | a splat's sky is garbage; keep ours |
| **collision, ground, edgeDistance** | live | **live** | never faded — the splat carries no physics |

The last two rows are the important ones. The car drives on the bake at all times; the splat is a
skin. That also means a splat corridor can be attached, moved or removed without touching anything
that decides where the car can go.

### 3.2 Dither, not alpha

The viewer already dissolves tree impostors with a screen-door dither *because* 35k camera-facing
quads cannot be depth-sorted (`scene.ts`, `refreshFar`). The same reasoning applies with more
force here: a splat tile is hundreds of thousands of alpha-blended gaussians. So the crossfade is
a dither on the procedural side and an opacity ramp on the splat side, and there is never a blend
order to get wrong.

### 3.3 The trap: `logarithmicDepthBuffer`

`main.ts` builds its renderer with `logarithmicDepthBuffer: true`. A splat renderer that writes
ordinary depth will z-fight everything in the scene. This has to be settled before any of the rest
is worth building:

- **Spark** (`sparkjsdev`, WebGL2, three-native, reads `.spz/.sog/.ply/.ksplat`) is the candidate,
  precisely because its materials are three materials and can include three's
  `logdepthbuf_pars_vertex` / `logdepthbuf_fragment` chunks.
- **GaussianSplats3D** (mkkellogg) is the established one but is more of a self-contained viewer;
  its shared-scene mode would need the same patch with less leverage.
- The fallback is to turn log depth **off** and measure what it was buying (it predates the
  horizon-cut work; the near/far split may make it unnecessary now).

`probes/corridor-splatdepth.mjs`: a splat plane behind a known building must be occluded, and in
front of it must occlude — asserted on pixels, not on hope.

---

## 4. What streams, and what it costs

A `.spz` for a 200 m cell of dense capture is order 5–30 MB. At 50 km/h a cell is 14 seconds. So
the splat stream is the imagery stream with different numbers:

- want = tiles whose `bounds_enu_m` (transformed) are within `SPLAT_LOAD_M` (~400 m) of the eye
  **and** whose envelope is within `r_core + FADE` of somewhere the camera can reach;
- nearest-first, at most two in flight, a byte budget (`SPLAT_BUDGET_MB`, start at 512 on desktop);
- evict beyond `SPLAT_KEEP_M`;
- a tile that fails or is missing sets `w_have = 0` for its cell, so the built world simply stays —
  **the failure mode of the splat layer is the world we already have**, which is the whole reason
  to keep the procedural layer alive underneath.

The existing `gradeNear` pump is the right place to hang decode work, since it already knows how to
spend a bounded slice of each frame and never blocks on a frame that a hidden tab will not deliver.

---

## 5. Where it lives

Splat worlds are **not** part of a site bake — they are a separate capture with its own cadence:

```
tools/corridor/data/splats/<world>/          world.json, corridor.json, route.json, tiles/*.spz
tools/corridor/data/sites/<site>/splats.json authored: which worlds, the fitted transform, knobs
```

`splats.json` (authored file, same family as `adjustments.json`, so the world editor can write it):

```json
{ "version": 1,
  "worlds": [{
    "id": "arrowhead-2026-09",
    "base": "/splats/arrowhead-2026-09/",
    "fit": { "dx": 0.0, "dy": 0.0, "dz": 0.0, "yaw_deg": 0.0,
             "rms_h_m": 0.0, "rms_v_m": 0.0, "camera_height_m": 2.1, "fitted": "2026-09-27" },
    "fade_m": 15, "core_scale": 1.0, "enabled": true }]}
```

The `fit` block is written by the fitter and carries its own quality numbers, so a bad attach is
visible in the file rather than only on screen. `?splats=off` and a layer toggle turn the whole
thing off; the viewer must be exactly as it is today with the file absent.

---

## 6. Conversion and the cluster

`merge.py` writes `.ply`. Two pieces are needed:

1. **`.ply` → `.spz`** (Niantic's format, ~10× smaller than raw PLY, which is what makes streaming
   over the tunnel plausible). Either `splatpipe export --spz` or a small `tools/corridor/splats/`
   converter; it belongs in gaussworks, next to `merge`.
2. **A far LOD.** gaussworks' README lists the LOD hierarchy as the next milestone. Driving needs
   less than a flythrough does: the current cell plus its ring at full detail, and a decimated
   (say 1/8) version for the next ring so the corridor ahead is not a wall of nothing. Decimation
   by opacity × scale is the usual choice and can be a merge-time flag.

The training itself is the cluster's job — gaussworks already pulls chunk work from a claim-based
queue on shared storage, which is exactly the shape the 8×GH200 box wants. That work is
independent of everything in this document and can start the moment the footage lands.

---

## 7. What to do with the footage when it arrives

The two halves do not block each other, and that matters because training is hours and the viewer
work is days.

**Track A — the capture (cluster).**
1. a config for Arrowhead Farms beside `configs/md-backroads.yaml` (bbox, camera profile, spacing);
2. `ingest` → frames + GPS; **check the GPS before anything expensive** — a neighbourhood under
   canopy is where GPS goes worst, and `poses`' spatial matching leans on those priors;
3. `chunk` → cells + per-chunk `corridor.json`; `poses`; `train`; `merge`;
4. `merge --prune-corridor` so floaters outside the observed envelope never reach the viewer.

**Track B — the seam (viewer), built against a synthetic world.**
Do not wait for real gaussians. A generated splat world — a few thousand coloured gaussians laid
along an existing site's road, written as a `.spz` with a hand-made `world.json` and
`corridor.json` — exercises every part of this design: the frame transform, the fit, the streaming,
the crossfade, the depth interaction, the probes. It also gives the probes something deterministic
to assert against for ever, which a photoreal capture never will.

Order: synthetic world → attach/fit → stream → seam → probes → then swap in Arrowhead and re-fit.

---

## 8. What a splat cannot do (and so what stays procedural)

Worth stating plainly, because it decides the whole layering:

- **no collision** — the bake is always the ground and the barrier;
- **one time of day, one season, one weather** — the capture is whatever the light was.
  A splat corridor will not change with the season picker. Options: accept it, colour-grade the
  splat toward the season's palette (cheap, crude), or capture more than once. Default: accept it,
  and *do not* fade the sky, the horizon or precipitation with `w`;
- **moving objects are smeared** — passing cars and people become ghosts; `merge`'s corridor prune
  removes the worst floaters, and masking (`splatpipe/mask.py`) exists for the rest;
- **no editability** — a splatted world cannot have a stop sign moved. Anything the editor places
  stays procedural and is drawn *over* the splat (so placements and furniture should be exempt
  from the fade unless a knob says otherwise).

---

## 9. Order of work

| # | step | done when |
|---|---|---|
| 1 | Spark in the scene, one static tile, log-depth settled | `corridor-splatdepth.mjs` passes |
| 2 | frame transform + `splats.json` + attach | a synthetic world lands where it was put |
| 3 | the fitter (ICP against the road network) + its numbers in the file | `corridor-splatfit.mjs` passes |
| 4 | tile streaming with a byte budget | `corridor-splatstream.mjs` passes |
| 5 | the seam: `w`, the dithers, the per-instance skips | `corridor-splatseam.mjs` passes |
| 6 | Arrowhead capture trained and merged | a real world attaches and re-fits |
| 7 | far LOD, colour grading toward the season, editor UI | — |

Steps 1–5 are viewer work against a synthetic world; 6 is the cluster; 7 is polish.
