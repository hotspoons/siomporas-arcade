# AUTOGEN — growing neighbourhoods, business parks and towns along a corridor

**Implemented**, in the browser, as mode 3 of the corridor editor:
`apps/corridor/src/editor/autogen.ts` (the rules) and `grow.ts` (the loop around them). Press **G**
in `/editor.html`; the result is `g-` items in `placements.json`.

It runs in the browser rather than as a `python -m corridor autogen` subcommand, and that was a
change of plan worth recording. The loop this has to serve is *generate → look at it → fix the six
it got wrong → generate again*, and a loop with a shell round trip in it is a loop nobody runs
twice. Everything the rules need is already in `web/manifest.json`; the three quantities that
genuinely need the GIS stack are precomputed there by `corridor/buildings.py` (§10).

Sections 2–7 below are the rule set, and describe the shipped code. §8 is the override model —
how a regeneration keeps the corrections you made to the last one. §9 says what is not done.

## 1. What the corridor already knows

| input | where | what it gives |
|---|---|---|
| spine + siblings | `web/manifest.json` | along-track `s`, lateral offset, pavement half-width per station |
| OSM features | `<site>/osm.geojson` | `way[building]` footprints, `way[landuse]` polygons, service roads, barriers |
| NAIP 1 m | `web/naip_1m.jpg` | roof colour, parking-lot extent (bright, flat, unvegetated) |
| lidar DSM/CHM | `<site>/lidar/` | true roof height per footprint; where the trees actually are |
| Overture buildings | trailworks `pipeline/ingest/overture.py`, GeoParquet cached per region, DuckDB bbox query | footprint + `height` + `num_floors` + `names.primary` |
| catalog | `apps/corridor/public/assets/catalog.json` | `{id, category, footprint_m, height_m}` |

Two facts set the whole design, both measured over the nine baked sites:

- **3413 footprints, 2887 of them `building=yes`.** The tag is 85% noise. Category has to be
  *inferred from geometry and context*, never read off the tag.
- **Landuse is sparse** — 35 `residential`, 17 `commercial`, 7 `retail` polygons across nine
  sites. Zoning covers a minority of the corridor, so it is a *hint*, not the partition.

And one constraint: the bake is a **ribbon 300 m each side** of the road. A big-box store and its
lot fit. A town does not. Autogen fills frontage, not settlements.

## 2. Zone (R1) — every point gets one, first match wins

1. inside an OSM `landuse=` polygon → its zone
2. else: from footprint statistics in a 150 m disc — see R1b
3. else: `rural`

| landuse | zone | landuse | zone |
|---|---|---|---|
| retail, commercial | `commercial` | farmland, farmyard, meadow, orchard | `farm` |
| residential | `residential` | forest, grass, recreation_ground | `open` |
| industrial, construction, quarry | `industrial` | religious, cemetery, school | `civic` |

**R1b, derived zone** from the 150 m disc, first match: median footprint > 1500 m² → `commercial`;
count ≥ 6 and median 80–400 m² → `residential`; count ≥ 1 and max > 400 m² → `commercial`;
count ≥ 1 → `rural`; count 0 → `open`.

## 3. Category (R2) — from shape, height and zone

Per footprint: `A` = area m², `E` = elongation (long/short side of the minimum rotated rectangle),
`H` = height (Overture `height` → `num_floors`×3.2 → lidar DSM minus DTM over the footprint →
6 m). Deciles of `A` over the baked sites run 13 / 50 / 99 / 149 / 171 / 186 / 207 / 238 / 405 m²,
so the thresholds below are cut against real data, not guessed.

| condition | category |
|---|---|
| `A < 40` | `shed` |
| `A < 300`, `H < 9` | `house` |
| `A < 300`, `H ≥ 9`, `E < 2.5` | `apartments` |
| `300 ≤ A < 800`, zone `residential` | `house_large` |
| `300 ≤ A < 800`, zone `commercial` | `restaurant` if `A < 450` else `retail_unit` |
| `800 ≤ A < 4000`, `E ≥ 3` | `strip_mall` |
| `800 ≤ A < 4000`, `E < 3`, `H ≥ 11` | `office` |
| `800 ≤ A < 4000`, zone `farm` | `barn` |
| `A ≥ 4000`, zone `industrial` | `warehouse` |
| `A ≥ 4000` | `big_box` |
| any, within 45 m of a `highway=service` loop and `A < 600`, zone `commercial` | `gas_station` |
| any, `landuse=religious` / `building=church` within | `church` |

Ties are broken toward the *larger* category: a mis-built big box reads as a plausible mistake, a
house on a 6000 m² pad does not.

## 4. Asset choice (R3)

For a footprint of `(w, d)` and category `c`, score every catalog entry:

```
fit = |ln(A_catalog / A_footprint)| + |ln(E_catalog / E_footprint)| + 0.5·|ln(h_catalog / H)|
score = fit + (0 if entry.category == c else 1.5)
```

