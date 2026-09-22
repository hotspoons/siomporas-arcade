# Baking outside the United States

**Status:** the global DEM and imagery rungs are BUILT and an Italian pass bakes. 2026-09-22.
Sources below verified twice — once by the research pass, once again by me before building on them.
Every number here was fetched live on the date above, not cited. Where I did not verify something
I say so.

## The short version

Roads and geology already work worldwide. Canopy already works worldwide and is *easier* than what
we do now. Imagery is fine in France and 10x worse everywhere else.

**The elevation verdict has changed, and it changed by measurement.** The research pass expected
30 m sampling to destroy the Stelvio's switchbacks — "the geometry that makes the road worth
driving does not exist in the data". It does. Measured on the baked site: the switchback legs sit
a median **34.2 m** apart in plan, which is *wider than a 30 m cell*, so consecutive legs land in
different cells and GLO-30 gives them a median **17.5 m** of height separation against the
**18.5 m** the road's own average grade implies — **94%**. Only 1% of 3 858 stacked pairs come out
within a metre of each other.

The remaining elevation problem is the one that was always the real one: **GLO-30 is a surface
model**. Above the treeline, where an alpine pass mostly is, that costs nothing. In woodland the
road rides on the canopy, and that is still unsolved.

## What is built

`dem.py` has a rung below the USGS ladder: when TNM returns nothing at 1 m, 1/9 or 1/3 arc-second,
it reads **Copernicus GLO-30** straight off the COGs over `/vsicurl` — no download step, the same
`gdalwarp` that puts a USGS tile on the site lattice. `native_res_m: 30` and `surface_model: true`
go in the manifest so nothing downstream has to guess.

`naip.py` has `covered()` and `fetch_sentinel2()`, and `network_tiles.naip_tiled` routes through
them. See **the black JPEG**, below — that one nearly shipped.

A pass bakes:

```
stelvio-ref   SS38, 17 952 m of spine, 1 277 -> 2 757 m
              dem   Copernicus GLO-30, 1 tile, 30 m surface model
              naip  Sentinel-2 S2C_32TPS_20260904_1_L2A, 0.0% cloud, 10 m on a 1 m lattice
              geology 13 Macrostrat units
              81 distinct hairpins in the spine geometry
```

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

Built as `corridor/canopy.py`, with `python -m corridor.canopy <slug>` to add a canopy layer to a
site baked without lidar. Verified with the control this file already warned about: the Stelvio
reads 0.0 m over a 600 m window (correct — the pass is above the treeline) while Trafoi, in the
same tile, reads 4.6 m mean and 29.0 m max with 45% of pixels above 2 m.

### It is NOT a drop-in replacement for the US lidar CHM

The research pass suggested this "could replace the EPT lidar fetch in the US too — the same
product, precomputed". **Measured against our own lidar CHM at three baked sites, it is not the
same product.** Same bounds, same 1 m lattice, no registration shift (testing ±3 px moves binary
agreement from 60% to 61%):

| site | ours >2 m | Meta >2 m | binary agreement | Meta says tree, ours does not |
|---|---|---|---|---|
| arrowhead-farms (suburban) | 27.6% | 58.2% | 60% | **35.3%** |
| acadia-ocean-dr (Maine coast) | 25.1% | 54.5% | 65% | **32.4%** |
| south-mountain-i70 (highway) | 3.5% | 29.9% | 72% | **27.1%** |

26.5 million pixels, two states, three landscapes, one direction: **Meta reports about twice the
tree cover our lidar CHM does**, and the disagreement is one-sided — ours-says-tree-Meta-does-not
is only 4.7% at arrowhead-farms against 35.3% the other way. Where both agree there is a tree, the
heights are closer (mean −1.71 m) but still only 38% within 3 m.

