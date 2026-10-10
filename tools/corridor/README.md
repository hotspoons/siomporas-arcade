# corridor — a strip of real road, and everything the public record knows about it

Feed it a photo taken from the car. It reads the GPS fix, finds the carriageway you were on, and
pulls a couple of miles either side of you from every open source that has something to say about
that road: what OSM knows (lanes, speed, bridges, barriers, what crosses it), the bare-earth DEM,
30 cm aerial imagery, the classified lidar point cloud, and the geology the cut faces expose.

The output is a directory per site with one metric frame (the site's UTM zone) and a handful of
files the game side can read without knowing what a Web Mercator metre is. This is step one of
the real-road driving game: measure first, generate second.

```bash
just corridor-sites                       # ext/ref-driving/*.jpg -> sites.json
just corridor-fetch south-mountain-i70    # one site (or `all`); add `--skip lidar` for a quick pass
just corridor-report
tools/corridor/.venv/bin/python -m corridor.verify        # every site: safe to publish?
just corridor-view                        # the viewer, :5185 (apps/corridor)
just corridor-export                      # rewrite web/ layers + surface.json without refetching
tools/corridor/.venv/bin/python -m corridor flora all     # backfill flora.json onto older bakes
```

## What a site directory holds

| file | what | from |
|---|---|---|
| `site.json` | photo fixes, `frame` (EPSG + origin), `bbox_utm`, the corridor polygon | EXIF |
| `spine_utm.json` | the carriageway we drove, metres, trimmed to ±3219 m of the photo; per-way OSM tags by along-track metre; sibling chains (the other carriageway, ramps) | OSM |
| `spine.geojson` | same line in WGS84, for anything that wants a map | OSM |
| `osm.geojson` | every tagged way/node in the corridor, raw tags | OSM (Overpass) |
| `crossings.json` | ways that cross the spine, and OSM's guess whether they pass over or under | OSM |
| `dem_1m.tif` | bare earth, 1 m | USGS 3DEP via TNM |
| `naip.tif` (`naip_1m.tif` on a network site, 0.6 m) | natural colour, 0.3 m | NAIP: Planetary Computer COGs, USGS NAIPPlus as the fallback (below); Sentinel-2 outside the US |
| `lidar/corridor.laz` | the classified points within 200 m of the spine, in the site frame | USGS 3DEP / NOAA Digital Coast Entwine, TNM tiles as fallback |
| `lidar/dtm.tif` `dsm.tif` `chm.tif` `deck_z.tif` `deck_n.tif` `building_n.tif` | ground, surface, canopy height, bridge-deck height and density, building density — 1 m | derived |
| `profile.json` | every 2 m along the spine: road z; ground height relative to the road at 8/15/25/40/60 m left and right (cut vs fill); canopy at the same offsets; **structures** — bridges we are on and overpasses over us, measured from class-17 returns | derived |
| `horizon_30m.tif` | 60 km of elevation around the site at 30 m — the far hills | USGS 3DEP seamless |
| `surface.json` | every 20 m: pavement class (asphalt_new/aged/patched, concrete, chipseal) from lidar intensity inside the lanes, NAIP brightness and OSM `surface=`; per-segment majority | derived |
| `web/manifest.json` `buildings` / `landuse` / `pois` | per-footprint minimum rotated rectangle, height (OSM → lidar DSM−DTM → 6 m) with its source, along-track `s` and signed lateral `lat`, tags enriched from POIs inside; for the editor agent's autogen (AUTOGEN.md §10) | derived (`corridor/buildings.py`) |
| `web/` | browser-decodable layers + `manifest.json` for `apps/corridor` and the R2 publish: RGB-encoded height PNGs, 1 m imagery JPEG, canopy PNG, spine/structures/profile/surface in metres from the origin | derived |
| `geology.json` + `geology.geojson` | Macrostrat map units under the spine, with lithology and description | Macrostrat |
| `flora.json` + `flora_evt.npy` | what grows here: LANDFIRE vegetation classes with their share of the corridor, a ranked tree-species mix per class with genus and a lidar-measured canopy height, a ground-cover class per vegetation type, and Daymet monthly climate (`corridor/flora.py`; sources, fallbacks and traps in `docs/corridor/FLORA.md`) | LANDFIRE + USFS FIA/FHP + Daymet |
| `preview.png` | imagery + spine (yellow), siblings (orange), crossings (red over / blue under), structures (cyan overpass / magenta bridge), photo (white ring), canopy (green) | derived |
| `cuts.json` | cut faces beside the road from 1 m DTM transects: interval, side, `artificial`/`natural`, toe/top/height/slope, rock type, toe+top `[x,y,z]` every 10 m (`corridor/cuts.py`; rules and measurements in `docs/corridor/DESIGN.md` §5) | derived |
| `rock.json` | exposed rock polygons: slope > 40° with ≥ 3 m relief, bare or inside a cut, with lithology, intensity and NAIP colour (`corridor/rock.py`) | derived |
| `water.json` | OSM waterways snapped to the DTM low line with heights, culverts flagged, falls/rapids; ponds flat at their median ground (`corridor/water.py`) | OSM + derived |
| `branches.json` | network sites only: every non-primary road chain with its own lidar profile and structures (`corridor/network.py`) | derived |
| `lidar/tiles/`, `lidar/*.vrt` | network sites over 6 km: 1 km raster tiles and VRTs over them (`corridor/network_tiles.py`) | derived |
| `manifest.json` | what was fetched, from where, when, how long | — |

## The graded ground (web/pyr, 2026-10-09)

The viewer used to grade the ground at run time — `scene.ts`'s `gradedHeight` folding every road's
profile into the DEM, ~4 µs a sample, and the physics heightfield asks it 1,089 times a tile. The
bake knows every grade, so `pyramid.bake` now writes the fine levels of the pyramid (z13 and z14
at this latitude — a pixel under 6 m; coarser ones stay bare, a 10–40 m pixel cannot hold a 7 m
verge) with the road grading folded into `dem.png`, and the earth as sampled beside it as
`bare.png` (`entry.bare = {zmin, zscale}`), under a `layers.pyramid.graded = true` flag. The
grading is `corridor/grade.py`: a line-for-line port of the viewer's formula — the station field,
`edgeDistance`, the Catmull-Rom splines (checked against three.js to 1e-9), the junction meet,
the cul-de-sac bulbs, the driveways — built from the manifest the viewer will read, so the
pyramid bake runs after the branches and the intersections are in it. The bake also writes its
deck decision into that manifest (`spine.elev_s`, `branches[].elev_s`: the station runs it
treated as elevated, from the 1 m DEM, in runs of three stations or more), so the viewer's deck
colliders and strips call the same stations decks as the raster does — it used to decide at boot
against the 8 m overview — and driveway stations stand on the z the bake wrote for them (and a
driveway point between two coincident shape points takes its direction from the nearest distinct
one; a station with none claimed pavement over a 160 m square, in the viewer and in the port). A viewer
that sees the flag reads the raster for `physGroundAt` and the strips and asks `bareAt` for the
deck tests; an older bake grades at run time exactly as before. One place the raster cannot
answer: a bilinear cell that spans a step — two carriageways at different heights within a pixel
(a ramp on its main line) — smears the step over 2.3 m, so a cell spanning more than 0.5 m takes
the formula (`RASTER_CLIFF_M`, scene.ts). `?grade=runtime` forces the old path on a graded bake,
which is how `probes/corridor-gradedraster.mjs` measures one against the other.

Two things the bake now refuses rather than ships, both found re-baking crofton-triangle
(2026-10-09; the exceptions are `BakeFault`s, which the export's catch-alls re-raise so the job
exits non-zero). **Grades off the earth**: before the decks are decided the carriageways are
measured against the DEM over every non-deck station, and a median beyond `GRADE_OFF_MAX_M`
(0.5 m; the lidar DTM and the 3DEP DEM agree to 2 cm) is a `GradeFault` — the served 2026-10-02
crofton-triangle stood a median 1.28 m up (23 % of its stations "decks") because its branch z was
the raw height from before f208be9 curved the vertical. **Junctions in another frame**:
`junctions[].x/y` in the intermediates are ENU about the origin the file was written with, and
crofton-triangle's site.json moved that origin 1.14 km after the vectors were written, so a
re-export put every junction a kilometre off its road. A junction is now PLACED under the export
frame from the node's lon/lat (`roads` writes it) or, in an older file, the chain's own polyline
at `s`, and asserted onto the road (`network.place_junctions`, 1 m) — reading the file twice is
reading it once, and the file's `frame` tag carries the origin it was written about.

Grading costs the pyramid stage roughly a third again (crofton-triangle: 40 s → 54 s of the 1.5
minute export, of which 8 s builds the station field once and ~2 minutes of worker CPU grades
241 tiles). `CORRIDOR_GRADE=0` turns it off. The knobs the grading reads are tuning.ts's
DEFAULTS (`grade.Knobs`): a browser whose F6 panel moved LANE_WIDTH or BRANCH_VERGE is standing
on ground the bake graded for the defaults. Two things the raster cannot carry: the editor's
`ground_offset_m` adjustments (the viewer keeps run-time grading on a site whose adjustments are
active) and the `GRASS_LIFT_M` turf lip (a knob, default 0).

    tools/corridor/.venv/bin/python -m corridor export <slug>          # re-bake web/, graded
    tools/corridor/.venv/bin/python -m pytest tools/corridor/tests/test_grade.py

## The pyramid's imagery as KTX2 (web/pyr, 2026-10-10)

Every pyramid tile's `.jpg` now gets a `.ktx2` twin beside it (ETC1S, with its mip chain), the
same way the flat `tiles` layer has had one since the tile format landed, and the manifest says so
with `layers.pyramid.texture_ktx2 = "ktx2"`. The viewer prefers the twin when the flag is there
and keeps the jpg path for a bake without it — `pyramidstream.ts` goes through the same
`loadBakedTexture` the overview uses, which also falls back to the jpg if a twin fails to load.
What it buys: the frame a tile's photo first draws no longer decodes a JPEG, uploads a full RGBA
image and generates its mipmaps on the main thread (PERF-RIG.md's 10–12 ms `render` frame on the
Beltway); a ktx2 uploads as blocks it already carries, at a quarter of the GPU memory. Measured
headlessly on crofton-triangle's 512² tiles, `renderer.initTexture` (upload + mips) p50 1.7 ms
on the jpg against 0.2 ms on the twin, p90 3.0 against 0.3.

The encode runs ONCE per bake, in `pyramid.encode_twins`, after the pool has written every
level — so the serial loop, the forked pool and a shard's bake (shards.py merges the twins with
the tiles, and the finalizer's own bake re-runs the encode, which skips a twin that is already
current) all land in the same place. Cost on crofton-triangle: 271 tiles in 24 s wall (88 s of CPU
over eight encoder processes), 17.0 MiB of jpg → 11.7 MiB of ktx2 on the wire — the twins are
ADDED, the jpg stays, so a site's `web/pyr` grows by the twins (13 MB on crofton-triangle's 88 MB). The flag is written only when every
jpg has a twin; one failed encode keeps the whole layer on the jpg path rather than make the
viewer ask per tile. Without the `ktx` binary (`scripts/fetch_ktx.sh`, or `CORRIDOR_KTX`) the
bake says so and carries on.

