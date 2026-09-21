# Corridor sites — what each bake actually holds

*Generated 2026-09-21 14:23 UTC by `python -m corridor.sitesdoc` from `tools/corridor/data/sites/*/manifest.json`, `spine_utm.json`, `surface.json` and the bake log `/tmp/claude-1000/-workspaces-apex-conduit/397fba92-5e84-41c5-9605-5d43678842ec/scratchpad/newbakes.log`. Do not edit by hand; re-run it. Lidar year is read off the project name (`_D21` = 2021 delivery). The fetch itself does not record the NAIP acquisition date, so it is looked up here from the image service's catalog under the site point (the tile that covers the photo; a long corridor can straddle two flight dates). A DEM listed as "cached" was reused from an earlier run and its source tiles were not re-recorded (a `__main__.py` gap reported to main).*

**17 baked, 12 not yet** (acadia-ocean-dr (in progress), bell-branch-rd (not baked), crownsville-rd (not baked), ecola-or (failed), hawkins-rd (not baked), patuxent-river-rd (not baked), ragged-point-ca1 (failed), rossback-rd (not baked), rutland-rd (not baked), st-stephens-church-rd (not baked), underwood-rd (not baked), waterbury-rd (not baked)).

## Summary

| site | road | km | lidar project (year) | class 17 | veg classes | NAIP | DEM | structures | formations | missing |
|---|---|---|---|---|---|---|---|---|---|---|
| `acadia-ocean-dr` | *in progress* | | | | | | | |  |
| `arrowhead-farms` | Halls Grove Road | 0.6 | USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015 (2014) | demoted | no (unassigned) | 2023-07-12 | cached | none | Monmouth Formation | — |
| `arrowhead-farms-network` | Patuxent River Road | 2.3 | TNM:MD_Central_Processing_D24 (2024) | trusted | yes | 2023-07-12 | cached | none | Aquia Formation, Matawan Formation, Monmouth Formation | — |
| `bacon-ridge-rd` | Bacon Ridge Road | 2.1 | TNM:MD_Central_Processing_D24 (2024) | trusted | yes | 2023-05-25 | USGS 1 Meter 18 x35y433 MD_Central_Processing_D24 (2026-04-04), USGS 1 Meter 18 x36y433 MD_Central_Processing_D24 (2026-04-04) | none | Matawan Formation, Monmouth Formation | — |
| `bell-branch-rd` | *not baked* | | | | | | | |  |
| `bixby-bridge-ca1` | CA 1 | 6.4 | TNM:CA_AZ_FEMA_R9_Lidar_2017_D18 (2018) | trusted | no (unassigned) | 2022-05-18 | USGS 1 Meter 10 x59y403 CA_AZ_FEMA_R9_Lidar_2017_D18 (2021-06-19) | 2 bridge | Adobe Flat Shale Member; Asuncion Group; Atascadero Formation; Bald Hills Formation; Chico Formation; Forbes Formation; Funks Formation; Gualala Group; Guinda Formation; Jack Creek Formation; Jalama Formation; Kione Sand; Ladd Formation; Moreno Formation; Panoche Formation; Pigeon Point Formation; Rosario Formation; Salt Creek Conglomerate; Sites Formation; Venado Formation; Williams Formation; Yolo Formation; Great Valley Sequence; Boxer Formation; Cortina Formation; Rumsey Formation; Budden Canyon Formation; Tuna Canyon Formation; Rosario Group; Lusardi Formation; Point Loma Formation; Cabrillo Formation, Agua Sandstone Member; Alferitz Formation; Altamira Shale Member; Antelope Shale Member; Big Blue Serpentinous Member; Branch Canyon Formation; Briones Formation; Button Bed Sandstone Member; Capistrano Formation; Carneros Sandstone Member; Castaic Formation; Cierbo Sandstone; Claremont Shale; Devilwater Silt-Gould Shale Member; Escudo Sandstone; Fish Creek Gypsum Member; Freeman Silt; Gallaway Beds; Hambre Sandstone; Hannah Formation; Hercules Shale Member; Jewett Sand; La Vida Member; Malaga Mudstone Member; McDonald Shale; McLure Shale Member; Media Shale Member; Modelo Formation; Monterey Formation; Neroly Formation; Olcese Sand; Oso Member; Oursan Sandstone; Painted Rock Sandstone Member; Pismo Formation; Pleito Formation; Point Arena Beds; Point Sal Formation; Puente Formation; Pullen Formation; Quail Lake Formation; Reef Ridge Shale; Rincon Shale; Rodeo Shale; Round Mountain Silt; Salinas Shale; Salt Creek Shale Member; Saltos Shale Member; Sandholdt Shale; San Onofre Breccia; San Pablo Group; Santa Margarita Formation; Santos Shale Member; Sisquoc Formation; Sobrante Sandstone; Soda Lake Sandstone Member; Soda Lake Shale Member; Soquel Member Split Mountain Formation; Sycamore Canyon Member; Temblor Formation; Tequepis Sandstone; Tice Shale; Topanga Formation; Twisselman Sandstone Member; Valmonte Diatomite Member; Vaqueros Formation; Vedder Sand; Whiterock Bluff Shale Member; Wimer Formation; Yorba Member, Ash Mountain Complex; Placerita Formation; Sur Series… | — |
| `bonnie-branch-rd` | Bonnie Branch Road | 3.7 | TNM:MD_4County_D24 (2024) | trusted | no (unassigned) | 2023-07-12 | USGS 1 Meter 18 x34y435 VA_UpperMiddleNeck_2018_D18 (2021-12-21), USGS 1 Meter 18 x34y435 MD_4County_D24 (2026-05-11) | none | Baltimore Gabbro Complex, Ellicott City Granodiorite, Potomac Group | — |
| `bowie-racetrack-rd` | Race Track Road | 4.7 | USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015 (2014) | demoted | no (unassigned) | 2023-07-12 | USGS one meter x34y432 MD VA Sandy NCR 2014 (2020-03-30), USGS one meter x35y432 MD VA Sandy NCR 2014 (2020-03-30) | 1 bridge, 1 overpass | Monmouth Formation, Potomac Group | — |
| `braddock-i70` | I 70 | 6.4 | MD_Western_2_D21 (2021) | trusted | no (unassigned) | 2023-05-21 | cached | 2 bridge, 2 overpass | Antietam Formation, Buzzard Knob Member, Catoctin Formation… | — |
| `burtonsville-icc` | I 95 | 6.4 | USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015 (2014) | demoted | no (unassigned) | 2023-09-01 | cached | 4 gantry, 6 overpass | Potomac Group, Wissahickon Formation | — |
| `chesterfield-rd` | Chesterfield Road | 3.6 | TNM:MD_Central_Processing_D24 (2024) | trusted | yes | 2023-07-12 | USGS one meter x35y432 MD VA Sandy NCR 2014 (2020-03-30), USGS 1 Meter 18 x35y432 MD_Central_Processing_D24 (2026-04-04) | none | Aquia Formation, Matawan Formation, Monmouth Formation | — |
| `clarksburg-i270` | I 270 | 6.4 | TNM:MD_Central_Processing_D24 (2024) | trusted | no (unassigned) | 2023-07-12 | cached | 2 bridge, 4 gantry, 3 overpass | Ijamsville Formation; Marburg Schist, Marburg Formation, Wissahickon Formation | — |
| `crofton-crownsville` | Chesterfield Road | 3.6 | TNM:MD_Central_Processing_D24 (2024) | trusted | yes | 2023-07-12 | USGS one meter x34y431 MD VA Sandy NCR 2014 (2020-03-30), USGS one meter x34y432 MD VA Sandy NCR 2014 (2020-03-30) | 6 gantry | Aquia Formation, Calvert Formation, Magothy Formation… | naip.tif, lidar/dtm.tif, lidar/chm.tif, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg |
| `crownsville-rd` | *not baked* | | | | | | | |  |
| `ecola-or` | *failed* | | | | | | | | RuntimeError: USGS_LPC_OR_NORTHCOAST_2008_2009_OR_NorthCoast_2008-2009_003712.laz: no CRS in the LAS header |
| `frederick-i270` | I 270 | 6.4 | MD_Western_2_D21 (2021) | trusted | no (unassigned) | 2023-05-21 | cached | 3 bridge | Adamstown Member, Antietam Formation, Araby Formation… | — |
| `frederick-i70` | Frederick Freeway | 3.7 | MD_Western_2_D21 (2021) | trusted | no (unassigned) | 2023-05-21 | cached | 1 bridge, 3 gantry, 5 overpass | Adamstown Member, Frederick Limestone, Lime Kiln Member… | — |
| `hawkins-rd` | *not baked* | | | | | | | |  |
| `md450-staples` | Double Gate Road | 2.7 | USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015 (2014) | demoted | no (unassigned) | 2023-07-12 | USGS one meter x35y432 MD VA Sandy NCR 2014 (2020-03-30), USGS 1 Meter 18 x35y432 MD_Central_Processing_D24 (2026-04-04) | none | Aquia Formation, Calvert Formation | — |
| `patuxent-river-rd` | *not baked* | | | | | | | |  |
| `ragged-point-ca1` | *failed* | | | | | | | | RuntimeError: no EPT dataset covers this corridor |
| `rossback-rd` | *not baked* | | | | | | | |  |
| `rutland-rd` | *not baked* | | | | | | | |  |
| `shady-grove-icc` | MD 200 Toll | 6.4 | TNM:MD_Central_Processing_D24 (2024) | trusted | no (unassigned) | 2023-07-12 | cached | 3 bridge, 8 gantry, 3 overpass | Bear Island Granodiorite, Sykesville Formation, Wissahickon Formation | — |
| `sideling-i68` | US 40 Scenic | 4.4 | MD_Western_1_D21 (2021) | trusted | no (unassigned) | 2023-05-21 | cached | none | Hampshire Formation, Purslane Formation, Purslane Sandstone; Rockwell Formation… | — |
| `south-mountain-i70` | I 70 | 6.4 | MD_Western_2_D21 (2021) | trusted | no (unassigned) | 2023-05-21 | cached | 2 bridge | Catoctin Formation, Catoctin Metabasalt | — |
| `st-stephens-church-rd` | *not baked* | | | | | | | |  |
| `underwood-rd` | *not baked* | | | | | | | |  |
| `waterbury-rd` | *not baked* | | | | | | | |  |

