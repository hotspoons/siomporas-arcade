# The monoliths: what the game still loads whole

**Status:** plan, 2026-10-08. Nothing here is built yet. It lists what is left to break up, with
measurements, and the order to do it in.

Rich, 2026-10-08: *"That is yet another thing that needs to be decomposed and moved to tiles. This
will be a good tell how many monoliths we have left."* And: *"On the monoliths can you write up a
plan in a doc in the repo so we can implement it later?"*

## What a monolith is

A monolith is data the game loads **whole**, or keeps for the whole session, no matter where the
player is. Every player pays for it up front in download, parse time and memory, even if they only
ever see one corner of the world. Most of a world already streams: terrain through the pyramid, and
buildings, furniture, branches, water, landuse and POIs per 1 km vector cell (`PLAN-WORLD-SCALE.md`
§ "Where we are"). The items below are what is left.

All numbers come from `dc-metro-take-2`: 63 km of the Capital Beltway, an ENU frame, a pyramid bake
(z 11–14), 19,035 streamed branches, 4,000 traffic cars in `dc-traffic-nightmare`. Rich's heap
snapshot that day was 5.4 GB, 88% of it ArrayBuffers.

**How to watch the list shrink.** Every deploy plan (Deploy panel step 5, or MCP `deploy_plan`) now
has a "loaded whole" readout: the biggest objects the game reads that are not tiles. For a runtime
picture, use a heap snapshot sorted by retained size, or probe a live tab through the dev bridge
(`scripts/bridge.mjs`, `APEX_BRIDGE=apex-dev`): count `apex.scene` objects, read
`apex.renderer.info.memory`, and time `renderer.render` per pass.

## Files the game loads whole

