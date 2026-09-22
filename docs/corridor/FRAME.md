# The frame: geodetic authority, ENU rendering, a floating origin

*Rich, 2026-09-21: "let's go geodetic … and let's go full in on designing this for scale."*

This is the coordinate design corridor is moving to, why each piece is the way it is, and what was
measured to decide it. Every number here comes from `packages/engine/test/wgs84*.test.ts`, which
check the implementation against pyproj/PROJ rather than against itself.

## The three frames

| | what | precision | who uses it |
|---|---|---|---|
| **geodetic** | WGS84 lon/lat/h | float64 | storage, the bake, tile ids, anything persisted |
| **ECEF** | WGS84 geocentric metres | float64 | the transit frame only — never stored, never rendered |
| **local ENU** | east/north/up metres about a *floating origin* | float32 at the end | vertex buffers, physics, everything in the viewer |

three.js world stays `(x, y, z) = (east, up, −north)`, which is exactly what corridor already used
(`toWorld = (x, y, z) => (x, z, −y)`). **Nothing downstream changes its idea of which way is up.**
Only the derivation of the ENU metres changes: from "UTM easting/northing minus an origin" to a
true tangent frame about a geodetic anchor.

## Why not render in absolute ECEF, which is what trailworks does

trailworks (`viewer/src/render/geoMath.ts`) is a true WGS84 globe and renders in absolute ECEF
scene coordinates. That is correct *for trailworks*, which is a terrain viewer seen from altitude.

Corridor is a driving game with the camera 1.5 m off the deck looking at 0.1 m lane markings, and
three.js vertex buffers are float32. Measured:

```
float32 spacing at 6.4e6 m (ECEF magnitude)  ->  0.256 m
float32 spacing at 3.0e4 m (a large site)    ->  0.002 m
float32 spacing at 1.0e3 m                   ->  0.001 m
```

Absolute ECEF quantises the world to a quarter of a metre. The road would visibly swim. So the
authority is shared with trailworks; the render frame is not.

## What the flat UTM frame was actually costing

The bake stored site metres as UTM (EPSG:32618) minus `frame.origin`. Measured at
crofton-triangle's own anchor against its own bake origin, the difference decomposes into three
very different things — and the popular assumption (that UTM is "inaccurate") is the wrong one:

| effect | size at Crofton | verdict |
|---|---|---|
| **grid convergence** — UTM north vs true north | **1.0594°** | a rotation, not an error |
| **scale factor** | **~135 ppm** (1.1 m over 8.5 km) | small |
| **residual horizontal**, after removing both | **< 0.34 m at 25 km on axis; 2.42 m at the corners of a 50 km box** | UTM was fine horizontally *for one site* |
| **curvature** — the drop a plane cannot represent | **0.70 m @ 3 km · 7.84 m @ 10 km · 49.0 m @ 25 km** | the real problem |

So: **the win is the vertical and the ability to stitch, not horizontal accuracy.** The 1.06°
rotation is invisible inside one site and fatal between two — it is why a UTM site can never be
laid beside its neighbour, why sun and shadow angles are slightly off, and why gaussworks (which
aligns to ENU) and the bake disagree about north.

The curvature figure is worth stating exactly, because the familiar `d²/2R` is a *spherical*
approximation and overstates it: going east at latitude 39 the relevant radius is the prime
vertical N = 6 386 615 m, not the mean 6 371 009 m. At 30 km the ellipsoid says **70.46 m** where
`d²/2R` says 70.63 m. Both are far larger than anything horizontal.

### The rigid fit is a migration shim, not the answer

It is tempting to keep storing UTM metres and let the viewer apply that rotation and scale. Over
one site that is sub-metre and fine. It does not survive scale, for two measured reasons:

* the fit is **estimator-dependent** — a symmetric fit agrees with the closed-form convergence to
  four decimals, but the six asymmetric sample points used in the first pass of this work gave
  1.0606° and 166 ppm rather than 1.0594° and 135 ppm, about a metre apart at 25 km;
* the **residual is not flat** — over a 50 × 50 km box the best rigid fit still leaves **2.42 m**
  at the corners, because a conformal projection's distortion is not a rotation and a scale.

The bake has PROJ. The browser should not need it. So the destination is that **export emits true
ENU metres about the declared anchor**, exactly, and `frame.kind` becomes `"enu"`. The
`utm_convergence_deg` / `utm_scale` pair exists so a viewer can place an already-exported site in
the meantime, and should be treated as deprecated the moment every site has been re-exported.

## Existing bakes convert with no re-bake

Every site already records `frame.epsg` and `frame.origin`. UTM → WGS84 is exact and invertible,
so site metres already have a known geodetic position. **Going geodetic is a re-interpretation of
data we already have, not a re-fetch.** This is asserted in `wgs84-pyproj.test.ts`.

## Rebasing, and why it is a rotation too

A render origin *is* an `Anchor`. Rebasing means building a new one and asking the old where it
now sits. The trap: **a rebase is not just a translation.** Two tangent frames are also rotated
relative to each other by the angle subtended at the centre of the Earth — about 0.009° per km.
Treating a rebase as a pure translation loses ~141 m over 60 km; the test
`a rebase is a translation AND a rotation` pins that down. `Anchor.delta` gives the shift and
`Anchor.deltaRotation` the rotation, and both must be applied.

For a single site ≤ 30 km one anchor is enough and float32 gives millimetres throughout
(`survives a whole site at float32 through the local frame`: worst error < 2 mm over 30 km). The
rebase machinery is what makes a *continuous* world possible later, which is the point of building
it now rather than bolting it on.

## Tile addressing

`tileBounds` / `tileOf` implement the same geographic quadtree as trailworks
(`globe_tiles.tile_bounds`, `geoMath.tileBoundsRaw`): level z has 2^(z+1) longitude columns and
2^z latitude rows. Sharing the scheme means the two projects address the world with the same ids,
which is the precondition for ever sharing data between them.

Note this is *not* what the corridor bake emits today. `export.py` already writes 1 km tiles on a
site-local metre grid (`web/tiles/0/`, indexed by `manifest.layers.tiles`) — 59 tiles for
crofton-triangle, 375 for crofton-crownsville, and **the viewer does not stream any of them yet**.
Moving those onto the global quadtree is the step that turns sites into a world.

## Order of work

1. ✅ `packages/engine/src/geo/wgs84.ts` — the geodesy core, checked against PROJ.
2. The bake declares a geodetic anchor in the manifest (`frame.anchor`), alongside the existing
   UTM fields so nothing breaks. Backfill existing sites; no re-bake.
3. The viewer builds an `Anchor` from the manifest and routes terrain/tile vertex generation
   through `toLocal`. Curvature appears; nothing else changes.
4. Tiles move to the global quadtree and start streaming.
5. Floating origin: rebase when the camera drifts, translating *and* rotating.

Steps 3 and 4 are the same edit if done together, which is why the frame had to be settled before
the tile system — the tile loader is precisely the code that turns stored data into world
coordinates, and writing it twice would be the waste.
