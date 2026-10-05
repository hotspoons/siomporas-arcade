# Baking a large world in pieces: plan → shard → finalize

**Status:** Phase 0 (the two hangs) shipped. Phase 1 (plan → shard → finalize) shipped: the
corridor engine (`corridor plan|shard|finalize`, `corridor/shards.py`) and the worldeditor
orchestration (`runs.bake` fans plan → N shard Jobs → finalize above `shardAboveM`). Phase 2
(cluster-aware sizing) is partially shipped — shards spread by `topologySpreadConstraints`, request
sizing is still the one 384 Gi request.

Known gaps vs the sections below, all on the path to the first real run:

  * the shards write the per-block rasters, lidar, profiles and branches, but
    `export_tiles` / `pyramid.bake` / `overview` currently run in the FINALIZER
    over the merged site. That is the wrong side of the seam: the export reads
    the site's `dem_1m.tif` / `naip_1m.tif` and `lidar/`, and the finalizer does
    not yet merge the per-block root rasters into one (a 30 km NAIP merge is the
    2.5 GB raster the whole design exists to avoid). The right fix is the one
    §Phase 1 describes — each shard runs `export_tiles` / `pyramid.bake` for its
    own tiles and the finalizer only unions `web/tiles` + `web/pyr`. Until then,
    a sharded world's tiles/pyramid are not yet produced;
  * `overview` is a whole-region layer and is not sharded at all (Phase 0 made
    it strip-parallel and logged; that is its fix for now);
  * none of it has been exercised against a real large world yet.

## What this is

A `kind: network` bake is one Job. It runs `network.fetch_site` top to bottom over one bbox, one
corridor, one road graph, and writes one `sites/<slug>/` directory. That is the right shape for
Crofton (18 km, 147 s) and it is the wrong shape for the Capital Beltway, where the same function
runs for nine hours and then dies. This plan splits a large world into **shards baked as
independent parallel Jobs**, plus a small **plan** Job that fixes the global identity before them
and a **finalizer** Job that stitches the outputs back into one world. It does not change the
output format (`web/manifest.json`, `web/tiles/`, `web/pyr/`) and it does not rewrite the road
graph. The goal is that a world too big for one Job becomes N Jobs that each fit a node, and the
result is byte-comparable to the single bake it replaces.

## Why now

Two things make this urgent, and one of them is a ceiling we can already see.

