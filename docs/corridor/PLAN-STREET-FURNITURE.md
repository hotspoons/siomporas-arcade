# Street furniture: signs, kerbs, walks, trails and rail

**Status:** plan + first implementation, overnight 2026-10-06. The overpass/bridge ground fix that
this sits beside is in `PLAN-WORLD-SCALE.md`'s orbit and already built (`world/overpass.ts`).
**Audience:** whoever picks up the furniture work next — the main agent, or a person.
**Companion:** [`LANES-AND-SIGNALS.md`](LANES-AND-SIGNALS.md), [`DESIGN.md`](DESIGN.md).

## Done in the first pass (2026-10-06, overnight)

- **Walks never cover roads (4)** — `furniture.ts` `clearSpans` clips each walk *segment* against the
  carriageway instead of keeping or dropping a whole station by its endpoints. Unit-tested
  (`test/furniture.test.ts`). Not yet eyeballed on a screen.
- **Kerbs (3), the hard part** — `furniture.ts kerbCorner` is the corner rule: an offset kerb line
  per way, mitered to the intersection on a gentle bend (the right-angle kerb), chamfered to two
  vertices on a real street corner (the bevel). Unit-tested. **The run-join pass is now written**
  (`kerbJoinRings` + the `KERB_JOIN_M` pass in `buildSidewalks`, 2026-10-07): the first/last station
  of every walk is kept as a `KerbEnd`, ends within `KERB_JOIN_M` on the same kerb side are joined
  with the miter/bevel band, and only where both kerb feet are clear of a carriageway. Unit-tested;
  not yet eyeballed on a screen.
- **Trails and rail (6), the decision** — `world/trail.ts trailPaving` picks dirt/gravel/paved from
  `surface` then `trailblazed`, defaulting an untagged path to DIRT. Unit-tested
  (`test/trail.test.ts`). `trailMesh` and the bake that carries the ways are not written.
- **Overpass geometry (under bridges)** — `props.ts overpassMesh` grew a recessed soffit slab and
  three span girders, and refuses to build a pier whose foot lands on a carriageway (the call site
  passes an `edgeDistanceWorld` test).
- **The crossing tags (6, unblocker)** — `export.py` no longer strips `tunnel`/`layer`/`bridge` from a
  crossing record; `site.ts Crossing` carries them optionally. This is what a portal needs; the
  portal itself is not built.
- **The ground under an overpass** — not furniture, but the reason the rest is visible: an elevated
  carriageway is a deck, never the ground (`world/overpass.ts isDeck`, physics `physGroundAt` +
  streamed trimesh `decksNear`). See the commit and `probes/corridor-overpass.mjs`.
- **The one bug underneath all of it (fixed, `f7cf98b`)** — a branch was tiled by its first vertex, so
  a road that bridges a tile it does not start in streamed no spline there and the deck had nothing to
  carry. `_vector_tiles` now writes a way into every tile its vertices fall in (`_WAY_COORDS`), and the
  viewer dedupes by id (`takeBranch`, `addBranchSegments`) so a road in two loaded tiles is built
  once. `_load_tiled` dedupes too, so a re-tile does not multiply. Verified on dc-metro against a
  serve-time proxy applying the same replication: the Whitfield Chapel Road overpass carries the car
  at y≈58.5 (sank 0); before, it fell to ≈50.4 in a second.

Everything else below is designed and not built.

---

## What Rich asked for

> school-zone signs at school-zone edges; major-road intersection signage (exit signs and/or signs
> hung from stop-light booms); right-angle and beveled kerbs; sidewalks never cover roads; better
> dubious entrance/exit handling (crofton-triangle on both sides of highway); render trails and
> railways (use trailblazed to decide "paving", e.g. dirt).

Six things. Three are viewer-side (signs, kerbs, walks), two need the bake (trails/rail, entrance
classification), and one is a bug that all of them touch.

---

## What already exists (do not rebuild)

`world/furniture.ts` (1 092 lines) already builds, from the manifest and the analytic ground:

