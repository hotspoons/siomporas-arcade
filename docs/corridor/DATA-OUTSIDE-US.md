# Baking outside the United States

**Status:** research, 2026-09-22. Nothing built.
Every number here was fetched live on the date above, not cited. Where I did not verify something
I say so.

## The short version

Roads and geology already work worldwide. Canopy already works worldwide and is *easier* than what
we do now. Imagery is fine in France and 10x worse everywhere else. **Elevation is the problem**,
and it is a bigger problem than "lower resolution" — the free global product is a *surface* model,
so it has the trees in it.

## Layer by layer

| layer | US today | outside the US | verified |
|---|---|---|---|
| roads | OSM via Overpass | same, no change | Stelvio bbox, 52 ways, 2.5 s |
| geology | Macrostrat | **Macrostrat is already global** | Stelvio → gneiss/mica schist; Chamonix → carbonate; Dolomites → felsic volcanics |
| canopy | USGS lidar EPT → our own CHM | **Meta/WRI global 1 m canopy height**, anonymous on AWS | Chamonix forest: mean 13.6 m, max 31 m, 82.5% of pixels >2 m |
| imagery | NAIP 1 m | France: IGN BD ORTHO. Elsewhere: Sentinel-2 10 m | IGN z18 tile, 20 013 distinct colours; S2 scene over Stelvio **today**, 0.1% cloud |
| elevation | USGS 3DEP **1 m DTM** | Copernicus GLO-30 **30 m DSM** | Stelvio 2760.0 m vs published 2757; Umbrail 2498.6 vs 2501 |

## Geology: nothing to do

Macrostrat answers anywhere. My first test said "0 units" for *both* Italy and Maryland, which is
how I knew the test was wrong rather than the coverage — I had added a `scale=large` parameter the
bake does not send. Control first, always.

## Canopy: better than what we have

`s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/` — 56 145 tiles, 1.19 m, EPSG:3857,
anonymous, COG, with a `tiles.geojson` index. One tile covers each of Stelvio, Chamonix and
Crofton.

Stelvio reads 0.0 m over a 600 m window. That is **correct, not missing** — the pass is at 2757 m,
above the treeline — and the way to know the difference is the Chamonix window in the same tile
pyramid reading 13.6 m mean with 82.5% of pixels above 2 m. A single point sample could not have
told those apart.

This could replace the EPT lidar fetch **in the US too**. We currently pull point clouds and build
a CHM ourselves; this is the same product, precomputed, globally, at the same resolution.

## Imagery: France is better than NAIP, everywhere else is 10x worse

**France** — `data.geopf.fr`, no API key, open licence. `HR.ORTHOIMAGERY.ORTHOPHOTOS` over WMTS
returned a real z18 tile (≈45 cm/px at that latitude). The same endpoint carries LiDAR HD layers
including **MNH — a canopy height model** — and `IGNF_ORTHO-61_RVB_0M08` at 8 cm for test zones.

**Everywhere else** — Sentinel-2 L2A at 10 m, via the Element84 STAC API. Free, global, and
refreshed constantly: the Stelvio search returned a scene from the same day at 0.1% cloud.

10 m against NAIP's 1 m is the honest cost. Lane markings are 10 cm; at 1 m they are already
inferred rather than seen, and at 10 m a two-lane road is one pixel wide. Road surface appearance
would have to come from the OSM tags and our own materials, not from the photo — which is arguably
where it should come from anyway.

**One useful accident:** `https://earth-search.aws.element84.com/v1/` serves `naip`,
`sentinel-2-l2a` AND `cop-dem-glo-30` from one STAC API. A single code path could replace three
bespoke fetchers, US and EU both.

## Elevation: the actual blocker

Copernicus GLO-30 is accurate where it is defined — **+3 m at the Stelvio Pass, −2 m at Umbrail**,
against published pass heights. That is not the problem. Two other things are:

1. **30 m, not 1 m.** At 46.5°N a cell is about 21 m east-west by 30 m north-south. A Stelvio
   hairpin is roughly 20 m across. The pass's 48 switchbacks would be *below the sample spacing* —
   the geometry that makes the road worth driving does not exist in the data.

2. **It is a DSM, not a DTM.** GLO-30 is a surface model: forest canopy and buildings are in the
   elevation. Our whole pipeline assumes bare earth, with canopy carried separately in the CHM.
   Through woodland the road would ride on treetops.

Point 2 is the one that bites. Point 1 we already work around — the road surface comes from OSM
geometry draped on the DEM, and `CAR_CREST_GAIN` exists because one-tick height derivatives off a
DEM already fling the car. A coarse DEM is a worse *landscape*, not necessarily a worse *road*.

### Options, roughly in order of effort

- **France: solved.** RGE ALTI is a 1 m lidar-derived DTM. The point API returned 1035.66 m at
  Chamonix, which is right. Bulk access is tile download, not this API — **unverified, and the
  thing to check first.**
- **Italy: TINITALY, 10 m**, from INGV. Site answers 200; I did not test a download or confirm the
  licence. Regional lidar (Lombardia, Trentino, Alto Adige) is finer still and is per-region
  plumbing. **Unverified.**
- **Pan-EU fallback: GLO-30**, accepting a DSM. Subtracting the Meta CHM from the DSM gets closer
  to bare earth — the CHM is 1 m and the DSM is 30 m, so this is approximate, and it is a real
  technique rather than a hack. **Untested.**
- There is no single 1 m bare-earth DTM for Europe. Each country publishes its own.

## What I would do

Make an Italian pass bake *at all* before making it bake well: GLO-30 plus Sentinel-2 plus the
global CHM plus Macrostrat is four sources, all anonymous, all verified reachable today, and it
would put the Stelvio on screen. Then judge whether 30 m elevation actually ruins it, with the
thing in front of you rather than in the abstract.

The sequencing argument is that France is the only country where we can currently beat our US
quality, and it would be a mistake to build France-specific plumbing first and conclude that
Europe is solved.

## Also worth knowing

Our bake's `fetch --skip` already takes `dem,naip,lidar,geology,horizon,surface`, so a site can be
baked with any subset. That is the seam these sources would slot into; nothing needs restructuring
to try one.