## The sixteen queued 2026-09-21

| site | status | where it stands |
|---|---|---|
| `patuxent-river-rd` | not baked | gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads |
| `bacon-ridge-rd` | baked | baked 2026-09-21T04:41:21Z in 106.2 s; TNM:MD_Central_Processing_D24, 0 structures |
| `chesterfield-rd` | baked | baked 2026-09-21T04:43:34Z in 162.4 s; TNM:MD_Central_Processing_D24, 0 structures |
| `crownsville-rd` | not baked | gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads |
| `underwood-rd` | not baked | gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads |
| `waterbury-rd` | not baked | gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads |
| `rutland-rd` | not baked | gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads |
| `rossback-rd` | not baked | gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads |
| `hawkins-rd` | not baked | gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads |
| `bell-branch-rd` | not baked | gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads |
| `st-stephens-church-rd` | not baked | gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads |
| `bonnie-branch-rd` | baked | baked 2026-09-21T04:39:58Z in 779.4 s; TNM:MD_4County_D24, 0 structures |
| `ragged-point-ca1` | failed | RuntimeError: no EPT dataset covers this corridor |
| `bixby-bridge-ca1` | baked | baked 2026-09-21T14:02:26Z in 629.1 s; TNM:CA_AZ_FEMA_R9_Lidar_2017_D18, 2 structures |
| `ecola-or` | failed | RuntimeError: USGS_LPC_OR_NORTHCOAST_2008_2009_OR_NorthCoast_2008-2009_003712.laz: no CRS in the LAS header |
| `acadia-ocean-dr` | in progress | Park Loop Road / Ocean Drive, Mount Desert Island |

## Per site

### `acadia-ocean-dr`

*Park Loop Road / Ocean Drive, Mount Desert Island*  
fix 44.3206, -68.1885 · 0 photo(s) · status **in progress**

Missing: lidar/dtm.tif, lidar/chm.tif, profile.json, web/chm_2m.png

### `arrowhead-farms`

