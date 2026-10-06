# From a corridor to a world: the scale plan

**Status:** plan, 2026-10-06. A quick map of what stands between the current bake and a world at
arbitrary size, and the order to do it. It is a pointer, not a spec: the detail lives in
`PLAN-SHARDED-BAKE.md`, `PLAN-OPEN-WORLD.md` and `PLAN-STREAMING-WORLD.md`, and this file only
says how they fit and what is actually blocking today.

Rich, 2026-10-06: *"before we get into world scale stuff (write a quick plan doc though)"*.

## Where we are

The **runtime** half is done. The manifest no longer holds the world: buildings, sidewalks,
parking, barriers, power, signals, driveways, siblings, stubs, intersections, branches, cuts, rock,
sidewalk zones, water, landuse and POIs all stream per 1 km cell, and the resident manifest carries
only the spine, the frame, the layers and small summaries (`landuse_area`, water/cuts/intersection
counts). `dc-metro-take-2` (63 km of the Capital Beltway, 1450 tiles, 19 035 streamed branches) and
`ellicott-mills-and-ilchester` run this way; `crofton-triangle` stays inline because it is small
enough not to matter.

So the viewer can already walk a big world. What it cannot do is **bake** one.

## The gate

`MAX_M` is capped at 43 000 m and cannot be raised yet. Two things hold it:

1. **Shard memory is unbudgeted.** `partition` caps at 16 shards of 8 km, and a shard peaks around
   **139 GiB** on the Capital Beltway because the whole block's root rasters (1 m DEM, 30 cm–1 m
   NAIP, lidar) are held at once. Widening the world widens the blocks past what a node has.
   THIS IS THE GATE — `PLAN-SHARDED-BAKE.md` Phase 2 (size shards from a measured peak, spread them
   with `topologySpreadConstraints`).
2. **The finalizer still merges.** `export_tiles` / `pyramid.bake` / `overview` run in the
   finalizer over the merged site rather than per shard, so the merge it was all meant to avoid is
   still on the path. Phase 1's remaining item: each shard runs its own `export_tiles` /
   `pyramid.bake`, and the finalizer only unions `web/tiles` + `web/pyr`.

Both are in `PLAN-SHARDED-BAKE.md`; neither needs a design, they need doing.

## Then, in order

1. **Shard sizing + spreading** (unblocks `MAX_M`). Memory-budget the shard request from the
   measured peak, fan shards across nodes, and let the block size follow the budget instead of the
   fixed 8 km.
2. **Per-shard export**. Shards write their own tiles, pyramid and vectors; the finalizer unions.
   Drop the merged root rasters from the finalizer entirely.
3. **A world is not a corridor** (`PLAN-OPEN-WORLD.md`). Proximity to a road must stop deciding
   trees and ground textures: bake the full network's landcover, not a 150 m buffer of it. This is
   what makes the space between roads look like a place rather than a seam.
4. **Coverage at the source** (`OVERPASS-PLANET.md`). A world needs OSM everywhere; today an
   out-of-extract query is a silent success with zero ways. The self-hosted mirrors are the fix and
   are already in flight.
5. **A graph, not a spine.** Everything is still keyed to one primary chain (`spine`, `s_start`,
   `who === 0`). A world has many spines; the ground, structures, junctions and QA all need to name
   a chain and a station, not "the" spine. The streaming work already moved the data; this is the
   remaining hard-coded assumption.
6. **Runtime budgets for a continent.** The per-cell streamer works; it needs residency ceilings
   and a coarse LOD for the far field (pyramid + impostors + overview) so a world is bounded by
   bandwidth, not by what fits in memory.

## Not now

Sea, global elevation at 1 m, and a single seamless raster are all out of scope: the world is a
graph of roads and the land around them, streamed, and it never exists all at once.