**The twin is stored bottom-up**, and this is new for every twin this bake writes, not only the
pyramid's. three uploads a plain image with `flipY` — row 0 of the jpg lands at v = 1 — and the
terrain's UVs are written against that (north is v = 1). A compressed texture cannot be flipped
on upload, and three's KTX2Loader ignores the file's orientation metadata, so a twin written
top-down (what `ktx create` does by default, and what `ktx2.py` did until now) draws MIRRORED
north–south. Measured on a pyramid tile drawn through three's own loaders
(`probes/corridor-bakephases.mjs crofton-triangle-bp --phase orient`): row-profile correlation
with the jpg −0.08, with the jpg reversed 0.906; with `--convert-texcoord-origin bottom-left` the
twin and the jpg agree. The overview, horizon and flat-tile twins of every earlier bake are
mirrored in the same way (the pyramid draws over the overview near the eye, which is how it went
unnoticed); a re-export rewrites them, and the viewer did not change.

    tools/corridor/.venv/bin/python -m pytest tools/corridor/tests/test_pyramid_twins.py
    node probes/corridor-bakephases.mjs <slug> --phase ktx2        # the viewer takes the twins; the upload cost
    node probes/corridor-bakephases.mjs <slug> --phase orient      # the same way up as the jpg

## Network sites