*Rich's neighbourhood (Davidsonville): Arrowhead Farms Ct/Rd/Dr, Halls Grove Rd, Gosheff Ln, Patuxent Overlook/Preserve, Patuxent River Rd, Deer Pass Ln — a network site later — point moved onto Halls Grove Rd so the spine is a road, not the 75 m court*  
fix 38.98138, -76.69057 · 0 photo(s) · status **baked**

- **road**: {'name': 'Halls Grove Road'} · 629.5 m · snap 45.8 m · trimmed [False, False] · fetched 2026-09-21T04:49:23Z (4.4 s)
- **lidar**: `USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015` (2014) · 1,473,400 pts in corridor · z factor 1.0 · classes: unassigned 68%, ground 32% · class 17: 0.2107 (demoted) — class 17/18 demoted to unassigned: implausible share, vendor used them as junk bins
- **DEM**: reused from cache (sources not re-recorded)
- **NAIP**: reused from cache · tile under the fix `m_3807603_nw_18_030_20230712` flown 2023-07-12 at 0.3 m
- **OSM**: 97 features, 5 crossings; spine tags: `highway`=residential
- **structures** (0): none
- **surface** (per 20 m): {'asphalt_aged': 32}
- **geology**: Monmouth Formation
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 59 buildings · 0 POIs · 0 landuse rings · authored: none
- **missing**: nothing

### `arrowhead-farms-network`

*Rich's neighbourhood as one network (cadre §6): every named road chained, Patuxent River Rd as the primary; OSM spellings checked 2026-09-21 (Lane not Drive; Patuxent Overlook has no Road; no Halls Grove Court in OSM)*  
fix 38.98138, -76.69057 · 0 photo(s) · status **baked**

- **road**: {'name': 'Patuxent River Road'} · 2318.4 m · snap 381.4 m  ⚠ **check the road**: the fix snapped this far, which usually means it landed on a different road · trimmed [False, False] · fetched 2026-09-21T05:11:30Z (2348.1 s)
- **lidar**: `TNM:MD_Central_Processing_D24` (2024) · 26,536,147 pts in corridor · z factor 1.0 · classes: ground 48%, veg_high 25%, unassigned 21%, building 3%, veg_med 2%, veg_low 1% · class 17: 0.0 (trusted)
- **DEM**: reused from cache (sources not re-recorded)
- **NAIP**: reused from cache · tile under the fix `m_3807603_nw_18_030_20230712` flown 2023-07-12 at 0.3 m
- **OSM**: 638 features, 20 crossings; spine tags: `highway`=residential
- **structures** (0): none
- **surface** (per 20 m): {'concrete': 8, 'asphalt_aged': 108}
- **geology**: Aquia Formation, Matawan Formation, Monmouth Formation
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 237 buildings · 8 POIs · 7 landuse rings · authored: none
- **missing**: nothing

### `bacon-ridge-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 39.038926, -76.6183 · 0 photo(s) · status **baked**

- **road**: {'name': 'Bacon Ridge Road'} · 2107.8 m · snap 0.0 m · trimmed [False, False] · fetched 2026-09-21T04:41:21Z (106.2 s)
- **lidar**: `TNM:MD_Central_Processing_D24` (2024) · 13,588,441 pts in corridor · z factor 1.0 · classes: ground 54%, veg_high 25%, unassigned 15%, veg_med 4%, building 1%, veg_low 1% · class 17: 0.0006 (trusted)
- **DEM**: USGS 1 Meter 18 x35y433 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x36y433 MD_Central_Processing_D24 — 2026-04-04
- **NAIP**: fetched at 0.3 m, [4033, 7600] px · tile under the fix `m_3907660_sw_18_030_20230525` flown 2023-05-25 at 0.3 m
- **OSM**: 257 features, 31 crossings; spine tags: `highway`=residential; `maxspeed`=25 mph
- **structures** (0): none
- **surface** (per 20 m): {'asphalt_aged': 106}
- **geology**: Matawan Formation, Monmouth Formation
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 129 buildings · 3 POIs · 4 landuse rings · authored: none
- **missing**: nothing

### `bell-branch-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 38.981975, -76.653359 · 0 photo(s) · status **not baked**

Missing: site.json, spine_utm.json, osm.geojson, crossings.json, dem_1m.tif, naip.tif, horizon_30m.tif, geology.json, lidar/dtm.tif, lidar/chm.tif, profile.json, surface.json, web/manifest.json, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg, web/horizon_60m.png

### `bixby-bridge-ca1`

*Highway 1, Big Sur*  
fix 36.3715, -121.9018 · 0 photo(s) · status **baked**

