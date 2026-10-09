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
| `naip.tif` | natural colour, 0.3 m | USGS NAIPPlus |
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

Grading costs the pyramid stage roughly a third again (crofton-triangle: 40 s → 54 s of the 1.5
minute export, of which 8 s builds the station field once and ~2 minutes of worker CPU grades
241 tiles). `CORRIDOR_GRADE=0` turns it off. The knobs the grading reads are tuning.ts's
DEFAULTS (`grade.Knobs`): a browser whose F6 panel moved LANE_WIDTH or BRANCH_VERGE is standing
on ground the bake graded for the defaults. Two things the raster cannot carry: the editor's
`ground_offset_m` adjustments (the viewer keeps run-time grading on a site whose adjustments are
active) and the `GRASS_LIFT_M` turf lip (a knob, default 0).

    tools/corridor/.venv/bin/python -m corridor export <slug>          # re-bake web/, graded
    tools/corridor/.venv/bin/python -m pytest tools/corridor/tests/test_grade.py

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

USGS 3DEP, NAIP: public domain. OpenStreetMap: ODbL (attribute; share-alike applies to derived
*data*, not to a rendered game). Macrostrat: CC-BY. Say so in the credits.