Take the best. Then `scale = sqrt(A_footprint / A_catalog)`, and an entry that would need to go
outside **`scale_min..scale_max`** (0.7–1.4 by default, both knobs in the panel) is not considered
at all — it is the wrong object, not a small one. If nothing fits, the footprint is skipped and
counted under *no catalog asset fits*, which is a message about the catalog rather than the site.
The catalog therefore has to span the range: 19 entries from a 6 × 4 m shed to a 120 × 78 m big
box, `footprint_m` always **[long, short]**.

## 5. Siting (R4)

- **Yaw**: the minimum rotated rectangle's long axis, wherever a real footprint exists — it beats
  the road normal on a corner lot and on a cul-de-sac, and the bake measured it. Invented frontage
  has no rectangle, so it uses the road normal (`yawFacingRoad`).
  **Watch the frame.** `rect.yaw_deg` is `degrees(atan2(dy, dx)) % 180`, a math angle measured
  counterclockwise from EAST, describing an axis. A placement's `yaw_deg` is a compass bearing,
  rendered as `rotation.y = -yaw·π/180`. The conversion that puts a box's long side on the
  rectangle is `yaw = -rect.yaw_deg` (`yawForLongAxis` in `editor/corridor.ts`). Get the sign
  wrong and you get a town mirrored about the east axis, which looks entirely plausible until you
  put it next to the air photo.
- **Setback**, from the *pavement edge* (not the centreline), when the footprint is invented rather
  than real: `commercial` 30 m (parking in front), `retail_unit` in a mall row 45 m, `residential`
  14 m, `industrial` 45 m, `farm` 70 m, `civic` 25 m.
- **Keep-out**, hard: pavement + 10 m; inside any `struct-*` adjustment area; within 8 m of a
  `crossings.json` entry; anywhere the CHM says > 6 m of standing canopy, unless the footprint is
  real (in which case the canopy is wrong and autogen emits a `tree_density: 0` area instead).
- **No overlap**: place biggest first, reject any candidate whose footprint circle
  (`max(w,d)/2 · scale`) intersects one already placed.

## 6. Procedural vs placed (R6)

**Placed** (goes in `placements.json`): every building, water towers, billboards, gateway signs,
pole signs — anything with an identity the eye reads as an object.

**Procedural** (generated by the viewer from rules, never enumerated as items): parking lots, lot
striping, driveways and curb cuts, kerbs, lot fences and hedges along landuse boundaries, power
poles along the verge at a 45 m pitch, lawn. A 400-space lot is 400 rectangles; putting those in a
JSON file would make `placements.json` unopenable and unhandeditable, which defeats its purpose.

Lot geometry, for the procedural side to consume: parking area = `footprint × ratio`, ratio by
category — `big_box` 3.0, `strip_mall` 2.5, `retail_unit` 2.0, `restaurant` 1.6, `office` 1.4,
`warehouse` 0.6, everything else 0. The lot occupies the gap between the setback line and the
building frontage, clipped to the keep-out and to the landuse polygon where one exists.

**Ground, not objects**: a lot, a lawn or a farmyard changes what the ground *is*. That is an
adjustment area, not a placement — autogen emits `surface_class` + `grass_*` + `tree_density`
areas for these, which is precisely what the areas schema is for.

## 7. Invented settlements (R5)

Where the corridor is `rural`/`open` and Rich wants a town anyway, seed instead of read. Per side,
walk `s` and draw a gap from the zone's spacing distribution, then site as in R4:

| zone to invent | frontage spacing | mix |
|---|---|---|
| `strip` (commercial ribbon) | 55 ± 20 m | gas 1, restaurant 2, retail_unit 4, strip_mall 1, motel 1 |
| `hamlet` | 90 ± 40 m | house 6, church 1, barn 2 |
| `business park` | 130 ± 30 m | office 3, warehouse 2 |

Density falls off with distance from the nearest real junction in `crossings.json`: full mix within
400 m of a junction, half beyond 800 m, nothing beyond 1500 m. Roadside commerce grows at the exits
and this is the cheapest way to make an invented town look like it grew rather than got extruded.

## 8. Override — what survives a regeneration

The generator is only useful if you can disagree with it, so an id is never a fresh guid. A
generated item's id is **derived from its source building index** (`g-137`), or for invented
frontage from its side and along-track metre (`g-inv-l-2480`). The same input lands on the same id
every run, which is what makes the following work:

| you did | stored as | what the next generate does |
|---|---|---|
| moved / turned / scaled / retagged a `g-` item | `"locked": true` on the item | leaves it exactly as it is |
| deleted a `g-` item | its id in `autogen.deleted` | does not put it back |
| placed something by hand | a `p-` id | never touched — hand items are not autogen's business |
| changed a knob | `autogen.params` | everything unlocked is re-made under the new rules |

So "generate, fix six, try a different density" costs one keypress and keeps the six. The panel
shows the tally — generated / locked / by hand / deleted — with buttons to restore the deleted and
to unlock everything, and `clear generated` for a genuine clean slate.

