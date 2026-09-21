# Flora — the right trees and the right ground, from the public record

Rich, 2026-09-21:

> Is there a canonical source of data we can use to correctly set the tree types for a given map in
> corridor? Right now everything gets mid-Atlantic trees. Definitely would like to see pines or
> whatever conifers are in MDI, and some pines and sequoias in CA, and regionally appropriate trees.
> It would be great if we could automate this from government climate data.
>
> Also ground cover should be more than just grass — in California everything is brown, I'd love
> whatever that brown ugly ground cover is called (is it just dirt and sand, or are there plants in
> California?) and make this legit.

**Yes, there is a canonical source, and it is not climate data.** It is **LANDFIRE Existing
Vegetation Type** — 30 m, the whole United States, updated every year, about a thousand named plant
communities, free, public domain, and served from an endpoint that answers in under a second. It
does not say what *could* grow beside a road; it says what a satellite and several thousand field
plots agree *is* growing there. Climate rasters answer a different question, and the difference
matters: on the same latitude and in the same Köppen class, Big Sur's road is bay laurel over
chaparral and Chesterfield Road is white oak over turf.

Climate still earns a place, for the one thing it is the only source for: **when** any of it is
green. That is where Rich's guess lands, and it lands hard — see [§5](#5-daymet-and-the-brown).

---

## 1. The sources, and what each is for

| source | what it gives | res | coverage | endpoint | licence |
|---|---|---|---|---|---|
| **LANDFIRE EVT** (LF2024) | the vegetation class of every pixel: ~1000 NVC ecological systems by name, with lifeform, physiognomy, canopy closure and **evergreen / deciduous / annual** subclass | 30 m | CONUS + AK + HI, annual | `lfps.usgs.gov/arcgis/rest/services/Landfire_LF2024/LF2024_EVT_{CONUS,AK,HI}/ImageServer` | public domain (USGS/USFS) |
| LANDFIRE EVT attribute table | `VALUE` → `EVT_NAME`, `EVT_LF`, `EVT_PHYS`, `EVT_CLASS`, `EVT_SBCLS`, RGB | — | — | `landfire.gov/sites/default/files/CSV/2024/LF2024_EVT.csv` | public domain |
| **USFS FHP tree-species basal area** (NIDRM 2013–2027, Wilson et al.) | basal area ft²/acre for **340 named species**, one multidimensional slice per species per year | 30 m | CONUS + AK, circa 2002 and 2011 | `imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_FHP_TreeSpeciesMetrics_BasalArea/ImageServer` | public domain |
| **FIA REF_SPECIES** | the species vocabulary: SPCD, common and scientific name, **genus**, softwood/hardwood | — | national | `apps.fs.usda.gov/fia/datamart/CSV/REF_SPECIES.csv` | public domain |
| **Daymet v4** (ORNL DAAC) | daily rain, tmax, tmin at a point, 1980– | 1 km | North America | `daymet.ornl.gov/single-pixel/api/data` | public domain, cite Thornton et al. 2022 |
| LANDFIRE EVC / EVH | canopy cover % and stand height — the cross-check against our own lidar CHM | 30 m | as EVT | same host | public domain |
| EPA Level III/IV ecoregions | polygons, for a regional palette where a raster has no coverage | vector | CONUS | `gispub.epa.gov/arcgis/rest/services/ORD/USEPA_Ecoregions_Level_III_and_IV/MapServer` | public domain |
| NLCD / Annual NLCD | deciduous / evergreen / mixed forest, shrub, herbaceous, barren | 30 m | CONUS | `mrlc.gov/geoserver/mrlc_display/wms` | public domain |
| OSM `leaf_type` / `leaf_cycle` | free, already on disk in `osm.geojson` | vector | wherever a mapper typed it | — | ODbL |

### Evaluated and not used

