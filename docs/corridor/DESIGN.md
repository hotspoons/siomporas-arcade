# Corridor design — the rules the code is built on

*Companion to `PIPELINE.md` (what runs, in what order) and `SITES.md` (what each bake holds).
This is the *why* and the invariants: the frames, the one-height rule, the LOD footprint, the
grass tile design, every detection rule with its threshold, the sign conventions that have bitten
people, and a one-page "how to add a road". Read from the code on 2026-09-21; the original
design notes from the first night are in `tools/corridor/DESIGN.md`.*

## 1 · Frames

There are exactly three, and two conversions.

| frame | axes | who uses it |
|---|---|---|
| **geographic** | WGS84 lon/lat; Web Mercator for EPT lidar | only inside the fetchers (`geo.Frame`) |
| **site** | UTM zone of the photo (`EPSG:326xx`), metres, **x east, y north**, z NAVD88 m; everything the bake writes; `web/` layers and the manifest are *relative to the site origin* (the photo point) | `tools/corridor`, `web/manifest.json`, `adjustments.json`, `placements.json` |
| **world** (three.js) | X = site x, **Y = up**, **Z = −site y** (south) | `apps/corridor/src/**` |

`toWorld(x, y, z) = (x, z, −y)`. Two families of function, named by frame:

- `groundAt(x, y)`, `heightAt(x, y)` in `props.ts`/`strip.ts` callbacks take **site** y.
- `Site.heightAt(x, y)` is the raw 2 m DEM in site coordinates. `Site.groundAt(x, z)`,
  `Site.edgeDistance(x, z)`, `strip.heightAt(x, z)` take **world** x, z. `edgeDistance < 0` is on
  the pavement.

Along the road there is a fourth, derived frame, the **corridor frame**: along-track metre `s`
and signed lateral offset (`lat`, **positive = left of travel**). `profile.json`, `structures`,
`surface.json`, `buildings[].s/lat` and `structures.json` intervals are all in it, because a
re-bake that moves the centreline sideways must keep a bridge over the road. `editor/corridor.ts`
holds the conversions (`nearestStation`, `atCorridor`, `leftOf`).

## 2 · One surface, one height function

Every bug of the shape "green stuff on the road", "ribbons on the embankment", "the car shakes"
has been two meshes modelling the same ground at different samplings. The rule, in force:

1. **The carriageway spline is the road height.** A centripetal Catmull-Rom through the 10 m
   densified, Gaussian-smoothed spine (`export.py` σ = 30 m; `scene.ts` `+0.4 m`) drives the
   asphalt, the paint, the strip under the pavement, the driver's eye and the car.
   `edgeDistance()` returns the height *from that spline* at the projected station, so the
   ground and the road agree to the millimetre.
2. **The strip is the only ground within 40 m of any carriageway.** 1 m × 2 m, road height under
   pavement (−2 cm), DEM beyond a 0.6–7 m blend. The coarse terrain under it is sunk 2.5 m
   (`sinkUnderStrip`). Anything that stands near the road stands on `strip.heightAt`.
3. **The horizon exists only outside the near-DEM footprint.** Triangles inside are removed;
   the one-cell rim is pinned 3 m under the near terrain (`cutHorizon`).
4. **Authored grade changes happen before the spline.** `flatten` rewrites the spine z; nothing
   downstream knows it happened.

Open case (2026-09-21): "ribbons" on steep embankments — probably the coarse terrain poking
through the strip on a 40° cut where 2.5 m is not enough. Design fix: cut terrain triangles out
of the strip footprint the way the horizon is cut, not a bigger sink.

## 3 · The LOD footprint

Distance is measured with `tuning.ts::lodDistance`, not Euclid: a thing directly behind the
view counts `(1 + LOD_BEHIND_PENALTY)` × as far (default 0.9 → nearly double), ahead counts as
is, and past `LOD_TOPDOWN_PITCH` (0.9 rad) the stretch fades to a circle for map views. The budget
goes where the driver looks.

| band | terrain | trees | grass | props |
|---|---|---|---|---|
| under the wheels → 40 m | strip, 1 m × 2 m | — | blades, full density inside `GRASS_LOD_NEAR` (12 m) | full GLBs |
| → `GRASS_RADIUS` (106 m) | strip / near DEM (2 m, stride to ≤ 1.1 M verts) | ez-tree models inside `TREE_NEAR_RADIUS` (240 m), ≤ `TREE_NEAR_CAPACITY` per variant, re-picked when the eye moves 15 m or turns 25° | blades thinned to `GRASS_LOD_MID_DENSITY` / `FAR_DENSITY` | GLBs |
| → `GRASS_SPRITE_RADIUS` (300 m) | near DEM | impostors: 8-yaw + top atlas of the same models, one quad each, static slots | sprite cards, thinned toward the rim | boxes/GLBs |
| → edge of the 600 m corridor | near DEM draped in NAIP | impostors | — | — |
| → 30 km | horizon 60 m, NAIP-draped, cut under the near DEM | — | — | — |

