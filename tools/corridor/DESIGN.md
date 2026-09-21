# The real-road driving game — design notes, 2026-09-20

*What we are trying to build, what the corridor data makes possible, how the props get made, and
how this stays portable to a real engine. Written after the first two corridors baked; revise as
the numbers come in.*

## The idea in one paragraph

Pick a route. Pull the public record for it — OSM for what the road *is*, lidar for what is
*there*, imagery for what it *looks like*, geology for what the cuts are made of — and turn that
into a drivable stretch of western Maryland that is recognisably that stretch: the arch bridge over
the Catoctin cut, the grass median widening past Myersville, the shale walls at Sideling Hill, the
piedmont ridge filling the windscreen on I-270. Not a photo-textured Google Earth; a *game* built
from measured geometry and generated props, where a bridge is a parameterised bridge and a boulder
is a boulder with a collider.

## The pipeline, and where each piece already exists

```
photos ─► sites ─► corridor bake (tools/corridor) ─► site directory
                       │                                   │
                       │  OSM spine + tags                 ├─► ROAD SURFACE       lanes, shoulders, median, grade, banking
                       │  1 m DEM + lidar profile          ├─► TERRAIN            cut/fill faces, embankments, ditches
                       │  canopy height model              ├─► VEGETATION FIELD   where trees are, how tall, how dense
                       │  structures (bridge/overpass)     ├─► STRUCTURES         parameterised bridges, culverts, gantries
                       │  geology units                    ├─► ROCK PALETTE       which stone the cut faces show
                       │  30 m horizon DEM                 └─► FAR TERRAIN        the ridge on the windscreen
                       │
   flux.2-dev ──► keyed cut-outs ──► TRELLIS.2 ──► .glb props ──► prop library (rocks, trees, barriers, bridge parts)
```

Everything left of the arrows exists after today. Everything right of them is the game.

### Road surface

`spine_utm.json` is the carriageway centreline in metres with OSM tags per along-track segment:
`lanes`, `maxspeed`, `bridge`, `surface`. `siblings` is the other carriageway. From those two
lines and a lane width (3.66 m US interstate standard, measurable from NAIP where it matters):

- sweep a cross-section along the spine: lanes × 3.66, shoulders (3.0 m outside / 1.2 m inside
  on I-70, read off NAIP once per corridor rather than assumed), then the median to the sibling;
- the **median type** is a classifier on the median width and what OSM has in it: > 12 m of grass
  (South Mountain), a `barrier=jersey_barrier` way (I-70 at Frederick), a `barrier=guard_rail`;
- **grade** comes from `profile.json` `road_z`, already lifted onto bridge decks; **banking** is
  the lateral DTM difference at ±8 m, which is the superelevation on curves (a real number here,
  not a guess);
- the mesh is a ribbon: triangle strip per lane, UVs in metres so a 1 texel = 1 cm asphalt texture
  tiles, lane markings as a second decal strip driven by OSM `lanes` and `turn:lanes`.

### Terrain: cut and fill

`ground_rel` in the profile gives ground height relative to the pavement at 8/15/25/40/60 m either
side, every 2 m. That IS the artificial canyon. Where `left_15` is +12 m and `left_8` is +9 m, the
cut face is steep and starts at the shoulder; where `right_40` is −17 m the road is on a fill with
a long embankment down to a creek. Rules:

- |ground_rel| < 1.5 m at 15 m → flat verge, mow-line grass;
- ground_rel > 3 m and slope between 8 m and 15 m > 45° → **rock cut**: instance the cut-face
  props (below) along the face, oriented to the spine, textured from the geology unit;
- ground_rel < −3 m → **embankment**: grass slope, guardrail at the shoulder (OSM
  `barrier=guard_rail` confirms), drainage ditch prop at the toe;
- the 1 m DTM itself is the ground mesh out to ±200 m, decimated with error bounds, and the 30 m
  horizon DEM beyond, with a skirt blending the two at the corridor edge.

### Structures