- **USFS TreeMap (RMRS)** — an imputed FIA plot per forested pixel, and on paper the strongest
  candidate of all. It has **no public ImageServer**: the FS ArcGIS host `apps.fs.usda.gov/fsgisx01`
  now answers *"The service being requested has been migrated to IIPP"*, and the IIPP catalogue has
  no TreeMap service in any of its fifteen folders. It is a bulk download only. Revisit if the bake
  ever runs somewhere with room for a national 30 m raster.
- **NAIP's fourth band.** `naip.py` asks for `bandIds=0,1,2` and the service does carry NIR.
  Evergreen/deciduous separation from a single leaf-on summer image is weak and would have to be
  calibrated per flight; LANDFIRE has already done that work with a multi-date Landsat stack.
  Not built on.
- **OSM `leaf_type`.** Free and already on disk, so it was measured rather than assumed. Across the
  nine test sites, the number of `natural=wood` / `landuse=forest` ways carrying `leaf_type` is
  small enough that it cannot drive anything; it is worth keeping as a future override for an
  individual named wood, not as the mechanism.
- **Köppen / PRISM / plant hardiness zones.** These are the "government climate data" the brief
  guessed at. They say what the climate permits, which is a much larger set than what is standing
  there — and on a coast they are almost constant along the whole corridor. Used for phenology
  only; see §5.

---

## 2. The chain, and what falls back to what

```
EVT class of every 30 m pixel in the corridor          ← always, this is the spine of it
   └─ species mix for each class = f · (FHP basal area over that class's pixels)
                                 + (1−f) · (the class NAME parsed against FIA's vocabulary)
        where f = the fraction of the class's pixels that carry any basal area at all
   └─ ground-cover class for each class, by rule over EVT_LF / EVT_SBCLS / EVT_PHYS
   └─ leaf cycle for each class, straight off EVT_SBCLS
Daymet monthly normals at the site                     ← when it is green, never what it is
```

It is a **blend, not a threshold**, and that is the second version. The first picked the measured
mix whenever a class had eight pixels of basal area and the class name otherwise, which is wrong in
the middle: at Bixby Bridge the class "California Coastal Redwood Forest" cleared eight pixels and
came out **12 % redwood**, because the twelve pixels that happened to carry data were bay laurel.
The class name is data too — LANDFIRE named that community after its dominant tree — so the two
sources are weighted by how much of the class was actually measured. With the blend, Bixby's mix is
California live oak 58 %, redwood 33 %, California laurel 7 %.

`f` varies enormously and is reported per site as `canopy.coverage`: 97 % at Sideling Hill, 85 % at
Acadia, 32 % at Chesterfield Road, **8 % at Bixby Bridge**, 0 % at Frederick. At the top of that
range the answer is the measured plot data; at the bottom it is LANDFIRE's class name; in between it
is both, in proportion.

---

## 3. What it actually returns — the readouts

Printed by `probes/corridor-flora.mjs` and by `python -m corridor flora <slug>`, not predicted.

### acadia-ocean-dr — Park Loop Road, Mount Desert Island, Maine

```
32 EVT classes over 266 ha of corridor
  19.3%  Acadian Low-Elevation Spruce-Fir Forest            Tree   Evergreen closed tree canopy
  18.1%  Open Water                                         Water
  13.7%  Acadian Low-Elevation Spruce-Fir-Hardwood Forest   Tree   Mixed evergreen-deciduous closed
   8.2%  Developed-Roads
   5.5%  Laurentian-Acadian Alkaline Conifer-Hardwood Swamp Tree   Riparian
   4.9%  Acadian Low-Elevation Hardwood Forest              Tree   Hardwood
   4.4%  Laurentian-Acadian Northern Hardwoods Forest       Tree   Hardwood
   2.9%  Northern Appalachian-Acadian Rocky Heath Outcrop Woodland
canopy   85 % of tree pixels carry basal area (14/49 rasters)
         red spruce 34 %, red maple 29 %, paper birch 23 %, white spruce 3 %
ground   conifer_duff 24 %, mixed_litter 22 %, water 17 %, mown 15 %, hardwood_litter 13 %
climate  1352 mm/yr, Jun–Aug 22 % of it
```