`placements.json` therefore carries one optional block the viewer ignores:

```jsonc
"autogen": { "params": { …the knobs… }, "deleted": ["g-88"], "ran": "2026-09-21T01:12:00Z" }
```

Only the invented frontage is random, and it is seeded — footprints from the bake give the same
answer every run, so pressing generate twice with the same knobs is a no-op.

## 9. What is not done

- **Procedural lots, striping, driveways, fences, power poles** (§6). The rules are written; none
  of it is generated. It is the next largest visible win after the buildings themselves.
- **Ground as adjustment areas.** §6 says a parking lot or a farmyard is a change to what the
  ground *is*, and belongs in `adjustments.json`. Autogen emits placements only; it does not yet
  write `g-` areas. Concretely this means a generated building can stand in a stretch the lidar
  says is forest, with trees through it — the canopy is not cleared under a new footprint, because
  the browser has no canopy sampler. Either the bake zeroes the CHM under `buildings[]` the way it
  already does under the road, or `Site` exposes a canopy lookup and autogen emits the clearings.
  The first is less code and helps every consumer.
- **Overture** heights and names. `buildings.py` has the slot (`height_src`); nothing fetches them,
  so 156 of frederick-i70's 347 footprints fall through to the 6 m default.
- **Non-uniform fit.** A `Placement` carries one uniform `scale`, so a catalog asset is matched to
  a footprint's AREA and rejected if it would have to stretch past `scale_min..scale_max`. A real
  46 × 30 m footprint therefore gets an asset of roughly the right size rather than exactly the
  right outline. The honest fix is procedural massing from `ring` — extrude the real polygon —
  which is a renderer feature, not an autogen one.
- **Model facing.** The box proxies have their long side on local +X, so §5's yaw is exact for
  them. A reconstructed `.glb` faces whichever way TRELLIS left it; a per-entry `yaw_offset_deg`
  in the catalog is the place to fix that, one number per asset, by eye.

## 10. What the bake has to add first

`osm.py`'s `FEATURE_FILTERS` fetched `way[building]` and `way[landuse]` but **no POI tags at all** —
zero `amenity`, `shop` or `tourism` features across nine sites — while 2887 of 3413 footprints were
a bare `building=yes`. Those filters have since been added and the nine sites re-fetched, which
turns a large slice of R2 from inference into reading: a `shop=supermarket` node inside a 5000 m²
footprint settles the category outright.

What still has to happen is in `export.py`. Autogen is a *browser-side and pipeline-side* consumer
of `web/manifest.json`, and three of the quantities every rule above needs cannot be computed
without the GIS stack — so they belong in the bake, not in a loop over `osm.geojson`:

```jsonc
"buildings": [{
  "ring":      [[x, y], ...],   // site frame m, simplified to 0.5 m, closed implicitly
  "area_m2":   187.3,
  "rect":      { "w": 18.2, "d": 10.3, "yaw_deg": 41.2 },  // MINIMUM ROTATED RECTANGLE
  "height_m":  6.4,
  "height_src": "overture" | "osm" | "lidar" | "default",
  "s": 1240.5, "lat": -78.2,    // along-track metre and SIGNED lateral offset of the centroid
  "tags": { "building": "yes", "shop": "supermarket", "name": "..." }
}],
"landuse": [{ "class": "residential", "ring": [[x, y], ...], "area_m2": 41200 }],
"pois":    [{ "x": .., "y": .., "s": .., "lat": .., "kind": "shop=supermarket", "name": "...",
              "building": 12 }]   // index into `buildings`, or null
```

Why each of the three derived fields, since they are the whole ask:

- **`rect`** is what R2 keys on. Elongation separates a strip mall from an office block and a barn
  from a house, and the minimum rotated rectangle's long axis beats the road normal for yaw on a
  corner lot. Computing it needs `shapely.minimum_rotated_rectangle`; in the browser it is a
  convex hull and a rotating-calipers loop per footprint, over three thousand footprints.
- **`height_m` + `height_src`** because the priority chain (Overture `height` → `num_floors`×3.2 →
  **DSM minus DTM over the footprint** → 6 m) has a lidar step in it, and that step is a raster
  read inside a polygon. It is also the only honest height for the 85% of footprints OSM labels
  `building=yes` and nothing else. `height_src` lets autogen distrust a `default`.
- **`s` / `lat`** because every rule in this document is written in corridor coordinates — setback
  is from the pavement edge, density falls off with distance from a junction — and projecting a
  centroid onto the spine is the one thing the manifest already knows how to do.

Keep it small: drop footprints under 15 m² (sheds and map noise — that is the first decile), and
simplify rings at 0.5 m. On the densest of the nine sites that is roughly 1200 buildings, which at
these fields is a few hundred kilobytes of JSON, on a manifest that already ships a 22 MP air
photo beside it.