`structures` in `profile.json` is measured: along-track start/end, deck height, clearance.
`crossings.json` says what the crossing is (a tertiary road, a power line, a stream) and which way
it passes. A **parameterised bridge** takes: span (structure length), deck width (the crossing
way's `lanes` × 3.66 + parapets), clearance, the two abutment ground heights (DTM at the ends),
and a *type*. Type is where the photos come in: South Mountain's arch is a steel through-arch on
concrete abutments; the Racetrack Road rail bridge is a riveted plate girder; most I-270 overpasses
are prestressed concrete beam on pier bents. Three or four types, each a kit of TRELLIS-generated
parts (abutment, pier, girder segment, arch rib segment, parapet panel) stretched along the span,
covers every crossing in these corridors. Culverts (`tunnel=culvert` waterways) are a headwall
prop at the fill toe.

### Vegetation

The canopy height model is per-metre tree height. Placement: sample the CHM, Poisson-disc inside
cells above 3 m, tree height from the CHM value, species mix from the geology/elevation band
(ridge oaks, floodplain sycamores, roadside red maples). The **manicured roadside tree** the photos
show — single-stem, mown grass under it — is where the CHM has an isolated 8–12 m blob within 30 m
of the shoulder over a flat verge. Old growth is a continuous canopy above 20 m. Both are the same
prop family at different heights with different lower-branch trims.

### Rocks and the cut faces

Macrostrat gives the formation under every 250 m of spine. So far:

| corridor | formation | what the props look like |
|---|---|---|
| South Mountain / Braddock, I-70 | Catoctin Formation (metabasalt, greenstone) | dark grey-green, blocky, chloritic sheen, blast-fractured faces |
| Sideling Hill, US 40 / I-68 | Rockwell Fm, Purslane Ss (syncline) | thin-bedded grey shale + tan sandstone, the famous folded layers |
| I-270 Frederick → Clarksburg | Ijamsville phyllite, Urbana Fm | slaty, silver-grey, splitting in plates |
| ICC, Bowie | Coastal-plain sands and gravels | no rock cuts; sand faces, riprap only |

Prop briefs per formation (each: five to eight variants, 0.5 m to 3 m, plus a 6 m cut-face panel
that tiles): *shale bedded boulder*, *shale talus fan*, *cut-face panel with drill-hole scars*,
*greenstone block*, *sandstone ledge*, *riprap pile*. Generated with flux on a chroma key,
keyed, reconstructed with TRELLIS.2, finished with meshopt (see `tools/assetgen/finish.mjs`).

### Far terrain and LOD

The 30 m horizon DEM (60 km square) is the ridge line. Rendered as a coarse mesh with a
hypsometric-plus-NAIP-tint material, it puts Catoctin and South Mountain in the right place from
20 km out and costs nothing. LOD plan, near to far:

| band | terrain | trees | props |
|---|---|---|---|
| 0–150 m | 1 m DTM mesh, full props | TRELLIS trees, 3–8 k tris | full meshes |
| 150–600 m | 1 m DTM decimated 4× | impostor cards baked from the same models at 8 yaws (the coast game already does this) | impostors |
| 600 m–3 km | 4 m DTM | canopy as a displaced, textured shell over the CHM (a "forest blanket") | none |
| 3–30 km | 30 m horizon DEM | colour only, from NAIP + season tint | none |

The forest-blanket trick is what gives the piedmont its look from a distance: canopy is a
continuous surface, not individual trees, and the CHM *is* that surface.

## Staying portable to a real engine

The three.js POC is disposable; the data and the props are not. Rules that keep the exit open:

1. **The corridor bake is the source of truth, not the scene.** Everything derived (road ribbon,
   cut-face placement, tree instances, bridge params) is regenerated from `data/sites/<slug>/` by
   a deterministic step with a seed. Port the generator, not the scene.
2. **Intermediate format is glTF + JSON, metres, Z-up in the site frame.** glTF is what Godot,
   Unity, Unreal and Bevy all import. The site frame is a UTM zone with a recorded origin, which is
   trivially re-based to an engine's ENU origin (and matches gaussworks' ENU worlds).
3. **The road is a spline with a profile, not a mesh.** Store the centreline, the lane count per
   segment, the cross-section; every engine has a spline-mesh node that takes exactly that.
4. **Props are a library with a manifest** (`assets.json` style, as the coast game does): id,
   glb, footprint, height, collider type, LOD set. Instancing lists are `[prop_id, x, y, z, yaw,
   scale]` — the least engine-specific thing possible.
5. **Physics stays simple in the POC** (heightfield + convex hulls for rocks, box for barriers) so
   nothing depends on a JS physics engine's quirks.
6. **No engine-side procedural generation in the browser** beyond instancing; if something has to
   be computed, compute it in the bake and ship the result. This is also the R2 story: the Worker
   serves baked results, it never bakes.

Candidate real engine when the time comes: Godot 4 (glTF-native, C#/GDScript, open licence,
exports real executables) or Bevy (Rust, if the runtime should be code-first). Both read
everything above unchanged.

## AI for feature detection from maps, geography and geology

What the cluster could run, and what each would buy us. In order of payoff:

1. **Nothing, first.** The classified point cloud already labels bridge decks, ground, water and
   (in most projects) vegetation and buildings, and the geometric overhead test in `lidar.py`
   finds the unlabelled ones. OSM names the crossing. Before adding a model, exhaust the labels.
2. **SAM 2 / segment-geospatial (`samgeo`) on NAIP.** Prompt-free segmentation of 30 cm imagery
   into pavement, gravel shoulder, mown grass, rough grass, tree crowns, bare rock, water, roof.
   That is the *material* map the terrain shader wants, and it separates "mown verge" from
   "meadow" — which the CHM cannot. Runs on one GPU in seconds per corridor. Highest value, lowest
   risk.