The near/impostor switch is a hard boundary today (a `TREE_FADE_M` crossfade is the editor
agent's lane). Impostor cards lie flat above `IMPOSTOR_FLAT_PITCH` so a top-down view is not
fanned cards over the road.

## 4 · Grass as tiles

The first grass re-seeded the whole ring every 5 m of travel — up to 400 000 blades, a ground
lookup and five hashes each, a 25 MB upload, every 0.75 s at road speed. That was the hiccup.

Now (`grass.ts`): the world is cut into **8 m tiles**. A tile is generated **once**, at full
density, with its blades in **random-rank order** so any prefix is a uniform thinning; it holds
blades only if it is inside the blade radius (~7 000 records) and cards otherwise (~50). The
visible set is a typed-array copy of cached prefixes; only tiles entering the ring cost anything,
and at most `GRASS_TILES_PER_FRAME` of them per frame (`pending` is the queue; watch it at
30 m/s — if it grows, generation moves to a worker). Placement is data: open ground (canopy
< 3 m), off the pavement (`edgeDistance`), mown short inside `GRASS_MOW_LINE`, taller with
weeds to `GRASS_MAX_FROM_ROAD`, none on slopes over `GRASS_SLOPE_MAX`, bare patches by hashed
cells; positions are hashed from a fixed lattice so nothing jumps between re-seeds. Wind fades out
above `GRASS_WIND_STILL_BELOW` (4 m/s) — nobody sees sway from a moving car. Season sets the
colour ramp, height and dryness; `GRASS_DRY_ADD` puts September on top of it.

## 5 · Detection rules, with their numbers

Every rule below reads something measured. Where a number is a calibration it says so.

**Road identity** (`osm.py`): nearest drivable way by distance + class penalty (motorway 0 …
tertiary 320, other 420; `_link` +150; anonymous +200). Chain by `ref` else `name` through shared
end nodes. Siblings: same identity within 120 m.

**Crossings**: endpoint within 6 m of the intersection → merge, not a crossing. Over/under from
the crossing's tags, then the spine's tags at that metre, then power → over, waterway → under,
motorway/trunk + highway → *inferred* over, two ordinary roads → grade.

**Lidar trust**: class 17 > 3 % of the corridor → classes 17 and 18 are junk bins, demoted.

**Canopy**: max of (vegetation 3–5 **or unassigned 1**) − filled DTM, 0–80 m, zeroed under class-17
cells, and at export zeroed over every carriageway (max lanes × 3.66 + 4.2 m, + 2 m) and under
every OSM building footprint + 1 m. A tree in the viewer is a CHM cell ≥ 3 m on a 6 m lattice
(coarsened to fit 120 k), never within 3 m of a pavement edge.

**Bridge we are on**: class-17 points within 14 m of the centreline, run ≥ 4 m, deck continues our
grade better than the DTM does, deck ≥ 1.5 m above the DTM.

**Overpass / gantry**: non-noise points 4.5–40 m above the driving surface within ±8 m, 6 of 8
lateral 2 m cells occupied, **underside planar**: std of per-cell minima ≤ 0.5 m and range
≤ 1.5 m (measured: real decks ≤ 0.28 / 0.74; Race Track Road's canopy 1.2–5.3 / 3–15). Run ≥ 5 m
→ overpass, else gantry. Never on a station already on a bridge.

**Pavement class** (`surface.py`, every 20 m, calibrated on one interstate): lidar lane intensity
relative to the corridor's own median ratio (`new ≤ 0.75×`, `concrete ≥ 1.6×`); NAIP lane
brightness absolute (`concrete ≥ 120`, `new ≤ 90`); OSM `surface=` as a vote; chip seal needs
texture ≥ 22 and a non-motorway class; a ≥ 35 % intensity jump against both neighbours is a patch.

**Building height** (`buildings.py`): OSM `height` → `building:levels × 3.2` → lidar DSM−DTM
(median of the top quartile over the footprint) → 6 m; footprints < 15 m² dropped.

**Adjustment proposals** (`areas.py`): a side whose *mean* canopy is < 40 % of the other's (and
the other ≥ 3 m) → one whole-side handle (a leaf-off flight line); else runs where a 50 m-smoothed
canopy departs from the same side's ±300 m rolling median by max(3 m, 60 %) for ≥ 150 m, strongest
6 per side; one band ±40 m per structure; one per surface-class run ≥ 30 m. All knobs neutral.

**Cut faces** (`cuts.py`, this agent — rule as designed, thresholds to be measured on Sideling,
Braddock and Bonnie Branch): from `profile.ground_rel` (ground beside the surface at 8/15/25/40/
60 m) and the DTM, a cut face is ground rising **> 0.6 m/m within 15 m of the pavement for
≥ 20 m** along-track. `artificial` when the face is straight, constant-slope and parallel to the
road (blasted or graded); `natural` when both sides rise (a ravine) and the low line follows an
OSM stream. Manifest key `cuts`: intervals with side, height, slope, class, lithology.

**Exposed rock** (`rock.py`): bare ground (canopy < 0.5 m) with high 1 m roughness (DTM residual
from a 5 m plane), slope > 30°, lithology from `geology.json` (shale / siltstone / schist /
granite / sandstone / metabasalt), NAIP grey-brown → polygons with a rock type. Manifest key
`rock`.

**Water** (`water.py`): OSM `waterway=*` lines and `natural=water` polygons snapped to the DTM
low line; a fall or rapid where the stream drops > 2 m over 20 m. Manifest key `water`.

## 6 · Sign conventions (the ones that bit people)

- three.js `rotation.y = θ` sends local **+Z** to `(sin θ, 0, cos θ)` and local **+X** to
  `(cos θ, 0, −sin θ)`. With `θ = atan2(dir.x, dir.z)` local Z runs *along* the road and local X
  is the road's left normal. The stray `+π/2` that used to be in `buildBridges` laid every
  abutment across the carriageway as a wall.
- **Left of travel** for a world direction `dir` is `(dir.z, 0, −dir.x)`. Check: heading north,
  `dir = (0,0,−1)`, left = `(−1,0,0)` = west.
- A **compass bearing** is 0 at north (−Z), 90 at east (+X): `bearing(v) = atan2(v.x, −v.z)`.
  A placement's `yaw_deg` is a bearing and is rendered `rotation.y = −(yaw + yaw_offset_deg)·π/180`.
- `buildings[].rect.yaw_deg` is a **math angle from east, 0–180**, describing an axis, not a
  facing. Aligning a box's long side to the plot is `yaw = −rect.yaw_deg`. Getting this wrong
  mirrors a town about the east axis and looks plausible until you compare with the photo.
- `profile.ground_rel`: **positive = ground above the pavement = a cut**; negative = a fill.
  `left_*` is left of travel.
- `tsconfig` has `erasableSyntaxOnly`: no constructor parameter properties.
- Custom `ShaderMaterial`s must include `common` + `logdepthbuf_pars_*` + `logdepthbuf_*` (the
  renderer uses a logarithmic depth buffer) or they fail every depth test silently; fog on a
  `ShaderMaterial` is fixed at compile time.
- A missing optional JSON must 404 (the middleware does); Vite's SPA fallback would answer
  `index.html` with a 200 and `r.json()` dies on `<!doctype`.

## 7 · How to add a road (one page)

1. **Where.** Either drop the phone photos into `ext/ref-driving/` and run `just corridor-sites`
   (EXIF fixes → clustered 400 m → `sites.json`; add a `NAMES` entry in `sites.py` for the slug),
   or append to `tools/corridor/sites.json` by hand:
   ```json
   { "slug": "bonnie-branch-rd", "lat": 39.2322538, "lon": -76.785061, "photos": [], "heading_deg": null, "note": "why" }
   ```
   The fix does not have to be on the road; `nearest_road` snaps it (the snap distance is in the
   manifest). It does have to be nearer the road you mean than a bigger one (class penalties
   prefer the interstate).
2. **Bake.** `just corridor-fetch bonnie-branch-rd` (add `--skip lidar` for a two-minute pass
   without the point cloud). Watch the `spine` line: the `ident`, the length, the snap distance
   and the sibling count tell you whether it found the road you meant. Eastern-Maryland sites
   fall back to TNM LAZ tiles (≈ 6 GB, cached under `data/cache/laz/`); the first one takes a
   while. The bake ends with `web/manifest.json` and refreshes `sites/index.json`.
3. **Look.** `just corridor-view` (or your agent's port) → the site appears in the picker.
   Check `preview.png` beside the bake for the spine/crossings/structures over the imagery.
4. **Proposals.** `python -m corridor areas bonnie-branch-rd` seeds `adjustments.json`; open
   `/editor.html` to slide, place, flatten or bridge.
5. **Publish** when the bucket exists: `python -m corridor publish bonnie-branch-rd`.

If it went wrong: no manifest → read the exception in the log (`SITES.md` records these);
`no drivable way within 800 m` → the fix is off; a spine with the wrong `ident` → the fix is
nearer a bigger road (move the point or add a class penalty); `no EPT dataset covers this
corridor` with no TNM LPC → no lidar, the bake continues with `--skip lidar` semantics and the
viewer has no trees, structures or cut/fill.

## 8 · Portability

Unchanged from the first night's notes: the bake is the source of truth, the scene is disposable.
Intermediate format is glTF + JSON in metres in the site frame; the road is a spline with a
profile, not a mesh; props are a library with a manifest (`catalog.json`) and instancing lists
`[asset, x, y, z, yaw, scale]`; nothing procedural runs in the browser beyond instancing that
could have been baked. Godot 4 or Bevy read all of it unchanged.
