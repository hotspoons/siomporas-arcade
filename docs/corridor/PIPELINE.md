# Corridor pipeline — from a photo to a drivable road

*Written from the code as it stands on 2026-09-21 (`tools/corridor/corridor/*.py`,
`apps/corridor/src/*.ts`). Every file, threshold and default named here was read out of the
source, not remembered. When the code moves, move this.*

There are two halves. The **bake** (`tools/corridor`, Python, runs once per site on the cluster
or in the devcontainer) pulls the public record for a stretch of road and writes one directory
of measured data. The **viewer** (`apps/corridor`, three.js, runs in the browser) turns that
directory into terrain, pavement, trees, grass, structures and props every time it loads. Nothing
is generated in the browser that could have been computed in the bake; nothing in the bake knows
what a three.js mesh is.

```
photo (EXIF fix)  or  lat/lon ──► sites.json
                                      │  python -m corridor fetch <slug>
                                      ▼
   OSM ─► spine + siblings + features + crossings
   3DEP ─► dem_1m.tif                    Macrostrat ─► geology.json
   NAIP ─► naip.tif                      3DEP seamless ─► horizon_30m.tif (+ 60 m NAIP)
   EPT / TNM LAZ ─► lidar/ rasters ─► profile.json (road z, cut/fill, canopy, structures)
                                      │
                                      ├─► surface.json          (pavement class every 20 m)
                                      ├─► web/manifest.json + web/*.png|jpg   (the viewer's contract)
                                      ├─► adjustments.json      (python -m corridor areas — proposals)
                                      └─► publish               (R2, python -m corridor publish)
                                      │
                                      ▼   apps/corridor  (vite dev :5185, /editor.html)
   terrain ─ strip ─ road + paint ─ trees ─ impostors ─ grass ─ structures ─ placements ─ car
```

---

## The three tiers at a glance

Rich's question — what is baked in the pipeline, what is built when the viewer boots, and what
is dynamic — in one table. Parts 1 and 2 below are the detail.

| tier | when | where it lives | what |
|---|---|---|---|
| **A · pipeline bake** | `python -m corridor fetch <slug>`, minutes per site, re-run only when data or a rule changes | `tools/corridor/data/sites/<slug>/` on disk (later an R2 bucket); the viewer reads only `web/` | OSM spine, lane tags, siblings, crossings, buildings/landuse/POIs · 3DEP 1 m DEM → `dem_2m.png` · NAIP 0.3 m → `naip_1m.jpg` · lidar → DTM/DSM/CHM/deck rasters, along-track profile, detected structures (deck planarity, class-17 demotion) · pavement class per 20 m · Macrostrat geology · 60 km horizon DEM + NAIP · canopy zeroed under carriageways and building footprints · `manifest.json`. Also offline, not per site: flux.2 surface textures (`tools/surfaces/gen.py`), TRELLIS.2 prop GLBs (`public/assets/`). |
| **B · viewer boot** | `buildSite()` in `scene.ts`, once per site load, a few seconds, all in memory | GPU buffers and closures on the `Site` object | authored `adjustments.json` / `structures.json` applied (flatten rewrites the grade before the spline exists) · terrain mesh from the DEM, horizon mesh with the near footprint cut out · the carriageway Catmull-Rom spline — the one height function · station grid for `edgeDistance` · asphalt + paint meshes · corridor strip · tree records from the CHM (position, height, species) · impostor atlas baked with the renderer for the season · hex-tiled surface material sets · catalog GLBs placed · minimap layers · car placed at the photo. A knob in the `road` tab or a season change re-runs the affected part of this tier (`retune`, `setSeason`). |
| **C · dynamic** | every frame | `updateNear()`, `Car.tick()`, controls | grass tiles generated a few per frame as the eye moves and cached (blades near, sprite cards far) · which tree records get full ez-tree models inside `TREE_NEAR_RADIUS` and which stay impostors · impostor and grass wind/colour uniforms · the LOD footprint (stretched behind the view, circular when pitched down) · car physics, chase/cockpit camera, fly controls · minimap redraw. |

## Part 1 · The bake (`tools/corridor`)

Entry point: `corridor/__main__.py`. Commands: `sites`, `fetch`, `report`, `export`, `areas`,
`publish`. Paths come from `CORRIDOR_DATA` (default `tools/corridor/data`), `CORRIDOR_SITES`
(`sites.json`), `CORRIDOR_PHOTOS` (`ext/ref-driving`). The `just corridor-*` recipes wrap these
with the venv at `tools/corridor/.venv`.