3. **A geospatial foundation model for land cover** (IBM/NASA Prithvi-EO 2.0, or Clay) fine-tuned
   on NLCD-style classes over NAIP+NAIP-NIR. Better than SAM at semantic labels (deciduous vs
   evergreen, crop vs pasture), worth it once we cover more than a few corridors. Alternatively
   just pull **NLCD 2021** (30 m) and **NAIP NIR** for an NDVI-based evergreen/deciduous split —
   free and no training.
4. **Tree-crown detection: DeepForest** (RGB → individual crown boxes) or `detectree2` (Mask
   R-CNN crowns). Gives individual trees with crown diameter from imagery; combined with CHM height
   that is a per-tree species-agnostic instance list. Use for the near band only.
5. **Rock-face classification from the profile plus imagery.** Not a downloadable model; a small
   classifier over (`ground_rel` slope, NAIP texture, Macrostrat unit) → {cut face, natural
   outcrop, retaining wall, embankment}. A few hundred labelled stations from these corridors would
   train it. Low priority: the rules above will do for ten corridors.
6. **Vision-language model on the driving photos** (Qwen2.5-VL or Pixtral on the cluster): tag
   each frame with barrier type, median type, lighting masts, sign gantries, bridge type. It
   converts Rich's photos into the labelled ground truth the rules and props are checked against,
   and it can run over dash-cam video later for a whole route. Cheap to stand up next to flux.
7. **Geology**: Macrostrat is already the model. The USGS **Maryland Geological Survey 1:24k
   quads** exist as scans; a segmentation of those is a research project, not a plan.

Recommended next deployment: **samgeo (SAM 2) as a service** next to recon, POST a NAIP tile,
get back a class mask. Then a VLM for photo tagging.

## What landed on day one (2026-09-20, evening)

- **Viewer** (`apps/corridor`, `just corridor-view`, phone layout, drive mode): imagery-draped
  1 m terrain, 30 m horizon, road surface from OSM lane counts with edge lines and dashes, trees
  from the canopy, overpasses with piers, structures clickable. Tunnel via `just corridor-tunnel`
  (a devproxy in front so the URL survives Vite restarts).
- **Surface detection** (`corridor/surface.py`): lidar intensity in the lanes + NAIP brightness →
  pavement class every 20 m; concrete lands exactly on bridge decks. Textures per class from flux
  (`tools/surfaces`), with derived normal and roughness maps, tiled at real scale.
- **Trees in two LODs**: lollipops for all ~35k canopy cells, and `@dgreenheck/ez-tree` procedural
  oaks/ash/aspen (MIT, textured bark, billboard leaves) for the ~1,000 nearest the eye, each scaled
  to its measured canopy height. SeedThree (WebGPU, GLB export with per-LOD meshes) and Blender's
  Sapling add-on are the alternatives if ez-tree's look runs out; TRELLIS trees from flux images
  remain the target for hero specimens.

### Later the same night

- **Surface**: stochastic hex tiling over three flux variants per class plus an 8 m macro map,
  after a single tile read as a repeat within seconds (Rich, correctly). Concrete only ever lands
  on bridge decks so far, which is right.
- **Trees**: near field ez-tree, far field impostors baked from the same models; both take a
  season. Grass/weeds are instanced blades placed from the canopy model and the road distance.
  Seasons are a palette (`season.ts`): winter bare, spring thin lime, summer full, autumn per
  species; grass ramp, ground tint and sky follow.
- **Geometry**: one centripetal Catmull-Rom through the 10 m densified spine (z from lidar)
  drives pavement, paint, grading and the driver's eye — no kinks at OSM nodes.
- **USGS**: DEM tiles come off the `prd-tnm` bucket (15 MB/s vs 3 MB/s); LPC LAZ is not mirrored
  there, so lidar delivery tiles still come from rockyweb with retries; the image services get
  back-off on 5xx.

## What the first two corridors say

South Mountain (I-70 eastbound, 6.4 km): I-70 is on two bridges (106 m over Harmony Road and Little
Catoctin Creek, 15 m above the valley; 62 m over Hollow Road, 2.9 m clearance under). No overpasses.
Ground stands up to 18 m above the pavement 40 m right of the road — the cut on the Catoctin
climb. Geology: Catoctin metabasalt. Lidar 2021, 26 pts/m², bridge decks labelled, vegetation NOT
labelled (everything not ground is "unassigned"), which is why canopy is derived geometrically.

Braddock (I-70 eastbound, 6.4 km): thirteen OSM crossings, including the arch bridge from the
photo — see the fetch report once it lands.

The frame whose fix was on New Design Road is dropped: a mirror shot of I-270 with a GPS fix 800 m
off the highway. GPS lag on a phone in a car is 5–10 s, which at 70 mph is 150–300 m; the photo
of the arch bridge shares a fix with a frame 84 s earlier, so the bridge is 2.5 km down the road
from where its EXIF says.