- **road**: {'ref': 'CA 1'} · 6438.0 m · snap 8.8 m · trimmed [True, True] · fetched 2026-09-21T14:02:26Z (629.1 s)
- **lidar**: `TNM:CA_AZ_FEMA_R9_Lidar_2017_D18` (2018) · 11,713,883 pts in corridor · z factor 1.0 · classes: unassigned 54%, ground 42%, water 4% · class 17: 0.0005 (trusted)
- **DEM**: USGS 1 Meter 10 x59y403 CA_AZ_FEMA_R9_Lidar_2017_D18 — 2021-06-19
- **NAIP**: fetched at 0.3 m, [4667, 20000] px · tile under the fix `m_3612141_ne_10_060_20220518` flown 2022-05-18 at 0.6 m
- **OSM**: 137 features, 35 crossings; spine tags: `highway`=primary; `lanes`=2; `oneway`=no; `surface`=asphalt/concrete
- **structures** (2): bridge s=3118–3342 (226.0 m, 37.96 m above ground, class17); bridge s=4216–4364 (150.0 m, 18.49 m above ground, class17)
- **surface** (per 20 m): {'concrete': 55, 'asphalt_aged': 267}
- **geology**: Adobe Flat Shale Member; Asuncion Group; Atascadero Formation; Bald Hills Formation; Chico Formation; Forbes Formation; Funks Formation; Gualala Group; Guinda Formation; Jack Creek Formation; Jalama Formation; Kione Sand; Ladd Formation; Moreno Formation; Panoche Formation; Pigeon Point Formation; Rosario Formation; Salt Creek Conglomerate; Sites Formation; Venado Formation; Williams Formation; Yolo Formation; Great Valley Sequence; Boxer Formation; Cortina Formation; Rumsey Formation; Budden Canyon Formation; Tuna Canyon Formation; Rosario Group; Lusardi Formation; Point Loma Formation; Cabrillo Formation, Agua Sandstone Member; Alferitz Formation; Altamira Shale Member; Antelope Shale Member; Big Blue Serpentinous Member; Branch Canyon Formation; Briones Formation; Button Bed Sandstone Member; Capistrano Formation; Carneros Sandstone Member; Castaic Formation; Cierbo Sandstone; Claremont Shale; Devilwater Silt-Gould Shale Member; Escudo Sandstone; Fish Creek Gypsum Member; Freeman Silt; Gallaway Beds; Hambre Sandstone; Hannah Formation; Hercules Shale Member; Jewett Sand; La Vida Member; Malaga Mudstone Member; McDonald Shale; McLure Shale Member; Media Shale Member; Modelo Formation; Monterey Formation; Neroly Formation; Olcese Sand; Oso Member; Oursan Sandstone; Painted Rock Sandstone Member; Pismo Formation; Pleito Formation; Point Arena Beds; Point Sal Formation; Puente Formation; Pullen Formation; Quail Lake Formation; Reef Ridge Shale; Rincon Shale; Rodeo Shale; Round Mountain Silt; Salinas Shale; Salt Creek Shale Member; Saltos Shale Member; Sandholdt Shale; San Onofre Breccia; San Pablo Group; Santa Margarita Formation; Santos Shale Member; Sisquoc Formation; Sobrante Sandstone; Soda Lake Sandstone Member; Soda Lake Shale Member; Soquel Member Split Mountain Formation; Sycamore Canyon Member; Temblor Formation; Tequepis Sandstone; Tice Shale; Topanga Formation; Twisselman Sandstone Member; Valmonte Diatomite Member; Vaqueros Formation; Vedder Sand; Whiterock Bluff Shale Member; Wimer Formation; Yorba Member, Ash Mountain Complex; Placerita Formation; Sur Series, Bodega Diorite; Santa Lucia Quartz Diorite
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 10 buildings · 16 POIs · 3 landuse rings · authored: none
- **missing**: nothing

### `bonnie-branch-rd`

*Ellicott City/Ilchester: falls and rapids down the fall line to the Patapsco*  
fix 39.2322538, -76.785061 · 0 photo(s) · status **baked**

- **road**: {'name': 'Bonnie Branch Road'} · 3689.7 m · snap 0.0 m · trimmed [False, False] · fetched 2026-09-21T04:39:58Z (779.4 s)
- **lidar**: `TNM:MD_4County_D24` (2024) · 458,290 pts in corridor · z factor 1.0 · classes: unassigned 74%, ground 25%, noise 0% · class 17: 0.0 (trusted)
- **DEM**: USGS 1 Meter 18 x34y435 VA_UpperMiddleNeck_2018_D18 — 2021-12-21; USGS 1 Meter 18 x34y435 MD_4County_D24 — 2026-05-11
- **NAIP**: fetched at 0.3 m, [8467, 9900] px · tile under the fix `m_3907650_ne_18_030_20230712` flown 2023-07-12 at 0.3 m
- **OSM**: 760 features, 57 crossings; spine tags: `highway`=tertiary; `lanes`=2; `maxspeed`=25 mph/30 mph; `surface`=asphalt
- **structures** (0): none
- **surface** (per 20 m): {'asphalt_new': 144, 'concrete': 26, 'asphalt_aged': 12, 'chipseal': 3}
- **geology**: Baltimore Gabbro Complex, Ellicott City Granodiorite, Potomac Group
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 363 buildings · 9 POIs · 12 landuse rings · authored: none
- **missing**: nothing

### `bowie-racetrack-rd`

fix 39.013133, -76.751944 · 2 photo(s) · status **baked**

- **road**: {'name': 'Race Track Road'} · 4698.6 m · snap 81.5 m · trimmed [True, False] · fetched 2026-09-21T04:48:06Z (58.0 s)
- **lidar**: `USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015` (2014) · 10,842,599 pts in corridor · z factor 1.0 · classes: unassigned 70%, ground 30% · class 17: 0.2399 (demoted) — class 17/18 demoted to unassigned: implausible share, vendor used them as junk bins
- **DEM**: USGS one meter x34y432 MD VA Sandy NCR 2014 — 2020-03-30; USGS one meter x35y432 MD VA Sandy NCR 2014 — 2020-03-30; USGS 1 Meter 18 x34y433 VA_UpperMiddleNeck_2018_D18 — 2021-12-21; USGS 1 Meter 18 x34y432 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x34y433 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x35y432 MD_Central_Processing_D24 — 2026-04-04
- **NAIP**: fetched at 0.3 m, [10300, 10067] px · tile under the fix `m_3907658_se_18_030_20230712` flown 2023-07-12 at 0.3 m
- **OSM**: 1331 features, 47 crossings; spine tags: `highway`=secondary/tertiary; `lanes`=2/4; `surface`=asphalt/concrete; `oneway`=no; `lanes:backward`=1; `lanes:forward`=3
- **structures** (2): overpass s=2350–2356 (8.0 m, clearance 8.85 m, geometry); bridge s=2500–2514 (16.0 m, 3.08 m above ground, geometry)
- **surface** (per 20 m): {'asphalt_aged': 85, 'chipseal': 29, 'concrete': 72, 'asphalt_new': 37, 'asphalt_patched': 12}
- **geology**: Monmouth Formation, Potomac Group
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 833 buildings · 9 POIs · 8 landuse rings · authored: adjustments, structures
- **missing**: nothing

### `braddock-i70`

fix 39.422592, -77.486522 · 3 photo(s) · status **baked**

