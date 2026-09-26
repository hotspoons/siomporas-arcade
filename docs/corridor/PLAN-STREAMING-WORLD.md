# From a compiled site to a streamed world

**Status:** plan, 2026-09-26. Written against Rich's list of that day: "we still have a monolithic
world that requires some world assets to be compiled at load time (the goal was to have a fully
dynamic infinite world if possible using tile locality to flatten startup times and stream in
levels)", "why does it have to grade 427 streets every time crofton loads?", "there is definitely
a much cleaner way to render [intersections] from available data", and "the satellite imagery in
my home town seems really low res".

## What loads today, and what it costs

Measured on crofton-triangle (388 roads, 59 km² of tiles, 28k buildings, 68k trees) through the
dev bridge on Rich's machine:

| step | where | cost | can it be baked? |
|---|---|---|---|
| terrain tiles, 59 packs | `loadTiles` | fetch-bound, decoded up front through a Budget | already tiled |
| imagery | `ImageryStream` | streams, KTX2, byte-capped | already streamed |
| the primary strip | `buildStrip` | 37k vertices, ~0.4 s | yes |
| **427 branch strips** | `makeBranchStrips` | **"grading N/427 streets…", several seconds** | **yes — pure function of the bake** |
| buildings | `buildBuildings` | 3.9 s, budgeted | yes, per tile |
| furniture, blades, stop bars, signals | `buildFurniture` etc. | ~1 s | yes, per tile |
| trees | CHM tiles → records → impostors | per tile already; impostor atlas rebaked per season | records yes; atlas is per-look |
| grass | `Grass` | generated at runtime around the eye | no — it IS streaming, by design |
| paved-from-imagery, sidewalk mask | this week | ~0.2 s | yes, trivially |

Everything marked "yes" is deterministic given the bake's rasters plus a handful of *geometry*
knobs (`BRANCH_VERGE`, the two strip spacings, `FURNITURE_CHUNK_M`) that nobody has tuned since
the first week. Everything that people DO tune live — colours, seasons, weather, wind, densities —
is a material or a uniform and is unaffected by baking the geometry.

## The order

Each step is shippable on its own and each makes the next one smaller.

### 1. Strips into the packs

`network_tiles` already writes a pack per 1 km tile with `dem.png` + `chm.png`. Add
`strips.bin`: for every road whose strip intersects the tile, the strip's lattice clipped to the
tile — positions as int16 offsets from the tile origin (2 mm is plenty), `aEdge` and `aCanopy`
as uint8 — plus a tiny index of which road each run belongs to, so `heightAt`/`edgeDistance` can
still answer "which strip am I on". Crofton: ~212k vertices ≈ 4.2 MB raw, ~1.5 MB gzipped across
59 tiles, i.e. **25 kB a tile**. The loader builds a `BufferGeometry` per tile straight from the
bytes; no sampling, no grading. Startup on Crofton goes from "grading 427 streets" to nothing.

The one subtlety: today a branch strip's `skipAt` leaves out stations another road already
covers, and the strip's `heightAt` is what the car and the grass ask near roads. Both survive
tiling if the bake resolves overlaps once (it already computes them) and the tile carries the
resolved result.

### 2. Buildings, furniture, blades, stop bars, signals per tile

Same container, same idea: `buildings.bin` (trailworks baked exactly this — see
`reference-corridor-tile-format`; we skipped it only because 563 ms was not worth 5.9 MB, and per
tile it is 100 kB and worth it), `furniture.bin` with the placed instances (the kerb walk that
moves each mast off the centreline runs at bake time), the blade atlas per site. After this the
manifest stops carrying `buildings`, `sidewalks`, `intersections` in full; it carries a tile index.

### 3. Roads themselves into the pyramid

The road mesh (`road`, the paint, driveways) is built from `manifest.roads` at load. Per tile it
is the same bytes budget as the strips. Once it is in the tile, the pyramid (`pyramidstream.ts`)
can stream it with the terrain at the level the camera wants — a motorway at z=12, every driveway
at z=16 — and **the site boundary stops existing**: the pyramid's root tiles are wherever the bake
put them, and a bake can be a county.

### 4. Then the infinite part

The bake becomes a job per tile, not per site (the world editor already runs bakes as Jobs); the
Overpass and DEM/imagery fetchers already work per bbox. "Infinite" is then a scheduler that bakes
tiles ahead of where people go, and a viewer that has no `manifest.spine`. Not this month.

