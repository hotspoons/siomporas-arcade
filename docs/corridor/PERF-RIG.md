# The rig loop: 60 fps on the DC Beltway

**Status:** in progress, 2026-10-08. The numbers are from Rich's machine (Chrome, 1792 × 926 at
Display ▸ Detail = Low) over the dev bridge, with the test rig driving the outer loop at 25–28 m/s
and firing a missile at the car ahead every 0.5 s through `dc-traffic-nightmare` (3,999 cars).

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

| | frame CPU p50 | p95 | p99 | max | frames > 33 ms / 20 s |
|---|---|---|---|---|---|
| baseline | 16.6 ms | 32.3 | 43.2 | 53.4 | 34 |
| after this loop | 9.1 ms | 11.7 | 13.3 | 26.7 | 0–2 |

GPU: ~6 ms p50, ~8 ms p95 at Low. The frame is now vsync-bound at the median and the tail is
within a frame.

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

## What is left (measured, not yet fixed)

| cost | where | what to do |
|---|---|---|
| 6–15 ms, every ~350 m and on reseats | `nearPerf.treesPlant` / `treesNear` / `treesFar`: `t.plant` walks every record (2–4.6 ms); `near.update` sorts candidates and writes instance matrices; `refreshFar` rebuilds the impostor instances | slice `plantMoved` over frames; cap the reseat to the slots that changed; rebuild the far cards per changed region |
| 3–4 ms on busy frames | grass `genMs` overshooting its share | the first cell of a verge tile builds the 0.5 m mask lattice (361 `blockedAt` calls) — yield while building it, or build it from the sidewalk/parking bounds directly |
| 6–11 ms, rare | `nearPerf.pyr`: `PyramidStream.update` on a tile landing (select, diff, release, fetch) | profile `select`/`diff`; move the quadtree walk to the decode worker |
| 10–12 ms, rare | `render` on the frame a pyramid tile's JPEG texture first draws (upload + mipmaps of a 4096² RGBA) | KTX2 (GPU-compressed, pre-mipped) tiles from the bake; `createImageBitmap` off-thread; `renderer.initTexture` on arrival |
| 1.5 ms/frame | `physics.update`: 2 steps × 0.7–0.9 ms with 4,300 bodies; the step cost does not track the traffic bodies enabled | `PHYS_HZ` 60 when the frame is over target; measure what the step spends on with the Rapier profiler |
| 1.1 ms/frame | `traffic.tick`: `place` walks all 4,000 cars a frame | a coarse grid so only cars near the draw radius are visited |
| 2.2 ms/frame | `render` CPU: ~590 draw calls | instanced traffic (one draw per model, not per car); merge static street furniture per cell |

## For the bake (precompute, next run)

- **Graded ground raster per pyramid tile.** The physics heightfield and the terrain strips sample
  `physGroundAt` at run time — the DEM with the road grading folded in — at ~4 µs a sample. The
  bake knows every road's grade; writing the graded DEM into each tile (or a second channel) makes
  a physics tile a copy, not 4,225 samples, and the strips a lookup.
- **Pyramid imagery as KTX2** (the tile format already supports it): no JPEG decode, no upload
  spikes, a quarter of the GPU memory.
- **Grass eligibility per cell** (road distance, canopy, slope, shelf, zone): the generator asks
  the same five questions of the same ground every time a tile is planted. A per-tile bitmask from
  the bake leaves only the per-blade jitter at run time.
- **Tree records per 1 km cell** so a replant is a cell swap, not a walk over every record.