- **road**: {'ref': 'I 70'} · 6438.0 m · snap 0.8 m · trimmed [True, True] · fetched 2026-09-21T04:23:21Z (68.2 s)
- **lidar**: `MD_Western_2_D21` (2021) · 13,031,479 pts in corridor · z factor 1.0 · classes: ground 64%, unassigned 36%, noise 0%, bridge_deck 0% · class 17: 0.0002 (trusted)
- **DEM**: reused from cache (sources not re-recorded)
- **NAIP**: reused from cache · tile under the fix `m_3907737_sw_18_030_20230521` flown 2023-05-21 at 0.3 m
- **OSM**: 585 features, 13 crossings; spine tags: `highway`=motorway; `lanes`=2/3; `maxspeed`=70 mph; `oneway`=yes; `surface`=asphalt/concrete; `turn:lanes`=||merge_to_left/||slight_right
- **structures** (4): overpass s=320–330 (12.0 m, clearance 18.72 m, geometry+class17); bridge s=2830–2890 (62.0 m, 4.75 m above ground, class17); bridge s=3270–3360 (92.0 m, 6.26 m above ground, class17); overpass s=4758–4766 (10.0 m, clearance 6.31 m, geometry+class17)
- **surface** (per 20 m): {'asphalt_aged': 313, 'concrete': 8, 'asphalt_new': 1}
- **geology**: Antietam Formation, Buzzard Knob Member, Catoctin Formation, Catoctin Metabasalt, Harpers Formation, Leesburg Member, Loudoun Formation, Maryland Heights Member, New Oxford Formation, Poolesville Member, Weverton Formation
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 228 buildings · 6 POIs · 15 landuse rings · authored: adjustments
- **missing**: nothing

### `burtonsville-icc`

fix 39.070586, -76.911544 · 1 photo(s) · status **baked**

- **road**: {'ref': 'I 95'} · 6438.0 m · snap 280.9 m  ⚠ **check the road**: the fix snapped this far, which usually means it landed on a different road · trimmed [True, True] · fetched 2026-09-21T04:12:24Z (85.3 s)
- **lidar**: `USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015` (2014) · 13,152,356 pts in corridor · z factor 1.0 · classes: unassigned 62%, ground 38% · class 17: 0.2123 (demoted) — class 17/18 demoted to unassigned: implausible share, vendor used them as junk bins
- **DEM**: reused from cache (sources not re-recorded)
- **NAIP**: fetched at 0.3 m, [13967, 17633] px · tile under the fix `m_3907657_ne_18_030_20230901` flown 2023-09-01 at 0.3 m
- **OSM**: 887 features, 28 crossings; spine tags: `highway`=motorway; `lanes`=4/5/6; `maxspeed`=65 mph; `oneway`=yes; `surface`=asphalt; `turn:lanes`=none|none|none|none|slight_right/none|none|none|through;slight_right|slight_right/||||slight_right/|||||merge_to_left
- **structures** (10): overpass s=1162–1182 (22.0 m, clearance 8.11 m, geometry); overpass s=2644–2662 (20.0 m, clearance 7.51 m, geometry); overpass s=2668–2684 (18.0 m, clearance 7.3 m, geometry); overpass s=2810–2820 (12.0 m, clearance 8.92 m, geometry); gantry s=4054–4054 (2.0 m, clearance 8.28 m, geometry); overpass s=4660–4676 (18.0 m, clearance 7.71 m, geometry); gantry s=4926–4926 (2.0 m, clearance 5.72 m, geometry); gantry s=4930–4930 (2.0 m, clearance 7.99 m, geometry); gantry s=6144–6144 (2.0 m, clearance 7.47 m, geometry); overpass s=6148–6190 (44.0 m, clearance 6.91 m, geometry)
- **surface** (per 20 m): {'asphalt_aged': 161, 'asphalt_new': 61, 'concrete': 93, 'asphalt_patched': 7}
- **geology**: Potomac Group, Wissahickon Formation
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 412 buildings · 2 POIs · 10 landuse rings · authored: adjustments
- **missing**: nothing

### `chesterfield-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 38.998792, -76.605292 · 0 photo(s) · status **baked**

- **road**: {'name': 'Chesterfield Road'} · 3582.1 m · snap 0.0 m · trimmed [False, False] · fetched 2026-09-21T04:43:34Z (162.4 s)
- **lidar**: `TNM:MD_Central_Processing_D24` (2024) · 24,101,497 pts in corridor · z factor 1.0 · classes: ground 48%, veg_high 30%, unassigned 17%, veg_med 3%, building 1%, veg_low 1% · class 17: 0.0003 (trusted)
- **DEM**: USGS one meter x35y432 MD VA Sandy NCR 2014 — 2020-03-30; USGS 1 Meter 18 x35y432 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x36y432 MD_Central_Processing_D24 — 2026-04-04
- **NAIP**: fetched at 0.3 m, [11100, 4633] px · tile under the fix `m_3807604_nw_18_030_20230712` flown 2023-07-12 at 0.3 m
- **OSM**: 448 features, 22 crossings; spine tags: `highway`=residential; `surface`=concrete
- **structures** (0): none
- **surface** (per 20 m): {'asphalt_aged': 172, 'chipseal': 5, 'concrete': 3}
- **geology**: Aquia Formation, Matawan Formation, Monmouth Formation
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 260 buildings · 5 POIs · 2 landuse rings · authored: none
- **missing**: nothing

### `clarksburg-i270`

fix 39.181842, -77.252419 · 1 photo(s) · status **baked**

- **road**: {'ref': 'I 270'} · 6438.0 m · snap 5.9 m · trimmed [True, True] · fetched 2026-09-21T02:10:27Z (252.1 s)
- **lidar**: `TNM:MD_Central_Processing_D24` (2024) · 46,113,327 pts in corridor · z factor 1.0 · classes: unassigned 62%, ground 38%, bridge_deck 0%, noise_high 0%, noise 0% · class 17: 0.0028 (trusted)
- **DEM**: reused from cache (sources not re-recorded)
- **NAIP**: reused from cache · tile under the fix `m_3907754_se_18_030_20230712` flown 2023-07-12 at 0.3 m
- **OSM**: 1196 features, 26 crossings; spine tags: `highway`=motorway; `lanes`=3/4/5; `maxspeed`=55 mph; `oneway`=yes; `surface`=asphalt; `turn:lanes`=none|none|none|none|slight_right/none|none|none|through;slight_right/|||merge_to_left/|||slight_right
- **structures** (9): overpass s=1190–1208 (20.0 m, clearance 7.37 m, geometry+class17); overpass s=1214–1232 (20.0 m, clearance 8.37 m, geometry+class17); gantry s=2424–2424 (2.0 m, clearance 8.34 m, geometry); overpass s=2856–2888 (34.0 m, clearance 7.16 m, geometry+class17); bridge s=4060–4112 (54.0 m, 7.03 m above ground, class17); gantry s=5422–5424 (4.0 m, clearance 6.57 m, geometry); gantry s=5622–5622 (2.0 m, clearance 7.47 m, geometry); gantry s=5866–5868 (4.0 m, clearance 5.87 m, geometry); bridge s=6132–6212 (82.0 m, 5.97 m above ground, class17)
- **surface** (per 20 m): {'asphalt_aged': 239, 'asphalt_new': 14, 'concrete': 69}
- **geology**: Ijamsville Formation; Marburg Schist, Marburg Formation, Wissahickon Formation
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 367 buildings · 8 POIs · 9 landuse rings · authored: adjustments
- **missing**: nothing

