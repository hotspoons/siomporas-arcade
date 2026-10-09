# The rig loop: 60 fps on the DC Beltway

**Status:** in progress, 2026-10-08. The numbers are from Rich's machine (Chrome, 1792 × 926 at
Display ▸ Detail = Low) over the dev bridge, with the test rig driving the outer loop and firing a
missile at the car ahead every 0.5 s through `dc-traffic-nightmare` (3,999 cars). The first runs
were at 25–28 m/s; Rich: *"to be more reflective of real world usage you need to get the car going
like 170–180 MPH, this is essentially a stage rally"* — the rig now asks for 78 m/s and the car
holds 65–75 on the straights.

Rich, 2026-10-08: *"go in a loop and see what gains we can make with this dc beltway level and
traffic … My goal is 60fps solid, most of what is left is CPU, some GPU."*

## How to repeat a run

```sh
APEX_BRIDGE=apex-dev just corridor-remote          # the app on :5186 against the deployed editor
APEX_ORIGIN=http://localhost:5186 node scripts/bridge.mjs --timeout 80000 --file rigrun.js
```

Inside a probe: `apex.rig.start({ speed, fireEvery, lane })`, `apex.rig.stats()`, `apex.rig.stop()`.
Turn `SCREEN_WAKE_LOCK` on first (see `AGENTS.md`). What to read:

- `apex.framePerf` — the last frame's CPU by section of `frame()`: weapons, traffic, game,
  waypoint, physics, dents, sky, world, map, shading, render.
- `corridor.site.nearPerf` — `world` split by layer: trees (plant / near / far / shadow), grass,
  water, stream, pyramid, the LOD pass, grading.
- `corridor.physics.stats()` — `stepMs`, `buildMs`, steps, bodies.
- `corridor.site.grass.perf` — `genMs`, `asmMs`, tiles made.
- `apex.governor` — the frame governor's scale and the last frame's CPU.
- `apex.perfMeter.read()` — the panel's percentiles.

The exact per-frame attribution that found everything below is a bridge probe that wraps these
calls and prints, for every frame over 14 ms, what it was made of. Keep doing it that way: the
sampling profiler's resolution on Chrome is too coarse for a 20 ms hitch.

## Where it started (baseline, same run)

| | speed | frame CPU p50 | p95 | p99 | max | frames > 33 ms / 20 s |
|---|---|---|---|---|---|---|
| baseline | 27 m/s | 16.6 ms | 32.3 | 43.2 | 53.4 | 34 |
| after this loop | 27 m/s | 9.1 ms | 11.7 | 13.3 | 26.7 | 0–2 |
| after this loop | 65–75 m/s | 8.6 ms | 11.5 | 13.0 | 15 | 0 |

The last 20 s window at speed, as the panel reads it: 59.6 fps, frame time p95 18.3 / p99 18.6 ms,
GPU p50 8.6 / p95 12.4 ms, 370 draw calls, heap 1.7 GB (was 3.1 GB before the dent and LOD fixes).
The one 67 ms frame in it was the rig putting the car back on the road after a crash (`place`
builds the heightfield tile under the wheels whole, by design).

GPU: ~6 ms p50, ~8 ms p95 at Low. The frame is now vsync-bound at the median and the tail is
within a frame; two or three frames in fifteen seconds still go past 14 ms (the list below).

## What was found, in order

1. **Fixed per-frame budgets on top of a full frame.** The grass generator (4 ms), the tree
   planter (3 ms) and the grading pump (6 ms slices) each spent their whole budget every frame
   whatever the frame cost. → The **frame governor** (`world/streamscale.ts`, `STREAM_*` knobs):
   `frame()` measures its own CPU and scales those budgets toward `STREAM_TARGET_MS`. p50 16.6 → 8.5.
2. **Physics heightfield tiles built whole**, 17–23 ms each, one frame every few hundred metres
   (`phys.build`). → Terrain samples the tiles ahead in slices (`PHYS_TILE_MS` a frame); the tile
   under the wheels is still built whole.
3. **Grass tiles could not be interrupted**: the deadline was checked after a tile, and a verge tile
   was 5–7 ms. → `generateSteps` yields a cell at a time.