A `sites.json` entry with `kind: "network"`, a `roads` list (OSM names or refs), a `primary` road,
a centre and `radius_m` bakes one interconnected region as one site: every road chained, the
primary as the spine, every other road as a branch with junctions, rasters clipped to the union
of the roads buffered 150 m, and — over 6 km a side — 1 km web tiles instead of single images.
`docs/corridor/PIPELINE.md` §1.12 has the detail; `python -m corridor.sitesdoc` regenerates
`docs/corridor/SITES.md` from every bake.

## Why these sources, and the traps in them

**The DEM is not enough.** USGS's 1 m DEM is bare earth: the vendor deletes every bridge deck,
tree and building. Those are exactly the things this game has to place. So the point cloud comes
too, because it keeps the ASPRS classification: 2 ground, 3–5 vegetation, 6 building, **17 bridge
deck**. "Does something cross over this road" is not inferred here — it is *labelled*, at eight
points a square metre. Canopy height is vegetation minus ground; a blasted rock cut is ground
standing 10–30 m above the pavement a few metres off the shoulder (`ground_rel` in the profile).

**Entwine, not delivery tiles.** USGS stages every project as EPT — an octree of LAZ nodes with a
JSON hierarchy — on a public bucket. A 6 km corridor is a few dozen nodes; the same stretch as LAZ
delivery tiles is 850 MB. The bucket has no vertical CRS; Z is checked against the DEM on load and
converted if it is in feet. There is no PDAL on Debian trixie/arm64, so `lidar.py` walks the
octree itself and reads nodes with `laspy` + `lazrs`.