The **first hang**: `network_tiles.profile_many` forks a `ProcessPoolExecutor(mp_context="fork")`
after the parent already holds ~120 threads (numpy/scipy OpenBLAS pools plus GDAL's). On the
optimized image, `dc-metro-take-2` sat idle — loadavg 0.01, 124 GiB current / 139 peak against a
384 GiB limit — with the parent and 32 children parked on futexes. The children are waiting on a
lock the fork inherited, and no amount of memory would have moved them. Fix direction: set
single-thread BLAS/OMP/GDAL (`OPENBLAS_NUM_THREADS=1`, `OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`,
`NUMEXPR_NUM_THREADS=1`, `GDAL_NUM_THREADS=1`) **before numpy loads**, so the only parallelism is
the process pool. Hardening option: hand the near-road cloud to a **spawn** pool through shared
memory, so no lock is ever inherited.

The **second hang**: `network_tiles.overview()` re-reads the full 1 m `dem_1m.tif`, `chm.vrt` and
`naip_1m.tif` through `rasterio.read(..., out_shape=...)` in one call, single-threaded, to produce
an 8 m whole-region picture. On the Beltway that stage was stuck past 3.4 h.

The **ceiling**: `tools/worldeditor/worlds.mjs` refuses a world over `MAX_M = 20000`, and `MAX_M` is
a HALF-WIDTH — the bake takes a square of side `2R`, so 20 km is a 40 km square and a 1600 km²
request. `validate()` says it plainly: "over the 20000 m ceiling — bake it in pieces." This plan is
the pieces.

## What is already shardable

Most stages are already per-area or per-tile; the work is proving it and giving each one an owner.

| stage | function | already independent because |
|---|---|---|
| DEM fetch | `dem.fetch_dem` → `dem.discover_1m` | queried per bbox; vintages are de-duplicated per 10 km `x{n}y{m}` tile (`_newest_per_tile`) |
| NAIP fetch | `network_tiles.naip_tiled` | windowed writes, only the 4 km service tiles touching the corridor; rastercache keys on bbox |
| lidar rasters | `network_tiles.lidar_tiled` | scatters points into 1 km `lidar/tiles/<x>_<y>.*.tif`, then `gdalbuildvrt` |
| tile export | `network_tiles.export_tiles` | one `web/tiles/0/<x>_<y>.pack` + `.naip.jpg` per 1 km UTM tile, disjoint ids, from site-level rasters |
| pyramid | `pyramid.bake` | one pack per geodetic `(z,x,y)`; `plan()` is a pure function of the bbox and is quad-closed |
| surface | `surface.measure` | per road-station (see the caution in *Open questions* — its inputs are not yet per-shard) |

Each of these already has the seam it needs; none of them is the reason a bake is one Job. The
reason is what comes next.

## What is global

A naive quadrant split breaks these, and each one has to be resolved **once**, before the shards,
or stitched **once**, after them.

- **The road graph.** `network.roads()` chains ways by connectivity and assigns `id = r{min OSM way
  id}`. The id is stable per chain, but a chain *split at a shard seam is not the same chain* — its
  geometry, its junctions, its `dead_ends` all change. A step run once over the whole region and
  written to the volume fixes identity for every shard.
- **The primary profile.** `profile.json` is one continuous `s`-keyed array over the primary chain
  (`network_tiles.profile_tiled`). Split at a seam it must be stitched by cumulative length, not
  concatenated.
- **Per-feature manifest arrays.** `export.py` builds barriers, signals, parking, power, sidewalks,
  driveways, stubs and dead ends from `osm.geojson`; at a seam a feature that spans the seam appears
  in two shards and must be de-duplicated by OSM id.
- **The DEM vintage.** Already per `x{n}y{m}` tile (`dem.discover_1m`), so two shards over the same
  tile get the same vintage — but only if the plan step resolves the tile set, so that claim must
  hold across the whole region rather than per shard bbox.
- **The ENU frame origin.** Every shard must emit coordinates relative to the **world centre**, not
  its own. `export.py` routes all site metres through `_enu`/`_enu_cols` from one `Frame`; the plan
  step hands every shard that origin, cheaply.
- **Quad closure.** `pyramid.plan()` closes each quad up to `root_level`. A parent whose four
  children land in four different shards must still see all four, or it freezes at its own coarse
  level (the trap `pyramid.py` records from trailworks).

## The architecture

### Phase 0 — do this first, sharding or not

Phase 0 is a prerequisite and is worth shipping on its own: it makes the single-node dc-metro bake
come in well under an hour and removes the two hangs.

**Measured on dc-metro-take-2, 2026-10-05 (single Job, Phase 0 image).** The first hang is gone:
the primary profile of the 62 km Capital Beltway took **5m04s** (it used to wedge for 210 min), and
all **9,794 branches profiled in 6m16s at ~26/s** with the main process at Threads 65 and loadavg
16–19 — the forked workers stayed busy instead of parking on an inherited lock. The second hang
(`overview`) and the tail are what the remaining watcher is for.

1. **Unfork the deadlock.** Set the single-thread environment before numpy is imported (in
   `corridor/__main__.py`, and in the Job env in `tools/worldeditor/runs.mjs` `#startJob` and
   `tools/corridor/chart/templates/job.yaml`). Then revisit `profile_many`: either keep the fork
   with a quiet parent, or move the cloud to `multiprocessing.shared_memory` and use a spawn pool.
   The parallelism is the pool; the BLAS threads were never the point.
2. **Parallelize `export_tiles`.** It is a `for tx, ty in tiles` loop (`network_tiles.export_tiles`)
   where every iteration reads disjoint windows and writes disjoint files. Fan it out across a pool
   exactly as `profile_many` fans out branches — the per-tile seam already exists.
3. **Parallelize `pyramid.bake`.** Same shape: a `for i, t in enumerate(tiles)` loop writing
   `web/pyr/<z>/<x>_<y>.{pack,jpg}`. Its one shared object is `_OPEN` (the open source datasets);
   give each worker its own dataset handles.
4. **Fix `overview`.** Two directions, in preference order: (a) build the coarse picture from the
   2 m `web/tiles/0` packs or the pyramid leaves already on disk, instead of re-reading the 1 m
   VRTs; or (b) keep the 1 m source but read it in row bands across a pool and stitch. The current
   `read()` (`network_tiles.overview`) issues one `src.read(out_shape=...)` over the whole bbox.

Expected, to be measured and recorded: dc-metro (28.8 × 28.7 km, 514.1 km², 10,137 branches) under
an hour on one 72-core node.

### Phase 1 — plan → shard → finalize

**The plan Job** (one small Job, minutes). It resolves the boundary → bbox → ENU frame, runs
`network.roads()` once over the whole region, and then `network.dead_ends()` once (a dead end is a
property of the whole graph, and it must not be re-judged per shard). It assigns the work:

- **Chains** to exactly one shard each, whole, by the shard that owns the majority of the chain's
  length. A chain is never split — that is what preserves `id`.
- **1 km tiles** to exactly one shard each, disjoint, by the shard whose block contains the tile.
- **The DEM tile set** across the region, so the vintage claim holds world-wide.
- The world ENU origin, the `world`/`tiled` flags, and the padding margin.

It writes `plan/roads.json` (the chains with ids, junctions, dead ends) and `plan/shards.json` (the
shard list, each shard's block, its tiles, its chain ids) to the volume. Identity is now fixed; a
shard cannot renumber or re-split it.

**The shard Jobs** (N parallel Jobs). Each reads `plan/roads.json` + `plan/shards.json` for its
index and, for its own chain and tile set only:

1. clips its block with a **profile padding margin** (`PROFILE_PAD_M`; a hypothesis, but it must be
   at least the lidar half-width 150 m plus `BAND_M = 15 m` plus room for the smoothing window, so
   start at ~300 m) so a chain that exits the block still has rasters at its end;
2. runs DEM (`dem.fetch_dem` over the block), NAIP (`naip_tiled`), lidar (`lidar_tiled`), the
   primary profile (`profile_tiled`), branch profiles (`profile_many`), `export_tiles`,
   `pyramid.bake` — the same calls `fetch_site` makes, scoped to its own tiles;
3. writes `shards/<i>/` (mirroring the `sites/<slug>/` layout: `spine_utm.json`, `branches.json`,
   `profile.json`, `lidar/`, `web/tiles/0`, `web/pyr`).

Each shard is a Job sized to a memory budget (Phase 2), started by the same ServiceAccount.

**The finalizer Job** (one Job, minutes). It reads every `shards/<i>/` and writes `sites/<slug>/`:

- **Union the tile and pyramid directories.** Tiles are disjoint by construction; copy packs and
  textures into one `web/tiles/0` and `web/pyr`. De-duplicate by `(x,y)` / `(z,x,y)`.
- **Concatenate disjoint branches.** Every non-primary chain belongs to one shard, so
  `branches.json` is a concatenation with no overlap.
- **Stitch the primary profile by cumulative `s`.** Offset each shard's slice by the length of the
  primary before it, then concatenate `s`, `road_z`, `ground_rel`, `canopy` and structures, and
  re-run `_fill_along` on the seams (`network_tiles._fill_profile`).
- **De-duplicate features by OSM id.** Barriers, signals, parking, power, sidewalks, driveways and
  stubs are rebuilt from `osm.geojson` (`export.py`); merge by OSM id, not by position.
- **Re-run quad closure on the union.** Take the union bbox, call `pyramid.plan(union, zmax,
  zmin)`, and emit any tile no shard produced as the empty marker `pyramid.bake` already writes
  (`entry["empty"] = True`, no pack) so every parent quad is complete.
- **Write `web/manifest.json`** through `export.export_site` over the merged `sites/<slug>/`, then
  `export.write_index(sites/index.json)`; optionally `publish.publish`.

| | today | after |
|---|---|---|
| unit of work | 1 Job, 1 site | 1 plan Job + N shard Jobs + 1 finalizer Job |
| road identity | decided during the bake | decided once, in the plan step |
| branch profiles | one serial/one-fork pass | N independent passes |
| failure domain | the whole bake | one shard |
| ceiling | `MAX_M = 20000` half-width | the volume and the scheduler |

### Phase 2 — cluster-aware submission

- **Size shards to a memory budget** (start ~64 GiB each: the observed peak on the 384 GiB run was
  139 GiB, and `surface.measure` and the lidar assembly are the two spikes), then submit all.
- **Spread across nodes.** Nothing in `runs.mjs #startJob` sets any anti-affinity, and Kubernetes
  packs. Add `topologySpreadConstraints` on `kubernetes.io/hostname` (labelSelector on the run's
  own label, `maxSkew: 1`, `whenUnsatisfiable: ScheduleAnyway`) to each shard Job, or the eight
  shards land on one 573 GiB node and the whole exercise is a slower single bake.
- **Raise or remove `MAX_M`.** Once shards exist, the 20 km ceiling in `worlds.mjs` is the editor
  refusing a world the backend can actually bake; replace the error with the shard count and the
  area estimate.
- The `worldeditor` ServiceAccount already has exactly the verbs this needs for `batch/jobs`
  (`create`, `get`, `list`, `watch`, `delete`) plus `pods` and `pods/log` — see
  `tools/worldeditor/chart/templates/rbac.yaml`. No new grant is required to start N Jobs.

## Seams and correctness

| seam | risk | resolution |
|---|---|---|
| chain identity | a chain cut at a seam is a different chain | assign whole chains to one shard in the plan step |
| primary profile | split `s`-keyed arrays | stitch by cumulative `s`, then `_fill_along` |
| features | a seam feature appears twice | de-dupe by OSM id |
| DEM vintage | two shards pick different vintages of one tile | plan the `x{n}y{m}` tile set once |
| frame | a shard emits coordinates about its own centre | hand every shard the world ENU origin |
| quad closure | a parent with children in four shards freezes | finalizer re-runs `plan()` on the union, emits empty markers |
| profile padding | a boundary chain's last stations have no rasters | fetch the block plus `PROFILE_PAD_M` |

## Acceptance / spike

Prove it on a **2×2 split of the dc-metro world** and diff it against the current single bake,
tile-by-tile. This is the whole point of the plan: sharding is only correct if the stitched world is
the world a single bake would have written.

Specific assertions:

1. **Packs are byte-equal.** For every `(x,y)`, the `.pack` bytes from the finalizer equal the single
   bake's, or the decoded rasters (`dem`, `chm`) match to the encoding's own quantum (`zscale`,
   0.25 m) where the source window differs.
2. **Textures match.** Every `.naip.jpg` decodes within a mean-absolute luma tolerance of the single
   bake's.
3. **Pyramid is complete.** `(z,x,y)` set from the finalizer equals the single bake's set; no parent
   in the finalizer is missing a child the single bake had.
4. **Branches are disjoint and complete.** Union of shard branch ids equals the single bake's; no id
   is duplicated; per-branch `coords` and `profile.road_z` match within a metre.
5. **Primary is continuous.** Len of stitched `profile.s` equals the single bake's within one
   `STEP_M`; `road_z` is monotone across each seam within the smoothing tolerance; no seam value is
   an outlier against its neighbours.
6. **Manifest is feature-complete.** No barriers/signals/parking/power/sidewalks/driveways/stubs id
   is lost or doubled against the single bake.
7. **Frame holds.** A sampled branch coordinate from a shard placed back through the single bake's
   `Frame` lands at the same ENU metres as the single bake's coordinate for that chain.
8. **`corridor.verify` passes** on the merged site, and `scene.ts` loads it with no "site has no DEM
   layer" and streams it.

The spike is a 2×2 because four shards is enough to exercise every seam (a horizontal, a vertical
and a corner) without the cost of a full eight-node run.

## Open questions / risks

- **Is `surface.measure` per-shard?** The stage is per road-station, but reading `surface.py` it is
  not yet per-shard: `measure()` loads `spine_utm.json`, measures against the **primary** spine
  `sp["coords"]`, and reads the **whole** `lidar/corridor.laz`. Its station `s` is primary-relative
  and its `lanes_at`/`osm_surface_at` read the primary's `segments` `s_start`/`s_end`. So a shard
  must either carry the primary's full spine and cloud (defeating the point) or `surface.measure`
  must grow an offset/stitch path like `profile.json`. Treat the "already shardable" claim above as
  a hypothesis to verify before Phase 1, not a fact.
- **How does the viewer consume `manifest.json`?** `export_site` writes one manifest with `layers`,
  `spine`, `branches`, `crossings`, `surface`, `buildings`, `flora`; the finalizer must reproduce
  that contract exactly, and
  `sites/index.json` must be rewritten (`write_index`). If the viewer keys anything off file
  mtimes or a single `manifest` revision, the merge changes it.
- **Is `roads()` over the whole region cheap enough?** The Beltway's roads/osm was ~20 s in the bake
  log and Overpass is cached by query SHA-1 under `data/cache/overpass/`, so yes — but that is a
  measurement, not a guarantee, for a continental bbox. The plan step should cache and record it.
- **Are `export.py`'s per-feature arrays area-independent?** They are rebuilt from `osm.geojson`,
  which `write_vectors` clips to the region, so a shard's `osm.geojson` must be the union of the
  region's features, not its block's. That is a plan-step / finalizer question, and the current code
  derives some features against the **site box** — verify each builder.
- **`PROFILE_PAD_M` is a guess.** It has to be at least the lidar band; the spike's assertion 5 is
  what will set it.
- **`overview` after sharding.** If overview is built per shard, the finalizer needs to re-stitch a
  whole-region overview; if it is built by the finalizer, it is the same 1 m read problem at world
  scale. Phase 0's fix (build from tiles/pyramid) largely dissolves this.
- **The `world` flag and the global canopy.** `fetch_site` fetches `canopy_global.tif` per shard
  over `bbox`; the finalizer must merge these or re-fetch once. Hypothesis: fetch once, in the plan
  or finalizer step, and have shards read the shared raster.

## What we are NOT doing yet

- **Not rewriting the road graph.** `roads()`, `_chains`, junctions and `dead_ends()` stay as they
  are; the plan step calls them unchanged over a bigger bbox.
- **Not changing the output format.** `web/manifest.json`, `web/tiles/0`, `web/pyr`, the site frame
  and `sites/index.json` are the contract; sharding is behind them.
- **Not moving off the RWX claim.** Everything lands on the shared `worldeditor-data` PVC at
  `/data`; no object-store-first rewrite, no distributed filesystem.
- **Not deleting the single-Job path.** A small world still bakes as one Job (Crofton is 147 s);
  sharding is opt-in above a size threshold.
- **Not solving the streaming viewer.** That is `PLAN-STREAMING-WORLD.md`; this plan only makes the
  bake that feeds it finish.