### bixby-bridge-ca1 — CA 1, Big Sur

```
35 EVT classes over 382 ha
  29.8%  Northern California Coastal Scrub                  Shrub  Mixed evergreen-deciduous shrubland
  17.4%  California Coastal Live Oak Woodland and Savanna   Tree   Evergreen sparse tree canopy
  13.6%  Open Water
  11.0%  California Coastal Redwood Forest                  Tree   Evergreen open tree canopy
   5.0%  California Northern Coastal Grassland              Herb   Perennial graminoid grassland
   2.6%  California Ruderal Grassland and Meadow            Herb   Annual Graminoid/Forb
   2.6%  Mediterranean California Northern Coastal Dune     Sparse Sparsely vegetated
canopy   8 % of tree pixels carry basal area (8/45 rasters), so the mix is mostly the class names
         California live oak 58 %, redwood 33 %, California laurel 7 %
ground   mixed_scrub 29 %, broadleaf_evergreen_litter 17 %, water 15 %, conifer_duff 12 %
climate  828 mm/yr, Jun–Aug 0.2 % of it
```

### ragged-point-ca1 — CA 1, southern Big Sur

```
  24.0%  Southern California Coastal Scrub                  Shrub
  19.4%  California Coastal Live Oak Woodland and Savanna   Tree
  19.0%  California Central Valley and Southern Coastal Grassland  Herb
canopy   1 % — the species come from the class names
ground   evergreen_scrub 26 %, perennial_grass 20 %, broadleaf_evergreen_litter 19 %
```

### ecola-or — Ecola Park Road, Oregon coast

```
  40.7%  North Pacific Seasonal Sitka Spruce Forest                        Tree  Evergreen closed
  12.5%  North Pacific Maritime Mesic-Wet Douglas-fir-Western Hemlock F.   Tree  Evergreen closed
   9.6%  North Pacific Broadleaf Landslide Forest                          Tree  Deciduous closed
   6.8%  North Pacific Maritime Coastal Sand Dune and Strand               Sparse
canopy   75 %: Sitka spruce 60 %, western hemlock 24 %, red alder 11 %, Douglas-fir 4 %
ground   conifer_duff 53 %, mown 25 %, hardwood_litter 9 %, dune 7 %
```

### chesterfield-rd — the mid-Atlantic baseline

```
  36.4%  Northern Atlantic Coastal Plain Hardwood Forest    Tree   Deciduous closed tree canopy
  15.7%  Southeastern Native Ruderal Forest                 Tree   Mixed evergreen-deciduous open
  14.3%  Developed-Roads
   4.1%  Eastern Cool Temperate Pasture and Hayland         Herb   Annual Graminoid/Forb
canopy   32 %: white oak 67 %, sweetgum 33 %
ground   hardwood_litter 40 %, mown 36 %, mixed_litter 18 %, perennial_grass 6 %
climate  1292 mm/yr, Jun–Aug 32 % of it
```

### sideling-i68 — the one with real forest cover

```
  61.0%  Northeastern Interior Dry-Mesic Oak Forest
canopy   97 % of tree pixels carry basal area (28/85 rasters)
         chestnut oak 25 %, red maple 16 %, northern red oak 16 %, white oak 12 %
ground   hardwood_litter 73 %, mixed_litter 14 %, mown 11 %
```

### frederick-i70 — the one with no forest at all

```
  39.4%  Developed-Roads      19.9% Developed-Medium Intensity      18.6% Developed-Low Intensity
canopy   0 % — no basal-area raster has a single non-zero pixel in this corridor
         the mix is `oak 100 %`, from "Eastern Cool Temperate Urban Deciduous Forest"
ground   mown 98 %
```