**Where the points come from, in order** (`corridor/lidar_sources.py`). EPT from both agencies,
discovered from their indexes (slim copies in the bake cache, refreshed monthly): USGS's 2,279 3DEP
sets on `usgs-lidar-public` (index: hobuinc/usgs-lidar `resources.geojson`; `lidar.DATASETS` is only
the fallback when that is unreachable) and NOAA Digital Coast's ~1000 on `noaa-nos-coastal-lidar-pds`
(its STAC item collection). Only when EPT covers under half the streets, the USGS delivery tiles
through TNM — whole LAZ files from rockyweb, ~80 KB/s a connection, fetched 16 at a time. The
primary is the newest survey over at least half the streets and later ones fill only the 25 m cells
it left empty (Crofton: NOAA 2020 Anne Arundel, then 2018 Prince George's for the western edge — the
whole bake in 4.7 minutes instead of six hours; Pikes Peak: USGS CO_Eastern_ElPaso_2018; Mount
Desert Island: USGS ME_MidCoast_1_2021 over NOAA's 2010). The walk stops
at the depth that reaches `CORRIDOR_LIDAR_DENSITY` points/m² (default 8). `CORRIDOR_LIDAR_SOURCE=tnm`
forces the delivery tiles when the newest vintage matters more than the hours. Tests:
`.venv/bin/python -m unittest discover -s tests`.

**NAIP comes from Microsoft's Planetary Computer first, USGS's ImageServer second** (2026-10-10,
after USGSNAIPPlus answered 504 for an hour and killed two dc-metro bakes). The Planetary Computer
holds the USDA's own quarter-quad COGs (RGB+NIR, 0.3 m in Maryland's 2023 cycle, 0.6 m in
Virginia's), found by a STAC search and read with HTTP range requests over GDAL's `/vsicurl/` with a
free SAS token — no account, no credentials; it is refreshed when it nears `msft:expiry`. The AWS
Open Data NAIP buckets were measured too and are requester-pays, so they are not used. ONE YEAR
first (Rich, 2026-10-10): over the whole area being baked — the WORLD's bbox, so every shard picks
the same — the newest year whose leaf-on items cover all but `CORRIDOR_NAIP_YEAR_MAX_BARE` (default
2 %) of what any year covers is read alone — the state covering most of the world first (over DC,
Maryland's 2021-06 at 82 % before Virginia's hazy 2021-09 at 39 %), then finer, then later —
and everything else only fills its holes. A cloud mask (bright, grey, smooth blobs ≥ 3 ha that
another flight sees ≥ 35 darker) exists but is OFF unless `CORRIDOR_NAIP_CLOUDS=1`: it found the
12.6 ha cloud over Shaw and also took sun glint on the Tidal Basin for a 33 ha one.
dc-metro-take-2 picks 2021 (MD June, VA September; 2023 covers 81.9 %, Virginia's 2023 is leaf-off),
crofton-triangle 2023 at 0.3 m. `CORRIDOR_NAIP_YEAR=auto|<yyyy>|off`; `off`, or no year covering
enough, is the per-pixel ranking that follows, and `naip.year` in the manifest says which and why
(the year is part of the cached piece's name too). Within the per-pixel ranking a
LEAF-ON flight (`CORRIDOR_NAIP_LEAF_ON`, months, default `5-9`) beats a leaf-off one up to
`CORRIDOR_NAIP_LEAF_ON_YEARS` (default 2) years newer — Virginia flew 2023 in October and November,
red maples beside Maryland's September, so Arlington takes VA 2021-09-10 instead — then the newest
year wins, the finer item, the later date, and older items fill only the pixels the ones before
leave black (a state line, a quarter-quad's collar, a missing quarter-quad, NAIP's white redaction
rectangles). The rule is recorded in the manifest's `naip.rule` and keys the cached pieces. Red,
green and blue are read by NAME — the asset's `eo:bands` and the COG's colour interpretation must
agree, an item where they do not (or a CIR product) is skipped, never painted. Each item is read at
the coarsest overview no coarser than the lattice, then warped onto it — the lattice and the file
names do not change (`naip.tif` at 0.3 m, `naip_1m.tif` at `NAIP_RES_M`, the 60 m horizon JPEG).
Pieces cache under `data/cache/naip/` as `pc_<tile>_<rule>.jpg` beside a `.json` naming the items that fed
them, and the manifest's `naip` records the source, the items, their years and resolutions.
`CORRIDOR_NAIP_SOURCE=auto|pc|usgs` (default `auto`): `auto` turns to the ImageServer when the
Planetary Computer cannot answer (about two minutes of 5xx, then a breaker sends every remaining
tile there), and asks it for a second opinion where the catalogue is empty (it has no Hawaii or
Alaska); a forced source never falls back. An outage is never "no imagery": only an empty search
whose control over Crofton is full means "not covered" and drops to Sentinel-2; when neither source
can answer the bake stops with a `BakeFault`. `CORRIDOR_NAIP_PC_STAC` / `CORRIDOR_NAIP_PC_TOKEN`
override the endpoints, `CORRIDOR_NAIP_JOBS` (default 6) the tiles fetched at once.
Registration: the Planetary Computer path matches `gdalwarp` of the COG to 0.003 px; the ImageServer,
asked for the site's WGS84 UTM, shifts the same photograph 0.6-1 m north (it matches the COG exactly
in the COG's own NAD83 UTM), so imagery moves that much south against older bakes — onto the DEM and
lidar, which PROJ reprojects the same way this path does. Measured: ImageServer rasters sit exactly
one row (0.6 m) north at the 0.6 m lattice, 0.96 m at 0.3 m. Caveat: in `auto`, a bake whose
tiles came from both sources shows that step as a seam at the tile edges; `tiles_by_source` in the
manifest says when that happened.

**LANDFIRE's class at the centre of a corridor is always `Developed-Roads`.** The site point is on
the pavement by construction, and LANDFIRE has a 30 m class for pavement. Vegetation is read as AREA
SHARES over the whole corridor polygon, the way land use already was. The other traps in the flora
sources — a multidimensional `getSamples` that silently truncates at 100 rasters and drops red
spruce at Acadia, 2002 genus rollups that double-count against the 2011 species, basal-area rasters
that are dense in the East and 3 % populated at Big Sur — are written up in `docs/corridor/FLORA.md`.

**Overpass is a shared free server.** Every query is cached by hash under `data/cache/overpass/`,
so a re-run is offline; a 504 is retried with backoff. Do not point `all` at it in a loop.

**The photo's fix lags the car.** Frames a second apart share one coordinate and a frame a minute
later can carry a fix from a kilometre back. Photos within 400 m are one site, and the site is
snapped to the nearest drivable way — `snap_distance_m` in the manifest says how far.

**The road is identified by OSM `ref`, never by hand.** `nearest_road` reads `ref` (I 70, MD 200)
or `name` off the closest carriageway, then chains every way carrying that identity through shared
node ids. Divided highways come out as two one-way chains; ours is the spine, the other is a
sibling — the game needs both to measure the median.

**Structures are classified by continuity, not by height.** A deck 10 m above the DEM is either
a bridge we are on (valley below) or an overpass above us (our road is the ground). The profile
interpolates the road grade across the deck run from the pavement either side: if the deck sits on
that line we are on it, if the ground does, it is over us. The OSM crossing with a `bridge` tag at
the same along-track metre is the cross-check.

## Running it on the cluster

The bake belongs on the cluster, not a laptop: a handful of sites is tens of GB of cache and the
cluster has the storage and the bandwidth to USGS. `Dockerfile` builds a pure-Python image (every
dependency ships arm64 and amd64 wheels, so one QEMU buildx job emits both — see
`.github/workflows/corridor-image.yml`), and `chart/` runs it as a **Job** onto a PVC:

```bash
helm upgrade --install corridor tools/corridor/chart -n default          # bake `all` onto the PVC
helm upgrade --install corridor tools/corridor/chart -n default \
  --set publish.enabled=true --set publish.bucket=apex-corridor \
  --set publish.endpoint=https://<account>.r2.cloudflarestorage.com      # ...then sync to R2
kubectl logs -n default job/corridor-<revision> -f
```

Each `helm upgrade` is a new Job (named by release revision); a re-bake of a baked site is about a
minute because every source is cached on the volume. The PVC carries `helm.sh/resource-policy:
keep` — the cache is the expensive part. Credentials for the bucket come from a Secret
(`corridor-r2`, keys `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`; an R2 API token is exactly that).

**Publishing** (`python -m corridor publish`) mirrors `data/sites/` to `s3://<bucket>/corridor/sites/<slug>/...`
and writes `corridor/index.json` listing every site with its manifest. That is the shape the
arcade Worker will read: one fetch for the index, then per-site objects by key, nothing baked
into the Worker bundle. Objects whose size already matches are skipped, so it is safe to run
after every bake.

**Horizon.** `horizon_30m.tif` is 60 km of 3DEP seamless elevation around each site at 30 m —
the far terrain that puts Catoctin and South Mountain on the windscreen from 20 km out. It is the
LOD-far layer to the corridor DEM's LOD-near; both are NAVD88 metres in the site frame, so the
blend is a resampling problem, not a datum one.

## Ported from trailworks

The DEM (TNM API path) and NAIP fetchers are lifts from `ext/trailworks/pipeline/ingest/`,
trimmed to what a corridor needs: no S3 bucket index, no tile lattice, no exaggeration. What
trailworks does not have — the point cloud, the along-track profile, the structure inference — is
new here and is the part this game is actually about.

## Licences

USGS 3DEP, NAIP (USDA FSA; read from the Planetary Computer or USGS): public domain. OpenStreetMap: ODbL (attribute; share-alike applies to derived
*data*, not to a rendered game). Macrostrat: CC-BY. Say so in the credits.