| thing | where | what it does |
|---|---|---|
| signal masts and heads | `mastGeometry`, `headGeometry`, `signalLensOffsets` | a mast per signalised junction arm, stepped to the kerb, arm measured to reach the stop line, heads looking along −Z |
| stop / give-way signs | `signPostGeometry`, `signOutline`, `signFace`, `signTexture` | MUTCD R1-1 and R1-2 as painted canvases on a post |
| barriers | `buildBarriers` | walls, hedges, guard rails swept along a way with a kind-scaled profile |
| sidewalks + kerbs + crossing bars | `buildSidewalks` (`sidewalkCover`, ~line 880) | a three-point swept profile (kerb foot, kerb top, back edge), the kerb side found **by measurement**, dropped at crossings, clipped off carriageways |
| street-name blades | `intersections.ts buildBlades` | one merged mesh per site (no instance, hence no collider — see below) |

So the work below is **adding sign kinds, fixing the kerb geometry, extending the walk clip, and
teaching the bake to say what a way is** — not standing up a furniture system.

---

## 1. School-zone signs

**The thing.** A school zone is a stretch of road with a school beside it: a `school` amenity or a
`school_zone`/`maxspeed:school` tag, and the signs mark where the zone *starts*. MUTCD S1-1 /
S4-3 (school) with an S5-1 fluorescent yellow-green outline, plus a speed plate.

**Data.** Check `manifest.pois` for `amenity=school` (the bake already collects POIs) and
`manifest.roads` for `maxspeed=*school*`; if neither survives today, add a `school_zones` array in
`export.py` — a list of `{ s, side, kind: 'school'|'school_speed', speed }` derived from the OSM
ways/points, which is a small bake change and not a rebake of the heavy arrays.

*Answered 2026-10-06:* `amenity=school` **does** survive — `vt.counts.pois` is 13 873 and schools are
in the tiled `pois` (three in a six-tile sample). So a first pass can place a sign on the carriageway
nearest each school POI without any bake change; a proper zone-edge pair still wants a `school_zones`
array (the start/end and the `maxspeed:school` span are not recoverable from the point alone).

**Approach.** For each zone edge, place a post at the kerb the same way `buildFurniture` places a
mast (step sideways with `edgeDistance` until clear), facing **against** travel so the driver reads
it. A zone start gets the diamond; the paired end gets the optional END SCHOOL ZONE plate. Colour
is the fluorescent yellow-green (`#c7ea46`), not the ordinary warning yellow — that is the tell.