### 1.1 Sites (`sites.py`)

A site is a place Rich stopped. `python -m corridor sites` reads the GPS IFD out of every JPEG in
`ext/ref-driving` (`exif_fix`: lat/lon in DMS, altitude, `GPSImgDirection` as heading, the
`DateTimeOriginal`), drops frames in `IGNORE` (fixes known to be off the road they show), and
clusters fixes within `CLUSTER_M = 400` of an existing site. Slugs come from the nearest entry in
the `NAMES` table, so a re-run keeps names stable. The road is **not** named here; that would be
guessing. Sites with no photo (the sixteen backroad and coastal entries added 2026-09-21) are
hand-appended to `sites.json` with `lat`, `lon`, `photos: []` and a `note`.

### 1.2 The frame (`geo.py`)

`Frame.at(lon, lat)` picks the UTM zone (`utm_epsg`: 326xx north, 327xx south) and sets the
origin at the photo point. Everything the bake writes is in this frame — metres, x east, y north.
`bbox_wgs` / `bbox_merc` sample the box edges (UTM edges curve in other projections).
`snap_bbox` rounds outward to 10 m so every raster lands on the same 1 m lattice. UTM, not a local
ENU frame, because gaussworks' worlds are ENU and a UTM tile is re-based by subtracting an origin.

### 1.3 OSM (`osm.py`) — what the road *is*

Three Overpass queries, each cached by SHA-1 of the query text under `data/cache/overpass/`, tried
across four public mirrors with back-off (the main instance 504s under load).

1. **`nearest_road`** — drivable ways (`DRIVABLE` regex: motorway … primary_link) within 300 m of
   the fix, widened to 800 m if empty. Scored by distance **plus** a class penalty
   (`CLASS_PENALTY`: motorway 0, trunk 40, primary 120, secondary 220, tertiary 320, else 420),
   +150 for a `_link`, +200 for a way with neither `ref` nor `name`. Every reference photo was
   taken *from* a highway, so a fix 80 m from a side street and 200 m from the interstate belongs
   to the interstate. The winner's `ref` (else `name`) is the road's identity.
2. **`spine`** — every `highway` way carrying that identity inside `±(half_length + 800)` m,
   chained by shared **end** nodes into carriageways (`_chains`, orientation-fixing for two-way
   roads). The chain containing the nearest way is the spine, trimmed to `±half_length_m`
   (default 3219 m, two miles) along-track from the fix. Per-way `segments`
   (`s_start`, `s_end`, `osm_id`, raw `tags`) are kept so `lanes`, `oneway`, `maxspeed`,
   `turn:lanes`, `surface`, `bridge` are known per along-track metre. Other chains with the same
   identity within 120 m are `siblings` (the opposite carriageway, ramps).
3. **`features`** — every way/node in `FEATURE_FILTERS` inside the spine buffered by
   `half_width_m` (default 300 m): highways, railways, power, barriers, `man_made` (embankment,
   cutting, retaining_wall…), `natural`, `landuse`, `waterway`, buildings, bridges, tunnels,
   amenity/shop/tourism/office/leisure (what a building *is*), street lamps, junctions, towers.
   Closed ways with area-type tags become Polygons; the rest LineStrings. Raw tags are kept.

**`crossings`** — LineString features that intersect the spine and are not it. A way whose
endpoint is within 6 m of the intersection **merges** (a ramp), it does not cross. Otherwise the
over/under call, in order: the crossing way's own `bridge`/`tunnel`/`layer`; the spine's tags at
that metre (`bridge=yes` on us → they pass under); power → over; waterway → under; on a
motorway/trunk an untagged highway crossing is **inferred** over (nothing crosses an interstate at
grade); two ordinary roads → `grade`. The lidar profile is the check on `inferred`.

Outputs: `spine.geojson` (WGS84), `spine_utm.json` (metres, `coords`, `photo_s`, `segments`,
`siblings`), `osm.geojson`, `crossings.json`, `site.json` (`frame`, `bbox_utm`, `corridor`
polygon, `ident`).

### 1.4 Bare earth (`dem.py`)

TNM API product search `Digital Elevation Model (DEM) 1 meter`, GeoTIFF, over the corridor bbox in
WGS84; tiles sorted oldest→newest so `gdalwarp` paints the newest on top. Downloads go to the
`prd-tnm` S3 mirror first (5× faster than rockyweb) and fall back to the catalogued URL, cached
under `data/cache/usgs1m/` so neighbouring sites share 300 MB tiles. `gdalwarp -t_srs UTM -tr 1 1
-r bilinear -dstnodata -9999` → `dem_1m.tif`. The DEM is the **bare earth**: the vendor removed
every bridge deck, tree and building, which is exactly why the point cloud is fetched too.