## Lane-level intersections

Rich: "my rivian uses OSM and other sources and knows how many lanes are at an intersection and
which lanes turn which direction and the general layout of the intersection."

It does, and so does OSM, thinly: `lanes`, `lanes:forward/backward`, `turn:lanes` (e.g.
`left|through|through;right`), `oneway`, `junction=roundabout`, and stop-line positions as
`highway=stop` nodes. Crofton's coverage, measured 2026-09-22 (`project-corridor-street-spice`):
35 signal nodes, 3 stop nodes, `lanes` on most collectors, `turn:lanes` on the arterials only.
That is enough for the arterial junctions Rich actually drives (MD 450, MD 424, Crofton Parkway)
and nothing for the subdivision T's, which are all "one lane each way, stop on the stem" and are
correctly *derived* today.

What a cleaner renderer does, in order:

1. **Junction polygon.** Today each road's ribbon runs into the junction and overlaps. Compute the
   junction as the union of the approaching carriageways' offset polygons, clipped by the kerb
   returns (a radius per road class: 6 m residential, 12 m arterial), and draw it ONCE as one flat
   polygon at the junction's height. This alone removes the "messes".
2. **Lane model per approach**: `lanes` and `turn:lanes` → a list of lanes with allowed movements;
   absent tags → 1 lane each way for residential/tertiary, 2 for primary/secondary, with the
   rightmost lane `through;right` and the leftmost `left;through` unless a `left` pocket is tagged.
3. **Paint from the lane model**: lane lines end at the stop bar, arrows per movement (MUTCD), the
   double-yellow through a junction becomes dashed guidance only where `turn:lanes` says two
   lefts meet. This is where the "clean" comes from — not from more polygons, from the lines
   agreeing with each other.
4. **Signal heads per lane** rather than per mast: a left-turn lane gets its own arrow head. The
   controller already phases by road; adding a protected-left phase where a `left` pocket exists is
   one rule.

**Built the same day, in the viewer, from records the bake and OSM already held** (Rich: "there
needs to be opinions here"):

- **stop lines at every controlled approach** — the bake's 522 stop-sign bars plus one per
  signal approach (39 on Crofton), white, unlit, 0.6 m, on the approach's own half of a two-way
  road and the whole of a one-way carriageway. They were buried: drawn at ground + 0.05 where the
  asphalt rides the carriageway spline 0.4 m higher near a junction. Junction paint is now placed
  on the road surface (`roadHeightWorld`, the spline's height), never the ground.
- **lane paint ends at the stop line, per arm** — `junctionPaintCut` replaces the JUNCTION_CLEAR
  circle; the cut is the sector of each approach out to its own stop line.
- **ladder crosswalks** — across every arm of a signalised junction that has a sidewalk to arrive
  from (18), and at every OSM `highway=crossing` node not tagged unmarked (21).
- **lane-use arrows from `turn:lanes`** — 142 arrows on 25 approaches / 71 lanes, two per lane
  in the last twenty metres, straight / hooked / both.
- **one signal head per lane in the mast's own direction** — the bake wrote the way's total
  (`lanes=5` on Davidsonville Road) onto every mast; `_dir_lanes` uses `lanes:forward/backward`
  or half the total.

Still to do from the list above: the junction polygon itself (the box is still the union of
ribbons), the solid line beside a turn pocket, and a protected-left phase where a `left` pocket
exists. The subdivision junctions stay derived.

## Imagery resolution

Crofton's tiles are baked at **1 m** (`network_tiles`: `res.naip = 1.0`). NAIP is 0.6 m in
Maryland (some states 0.3), so the bake is throwing away 2.8x the pixels it fetched. At 0.6 m a
1 km tile is 1667² instead of 1000², 2.8x the bytes: ~25 MB → ~70 MB of KTX2 for Crofton's 59
tiles, which the byte-capped stream handles without a code change. It is a bake parameter, not a
design problem, and `network_tiles` can re-fetch imagery alone without touching the 8.7-hour
lidar pass (the tiles' DEM and CHM stay; only `naip.jpg`/`.ktx2` are rewritten).

Outside the US the answer is Sentinel-2 at 10 m and it is honest about it
(`DATA-OUTSIDE-US.md`).

## What this plan does not do

It does not make Crofton look different. It makes Crofton load in a second, makes a county
possible, and gives the intersections the geometry to be drawn properly. The visual work — sky,
styles, roofs from the footprint — is separate and mostly already in flight.