**Knobs.** `SCHOOL_SIGN_H`, `SCHOOL_ZONE_REACH_M` (how far the zone's road is signed), `SCHOOL_SIDE`.

**Test.** A school POI's road gets exactly two posts (start/end), on the kerb, facing oncoming
traffic; no post stands on a carriageway (reuse the edge-clear walk). No school in the world → no
posts, no error.

**Built 2026-10-07 (first pass).** Not as a separate `school_zones` array — the signs ride the
existing `signals.signs` stream, so they bucket and tile with the stop signs for free. `export.py`
`_signals` now finds `amenity=school` points/areas, projects the school onto the nearest non-freeway
carriageway (within `SCHOOL_SIGN_MAX_FROM_ROAD`), and emits `kind="school"` at one end of a
`SCHOOL_ZONE_REACH_M` stretch and `kind="school_end"` at the other, each facing the traffic entering
from that end. The viewer draws them in `furniture.ts`: a black-bordered diamond on fluorescent
yellow-green `#c7ea46` with the walking figures (S1-1), and the END SCHOOL ZONE plate (S4-3). The
zone fn is not yet unit-tested (it needs an OSM fixture and a rasterio DEM); the viewer selection is.

---

## 2. Major-road intersection signage

**The thing.** Two signs Rich named: **exit signs** on the major road's ramps (green, "EXIT nn"),
and signs **hung from the stop-light boom** at big junctions (street name, "left turn", lane
assignment).

**Data.** `manifest.intersections` already carries the junction list and counts; `manifest.roads`
carries names/refs; `manifest.crossings` says which arm is `over`/`merge`. The boom geometry is
`mastGeometry`'s arm — a sign hangs where the arm runs.

**Approach.** Extend the existing mast builder: at an arm whose junction is on the `major` list,
mount **one** panel under the arm at `arm * 0.55` out, facing the stop line, textured from a canvas
like `signFace`. Exit signs are their own small builder keyed to `crossings` where
`kind=motorway_link` and `relation` is an exit — the destination is the linked road's `name`/`ref`,
which the manifest already holds.

**Knobs.** `BOOM_SIGN_MIN_JUNCTION` (how big a junction earns a hung sign), `EXIT_SIGN_H`.

**Test.** A 4-way signalised junction on a `primary` gets a panel per boom; a side-street stop does
not. A motorway_link crossing named in `crossings` gets an exit panel.

**Built 2026-10-07 (first pass, boom signs only).** `furniture.ts boomSignAt` (pure, unit-tested)
picks a boom for a panel when a signalised junction of at least `FURNITURE_BOOM_MIN_ARMS` arms has a
superior road of at least `FURNITURE_BOOM_MIN_RANK` within `FURNITURE_BOOM_SNAP_M`; the panel is a
green body and a white lane-assignment face hung `FURNITURE_BOOM_DROP` under the arm, instanced per
(arm, side) bucket beside the mast. Exit signs (the `motorway_link` half) are **not built**: a tiled
world does not carry `crossings` in its per-cell manifest, so they need a bake field first.

---

## 3. Right-angle and beveled kerbs

**The thing.** The kerb is a swept profile along a walk. At a **corner** the sweep should turn a
right angle (or a bevel — the 45° chamfer real sidewalks use to open a corner for a turning car),
not run two parallel ribbons past each other and leave a notch.

**Current state.** `buildSidewalks` sweeps each way independently; OSM splits at the corner node, so
each way's ribbon ends near it and the next begins, and nothing joins them. The section around
line 1075 already has the vocabulary (`side`, `edge`).

**Approach.** Join runs that share an endpoint within `KERB_JOIN_M`: at the shared node, walk the
two ribbons' kerb-side vertices to the **mitered** intersection of the two kerb lines; where the
turn is sharper than `KERB_BEVEL_DEG` (a real street corner), cut the miter at
`KERB_BEVEL_M` and add the two-point bevel instead of the long point. This is pure 2-D geometry on
the ring the builder already accumulates, and it belongs in a small `kerbJoin` helper so it can be
unit-tested.

**Knobs.** `KERB_JOIN_M`, `KERB_BEVEL_M`, `KERB_BEVEL_DEG`.

**Test.** Two perpendicular walks meeting at a node produce a corner with four kerb vertices, none
outside a `KERB_BEVEL_M` box of the node; a straight-through pair is untouched.

---

## 4. Sidewalks never cover roads

**The thing.** `sidewalks rendering over streets` (Rich, 2026-09-27). There is a partial fix:
`roadInfo` at the kerb edge, `onRoad = edge.d < -(who !== own ? CLEAR : OWN_CLEAR)`, and a strip that
skips on-road spans. It still lets some through.

**Why it is still wrong.** The check is per **vertex** and the ribbon is flushed on a
previous-vertex basis (`if (i > 0 && !onRoad && !lastOnRoad)`), so a span whose *middle* is over a
road but whose endpoints are clear is drawn whole, and the 1.5 m "own road" slack is a metre of
asphalt by design. The zone walk is also a pure lateral offset, so it is only ever as good as the
road it was offset from.

**Approach.** Clip the **segment** against the road, not the vertex: for each pair of ring slices,
walk the segment and split it where `roadInfo` crosses zero on the kerb edge, emitting only the
clear sub-segments. That turns "skip a vertex" into "skip the part that is on the road", which is
what Rich is looking at. Keep the own-road slack but shrink it, and count the split metres so the
`overRoad` stat is honest.

**Knobs.** `SIDEWALK_ROAD_CLEAR_M` (already), `SIDEWALK_OWN_CLEAR_M` (already, shrink), and a new
`SIDEWALK_CLIP_M` resolution.

**Test.** A unit test on the clip: a segment from clear ground, across a 12 m road, to clear ground
emits two sub-segments totalling `len − 12`, and a segment wholly on the road emits none.

---

## 5. Dubious entrances and exits

**The thing.** "crofton-triangle on both sides of highway" — an entry or exit the bake could not
place confidently is drawn on both sides, or at a spot that is not a real entrance. On a divided
highway the two carriageways are close, and a node on one is ambiguously nearer the other.

**Data.** `manifest.stubs`, `manifest.driveways`, `manifest.crossings` (`merge`), and the spine
`siblings`. The classifier that decides "this node is an entrance" lives in the bake.

**Approach.** Two halves. **Bake:** when a driveway/stub node is within `ENTRANCE_AMBIG_M` of two
carriageways, do not pick one — record both, and a `side` hint from the way's own direction. **Viewer:**
in `buildDriveways`-equivalent, place the connector on the side whose `edgeDistance` agrees with the
hint, and drop it if the two disagree by less than the width of either road (it is genuinely in the
middle — a median gap, not an entrance). The crofton-triangle case is exactly this disagreement on
both sides of the highway.

**Knobs.** `ENTRANCE_AMBIG_M`, `ENTRANCE_DROP_M`.

**Test.** A node equidistant from two parallel carriageways (the highway) yields **one** connector,
on the hinted side; a genuinely centred node on a median yields none.

---

## 6. Trails and railways — and `trailblazed` as the paving tell

**The thing.** Render paths (`highway=path|footway|cycleway|track`) and railways (`railway=rail`),
and choose the path's surface from `trailblazed` (a dirt path, a paved greenway) rather than drawing
asphalt.

**Data.** `osm.py` already pulls `way[railway]` and lists `track`, `railway` among the classes
(line 313); crossings already carry `railway` in their tags. **The `tunnel`/`layer` strip is fixed:**
`export.py` now carries `bridge`/`tunnel`/`layer` (and `spine_bridge`) on the crossing record, and
`site.ts Crossing` declares them. What is still missing is the ways themselves: `network.py:196`
drops `footway`/`path`/`cycleway`/`pedestrian`/`steps`/`bridleway`/`track` from the branch stream,
and rail is not a road at all, so neither reaches the viewer — and neither carries `surface` or
`trailblazed`. A rail in a tunnel is still baked as a rail on the surface.

**Approach.**
- **Bake:** stop stripping `tunnel`/`layer` on the way record; add `surface` and a `trailblazed`
  boolean from the OSM tags. Keep paths and rails in the branch stream but under their own `kind`, so
  the viewer can give them their own mesh and material.
- **Viewer:** a `buildTrailsAndRail` beside `buildBarriers`: a path is a narrow ribbon (not a
  carriageway — no kerbs, no paint) with a material from `trailblazed` (dirt, gravel) or `surface`
  (paved); a railway is two rails + sleepers on a ballast ribbon, or simply a ballast ribbon at
  distance. `layer < 0` / `tunnel=yes` routes it through the same portal/interior treatment as a
  road tunnel (see `PLAN-WORLD-SCALE.md`).

**Knobs.** `TRAIL_WIDTH_M`, `RAIL_GAUGE_M`, `RAIL_VIEW_M`.

**Test.** A `highway=track` with no `trailblazed` gets the dirt material; a `highway=cycleway` with
`surface=asphalt` gets the paved one; `railway=rail` gets two rails.

---

## Order, and what needs a rebake

1. ~~**Kerbs (3)** and **walks (4)**~~ — the pure cores (`kerbCorner`, `clearSpans`) and the run-join
   pass (`kerbJoinRings`) are done and unit-tested; what remains is a look at a screen.
2. **Signs (1, 2)** — *school-zone signs and boom signs built 2026-10-07; exit signs still open.*
   Viewer plus the school `signals.signs` records; no `school_zones` array after all.
3. **Entrances (5)** — small bake classifier change + viewer guard. Not started.
4. **Trails/rail (6)** — the largest: `network.py` must emit the ways (with `surface`/`trailblazed`)
   and `trail.ts trailPaving` is the decision, already tested; `trailMesh` and the builder are not
   written. Needs a rebake of whatever world is being tested.
5. **Tunnels (bridge side, see `PLAN-WORLD-SCALE.md`)** — the crossing tags now reach the viewer;
   the portal/interior mesh is not written.

Nothing here raises `MAX_M` or touches the sharded bake; every item is per-tile or resident-small.

---

## The one bug underneath all of it

A branch is tiled by its **first point** (`_TILE_KEY` in `export.py`), and the viewer streams a
branch only when the eye reaches that tile. A long road whose first point is far from part of its
own length is therefore missing exactly where you are — which is how the dc-metro overpass ramp was
absent from the grid under its own deck (`probes/corridor-overpass.mjs` documents this). Every
"furniture missing at spot X" report can be this rather than a builder bug.

**Fixed, `f7cf98b`.** `_vector_tiles` keys a polyline to every tile its vertices fall in; the viewer
dedupes replicated ways by id. The new kinds below no longer inherit the holes.

**Testing it on an unbaked world.** `probes/vtproxy.mjs` replays the same replication at serve time:
it scans every branch tile the manifest names and injects each road into every tile it crosses, so
the viewer's dedup and the deck streamer can be exercised against dc-metro as it is today. Load
`http://localhost:5186/?data=http://127.0.0.1:5190#dc-metro-take-2` (or tunnel :5190 and pass that
URL as `?data=`). It is a stopgap — delete it once the world is next baked.