4. **The per-road / per-block visibility pass** ran every frame at 1.1 ms. → runs when the level
   under the eye changes, the eye moves 40 m, or 20 frames pass.
5. **Simplified meshes kept every vertex.** The 5% car: 4,052 triangles over 101,532 vertices.
   Dents cloned and re-normalled all of them (7–19 ms a missile landing), forty dented cars held
   216 MB. → compact attributes (meshopt `compactMesh`), Uint16 index. The first version applied
   the remap twice (`compactMesh` renumbers in place) and produced NaN normals — check
   `maxIdx < verts` whenever this code is touched.
6. **A blast dented every car in its radius**, a dent nobody could see at the rim. → the nearest
   four.
7. **A replant rebuilt two whole indexes** (collision grid 3.0 ms, near set 3.3 ms) every 350 m. →
   the trees that left are dropped from both; the pump adds the new ones.
8. **Tree planter `invalidateRegion`** scanned all ~350k cached cells per arriving branch (11.8% of
   the main thread) and compared north against z. → visits only the box's cells. (d9afcd7)
9. **At 175 mph: the governor hunted** (scale back to 1 after 25 good frames, then halved) and never
   saw the grading pump's slices, which resume as microtasks inside the frame task. → steers to
   headroom; `budget.ts` counts the slices (`framePerf.offFrame`).
10. **Tree colliders**: `refreshTrees` stood up 300 trunks in one frame every quarter second at
    speed (3–5 ms). → queued nearest first, ten a frame.
11. **Shader compiles mid-run**, four programs and ~30 ms each time: a landed cash wad's fade
    materials were disposed and the next wad recompiled them; tracer, muzzle-flash and missile-flash
    materials likewise per burst; a traffic model's programs compiled on the frame its first car was
    drawn. → the fade, tracer and flash materials are pooled; car models compile in the background
    as they load (`TrafficLayer.warm` → `renderer.compileAsync`); a program's first spawn of an asset
    stays hidden for the frame or two its compile takes.
12. **A dent on a car that had just come into range cloned the full car** (it wears full geometry
    until the next ranking pass) and pinned it at full. → low detail on attach; `dentObject` swaps
    to the simplified copy first; the flush is budgeted at 1.5 ms a frame.
13. **The tree planter's cache trim** walked all 350k entries the moment the crescent finished
    (13 ms). → 4,000 entries a pump. And `adoptArriving` replanted per branch inside the cell's
    unit (a 237 ms stretch on a branch cell) → one replant per frame, from the frame.

## Ultra (2026-10-09)

Rich: *"I had that on low mode and switched it to ultra mode — can you see if there are any high
detail expenses we can find and fix?"* At Ultra on the 2560 × 1323 window the CPU was fine
(5.7 ms) and the GPU was 18 ms a frame (21 fps): 8–13 M triangles, pixel-bound.

What was found:

1. **Every car in 700 m drew at full detail** (118k triangles each; the jam in view was 8–13 M).
   → full detail within 220 m / the nearest 80 (`detail.ts`, Ultra and High); beyond that a car is
   forty pixels and the 5% copy is the same picture.