### `crofton-crownsville`

*the interconnected Crofton/Crownsville world (cadre §6): 18 roads, Chesterfield Rd primary (the Hawkins Rd jump); MD 450 = Defense Hwy, MD 424 = Davidsonville Rd, MD 178 = Generals Hwy by ref; tiled export*  
fix 39.0, -76.62 · 0 photo(s) · status **baked**

- **road**: {'name': 'Chesterfield Road'} · 3582.1 m · snap 128.5 m · trimmed [False, False] · fetched 2026-09-21T04:56:39Z (31426.5 s)
- **lidar**: `TNM:MD_Central_Processing_D24` (2024) · 500,848,582 pts in corridor · z factor 1.0 · classes: ground 50%, veg_high 23%, unassigned 20%, veg_med 3%, building 3%, veg_low 1% · class 17: None (trusted)
- **DEM**: USGS one meter x34y431 MD VA Sandy NCR 2014 — 2020-03-30; USGS one meter x34y432 MD VA Sandy NCR 2014 — 2020-03-30; USGS one meter x34y433 MD VA Sandy NCR 2014 — 2020-03-30; USGS one meter x35y431 MD VA Sandy NCR 2014 — 2020-03-30; USGS one meter x35y432 MD VA Sandy NCR 2014 — 2020-03-30; USGS 1 Meter 18 x34y433 VA_UpperMiddleNeck_2018_D18 — 2021-12-21; USGS 1 Meter 18 x34y431 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x34y432 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x34y433 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x35y431 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x35y432 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x35y433 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x36y431 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x36y432 MD_Central_Processing_D24 — 2026-04-04; USGS 1 Meter 18 x36y433 MD_Central_Processing_D24 — 2026-04-04
- **NAIP**: fetched at 1.0 m, [18810, 18210] px · tile under the fix `m_3807604_nw_18_030_20230712` flown 2023-07-12 at 0.3 m
- **OSM**: 52999 features, 22 crossings; spine tags: `highway`=residential; `surface`=concrete
- **structures** (6): gantry s=398–398 (2.0 m, clearance 4.66 m, geometry); gantry s=556–556 (2.0 m, clearance 4.92 m, geometry); gantry s=1288–1288 (2.0 m, clearance 15.96 m, geometry); gantry s=1934–1934 (2.0 m, clearance 4.71 m, geometry); gantry s=3280–3282 (4.0 m, clearance 4.5 m, geometry); gantry s=3468–3468 (2.0 m, clearance 4.63 m, geometry)
- **surface** (per 20 m): {'asphalt_aged': 179, 'concrete': 1}
- **geology**: Aquia Formation, Calvert Formation, Magothy Formation, Matawan Formation, Monmouth Formation
- **web**: layers ['tiles', 'horizon', 'horizon_naip'] · 28413 buildings · 1082 POIs · 475 landuse rings · authored: none
- **missing**: naip.tif, lidar/dtm.tif, lidar/chm.tif, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg

### `crownsville-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 39.008201, -76.5929 · 0 photo(s) · status **not baked**

Missing: site.json, spine_utm.json, osm.geojson, crossings.json, dem_1m.tif, naip.tif, horizon_30m.tif, geology.json, lidar/dtm.tif, lidar/chm.tif, profile.json, surface.json, web/manifest.json, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg, web/horizon_60m.png

### `ecola-or`

*Ecola State Park Road, Cannon Beach (Goonies country)*  
fix 45.9197, -123.975 · 0 photo(s) · status **failed**

Last bake log lines:

```
Traceback (most recent call last):
    raise RuntimeError(f"{path.name}: no CRS in the LAS header")
RuntimeError: USGS_LPC_OR_NORTHCOAST_2008_2009_OR_NorthCoast_2008-2009_003712.laz: no CRS in the LAS header
```
Missing: lidar/dtm.tif, lidar/chm.tif, profile.json, web/chm_2m.png

### `frederick-i270`

fix 39.364661, -77.400114 · 1 photo(s) · status **baked**

- **road**: {'ref': 'I 270'} · 6438.0 m · snap 7.9 m · trimmed [True, True] · fetched 2026-09-21T04:22:09Z (49.2 s)
- **lidar**: `MD_Western_2_D21` (2021) · 10,791,038 pts in corridor · z factor 1.0 · classes: ground 76%, unassigned 24%, bridge_deck 0%, water 0% · class 17: 0.0009 (trusted)
- **DEM**: reused from cache (sources not re-recorded)
- **NAIP**: reused from cache · tile under the fix `m_3907745_ne_18_030_20230521` flown 2023-05-21 at 0.3 m
- **OSM**: 685 features, 13 crossings; spine tags: `highway`=motorway; `lanes`=2/3/4; `maxspeed`=55 mph/65 mph; `oneway`=yes; `turn:lanes`=||merge_to_left/||slight_right/||through;slight_right|slight_right; `surface`=asphalt
- **structures** (3): bridge s=1062–1252 (192.0 m, 5.45 m above ground, class17); bridge s=2686–2732 (48.0 m, 6.51 m above ground, class17); bridge s=3136–3296 (162.0 m, 11.01 m above ground, class17)
- **surface** (per 20 m): {'asphalt_aged': 306, 'concrete': 16}
- **geology**: Adamstown Member, Antietam Formation, Araby Formation, Frederick Limestone, Grove Limestone, Grove Member, Ijamsville Phyllite, Lime Kiln Member, Rocky Springs Station Member
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 95 buildings · 34 POIs · 23 landuse rings · authored: adjustments
- **missing**: nothing