Frederick is the fallback working: an interchange in a town has almost no forest, and what trees it
has are street trees. "Oak, mown grass" is the right answer and it came out of the chain rather than
out of a default.

---

## 4. Why these sources, and the traps in them

**The class at the centre of a corridor is always `Developed-Roads`.** The centre point of every
site is, by construction, on the pavement, and LANDFIRE has a 30 m class for that. A point sample
is worthless here: `flora.py` rasterises the corridor polygon and takes area shares over every pixel
inside it, the way `groundcover.ts` already weighted OSM land use by area rather than counting it.

**`getSamples` with `processAsMultidimensional` silently truncates, and drops the most important
species.** It is the obvious cheap call — one request returns every species slice at up to a few
dozen points, in about 30 s. At Acadia it returns 99 rasters and **red spruce is not among them**,
although its raster plainly has data there (mean 10.5, max 237 ft²/ac over the corridor). The
service reports `maxMosaicImageCount: 100`; the truncation is silent, unordered and not flagged in
the response. The reliable call is one `exportImage` per species variable, with the variable and the
year pinned by `mosaicRule.multidimensionalDefinition`.

**340 species is 340 requests unless you ask the catalogue first.** The service holds 7017 rasters —
one per species per year per FIA production zone. A spatial `query` against the raster catalogue
with the corridor's envelope costs one request and names the 45–130 species that have a raster over
this site (45 at Bixby, 49 at Acadia, 102 at Chesterfield). That is the difference between a six
minute bake and a ninety second one, and it is also the honest way to say "these are the species
this dataset models here".

**Never mix the 2002 and 2011 slices.** Taking "the latest year each variable has" looks sensible
and double-counts. The 2002 slices include genus rollups the 2011 slices do not: at Acadia,
`spruce_spp` (2002) = 15.8 ft²/ac and `red_spruce` + `white_spruce` (2002) = 15.8 ft²/ac, to the
decimal — the rollup *is* the sum. Mixed together, "spruce" came out as 44 % of the stand instead of
23 %. `flora.py` pins one year (2011) and drops every `*_spp` and `other_unknown` rollup by rule.

**The basal-area rasters are dense in the East and nearly empty in the West.** At Bixby Bridge only
136 of 4248 corridor pixels carry any basal area at all — 3 % — and the ones that do carry plausible
values (114 ft²/ac of bay laurel, 37 of redwood). The proportions survive; the absolute numbers and
the spatial detail do not. This is the single reason the EVT-name fallback exists, and it is why
the site-wide `canopy.coverage` is reported in the manifest: a consumer can see how much of the
species mix was measured and how much was read off a class name.