| # | File | On disk | In memory | Who reads it |
|---|---|---|---|---|
| 1 | `web/dem_8m.png` overview DEM | 30 MiB | **132 MB** Float32 (5658 × 5829 at 8 m), plus the decoded image | `scene.ts` `overviewHeight` (the fallback wherever no pyramid tile is resident), the overview terrain mesh, `cutHorizon`, the floor |
| 2 | `web/chm_8m.png` overview canopy | 5 MiB | **132 MB** Float32, plus the decoded image, which `makeCanopy`'s closure keeps for the whole session | `overviewCanopy`: the fallback for `canopyAt` outside resident tiles, adjustments, and a diagnostic blanket that is off by default |
| 3 | `context.json` | 47 MiB | several hundred MB of parsed objects (estimate) | `intersections.ts` `loadJunctionFacts` (lanes per way, crossings), `minimap.ts` (every road's coordinates) |
| 4 | `web/manifest.json` | 4.1 MiB | parsed and held | everything at boot. Inside it: `intersections` 2.2 MiB, `layers` 0.95 MiB (tile lists), `profile` 0.6 MiB, `spine` 0.24 MiB. The Beltway level program fetches it **again** for the spine. |
| 5 | `web/naip_overview.jpg` | 5.6 MiB | ~62 MB decoded RGBA (3868 × 3985), plus the minimap's own copy | far terrain imagery, the minimap |
| 6 | `web/horizon_60m.png` | 1.6 MiB | small (1000 × 1000) | the horizon ring. **Fine as it is.** |

The two 132 MB buffers in the heap snapshot were items 1 and 2. They are not the 2 m canopy: the 2 m
CHM and DEM already arrive per tile inside the pyramid packs (`PyramidSet.canopyAt` / `heightAt` read
`hit.t.chm` and `hit.t.dem`). The overviews exist only to answer *outside* a resident tile, and they
do it at 8 m over the whole 45 × 47 km box.

### 1–2. The overview DEM and canopy → the pyramid's coarsest level

The pyramid already covers the whole region at its coarsest level (z 11). Answer the fallback from
there instead of from a separate 8 m raster:

- **Keep z = zmin always resident.** It is a few dozen tiles for dc-metro. `PyramidSet` then never
  needs an external fallback inside the region; outside it, return the edge height and canopy 0.
- **Drop `L.dem` / `L.chm` from the boot path** for pyramid worlds. The overview terrain mesh and
  `cutHorizon` move to the z 11 tiles or to the horizon layer (item 6 is already the far ring).
- **Adjustments** (`canopy_scale` / `canopy_offset_m`) apply per tile at decode, not once over a
  whole-region raster.
- **Quick win, do it first:** stop `makeCanopy` from retaining `chmImg`. The blanket is off by
  default, so decode its alpha on demand when someone ticks it.
- Non-pyramid worlds (crofton-triangle, flat tiles) keep the overview; they are small.

Expected: about −264 MB of Float32 plus the decoded images on dc-metro, and a faster boot.

### 3. `context.json` → per-cell vectors

It holds three things, each with a natural tile:

- **Lane facts per OSM way** and **crossings**: put them in the vt cells beside the intersections that
  already stream there (`hydrateCell`). `loadJunctionFacts` becomes per-cell.
- **Minimap roads**: draw from the same per-cell road vectors around the player. For the zoomed-out
  view, bake a raster map pyramid (like the NAIP pyramid), so the minimap never holds every road's
  coordinates.
- Keep a tiny `context.json` stub (version, counts) so old viewers still find something.

### 4. `web/manifest.json` → a small boot document

- Move `intersections` (2.2 MiB) out; they already stream per cell, so keep only counts.
- Move tile lists out of `layers` into the tile indexes themselves (the pyramid has `empty`; the flat
  list is not needed in a pyramid world).
- `profile` streams with the spine chunks.
- The level program should get the spine from `api` (a small `api.world.spine()`) instead of
  fetching the manifest a second time.

Target: well under 1 MiB.

### 5. `naip_overview.jpg`

Near imagery is already in the pyramid. Re-bake the far overview at a coarser resolution (it is drawn
at the horizon), or fold it into the horizon layer. The minimap gets the map pyramid from item 3.

## Runtime monoliths (not files)

These are not downloads; they are things the running game keeps whole or grows forever.

| # | What | Measured / estimated | Plan |
|---|---|---|---|
| 7 | **Nothing streamed is ever unloaded.** Buildings, furniture, branch chunks, grass and spine strips, water and crops built per cell are only hidden past the draw distance (`updateNear` → `show()`). | Estimated 25–70 MB/km downtown, 5–10 MB/km suburbs (leak-hunt report, 2026-10-08) | Residency ceiling per cell (`PLAN-WORLD-SCALE.md` item 6): evict cells beyond N km. Dispose geometry, materials, the blade canvas; drop the cell's entries from `builtParts`, `liveStrips`, `roadParts`, `wetExtra`, `signalTicks`, `retro`, `wettable`, `precip`; clear `hydrated` / `builtStreet` / `chunkBuilt` so it rebuilds on return. Keep per-cell manifest data in maps keyed by cell instead of appending to global arrays (`manifest.buildings`, `landuse`, `pois`, `xByNode`, `branchRaw`). |
| 8 | **Every library material with variants** is decoded into 1024² `DataArrayTexture`s at boot (`loadSurfaceSets`), and three keeps the CPU copy. | 16 × 12.6 MB = ~200 MB (the identical 12,583 kB buffers in the snapshot) | Load only the materials the world's surfaces doc and road classes name; release `image.data` after upload (`onUpdate`). |
| 9 | **Water** keeps every source geometry and re-merges the whole bucket (bucketed by look, not area) on each arriving cell; all of it is drawn every frame. | Small in bytes on DC; cost grows with water seen | Bucket by area cell; evict with item 7. |
| 10 | **Branch adoption** indexes whole branches (curves with arc-length caches, stations every 5 m) and replants the full tree grid per adopted branch (`replantNow`). `finishJunctions` re-meets every branch so far. | ~60–70 KB per km adopted; GC churn grows with distance | Index per chunk, replant only the invalidated region, re-meet only neighbours. |
| 11 | **Address search** needs the raw `osm.geojson` (389 MB). Today it fetches a path without `/sites/` and silently never loads; fixing just the path would download 389 MB on every boot. | — | Bake a compact address index (number, street, centroid) per cell, or one small file, then fix the path. |
| 12 | **Traffic**: 4,000 cloned car models. | Fixed 2026-10-08: far cars detached from the graph (d21f9d5); dent clones released (e69f8ee) | Done. The remaining cost is the clones' JS objects; an instanced or pooled car mesh would remove that. |

## Already done (2026-10-08), for the record

- **Deploys stop shipping what the game never reads**: top-level bake sources (raw OSM, branches,
  spine…), loose `web/` files the web manifest does not name (`chm_2m.png`, 133 MiB, read by nothing),
  and the flat `web/tiles/` of a pyramid world (1,565 MiB, superseded). A dc-metro game deploy went
  from 9,486 objects / 3,615 MiB to 6,009 / 1,419 MiB. "Include bake sources" ships everything.
- The `chm_2m.png` in `web/` is still written by the bake. Stop writing it there, or keep it outside
  `web/`.

## Order

1. **Quick wins:** stop retaining `chmImg` (item 2); release the surface textures' CPU copies and
   load only the named materials (item 8). Small diffs, about 300 MB back on dc-metro.
2. **Overviews to the pyramid** (items 1–2): about −264 MB, and a faster boot.
3. **Residency ceilings** (item 7): the one that grows with distance. Measure first with a drive probe
   logging `renderer.info.memory` and `performance.memory` per km.
4. **`context.json` and the manifest to cells** (items 3–4), with the minimap's map pyramid.
5. **The address index** (item 11), then search works again.
6. Water and branch adoption (items 9–10) alongside 7, since they share the eviction path.

Each step is done when the deploy plan's "loaded whole" line no longer lists it, and the heap
snapshot after a 10 km drive is flat rather than climbing.