### 1.5 Imagery (`naip.py`)

USGS `USGSNAIPPlus/ImageServer/exportImage` at `RES = 0.3` m, `bandIds=0,1,2` (the service carries
NIR as a fourth band), 4000 px tiles stitched, each tile's JPEG cached by bbox → `naip.tif`
(JPEG-in-GeoTIFF, YCbCr). Acquisition date is **not** recorded by the fetch; the service returns
its current mosaic. Ported from trailworks `fetch_naip_rgb`.

### 1.6 Far terrain (`horizon.py`)

`3DEPElevation/ImageServer/exportImage` at 30 m over `±CORRIDOR_HORIZON_M` (default 30 000 m → a
2000² Float32 GeoTIFF, `horizon_30m.tif`) plus NAIP at 60 m over the same square
(`horizon_naip_60m.jpg`) so the far ridges are forest-green and field-tan, not a beige ramp. Same
vertical datum as the corridor DEM (NAVD88 m), so the LOD seam is a resampling problem.

### 1.7 Geology (`geology.py`)

Macrostrat `geologic_units/map` sampled every 250 m along the spine, de-duplicated by `map_id`;
units keep `name`, `strat_name`, `lith`, `descrip`, `b_age`/`t_age`, `color`. `named_formations`
is the set with a `strat_name` (the detailed state-map sources). The polygons at the photo point
go to `geology.geojson`. Credit Macrostrat (CC-BY) wherever shown. This is the input for the rock
palette (Part 3).

### 1.8 The point cloud (`lidar.py`)

**Fetch.** USGS stages 3DEP projects as Entwine Point Tiles (EPT) in Web Mercator on a public S3
bucket. `DATASETS` lists the Maryland projects newest-first; `candidate_datasets` keeps those
whose octree cube contains the corridor (necessary, not sufficient — Clarksburg sits in
MD_Western_2's cube with no points), `nodes_for` walks the hierarchy JSON by hand (no PDAL on
arm64 trixie), `_read_node` reads each LAZ node with laspy + lazrs, and the result is re-projected
to the site frame. When no EPT dataset yields points, `_fetch_tnm_laz` searches TNM for
`Lidar Point Cloud (LPC)` tiles, keeps the **newest project only** (no vintage seams), downloads
them (≈6 GB per eastern site), re-projects each from its declared CRS (US-foot compound CRSs are
converted) and clips per tile to the corridor polygon so memory holds the strip, not the box.

**Units.** `check_units` compares ground-class z to the DEM at 20 000 random points; a ratio near
1/0.3048 means feet and the cloud is scaled.

**Trust.** `classification_quality`: if class 17 (bridge deck) is more than 3 % of the corridor
the vendor used it as a junk bin (USGS Sandy NCR 2014: 24 % class 17, 21 % class 18), and 17/18
are demoted to unassigned before any structure logic runs. The manifest records the demotion.

**Rasters** (`rasters`, 1 m, inside the 200 m lidar corridor): `dtm.tif` (min of ground),
`dsm.tif` (max of everything), `chm.tif` (max of vegetation 3–5 **or unassigned 1** minus the
gap-filled DTM, clipped 0–80 m, zeroed under deck cells — MD_Western_2021 has no vegetation
classes at all, so canopy is "unassigned above ground"), `deck_z.tif` / `deck_n.tif` (class-17
height and count), `building_n.tif` (class-6 count), and `corridor.laz` (the clipped cloud in the
site frame, with the demoted classes).

**Profile** (`profile`, every 2 m along the spine). Order matters:

1. **Labelled decks first.** Class-17 points within 14 m of the centreline are binned along-track;
   a run ≥ 4 m is a bridge **we are on** when the deck continues our grade better than the ground
   does and stands ≥ 1.5 m above the DTM. The driving surface `road_z` is lifted onto the deck.
2. **Anything spanning the road above the driving surface.** All non-noise points within 10 m of
   the centreline, 4.5–40 m above `road_z`, binned 2 m along × 2 m across over ±8 m. A station is
   spanned when 6 of 8 lateral cells are occupied **and the underside is a plane**: the std of the
   per-cell minima ≤ `DECK_UNDERSIDE_STD = 0.5` m and range ≤ `DECK_UNDERSIDE_RANGE = 1.5` m (real
   decks measured ≤ 0.28 / 0.74; Race Track Road's tree tunnel 1.2–5.3 / 3–15 — this test took
   Bowie from 46 "overpasses" to 3). Runs ≥ 5 m are `overpass`, shorter are `gantry`; `source` says
   whether class 17 agreed.