**FIA's species table has four placeholder rows filed under the genus "Tree"** — `unknown dead
hardwood`, `other or unknown live tree`, and two conifer equivalents. They match the word
"hardwood" in an EVT class name, and until they were excluded every mid-Atlantic corridor carried a
species called `Tree broadleaf`.

**A group word must be earned.** Reading an EVT class name against FIA's vocabulary means matching
the last word of a common name — "spruce" → Picea, "oak" → Quercus. Two failures, both visible in a
printed mix: "pine" expands to Pinus (54 species) *and* Araucaria, Podocarpus and Casuarina, so a
corridor listed `pine 0 %` twice; and the single FIA species "myrtle of the river" makes "river" a
tree group, which put a Calyptranthes in a Maryland oak wood. A group word now needs three species
and resolves to the one genus with the most of them.

**"Live oak" means a tree in Georgia.** Matching a class name against FIA's common names is a
longest-phrase match, and "California Coastal Live Oak Woodland and Savanna" matches the two words
*live oak* — which FIA files as *Quercus virginiana*, the southern live oak, 4000 km away. FIA also
has *California live oak* (*Quercus agrifolia*), whose name is the matched phrase plus a word that
is already in the class name. A longer common name now wins when every extra word in it appears in
the class name too. The genus and the silhouette were right either way; the species printed in the
manifest was not, and a manifest nobody can trust at the species level is not worth writing.

**LANDFIRE's ImageServer does not publish its raster attribute table.** `.../ImageServer/rasterAttributeTable`
returns `{}` and `/legend` gives labels with no values against them, so a corridor is a histogram of
integers until you fetch the CSV LANDFIRE ships beside the product. The CSV is not linked from the
service; it lives at a `sites/default/files/CSV/<year>/` path on landfire.gov.

**`landfire.gov/arcgis` is a Drupal 404.** The services are on `lfps.usgs.gov`. The USFS half moved
too: `apps.fs.usda.gov/fsgisx01` now answers 403 with *"migrated to IIPP"* and everything is under
`imagery.geoplatform.gov/iipp`.

**Daymet's single-pixel API is a CSV with a preamble.** Seven lines of provenance before the header
row, day-of-year rather than a date, and one row per day — a decade is 3650 rows and about 93 kB per
site. Parse from the `year,` line, not from line 8.

---

## 5. Daymet, and the brown

Rich's question was "is it just dirt and sand, or are there plants in California?" — and it is plants.
A Big Sur hillside in September is three communities, and LANDFIRE names all three:

- **annual grassland** (`Herb` / "Annual Graminoid/Forb") — naturalised Mediterranean annuals, wild
  oat, ripgut brome, foxtail barley. They germinate with the first winter rain, are brilliant green
  from December to March, set seed in April and are **dead by May**. What you drive past in summer is
  standing straw over last year's thatch. It is a living community with a season, and its season is
  the inverse of Maryland's;
- **chaparral** (`Shrub` / "Evergreen shrubland") — chamise, manzanita, ceanothus: hard grey-green
  woody scrub, the same colour all year, the dark stipple between the straw;
- **coastal sage scrub** — softer, greyer, lower, and summer-*deciduous*, which is why it pales in
  August and greens in January.

LANDFIRE says *which*. It cannot say *when*, because its class is the same class in February. That
is Daymet's job, and one number does it:

| site | annual rain | Jun–Aug | share |
|---|---|---|---|
| bixby-bridge-ca1 | 828 mm | **2 mm** | **0.2 %** |
| acadia-ocean-dr | 1352 mm | 299 mm | 22 % |
| chesterfield-rd | 1292 mm | 419 mm | 32 % |

Two mm of rain in a quarter. Nothing that is not woody or deep-rooted is alive in August at Bixby
Bridge, and no palette tuned in Maryland can be right there.

`season.ts` turns that into a curing index — the worse of a ninety-day rainfall deficit and a cold
dormancy term — and shifts the palette by the **difference** between this site's curing and the
curing of the climate the palettes were drawn against (Chesterfield Road, printed in
`PALETTE_CLIMATE`). The consequences, measured:

| season | Chesterfield delta | Bixby delta | Acadia delta |
|---|---|---|---|
| winter (Feb) | 0 | **−0.93** | +0.07 |
| spring (Apr) | 0 | 0 | 0 |
| summer (Sep) | 0 | **+1.00** | 0 |
| autumn (Nov) | 0 | −0.13 | 0 |

Chesterfield is unchanged in every season by construction, which is the regression guard: the
reference site cannot move. Bixby is a full step drier in September and almost a full step *greener*
in February. Acadia is very slightly drier in February because it is colder, not because it is
drier — which is the dormancy term doing its job.

---

## 6. What the bake writes

`data/sites/<slug>/flora.json`, and a `flora` block plus a `flora_30m.png` layer in
`web/manifest.json`:

```jsonc
{
  "res_m": 30, "bbox_utm": [...], "size": [w, h], "grid": "flora_evt.npy",
  "evt": {
    "source": "LANDFIRE LF2024 EVT CONUS (30 m)", "service": "...", "table": "...",
    "classes": [{
      "value": 7373, "name": "Acadian Low-Elevation Spruce-Fir Forest",
      "lifeform": "Tree", "physiognomy": "Conifer", "canopy": "Closed tree canopy",
      "subclass": "Evergreen closed tree canopy", "leaf_cycle": "evergreen",
      "ground": "conifer_duff", "share": 0.1930, "rgb": [...],
      "species": [{"key": "Picea rubens", "weight": 0.51}, ...],
      "species_from": "fhp", "species_px": 412
    }, ...]
  },
  "canopy": {
    "source": "USFS FHP tree-species basal area 2011 (30 m, modelled from FIA)",
    "coverage": 0.85, "rasters_here": 49, "rasters_with_data": 14,
    "species": [{"key": "Picea rubens", "weight": 0.34}, ...],
    "ref": {"Picea rubens": {"common": "red spruce", "genus": "Picea", "softwood": true,
                             "spcd": 97, "canopy_h_m": 16.4}}
  },
  "ground": {"classes": [{"key": "conifer_duff", "weight": 0.24}, ...], "vocabulary": [...]},
  "climate": {"source": "Daymet v4 (ORNL DAAC), 1 km", "ppt_mm": [12], "tmax_c": [12],
              "annual_mm": 1352.0, "summer_dry": 0.2213, "citation": "..."}
}
```

`flora_30m.png` is the EVT class **index** per 30 m pixel (255 outside the corridor) on its own
lattice, not the DEM's 2 m one — the source is 30 m and resampling a class raster up would be five
megabytes of the same integer. It is what lets a tree on a canyon floor be a redwood and a tree on
the ridge above it be a live oak.

`canopy_h_m` is ours, not LANDFIRE's: the mean of **this corridor's lidar CHM** over the pixels where
that species carries basal area. It is what makes "a 40 m stem in a redwood mix is a redwood, an 8 m
one is a tanoak" arithmetic over two measurements instead of a rule about redwoods.

## 7. What the viewer does with it

- `flora.ts` — the class grid, `mixAt(x, y)`, `leafCycleAt(x, y)`, `curing(month)`.
- `species.ts` — genus → silhouette. **The one place a judgement is written down** in this path, and
  it is written at the level of the genus, which is what you read from a moving car. Each archetype
  is derived from ez-tree's presets by moving where branches start up the trunk, their length against
  the leader, and which way the growth force pulls their tips; the comment on each says which real
  tree the numbers are shaped after.
- `trees.ts` — which silhouettes to build (the six heaviest by area-weighted basal area), and a
  stable per-tree draw from the pixel's mix weighted by height affinity.
- `groundcover.ts` — eighteen ground classes with a blade style, a blade count and a floor texture
  each; `floorTexture(kind)` in place of one canvas of oak-hickory litter.
- `season.ts` — `siteLook(season, flora)`: the reference palette shifted by the curing difference.

## 8. Still open

- The floor textures are still painted canvases. They are now painted **per class** with a recipe
  (element colour, count, size, aspect) rather than one oak-hickory texture everywhere, but the real
  sets belong to flux.2 through `tools/surfaces/gen.py`. There is now a named class to generate for.
- **Chaparral and coastal scrub have no geometry.** 30 % of the Bixby corridor and 26 % of Ragged
  Point is `Shrub`, and it is currently drawn as low dense ground cover with a grey gravel floor and
  no woody instances. A shrub LOD — a manzanita and a chamise the size of a car bonnet — is the next
  visible win on the California sites, and `flora.json` already says where they go.
- **TreeMap** would replace the FHP layer's western hole with an imputed FIA plot per pixel, if the
  bulk download is ever worth hosting.
- LANDFIRE **EVH** (stand height) is fetched by nothing yet; it is the obvious cross-check against
  our own CHM and would catch a lidar flight with a bad Z factor.
- Alaska and Hawaii are wired (`EVT_AK`, `EVT_HI`) but untested — no site is there yet.
