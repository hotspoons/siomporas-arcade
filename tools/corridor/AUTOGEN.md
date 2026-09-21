# AUTOGEN — growing neighbourhoods, business parks and towns along a corridor

Design only; no code yet. What follows is the rule set a future `python -m corridor autogen <slug>`
would implement, writing `placements.json` (and adjustment-area seeds) into a baked site.

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

Take the best. Then `scale = sqrt(A_footprint / A_catalog)`, **clamped to [0.8, 1.3]**. Outside
that clamp the asset is the wrong object, not a small one: fall back to **procedural massing** —
extrude the real ring to `H` with a roof and a category-tinted facade material. A 180 m distribution
centre is always procedural; nothing in a catalog of ten boxes is that shape.

## 5. Siting (R4)

- **Yaw**: perpendicular to the nearest spine/sibling tangent, facing the road. Where the real ring
  exists, use the minimum rotated rectangle's long axis instead — it beats the road normal on a
  corner lot. (`PlaceMode.yawOfRoad` in the editor already does the road-normal half.)
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

## 8. Output contract

Autogen writes items with ids prefixed **`g-`** into `placements.json` and areas prefixed **`g-`**
into `adjustments.json`. On a re-run it replaces every `g-` id and **touches nothing else** — a
hand-placed `p-07` or a hand-drawn `a-03` survives regeneration untouched, the same rule
`python -m corridor areas` already follows. A `--seed` makes runs reproducible; it is recorded in
the file so a placement can be traced back to the run that made it.

## 9. Staging

1. real OSM footprints in-corridor → categories → catalog assets or procedural massing
2. Overture heights and names layered over that (better `H`, and a name turns a `retail_unit` into
   a pole sign worth reading)
3. procedural lots, fences, poles
4. invented settlements (R5)

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