**Which one is right is NOT established here.** Meta/WRI is a global model predicted from imagery
and calibrated against GEDI and ALS, so smearing canopy across suburban gaps is a plausible
failure; equally, `lidar.py`'s vegetation-minus-ground thresholds could be under-reporting, and
south-mountain-i70 at 3.5% tree cover for a wooded Maryland highway corridor does look low. That
needs ground truth to settle and did not get it.

The actionable part does not depend on settling it: **swapping the US CHM for this would visibly
double the trees in every baked US site**, so it is not a free simplification. Outside the US it is
the only option and a good one.

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

## The black JPEG: how NAIP says "not here"

`USGSNAIPPlus/exportImage` does not fail outside the United States. It answers **HTTP 200 with a
valid, entirely black JPEG**. One 32x32 export from each of two places:

```
Stelvio pass (Italy)   200  image/jpeg  659 B     1 distinct colour,   0% non-zero
Crofton (Maryland)     200  image/jpeg  905 B   390 distinct colours, 100% non-zero
```

This is the same shape as the Overpass silent empty — a well-formed success carrying nothing — and
it is why the first Stelvio bake produced a **6830 x 3450 image containing exactly one colour** and
a completely green log. `naip.covered()` therefore asserts CONTENT, not a status code, and the two
measurements above are what prove the assertion can tell them apart.

## Road identity breaks at a language border

Two separate problems, both found on the Stelvio, both costing a whole spine:

1. **One state road, four names.** South Tyrol is bilingual, so `SS38` is tagged
   `Stilfserjoch Staatsstraße - Strada Statale 38 dello Stelvio` (31 ways, the east ramp),
   `Strada Statale 38 dello Stelvio` (25, the west), `Stilfserbrücke - Via Ponte Stelvio` (9) and
   `Gomagoi` (6). `network.roads` groups by `name`, so the pass became four roads and the spine
   went 11.5 km down the *wrong side* — climbing 852 m instead of 1 481.
2. **`REF_RE` is US-only**: `^(MD|US|I|VA|PA|CA|OR|ME)[ -]?\d+...`. So `roads: ["SS38"]` is treated
   as a name, matches nothing, and the obvious fix is unavailable.

Worked around by listing all four names. **The real fix is to generalise `REF_RE` and to prefer
`ref` over `name` when chaining** — `network.py` is not this lane's file, so it is written up here
and raised rather than changed.

## Elevation: measured, and less of a blocker than it looked

Copernicus GLO-30 is accurate where it is defined — **+3 m at the Stelvio Pass, −2 m at Umbrail**,
against published pass heights. That is not the problem. Two other things are:

1. ~~**30 m, not 1 m.**~~ **Tested on the baked site, and it does not happen.** The claim was that
   the switchbacks fall below the sample spacing. The measurement says otherwise:

   | | |
   |---|---|
   | stacked leg pairs (within 40 m in plan, >200 m apart along the road) | **3 858** |
   | their plan separation | median **34.2 m** — wider than a 30 m cell |
   | height gap GLO-30 gives them | median **17.5 m**, max 31.9 m |
   | gap implied by the road's own 8.3% average grade | **18.5 m** |
   | so the DEM delivers | **94%** of the real separation |
   | pairs collapsed to within 1 m | 28 of 3 858 (**1%**) |

   The road centreline comes from OSM, not from the DEM, so the hairpins exist regardless; the
   question was only whether the DEM could give two stacked legs different heights, and at this
   pass it can.

   **A caution on counting hairpins.** Per-vertex heading change reported **zero** hairpins on a
   road that has 81, because OSM maps the curve densely and each vertex turns at most 33°.
   Cumulative turn over a 120 m window finds all 81. If you measure hairpins, measure the
   cumulative turn.

2. **It is a DSM, not a DTM.** GLO-30 is a surface model: forest canopy and buildings are in the
   elevation. Our whole pipeline assumes bare earth, with canopy carried separately in the CHM.
   Through woodland the road would ride on treetops.

Point 2 is the one that bites, and it is now the ONLY one. Point 1 we already work around — the road surface comes from OSM
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