### `frederick-i70`

fix 39.394894, -77.418378 · 1 photo(s) · status **baked**

- **road**: {'name': 'Frederick Freeway'} · 3680.2 m · snap 198.7 m · trimmed [False, True] · fetched 2026-09-21T04:21:41Z (17.4 s)
- **lidar**: `MD_Western_2_D21` (2021) · 4,970,341 pts in corridor · z factor 1.0 · classes: ground 71%, unassigned 28%, bridge_deck 1% · class 17: 0.0027 (trusted)
- **DEM**: reused from cache (sources not re-recorded)
- **NAIP**: reused from cache · tile under the fix `m_3907737_se_18_030_20230521` flown 2023-05-21 at 0.3 m
- **OSM**: 1458 features, 22 crossings; spine tags: `highway`=motorway; `lanes`=2/3/4; `maxspeed`=55 mph; `oneway`=yes; `turn:lanes`=none|none|none|merge_to_left/none|none|through;slight_right/||right/||slight_right
- **structures** (9): overpass s=500–522 (24.0 m, clearance 7.22 m, geometry+class17); gantry s=968–968 (2.0 m, clearance 7.66 m, geometry); overpass s=1010–1028 (20.0 m, clearance 6.1 m, geometry+class17); overpass s=1032–1036 (6.0 m, clearance 5.9 m, geometry+class17); overpass s=1150–1190 (42.0 m, clearance 7.22 m, geometry+class17); overpass s=2170–2202 (34.0 m, clearance 5.37 m, geometry+class17); gantry s=2980–2982 (4.0 m, clearance 6.1 m, geometry); bridge s=3280–3336 (58.0 m, 6.59 m above ground, class17); gantry s=3406–3406 (2.0 m, clearance 5.75 m, geometry)
- **surface** (per 20 m): {'asphalt_aged': 160, 'concrete': 24, 'unknown': 1}
- **geology**: Adamstown Member, Frederick Limestone, Lime Kiln Member, New Oxford Formation, Rocky Springs Station Member
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 347 buildings · 46 POIs · 20 landuse rings · authored: adjustments, placements
- **missing**: nothing

### `hawkins-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 39.010483, -76.605067 · 0 photo(s) · status **not baked**

Missing: site.json, spine_utm.json, osm.geojson, crossings.json, dem_1m.tif, naip.tif, horizon_30m.tif, geology.json, lidar/dtm.tif, lidar/chm.tif, profile.json, surface.json, web/manifest.json, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg, web/horizon_60m.png

### `md450-staples`