2. **three's logarithmic depth buffer writes `gl_FragDepth` in every shader, so early-Z is off
   renderer-wide**: every overdrawn fragment (leaves behind leaves, the ground under the road, cars
   behind cars) is shaded in full and then rejected. Flat-shading everything saved 8–12 of 16 ms;
   the trees' leaf shading alone was 4.8 ms. → a **reversed float depth buffer**
   (three's `reversedDepthBuffer` + `EXT_clip_control`; the default since 2026-10-09, `?depth=log` is the old path, and a browser without the extension keeps it). GPU at Ultra, same
   drive: **p50 18.4 → 7.6 ms, p95 23 → 11.4**. Four things had to move with it: a bare
   `THREE.Camera` in the water-probe pass (three calls `updateProjectionMatrix` on every camera
   now), a raw `gl.clearDepth` in the road cover (bypasses three's inverted clear cache), the
   skybox trick `gl_Position = p.xyww` (near plane under reversed-Z; `vec4(p.xy, 0, p.w)` under
   `USE_REVERSED_DEPTH_BUFFER`), and three's own render-list sort, which reverses the whole list —
   renderOrder included — so the dome drew last (custom sort comparators undo it). The pyramid
   tiles' polygon offset and the grass's sun-shadow bias flip sign. Still behind the URL
   parameter: without a post composer the canvas depth is 24-bit, and the float depth texture that
   makes reversed-Z precise over 60 km only exists on the composer's target.
3. **The car's reflection probe** re-rendered the scene on a third of all frames at speed
   (1048² cube, refresh 0.3 s, move trigger 25 m). → 512², 1 s, 60 m.
4. **Dents on full-detail cars** recomputed 160k normals (10 ms). → only the moved vertices'
   normals, from the faces that touch them (`Deformable.localNormals`).
5. The test rig's car is now a ghost to traffic and props (Rich: *"disable collision physics with
   the hero car too"*) — `RapierCar.setGhost`, on while the rig runs.

Measuring GPU by layer: hide/show toggles on `trees`, `grass`, `road`, `buildings` are undone by
`updateNear` every frame (it re-shows them from `userData.layerOn`) — flip the flag, not `visible`.
Paired A/B while driving drifts with the scenery; alternate frames (odd with, even without) or stop
the car. `apex.screenshot` now reads the frame loop's own render: a render made from the bridge
between frames inherits a probe's scissor and lies.

## Direction of travel (2026-10-09)

Rich, after playing through at Ultra: *"I was racing renderer budgets, and often on the freeway I
would outpace the tile renderer and it would never catch up; though I would drive across the next
tile and it would already be rendered … render budgets need to be focused in the direction of
travel."* Every builder ranked by distance to the eye in a disc, became eligible only within
`STREAM_BUILD_M` (100 m) of it, and the governor had them at 15%. Now the grading pump, the
pyramid's loads and the physics tiles rank by a **focus** `STREAM_LEAD_S` (3 s) of travel ahead of
the eye (the eye's own velocity; the eye itself at rest), the governor floor is 0.3 and its target
13 ms. `graded().unfinishedHere` counts the units covering the eye that are still being built —
the number a run at speed wants at zero; `aheadrun.js` (scratchpad) samples it per frame with
`STREAM_LEAD_S` 0 against 3.

Measured, then corrected. The first cut ranked everything by distance to a point 230 m ahead,
which put the cell under the wheels *outside* the build window: 20% of frames on unfinished
ground against 0.5% with no lead. The rule that works: a unit whose circle covers the eye is
always first; a unit ahead is credited with how far ahead it is, up to the lead; a unit behind
counts three times as far. Then the lead itself: a dense 1 km cell is ~7 s of pump work (twenty
branch units of ~25 ms plus the street and the buildings) and the pump gets ~1.8 ms a frame at
the governor floor, so a 3 s lead starts it too late. On the same dense stretch (s 27.5–31 km,
74 m/s): lead 3 s → 5.3% of frames unfinished, 7.3 units pending; **lead 8 s → 0.2%, 2.3
pending**. The pyramid tiles were never late (`tileBelowWantedFrac` 0 throughout) and keep a 2 s
focus, as do the physics tiles. Two things that did NOT help, for the record: slices in
`requestIdleCallback` (a 12 ms main thread has no idle time Chrome admits to) and slices yielded
through a `MessageChannel` (twice the pump's frame cost at the floor, wall/work unchanged — a
branch unit's 150 ms of wall time per 25 ms of work is awaits inside the unit, not the yield).

## What is left (measured, not yet fixed)

| cost | where | what to do |
|---|---|---|
| 16 ms, on a cell with water arriving | `nearPerf.water`: the water layer merges a whole per-look bucket (every stream seen so far) when a cell adds to it | bucket per (look, 1 km cell) so a merge is one cell's geometry |
| 2–7 ms, on a replant that evicts a kilometre of woods | `nearPerf.treesPlant`: the leavers' drops from the collision grid (`grid`, 7 ms for 19k) and the impostor reseat; the walk itself is per block now (below) | drop a whole block from the grids at once instead of a tree at a time |
| 2–3 ms/frame at speed | `physics.stats().parts.terrain`: the sliced tile sampling at `PHYS_TILE_MS` — by design, the ring must keep ahead of 75 m/s | the graded-ground raster from the bake (below) makes a tile a copy |
| 4.5 ms/frame CPU at Ultra | `fp.render`: 500–780 draw calls submitted (traffic at full detail is a draw per part per car) | instanced traffic; merge street furniture per cell |
| reversed depth | 24-bit canvas depth when post AA is off; shadow, mirror and probe targets untested for z-fighting at distance | a RenderPass + OutputPass composer with a FloatType depth texture whenever reversed is on; then make it the default |
| 6–11 ms, rare | `nearPerf.pyr`: `PyramidStream.update` on a tile landing (select, diff, release, fetch) | profile `select`/`diff`; move the quadtree walk to the decode worker |
| 10–12 ms, rare | `render` on the frame a pyramid tile's JPEG texture first draws (upload + mipmaps of a 4096² RGBA) | the bake now writes a KTX2 twin per tile and the viewer takes it (below); to be re-measured on Rich's card on a re-baked site; `renderer.initTexture` on arrival is still open |
| 1.5 ms/frame | `physics.update`: 2 steps × 0.7–0.9 ms with 4,300 bodies; the step cost does not track the traffic bodies enabled | `PHYS_HZ` 60 when the frame is over target; measure what the step spends on with the Rapier profiler |
| 1.1 ms/frame | `traffic.tick`: `place` walks all 4,000 cars a frame | a coarse grid so only cars near the draw radius are visited |
| 2.2 ms/frame | `render` CPU: ~590 draw calls | instanced traffic (one draw per model, not per car); merge static street furniture per cell |

## For the bake (precompute, next run)

- **Graded ground raster per pyramid tile.** The physics heightfield and the terrain strips sample
  `physGroundAt` at run time — the DEM with the road grading folded in — at ~4 µs a sample. The
  bake knows every road's grade; writing the graded DEM into each tile (or a second channel) makes
  a physics tile a copy, not 4,225 samples, and the strips a lookup.
- **Pyramid imagery as KTX2** (the tile format already supports it): no JPEG decode, no upload
  spikes, a quarter of the GPU memory. Done 2026-10-10 (below).
- **Grass eligibility per cell** (road distance, canopy, slope, shelf, zone): the generator asks
  the same five questions of the same ground every time a tile is planted. A per-tile bitmask from
  the bake leaves only the per-blade jitter at run time. Measured 2026-10-10 and NOT built — the
  questions are a quarter of a 2.5 ms generator; below.
- **Tree records per 1 km cell** so a replant is a cell swap, not a walk over every record.
  Done 2026-10-10, viewer-side (below): the bake never held tree records, the viewer grows them
  from the canopy raster, so the cell is the planter's.

### What landed: the graded ground raster (2026-10-09, branch `agent/graded-dem`)

The first item is done. `tools/corridor/corridor/grade.py` is `scene.ts`'s `gradedHeight` read out
line by line into numpy — the station field every 5 m with the 7 × 7 cell walk, `edgeDistance`
(lateral inside the ±3.5 m band, radial outside, so a lone station is a disc), three's centripetal
Catmull-Rom with its arc-length table (checked against three.js to 1e-9 m in `test_grade.py`),
`taperedLanes`, `pavedWidth`/`pavedOffset`, the junction meet, authored and geometric dead ends
with their bulbs, driveway and stub stations, `stripEdgeLimitAt`, the 0.6–7 m blend. `pyramid.bake`
runs it over every z13 and z14 tile (pixel ≤ 6 m; a z12 pixel is 9.6 m and cannot hold a 7 m
verge) and writes the result as `dem.png`, the sampled earth beside it as `bare.png`, and
`layers.pyramid.graded = true`. The viewer (`PyramidSet.bareAt`, `scene.ts` `gradedBake`) then
reads `physGroundAt` and the strip heights straight from the raster and asks `bareAt` for the
deck tests. An older bake has no flag and runs exactly the code it ran before.

Two things the measurement forced, both by design rather than by moving the targets:

- **The bake decides what is a deck, and says so.** The viewer flagged a station "elevated" at
  boot against whatever earth it held — the 8 m overview for everything outside the home
  kilometre — and the deck colliders, the strips and the formula all followed that guess. On a
  graded bake the raster under an elevated station is the earth, so the guess and the bake had to
  be one decision or a bridge approach has ground in neither. `grade.RoadModel.annotate_decks`
  writes the runs (`spine.elev_s`, `branches[].elev_s`) into the manifest and `addStations`
  takes them when present. And it decides in RUNS: OVERPASS_CLEAR_M is 3 m and Route 3 rides a
  3 m embankment, so against the 1 m DEM the flag flipped station by station along it; a deck is
  now at least three stations and a gap of up to two is still the deck (`_smooth_runs`).
- **Driveways stand on the bake's own z.** `_service_ways` writes every driveway and stub point's
  height from the 1 m DEM, and the viewer laid its driveway stations on the earth it held at boot
  instead — the 8 m overview for most of a site. A stub on Route 3 landed 3.5 m above the ground
  it stands on with a 40 m verge graded up to it, and 546 of the 743 points over 10 cm were
  that. On a graded bake both sides use the manifest's z.
- **A station with no direction is a 160 m plateau.** A stub of Lavender Cliff Way ends on two
  coincident shape points, so `addDriveways` gave its last station a (0, 0) tangent; `along` is
  then 0 for every point in the 7 × 7 walk, every point is "in the band", `lat` is 0 and d is
  −half up to 80 m away — 3.5 m of ground graded over the fields beside Route 3, 160 m across, in
  every bake this viewer has drawn. Both sides now take the direction from the nearest distinct
  point. This one is a viewer bug fix that reaches old bakes too, and the only such change.
- **A raster cannot hold a step.** Where two carriageways at different heights stand within a
  pixel of each other the formula is discontinuous, and a bilinear read smears the step over one
  2.3 m cell: 1.44 m measured beside Route 3 at s = 2840, where a branch runs 2.7 m below the spine
  four metres away — the written pixels there equal the formula at every pixel centre, the
  *read* between them does not. So a sample whose four pixels span more than `RASTER_CLIFF_M`
  (0.5 m) is computed, not read (`PyramidSet.cellSpanAt`). The cost returns only at cliffs.

**Measured** (`probes/corridor-gradedraster.mjs crofton-triangle-graded --compare`: the same
graded bake loaded twice, `?grade=runtime` against the raster, 69,940 points on and beside every
road, each sampled only once its leaf tile was resident, with a 12 m shifted control that must
disagree):

| class (by the viewer's own `edgeInfo.d`) | n | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| past every road's verge (the formula answers null) | 13,480 | 0 | 0 | **0.0000** | 0.0000 |
| the rest of the verge, 7 m < d ≤ 40 m | 12,238 | 0 | 0.0006 | **0.0077** | 0.073 |
| the blend, 0.6 m < d ≤ 7 m, carriageways | 22,898 | 0.0083 | 0.029 | **0.083** | 0.338 |
| on a carriageway's pavement, d ≤ 0 | 13,693 | 0.0015 | 0.0035 | **0.0315** | 0.300 |
| on a deck (road 3 m over the earth) | 135 | 0 | 0 | **0.012** | 0.012 |
| answered by a driveway station, on its pavement | 986 | 0.007 | 0.070 | 0.246 | 0.909 |
| the control: raster against the formula 12 m away | 69,940 | 0.269 | 1.15 | 3.44 | 8.71 |

By the probe's own grid classes (lateral offset from the sampled road): pavement p99 **2.4 cm** on
carriageways (127 of 11,176 over 2 cm), blend 8.8 cm, verge 3.8 cm, beyond 3.7 cm (every one of
those "beyond" points is inside another road's or a driveway's verge — by the viewer's `d` the
ground past every verge moved by exactly nothing), deck 1.2 cm. The cliff rule took the formula at
3,870 of the 69,940 points.

Against the targets (2 cm pavement, 10 cm verge, nothing beyond the verge or on a deck): verge,
beyond and deck are met; the pavement p99 is 2.4 cm rather than 2 — the 127 points over are the
mouths of driveways, which are 3.6 m wide on a 2.3 m raster, so the pixel centres under a mouth
belong to the road and the sliver between them to the driveway, and the viewer's own formula
steps 0.3–0.9 m there (a driveway is laid on the DEM, the road it meets is graded 0.9 m above
it). A raster of this resolution cannot hold a feature narrower than two pixels; the fix that
would make both agree is for a driveway to rise to meet its road, which is a change to the
formula and not to this port. The starting point, before the three decisions above, was a
pavement p99 of 6.95 cm and maxima of 3.4 m in every class.

The port itself was also held against the viewer's formula on the SERVED crofton-triangle bake
(1038 branches, the junction meet live: 1106 junctions met, 587 warped, largest step 8.95 m — the
viewer's own counters and the port's agree exactly), 121,495 points, the viewer's own earth as the
DEM term: p50 = p90 = 0.0000 m everywhere, and p99 = 0.0000 m over the 61,579 points whose answer
the viewer itself determines. The rest is the viewer's: 9,838 points answered by a driveway
station laid on the boot-time earth, and 50,078 whose nearest station sits within a metre of the
3 m deck threshold — because that bake's branch grades stand a median 1.5 m (p90 3.3 m) above
the 1 m DEM and 21,939 of its 93,835 stations are "decks", where a fresh export of the same site
puts road z on the DEM (median −0.01 m, 39 deck stations). That served bake's branch profiles are
off their ground; a re-export fixes it and the car stops riding deck colliders through the suburb.

**Bake cost** on crofton-triangle (427 branches in the on-disk intermediates): the export went
from 1:21 to 1:29 wall; the pyramid stage from 40 s to 54 s, of which ~9 s builds the station
field once and ~130 s of worker CPU grades 241 tiles (4.5 M pixels touched) across the pool.
`CORRIDOR_GRADE=0` turns it off.

**Not carried by the raster:** the editor's `ground_offset_m` adjustments (the viewer keeps
run-time grading on a site whose adjustments are active) and the `GRASS_LIFT_M` lip (default 0).
The knobs the bake grades with are tuning.ts's defaults.

Two things found on the way, both pre-existing: main's on-disk crofton-triangle intermediates
hold 427 branches while the served `web/manifest.json` (baked elsewhere on 2026-10-02) holds
1038, so a local re-export is a smaller world; and `export_branches`' on-read junction frame
repair converts an already-ENU `branches.json` a second time, putting every re-exported
junction ~1 km off its road (0 junctions met). And every probe in `probes/` that aborts
`/@vite/client` no longer boots under Vite 8.2 — the page never evaluates `main.ts`, with no
error. The new probe does not abort it.

**Both faults run down (2026-10-09, branch `agent/bake-blockers`), neither was what it looked like:**

- *The junctions were not converted twice; they were read about the wrong origin.* `junctions[].x/y`
  in spine_utm.json/branches.json are ENU about the origin the file was written with, and the file
  said only `"frame": "enu"`. crofton-triangle's vectors (2026-09-26) are about sites.json's centre,
  (354269, 4318567); its site.json (world editor, 2026-10-02) puts the origin at (355342, 4318965),
  1.14 km away, and `export_site` builds its frame from site.json. Measured on the on-disk file:
  under the manifest's origin the junctions sit 0.04 m from their roads; under site.json's, 1,082 m
  as-is and 1,068 m "repaired" — the on-read repair chose between two wrong answers. Now a junction
  is PLACED under the export frame from the node's lon/lat (`roads` writes it), or in an older file
  from the chain's own absolute-UTM polyline at `s`, and asserted onto the road
  (`network.place_junctions`, FrameFault past 1 m; the primary's and `intersections.py`'s go through
  it too). The scratch re-export of the on-disk site, twice: the two manifests byte-identical
  (7.97 MB), 1,038 junctions a median 0.028 m (max 0.070 m) from the raw polyline, and against the
  smoothed `coords` the same distribution the served bake has (median 0.050 vs 0.052 m, p90 1.63 vs
  1.71 m — the tail is the Gaussian smoothing on bends, in both). `tests/test_junction_frame.py`.
- *The served branch grades were not sampled from another DEM; they are the raw height.* Against
  main's dem_1m.tif the served branch z reads z − h: p50 −0.01 m, p90 0.10 m — and z − up(h):
  0.15 m within 2 km of the anchor, 0.65 at 2–4, 2.11 at 4–6, 3.34 at 6–9 km: d²/2R, the ellipsoid
  drop. The bake was exported on 2026-10-02; f208be9 (2026-10-06) is the commit that curved the
  vertical. Stale, and the next bake would not have repeated it — but nothing would have said so
  either, so the bake now measures its carriageways against the DEM before deciding the decks:
  `RoadModel.assert_grades_on_the_dem` (median over the non-deck stations within `GRADE_OFF_MAX_M`,
  0.5 m) is a `GradeFault`, which export.py and `corridor fetch` re-raise instead of printing
  "pyramid SKIPPED". On the served manifest it reads +1.28 m over 71,896 non-deck stations (23.4 %
  deck) and stops; the scratch re-export reads −0.013 m (|p90| 0.19 m, 0.1 % deck, 3 deck runs).
  `GradeOffsetTest` in `tests/test_grade.py`.
- *427 vs 1038 is the site, not a filter:* 421 of the on-disk 427 chain ids are among the served
  1,038; the served world is the editor's 5.26 km site (14.2 × 13.7 km DEM, primary MD 3/MD 450,
  NOAA 10311 lidar) and the on-disk intermediates are sites.json's 2.6 km Crofton Parkway entry
  (8.7 × 8.1 km). 404 of the 617 extra branches lie outside the Sep-26 footprint altogether.

### What landed: the tree records per block (2026-10-10, branch `agent/bake-phases`)

The fourth item, and it was never a bake change: the bake exports no tree records — `flora.py`
writes species and climate, and the viewer grows every tree from the canopy raster at run time
(`props.treesFromCanopy`) — so "records per 1 km cell" is the planter's own index. The planter
now keeps its records per world-aligned 100 m block (`BLOCK_M`), and `plantMoved` decides per
BLOCK: a block whose answers did not change is not visited, a block that fell wholly outside the
context ring is emptied in one go, a block that crossed the draw radius flips its trees' spare
flag together. The draw rim is blocky by ±70 m at 1,400 m out, where a tree is a pixel and the far
cards carry the woods; the context rim keeps a tree until its whole block is outside, never
sooner. The slot a tree holds, the near set, the collision grid and the impostor slots are
untouched — the patch note is the same shape, only shorter.

Two things the measurement found on the way. A streamed world replants far more often than
every `TREE_REPLANT_M`: every branch cell that arrives asks for one (`adoptArriving`), 65–86 in
forty seconds at 78 m/s on crofton-triangle, most of them with the centre barely moved — those
now walk nothing. And `plant()` itself still walked the array once more, `records.some(...)`
looking for a record without a cell, 0.5–1 ms over 42k that the block index had just saved;
a flag now.

Measured (`probes/corridor-bakephases.mjs crofton-triangle --phase cpu`, 78 m/s, 40 s, the
renderer stubbed so the loop runs at ~58 Hz on this box, 960 px wide so the site is the full
120k-tree budget):

| replant's `plant` part | n | p50 | p90 | p99 | max | records walked / held |
|---|---|---|---|---|---|---|
| before | 68 | 4.7 ms | 12.8 | 21.1 | 21.1 | 1.00 |
| after | 75 | **0.3 ms** | 1.6 | 4.0 | 4.0 | p50 0.01, p90 0.06, max 0.26 |

The walk itself (`treePlanting().movedMs`) is 1–2 ms only on the replants that cross a full
kilometre of woods (10–33k records in a block sweep after a jump); what remains of a heavy
replant is the leavers' drops from the collision grid (`grid`: 7 ms for 19k leavers, one tree at
a time) and the impostor reseat — the first row of "what is left". The probe's negative
(`--prove`, `TREE_REPLANT_M` at a billion metres) must fail its own checks; it does.

### Measured, not built: the grass eligibility mask (2026-10-10)

The third item was measured before it was baked, and the number says to leave it. The generator
now counts what its per-cell questions cost (`grass.perf.questionsMs`, `cellsAsked`,
`cellsRejected`, against `genTotalMs`, since boot), and the same rig run reads them: at 78 m/s on
crofton-triangle, 40 s, the questions — the road field, the canopy, the three ground reads for
the slope, the bare earth for the shelf — are **25 % of the generator**: 13.0 µs a cell on the
graded scratch bake (1,722 ms of 6,808), 14.7 µs on the served one (1,450 of 5,833), with 69–75 %
of the cells asked rejected. The generator itself is ~2.5 ms of a frame (`genMs` p50 2.4–2.8) and
is governed, so a mask that answered every rejected cell for free would hand back ~0.5–0.6 ms a
frame — and it could not answer them all: a 2.3 m pyramid pixel cannot say what a 1 m cell at a
kerb, a driveway mouth or a parking apron is without the run-time question being asked there
anyway, the mask would be baked for tuning.ts's defaults the way the graded raster is (a moved
`GRASS_SLOPE_MAX` or `GRASS_MAX_FROM_ROAD` then disagrees with it), and it would be a raster per
tile on the wire. On a graded bake the ground reads are already raster reads, which is where the
13 µs comes from. Not worth a bake format for; the counters stay so it can be re-measured when
the generator is next on the table.

### What landed: the pyramid's imagery as KTX2 (2026-10-10, branch `agent/bake-phases`)

`pyramid.encode_twins` writes a `.ktx2` (ETC1S, with its mip chain) beside every pyramid tile's
`.jpg` after the pool has written every level — the serial loop, the forked pool and a shard's
bake all land there — and sets `layers.pyramid.texture_ktx2 = "ktx2"` only when every jpg has a
twin. `PyramidStream` goes through the same `loadBakedTexture` the overview uses, prefers the
twin when the flag is there, and keeps the jpg path for an older bake (and for a twin that fails
to load — the fallback used to copy an image that had not arrived yet and never told the caller;
it loads into the caller's texture now). `pyramid().compressedHeld` against `photosHeld` says
which path a tab is on.

Cost on crofton-triangle: 271 tiles in 24 s wall (88 s of encoder CPU over eight processes),
17.0 MiB of jpg → 11.7 MiB of ktx2 on the wire, added beside the jpg: +13 MB on a `web/pyr` of
88 MB (the graded bake's `bare.png` twins are the rest of the scratch bake's growth, to 151 MB). Re-bake: `python -m corridor export <slug>` with
`ktx` on the path (`scripts/fetch_ktx.sh`, or `CORRIDOR_KTX`).

**Measured headlessly** (`probes/corridor-bakephases.mjs crofton-triangle-bp --phase ktx2`, a
scratch bake of crofton-triangle with the twins; the jpg-only copy of the same bake as the
control, on which the probe's "resident photos are ktx2" check must fail, and does): the one
operation the format changes, `renderer.initTexture` (decode done, upload + mipmaps) on twelve
leaf tiles, **jpg p50 1.7 ms, p90 2.2–3.0, max 4.0; ktx2 p50 0.1–0.2 ms, max 0.3** — swiftshader,
on this bake's 512² tiles, so a tenth of the operation, not the Beltway's 4096² on a card. The
per-frame `render` on a photo-arrival frame could not be told from the rest here (1.6 against
1.5 ms p50 at 320 × 200); the 10–12 ms frame in the table above is Rich's measurement and wants
re-reading on his card once a site is re-baked with the twins.

**The twin is stored bottom-up, and every earlier twin was mirrored.** three uploads the jpg with
`flipY` (row 0 at v = 1; the terrain's UVs put north at v = 1), a compressed texture cannot be
flipped on upload, and three's KTX2Loader ignores the file's orientation metadata — so a twin
written top-down, as `ktx create` does by default and as `ktx2.py` did, draws mirrored
north–south. Drawn through three's own loaders onto a quad and compared row by row
(`--phase orient`): correlation with the jpg −0.08, with the jpg reversed 0.906; with
`--convert-texcoord-origin bottom-left` at encode, 0.903 and −0.08. The overview, horizon and
flat-tile twins of every bake before this are mirrored the same way — the pyramid draws over the
overview near the eye, which is how it went unnoticed — and a re-export rewrites them. The viewer
did not change for it.