3. **Ground and canopy beside the road** at 8/15/25/40/60 m left and right, relative to the
   driving surface: `ground_rel` (positive = ground above the pavement = a cut; negative = a fill)
   and `canopy`.

Output `profile.json`: `s`, `road_z`, `ground_z`, `ground_rel`, `canopy`, `structures`
(`kind`, `source`, `s_start`, `s_end`, `length_m`, `deck_z_min/max`, `clearance_m`,
`height_above_ground_m`, `underside_std_m`).

### 1.9 Preview and manifest

`preview.py` draws imagery + spine (yellow), siblings (orange), crossings (red over / blue under),
structures (cyan overpass / magenta bridge), photo ring, canopy → `preview.png`. A preview failure
never fails a fetch. `manifest.json` records what was fetched, from where, when and how long
(`fetched`, `params`, `spine`, `osm`, `dem`, `naip`, `horizon`, `geology`, `lidar` incl.
`classification` and `structures`, `seconds`).

> Two gaps seen while writing this (reported to main, `__main__.py` is not this agent's):
> `manifest["surface"]` is assigned *after* `manifest.json` is written, so it is never on disk;
> and a re-run with a cached DEM records `{"cached": true}` and loses the source tile titles and
> dates. `web/manifest.json` is unaffected (it reads `surface.json` directly).

### 1.10 Pavement class (`surface.py`)

Every `STEP_M = 20` m: median **lidar intensity** of ground returns inside the lanes
(`lanes × 3.66 / 2 − 0.3`) against the verge 12–30 m out (intensity is per project — the same
asphalt reads 5 900 on MD_Western_2 and 14 300 on MD_Western_1 — so only the ratio to the
corridor's own median votes); **NAIP** brightness, chroma and texture inside the lane polygon
(absolute: concrete ≥ 120, new asphalt ≤ 90); **OSM `surface=`** as the third vote. Chip seal is
gated to non-motorway classes. A station whose intensity ratio jumps ≥ 35 % against both
neighbours is `asphalt_patched`. Classes: `asphalt_new | asphalt_aged | asphalt_patched |
concrete | chipseal | unknown`, plus a majority per OSM segment → `surface.json`. The thresholds
are a first calibration against one interstate and are stored with the output.

### 1.11 Web export (`export.py`) — the viewer's contract

Browser-decodable layers on one 2 m lattice, coordinates **relative to the site origin**:

| layer | encoding |
|---|---|
| `dem_2m.png` | height as RGB-packed uint16 (R high byte, G low) in `zscale` m steps above `zmin` — a 16-bit PNG would be quantised to 8 bits by the canvas |
| `chm_2m.png` | canopy, 8-bit, 0.25 m per step, **zeroed over every carriageway** (paved width + 2 m, from the max lane count) **and under every OSM building footprint + 1 m** — a truck is a 4 m "tree", a roof a 6 m one |
| `naip_1m.jpg` | imagery at 1 m, saturation 1.3× / contrast 1.1× / warmed, because NAIP is flown for measurement and reads grey-green under fog |
| `horizon_60m.png`, `horizon_naip_60m.jpg` | far terrain, same height encoding, 1000² over 60 km |
| `manifest.json` | see below |

Before the vectors, `buildings.derive` (`buildings.py`) computes per OSM footprint the minimum
rotated rectangle (`rect.w/d/yaw_deg`, yaw a **math angle from east, 0–180**), height
(OSM `height` → `building:levels × 3.2` → lidar DSM−DTM top-quartile median → 6 m, with
`height_src`), along-track `s` and signed lateral `lat` (+ = left of travel), tags enriched from
POIs inside; plus `landuse` rings and `pois`. That is autogen's input (`AUTOGEN.md` §10).

The **spine** is smoothed before it is splined: resampled at 2 m, Gaussian σ = 15 samples
(30 m) along-track, endpoints pinned, then densified every 10 m with z interpolated from
`profile.road_z`. OSM draws curves as chords 20–100 m apart; a spline through raw nodes reproduces
the kinks. Siblings get the same treatment (2-D only).

`web/manifest.json` keys: `slug`, `ident`, `frame`, `bbox`, `layers`, `spine` (`coords` [x,y,z]
every 10 m, `photo_s`, `length_m`, `segments` with tags), `siblings`, `structures`, `crossings`,
`surface` (stations + segments + summary), `profile` (every 10 m: `road_z`, `ground_rel` at
8/15/40, `canopy` at 15/40), `geology`, `photos`, `lidar` summary, `buildings`, `landuse`, `pois`.
`write_index` rebuilds `sites/index.json`. The TypeScript mirror is `apps/corridor/src/site.ts`.

### 1.12 Proposals, publish, cluster

`areas.py` (`python -m corridor areas`) proposes neutral adjustment-area polygons from what the
bake measured: a canopy side that reads < 40 % of the other (a leaf-off flight line), canopy runs
departing from the same side's ±300 m rolling median, one band per structure, one per surface-class
run. Ids encode position so a re-bake merges. `publish.py` mirrors `data/sites/` to
`s3://<bucket>/corridor/sites/<slug>/…` and writes `corridor/index.json`; size-matched objects are
skipped. `Dockerfile` + `chart/` run the bake as a Kubernetes Job onto a kept PVC
(`tools/corridor/README.md`, "Running it on the cluster").

---

## Part 2 · The viewer (`apps/corridor`)

Dev server: `npx vite --port 5185 apps/corridor` (`just corridor-view`). `vite.config.ts` serves
`/sites/**` straight from `tools/corridor/data/sites` and `/photos/**` from
`ext/ref-driving/small`, returns a real 404 for a missing optional JSON (Vite's SPA fallback would
otherwise answer `index.html` with a 200), and accepts `PUT` for exactly
`<slug>/(adjustments|placements|structures).json` — the editor's three files, written beside the
bake, never inside `web/`. `?data=<R2 prefix>` points the same code at a published bucket.

World frame (`scene.ts`): three.js X = site x (east), Y = up (m NAVD88), Z = −site y (south).
`toWorld(x, y, z) → (x, z, −y)`. `groundAt(x, y)` takes site y; `Site.heightAt` / `edgeDistance`
take world x, z.

`buildSite` (`scene.ts`) runs once per site load, in this order:

1. **Authored overrides first.** `adjustments.json` (`adjust.ts`) and `structures.json`
   (`structures.ts`). `flatten` intervals rewrite the spine's z to a straight grade *before* the
   spline exists; `suppress`/`flatten` drop detected structures inside them.
2. **Terrain.** `dem_2m.png` decoded (`decodeHeights`), a regular grid at a stride keeping
   ≤ 1.1 M vertices (≤ 300 k on `?lite`), draped with `naip_1m.jpg` (≤ 4096 px on lite). Season
   tints the drape (`season.ts` `LOOK[season].ground`).
3. **Canopy blanket** from `chm_2m.png` (hidden by default; the trees are the stand-ins). The
   human's `canopy_scale`/`canopy_offset_m` areas are baked into the CHM here, once.
4. **Horizon.** `horizon_60m.png` at ≤ 300 k vertices, draped with the 60 m NAIP, and **every
   triangle inside the near-DEM footprint removed** with the one-cell rim pinned 3 m under the near
   terrain (`cutHorizon`). Two meshes of the same ground at 60 m and 2 m cannot coexist.
5. **The spine spline.** A centripetal Catmull-Rom through the 10 m points (+0.4 m) is *the* road
   height for everything: pavement, paint, grading, the car, the driver's eye. `spineAt(s)`.
6. **Road.** `lanesAt(s)` from the segment's `lanes` (default 2); `twoWayAt(s)` from `oneway`
   (motorway/links one-way by default). `pavedWidth = lanes × LANE_WIDTH + shoulders`
   (`tuning.ts`: `LANE_WIDTH`, `SHOULDER_OUT`, `SHOULDER_IN`). `roadMesh` (`props.ts`) sweeps 6 m
   stations into one geometry **per surface class** (`surface.class` at `s`, or an area's
   `surface_class`), UVs in metres so textures tile at real scale, and paints: one-way → yellow
   left edge, white right, white dashes (3 m every 12 m); two-way → double yellow centre, white
   both edges. Siblings are 2-lane one-way `asphalt_aged` roads sharing the spine's grade within
   60 m (so they cross the same bridge decks). Road + strip rebuild 250 ms after a road knob moves.
7. **Edge distance.** Stations every 5 m from the spine and every sibling, hashed on a 20 m grid,
   each carrying its paved half-width; `edgeDistance(x, z)` is signed (negative on pavement) and
   returns the road height at the projected station from the *same* spline. Grass, verge blending
   and tree exclusion all ask this.
8. **The strip** (`strip.ts`): fine terrain 1 m across × 2 m along (4 × 2 on lite), from
   40 m left of the leftmost carriageway to 40 m right of the rightmost. Under pavement it sits
   2 cm under the road spline; from the edge it blends to the DEM over 0.6–7 m; an area's
   `ground_offset_m` deforms the verge over the same band. One material: imagery everywhere, mown
   turf inside ~8 m, rough grass to ~22 m, the photo's own luminance kept as modulation. The coarse
   terrain is sunk 2.5 m under it (`sinkUnderStrip`). `strip.heightAt` is `groundAt` near the road.
9. **Trees** (`treesFromCanopy`, `props.ts`): walk the CHM on a 6 m cell (coarsened until under
   120 k trees, 25 k lite), one tree per cell ≥ 3 m, height = canopy × (0.9–1.1), jittered, none
   within 3 m of any pavement edge, thinned by an area's `tree_density` (stable position hash),
   species from an area's `species`. A 16 m grid of trunk circles (r = h × 0.025) serves collision.
   Near field (`trees.ts`, `NearTrees`): ez-tree presets `Oak Medium`, `Ash Medium`,
   `Aspen Medium`, `Oak Large`, `Ash Small`, half the leaves at 1.3× size, instanced, scaled so the
   crown top lands at the measured height, re-picked within `TREE_NEAR_RADIUS` (LOD footprint
   stretched behind the view, `lodDistance`) when the eye moves 15 m or turns 25°. Leaf textures
   are swapped for greyscale masks so the season tint *is* the colour; sparse/bare leaf sets exist
   per season. Far field (`impostors.ts`): the same five variants baked to an atlas at 8 yaws + a
   top-down cell, one camera-facing quad per tree, slots static (slot = tree index) and toggled
   with `addUpdateRange` — rebuilding 35 k matrices per move was the phone jank.
10. **Grass** (`grass.ts`): the world cut into 8 m tiles, each generated once (ground, canopy < 3 m,
    off the pavement, mown inside `GRASS_MOW_LINE`, taller with weeds beyond, positions hashed
    from a fixed lattice) and cached; blades (quadratic-Bezier strips, three wind layers, AO,
    back-light) in LOD rings to `GRASS_RADIUS`, sprite cards out to `GRASS_SPRITE_RADIUS`; at most
    `GRASS_TILES_PER_FRAME` new tiles a frame. Season sets the colour ramp and height.
11. **Structures.** Detected `bridge`: parapets and edge beams along both pavement edges, on the
    spine and on siblings over the same stations (the deck *is* the road). `overpass`: a slab on
    two piers down to the measured ground (`overpassMesh`). `gantry`: a translucent bar.
    Crossings become markers (hidden by default). Authored `bridge_over` intervals
    (`buildBridges`, `structures.ts`) place a catalog asset with its long axis across the road,
    fitted to `span_m`, underside at road + `clearance_m`, concrete abutments to the ground.
12. **Placements** (`placements.ts`): `placements.json` items → catalog entry → the `.glb` (Draco,
    decoder at `/assets/vendor/draco/`) fitted to `height_m` (or `span`) with its base on the
    ground, else a labelled box of the real footprint. `yaw_deg` is a compass bearing, applied as
    `rotation.y = −(yaw + yaw_offset_deg)·π/180`.

Around it, `main.ts` owns the UI: site picker, layer toggles, seasons (`?season=`), F6 tune panel
(`tuning.ts` — every `export let` is a live knob; Rich drives, copies the panel's JSON, the default
is edited), fly camera (`fly.ts`, the trailworks scheme), drive mode (`car.ts`, the stuntin ground
regime + lateral grip, tree collision, grass drag, chase and cockpit cameras), the inset
`minimap.ts` (NAIP under OSM roads by class), stance URLs (X copies a URL that reproduces the
view; `probes/corridor-stance.mjs` renders it headlessly), and the phone layout (`?lite`).

The **editor** (`/editor.html`, `src/editor/`, the editor agent's) builds the same `buildSite`
read-only and writes the three authored files: areas (mode 1), placements (mode 2), autogen
(mode 3, `AUTOGEN.md`), structures (mode 4). `corridor.ts` there holds the along-track/lateral
conversions and every sign convention in one place.

---

## Part 3 · Where every texture and model comes from

| what | source | how it gets in |
|---|---|---|
| **Terrain, canopy, far terrain** | USGS 3DEP 1 m DEM; 3DEP lidar (EPT or TNM LAZ); 3DEP seamless 1/3″ | `dem.py`, `lidar.py`, `horizon.py` → `web/*.png` |
| **Imagery** | USGS NAIPPlus (0.3 m corridor, 60 m horizon) | `naip.py`, `horizon.py` → `naip_1m.jpg`, `horizon_naip_60m.jpg` |
| **Road geometry, lanes, paint, crossings, buildings, land use, water** | OpenStreetMap via Overpass (ODbL) | `osm.py`, `buildings.py` → `spine_utm.json`, `osm.geojson`, manifest |
| **Rock palette** | Macrostrat map units (CC-BY) | `geology.py` → `geology.json` → manifest `geology` |
| **Pavement textures** | flux.2-dev (`high-brine` on gh200-1) via `tools/surfaces/gen.py`: one prompt per class (`SETS`), 1024² top-down, made tileable by roll-and-blend over 96 px, normal from an albedo height field (Sobel, wrap-around), roughness = inverted blurred albedo; 3 variants per class + an 8 m macro map; also `grass_mown`, `grass_rough`, `shoulder_gravel` | `apps/corridor/public/surfaces/<class>/` + `surfaces.json` (gitignored, regenerable). `props.ts::loadSurfaceSets` builds one hex-tiled (`hextile.ts`, Mikkelsen 2022) `MeshStandardMaterial` per class; the join key is the class name `surface.py` emits |
| **Trees** | `@dgreenheck/ez-tree` (MIT) presets and its bundled bark/leaf textures | `trees.ts` at load; impostor atlas baked from the same meshes in `impostors.ts` |
| **Grass** | procedural blades + sprite cards drawn by `grass.ts`'s shaders; ground textures from `gen.py` | `grass.ts`, `strip.ts` |
| **3D props** (buildings, bridges, the car, rocks) | flux.2-dev image on chroma green → keyed cut-out → **TRELLIS.2** via `tools/recon-service` (`POST /reconstruct`, poll `/jobs/<id>`, `GET /jobs/<id>/asset`; ≈2 min per asset on a GH200, one job at a time) → `tools/assetgen/finish.mjs` (meshoptimizer to ~20 k faces, `KHR_materials_unlit`, 1024 px WebP, **Draco**) | `apps/corridor/public/assets/<id>.glb` (gitignored) + an entry in `catalog.json` |

**Traps that recur** (from `reference-glb-and-flux-traps`): `finish.mjs` always Draco-compresses,
so a `GLTFLoader` without a `DRACOLoader` rejects silently and every model becomes a box; flux
crops tall subjects however the prompt is worded (attach a reference instead); TRELLIS
reconstructions are normalised to ~1 m and carry no scale — `fitModel` scales to `height_m` or
`span_m`; a generated model faces whichever way the reconstruction left it — `yaw_offset_deg` on
the catalog entry corrects it once, for every placement; flux would not omit bridge supports, so
`probes/editor-trim.mjs` clamps everything below the deck's underside up to it before `finish()`.

### Where TRELLIS props slot in

`apps/corridor/public/assets/catalog.json` is the prop library manifest. One entry per asset:

```json
{ "id": "overpass-01", "name": "Concrete overpass span", "category": "bridge",
  "footprint_m": [30, 12], "height_m": 2.6, "glb": "assets/overpass-01.glb",
  "fit": "span", "yaw_offset_deg": 90 }
```

- `category` is what the placement rules key on: autogen picks a `house`/`strip_mall`/`church`…
  by inferred category; `bridge` entries are what a `structures.json` `bridge_over` may name;
  `rock` (this agent's kit, Part 4) is what `rocks.ts` instances along cut faces.
- `footprint_m` / `height_m` are real metres — with no `glb` the viewer draws that box, labelled,
  so a layout reads before the model exists.
- `fit`: `height` (default) scales the normalised model to `height_m`; `span` scales its longest
  horizontal axis to a placement's `span_m` (bridges).
- `yaw_offset_deg`: the model's own facing correction, applied on top of every placement's yaw.

Three consumers instance from it: **`placements.json`** items (`asset`, `x`, `y`, `z|null`,
`yaw_deg`, `scale`, `snap`) authored in the editor or generated by autogen (`g-` ids);
**`structures.json`** `bridge_over` intervals (`asset`, `span_m`, `clearance_m`); and
**autogen categories** (`AUTOGEN.md` §2–7: zone → category → the catalog entry whose footprint
fits). The rock kit adds a fourth: detected cut faces (`manifest.cuts`, Part 4) → `rocks.ts`
places `category: "rock"` entries of the matching lithology along the face with the tree
instancing pattern, never on pavement (`edgeDistance < 0`).

Generating a prop end to end, as done for the barn, diner, water tower, horse bridge and
overpass: prompt flux (`FLUX_URL`, `FLUX_VERIFY=0` for the staging cert) for the subject on a
solid chroma-green ground, key it (ImageMagick or the fighter pipeline's keyer), POST the RGBA
PNG to recon, download the `.glb`, run `finish.mjs`, drop it in `public/assets/`, append the
catalog entry, set `yaw_offset_deg` by eye in the editor.

---

## Fusing gaussian splats later (visuals) while keeping the geometry (dynamics)

The split already exists in the code: the car never touches a rendered mesh. It drives on the
carriageway spline's height function, `edgeDistance` for pavement vs verge, and the tree grid for
collision — all tier B closures built from the bake. Splats replace what the eye sees, not what
the tyres feel. What that looks like, tier by tier:

- **Bake (A).** gaussworks' 360 drive-through captures → trained splats per capture → registered
  into the corridor frame (EPSG UTM + NAVD88): the GPS track gives scale and a first pose, then an
  ICP of the splat means against the lidar DTM and the road spline pins it (the road surface is the
  most reliable common geometry). Dynamic objects (cars, people) masked out before training. Output
  per site: a 7-DOF transform in the manifest and the splats **chunked by along-track station**
  (every ~50 m of `s`), each chunk a `.ksplat`/`.spz` in `web/splats/` and later R2, with a
  capture date and time-of-day recorded.
- **Boot (B).** Load the transform and the chunk index; build the same terrain, strip, spline,
  station grid and structures as today. Nothing the car needs changes.
- **Dynamic (C).** Stream splat chunks ahead of the car by `s` (the grass tile scheduler is the
  same idea), unload behind. Render splats with depth writes into the same depth buffer as the
  meshes so the car, props, weather and grass sort against them; a distance band fades from
  splats (near, where captured, ±50 m of the road) to geometry (far terrain, horizon, far trees).

What it costs: a splat is a photograph — one season, one time of day, one traffic state. Seasons
and weather then become colour grading over the splats plus the geometry layers we keep drawing
(snow accumulation, wet road, particles), or one capture per season. The sun in the scene has to
match the capture. Anything the game changes (authored bridges, autogen buildings, cut-face rock)
is a mesh in front of the splats, so a splat captured with a real bridge and a game without one
cannot coexist — the authored world has to win, meaning splat editing (delete a region) is part
of the bake. The renderer: `@mkkellogg/gaussian-splats-3d` or Spark composite into a three.js
scene with depth today; the strip's height function can also be *improved* by splat depth where
the lidar is old (Bowie's is 2014).

## Part 4 · This agent's additions (terrain-and-data, 2026-09-21)

New bake modules, each additive in `export.py` (a manifest key each) and each with a viewer
consumer:

| bake | manifest key | viewer | detects |
|---|---|---|---|
| `cuts.py` | `cuts` | `rocks.ts` | cut faces from `profile.ground_rel` + the DTM: ground rising > 0.6 m/m within 15 m of pavement for ≥ 20 m; `artificial` (straight, constant slope, parallel to the road) vs `natural` (ravine walls both sides, following a stream) |
| `rock.py` | `rock` | `rocks.ts` | exposed rock: bare ground (no canopy) with high 1 m roughness, slope > 30°, lithology from `geology.json`, NAIP grey/brown → polygons with a rock type; the kit is 4–6 boulder/ledge GLBs per lithology |
| `water.py` | `water` | `water.ts` | OSM `waterway=*` / `natural=water` snapped to the DTM low line → water mesh with an animated normal shader; falls where a stream drops > 2 m over 20 m → whitewater strip |

See `DESIGN.md` for the rules and `SITES.md` for what each baked site actually contains.

## Appendix · Running it

```bash
just corridor-sites                    # photos → sites.json (or hand-edit sites.json for a lat/lon)
just corridor-fetch <slug>             # one site; `all`; `--skip lidar` for a quick pass
just corridor-export [slug]            # rewrite web/ + index.json without refetching (--resurface re-measures)
tools/corridor/.venv/bin/python -m corridor areas <slug>     # seed adjustments.json
tools/corridor/.venv/bin/python -m corridor report
just corridor-view                     # :5185; /editor.html on the same server
just corridor-tunnel                   # devproxy :5190 + cloudflared, for the phone
tools/corridor/.venv/bin/python tools/surfaces/gen.py [class] # regenerate a texture set
```

Licences: USGS 3DEP and NAIP public domain; OSM ODbL (attribute; share-alike on derived *data*);
Macrostrat CC-BY; ez-tree MIT; TRELLIS.2 per its licence banner in the recon service.