*MD 450 (Defense Hwy) between Patuxent River Rd and Staples Corner (MD 424); point is a midpoint estimate (Overpass 429'd), nearest_road should snap to MD 450*  
fix 38.9375, -76.667 · 0 photo(s) · status **baked**

- **road**: {'name': 'Double Gate Road'} · 2722.1 m · snap 369.0 m  ⚠ **check the road**: the fix snapped this far, which usually means it landed on a different road · trimmed [False, False] · fetched 2026-09-21T04:39:54Z (543.3 s)
- **lidar**: `USGS_LPC_MD_VA_Sandy_NCR_2014_LAS_2015` (2014) · 1,029,682 pts in corridor · z factor 1.0 · classes: unassigned 56%, ground 44% · class 17: 0.1288 (demoted) — class 17/18 demoted to unassigned: implausible share, vendor used them as junk bins
- **DEM**: USGS one meter x35y432 MD VA Sandy NCR 2014 — 2020-03-30; USGS 1 Meter 18 x35y432 MD_Central_Processing_D24 — 2026-04-04
- **NAIP**: fetched at 0.3 m, [9600, 3567] px · tile under the fix `m_3807603_ne_18_030_20230712` flown 2023-07-12 at 0.3 m
- **OSM**: 268 features, 42 crossings; spine tags: `highway`=tertiary
- **structures** (0): none
- **surface** (per 20 m): {'asphalt_aged': 93, 'asphalt_new': 33, 'concrete': 11}
- **geology**: Aquia Formation, Calvert Formation
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 149 buildings · 0 POIs · 2 landuse rings · authored: none
- **missing**: nothing

### `patuxent-river-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 38.939008, -76.678069 · 0 photo(s) · status **not baked**

Missing: site.json, spine_utm.json, osm.geojson, crossings.json, dem_1m.tif, naip.tif, horizon_30m.tif, geology.json, lidar/dtm.tif, lidar/chm.tif, profile.json, surface.json, web/manifest.json, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg, web/horizon_60m.png

### `ragged-point-ca1`

*Highway 1, San Luis Obispo County coast*  
fix 35.7595645, -121.3268269 · 0 photo(s) · status **failed**

Last bake log lines:

```
  spine   {'ref': 'CA 1'}  6438.0 m, photo at s=3219.0 (snap 485.5 m), 3 ways, 0 sibling chains
Traceback (most recent call last):
RuntimeError: no EPT dataset covers this corridor
```
Missing: lidar/dtm.tif, lidar/chm.tif, profile.json, web/chm_2m.png

### `rossback-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 38.962826, -76.658618 · 0 photo(s) · status **not baked**

Missing: site.json, spine_utm.json, osm.geojson, crossings.json, dem_1m.tif, naip.tif, horizon_30m.tif, geology.json, lidar/dtm.tif, lidar/chm.tif, profile.json, surface.json, web/manifest.json, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg, web/horizon_60m.png

### `rutland-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 38.968022, -76.634936 · 0 photo(s) · status **not baked**

Missing: site.json, spine_utm.json, osm.geojson, crossings.json, dem_1m.tif, naip.tif, horizon_30m.tif, geology.json, lidar/dtm.tif, lidar/chm.tif, profile.json, surface.json, web/manifest.json, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg, web/horizon_60m.png

### `shady-grove-icc`

fix 39.136908, -77.131681 · 1 photo(s) · status **baked**

- **road**: {'ref': 'MD 200 Toll'} · 6438.0 m · snap 2.0 m · trimmed [True, True] · fetched 2026-09-21T02:06:12Z (196.1 s)
- **lidar**: `TNM:MD_Central_Processing_D24` (2024) · 44,589,516 pts in corridor · z factor 1.0 · classes: unassigned 66%, ground 33%, bridge_deck 0%, noise_high 0%, noise 0% · class 17: 0.0027 (trusted)
- **DEM**: reused from cache (sources not re-recorded)
- **NAIP**: reused from cache · tile under the fix `m_3907755_se_18_030_20230712` flown 2023-07-12 at 0.3 m
- **OSM**: 1170 features, 21 crossings; spine tags: `highway`=motorway; `lanes`=3/4/5; `maxspeed`=60 mph; `oneway`=yes; `surface`=asphalt/concrete; `turn:lanes`=none|none|none|merge_to_left/none|none|none|none|merge_to_left
- **structures** (14): bridge s=940–1006 (68.0 m, 6.83 m above ground, class17); overpass s=1734–1748 (16.0 m, clearance 7.39 m, geometry+class17); gantry s=1978–1978 (2.0 m, clearance 6.49 m, geometry); gantry s=2216–2216 (2.0 m, clearance 5.62 m, geometry); gantry s=2220–2222 (4.0 m, clearance 5.94 m, geometry); gantry s=2572–2572 (2.0 m, clearance 7.01 m, geometry); gantry s=2744–2744 (2.0 m, clearance 6.58 m, geometry); gantry s=2890–2892 (4.0 m, clearance 5.79 m, geometry); gantry s=3076–3076 (2.0 m, clearance 5.79 m, geometry); bridge s=3432–3546 (116.0 m, 11.67 m above ground, class17); overpass s=4140–4156 (18.0 m, clearance 6.72 m, geometry+class17); gantry s=4184–4186 (4.0 m, clearance 7.93 m, geometry); overpass s=5054–5068 (16.0 m, clearance 7.33 m, geometry+class17); bridge s=6320–6416 (98.0 m, 7.57 m above ground, class17)
- **surface** (per 20 m): {'asphalt_aged': 270, 'concrete': 50, 'asphalt_new': 1, 'asphalt_patched': 1}
- **geology**: Bear Island Granodiorite, Sykesville Formation, Wissahickon Formation
- **web**: layers ['dem', 'chm', 'naip', 'horizon'] · 668 buildings · 5 POIs · 24 landuse rings · authored: adjustments
- **missing**: nothing

### `sideling-i68`

fix 39.699936, -78.297794 · 1 photo(s) · status **baked**

- **road**: {'ref': 'US 40 Scenic'} · 4386.3 m · snap 9.3 m · trimmed [False, True] · fetched 2026-09-21T04:29:59Z (33.5 s)
- **lidar**: `MD_Western_1_D21` (2021) · 10,190,481 pts in corridor · z factor 1.0 · classes: ground 59%, unassigned 41%, noise 1% · class 17: 0.0 (trusted)
- **DEM**: reused from cache (sources not re-recorded)
- **NAIP**: reused from cache · tile under the fix `m_3907822_ne_18_030_20230521` flown 2023-05-21 at 0.3 m
- **OSM**: 47 features, 9 crossings; spine tags: `highway`=secondary; `lanes`=2; `maxspeed`=55 mph; `oneway`=no; `surface`=asphalt
- **structures** (0): none
- **surface** (per 20 m): {'asphalt_aged': 207, 'chipseal': 6, 'concrete': 7}
- **geology**: Hampshire Formation, Purslane Formation, Purslane Sandstone; Rockwell Formation, Rockwell Formation
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 4 buildings · 1 POIs · 1 landuse rings · authored: adjustments
- **missing**: nothing

### `south-mountain-i70`

fix 39.4682, -77.523269 · 3 photo(s) · status **baked**

- **road**: {'ref': 'I 70'} · 6438.0 m · snap 7.1 m · trimmed [True, True] · fetched 2026-09-21T04:25:08Z (79.8 s)
- **lidar**: `MD_Western_2_D21` (2021) · 12,412,733 pts in corridor · z factor 1.0 · classes: ground 72%, unassigned 27%, noise 0%, bridge_deck 0% · class 17: 0.0002 (trusted)
- **DEM**: reused from cache (sources not re-recorded)
- **NAIP**: reused from cache · tile under the fix `m_3907736_ne_18_030_20230521` flown 2023-05-21 at 0.3 m
- **OSM**: 212 features, 6 crossings; spine tags: `highway`=motorway; `lanes`=2/3; `maxspeed`=70 mph; `oneway`=yes; `surface`=asphalt/concrete; `turn:lanes`=||merge_to_left
- **structures** (2): bridge s=1242–1346 (106.0 m, 15.35 m above ground, class17); bridge s=4844–4904 (62.0 m, 2.88 m above ground, class17)
- **surface** (per 20 m): {'asphalt_aged': 318, 'asphalt_new': 2, 'concrete': 2}
- **geology**: Catoctin Formation, Catoctin Metabasalt
- **web**: layers ['dem', 'chm', 'naip', 'horizon', 'horizon_naip'] · 29 buildings · 2 POIs · 2 landuse rings · authored: adjustments
- **missing**: nothing

### `st-stephens-church-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 39.021067, -76.642909 · 0 photo(s) · status **not baked**

Missing: site.json, spine_utm.json, osm.geojson, crossings.json, dem_1m.tif, naip.tif, horizon_30m.tif, geology.json, lidar/dtm.tif, lidar/chm.tif, profile.json, surface.json, web/manifest.json, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg, web/horizon_60m.png

### `underwood-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 39.009282, -76.664297 · 0 photo(s) · status **not baked**

Missing: site.json, spine_utm.json, osm.geojson, crossings.json, dem_1m.tif, naip.tif, horizon_30m.tif, geology.json, lidar/dtm.tif, lidar/chm.tif, profile.json, surface.json, web/manifest.json, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg, web/horizon_60m.png

### `waterbury-rd`

*gaussworks brief: Gambrills/Crofton/Crownsville/Davidsonville backroads*  
fix 39.0476, -76.624495 · 0 photo(s) · status **not baked**

Missing: site.json, spine_utm.json, osm.geojson, crossings.json, dem_1m.tif, naip.tif, horizon_30m.tif, geology.json, lidar/dtm.tif, lidar/chm.tif, profile.json, surface.json, web/manifest.json, web/dem_2m.png, web/chm_2m.png, web/naip_1m.jpg, web/horizon_60m.png

