# What we know about lanes and signals, and what we throw away

**Status:** audit, 2026-09-27. Rich, driving US 3 (Robert Crain Highway) at Johns Hopkins Road on
`crofton-triangle`:

> don't we have the number of lanes and turn lanes in the OSM data? Right where that is, there are
> 3 through lanes … and 2 left turn lanes, and a right turn lane all in the northbound traffic …
> This just shows 2 lanes and a stop light only on Johns Hopkins Rd, not on route 3.

He is right, and the reasons are four separate faults stacked on each other. One is fixed. The
other three are recorded here because each needs a decision rather than a patch.

---

## What is actually there

His position is world `[-210.39, 33.15, -2836.45]`, which is plan ENU `(-210.4, +2836.5)`. The
junction node is OSM `102600770` at `(-185.51, +2871.63)` — **41 m north-east of him**. He is
standing on the **last four metres** of road the viewer draws.

| | OSM has | the bake stored | the viewer drew |
|---|---|---|---|
| US 3 northbound at the junction | `highway=trunk lanes=4 oneway=yes`; the way before it `lanes=5` | **nothing** — the way is in no chain | the road ends; past it an unpainted "driveway" stub |
| the US 3 chain that reaches him | per-way lanes 3,4,5,6,7 | `["3","4","5","6","7"]` | `NaN` → **2 lanes** |
| Johns Hopkins Rd, west arm | `lanes=2` **`turn:lanes=left\|left`** | not in the network | 2 lanes |
| Johns Hopkins Rd, NW arm | `lanes=3` **`turn:lanes=left\|left;through\|through`** | not in the network | 2 lanes |
| the junction node | `highway=traffic_signals`, shared by **6 ways** | **no junction record at all** | one signal, facing along Johns Hopkins Road |

OSM itself tops out at `lanes=5` northbound here, not six, and carries no `turn:lanes` on the US 3
arms of this particular junction — so two of the pockets Rich describes are genuinely absent
upstream. But `lanes=5` and `lanes=4` are there, and were being thrown away.

---

## Fault 1 — the lane count was NaN. **Fixed.**

`network.py` collapses a chain's per-way `lanes` tags into a sorted **set of strings**. The viewer
did `Number(br.lanes) > 0 ? Number(br.lanes) : 2`, and `Number(["3","4"])` is `NaN`.

On `crofton-triangle`: 397 of 427 branches carry `null`, 10 carry an array, **20** carry a usable
number. So essentially the whole network was two lanes wide, junction or no junction.

Now in `scene.ts::branchLanes`, which takes the **smallest** member of the set — the through count,
the width the road holds for most of its length. `probes/corridor-lanes.mjs` asserts it and refuses
to pass on a site that does not contain the failing shape.

This is a floor, not a ceiling. The real answer is per-station lane counts for branches, the way
the spine already has them (`manifest.spine.segments[].tags.lanes` and `taperedLanes`). Branches
have no `segments` array at all. **That is a bake change and it is the single most valuable one on
this list**, because it also gives the taper Rich describes: 5 → 4 → 4 → 3 over a quarter of a mile.

---

## Fault 2 — the road query stops 274 m short of the junction

`network.py` builds its Overpass box from `site.json`'s `radius_m`, which for `crofton-triangle` is
**2600 m**. The junction sits **274 m outside** it. Verified against the cached response: the ways
either side are simply absent, and the chain Rich is driving only reaches him because Overpass
returns whole ways that intersect the box.

This one fault removes, in one go: the junction, both US 3 arms, both Johns Hopkins arms, their
`turn:lanes`, the signalisation, the stop bars, the crosswalks, the blades and the lane arrows.

**The data is already on disk.** `osm.geojson` comes from a different query — the chains buffered
by 300 m — and it contains every one of those ways and both signal nodes. So this is a re-bake with
a larger `radius_m`, not a re-fetch of anything we do not have.

**Decision for Rich:** raise `radius_m` and re-bake, and if so how far. A site is not cheap to bake
and the radius drives everything downstream.

---

## Fault 3 — `turn:lanes` is never read

`network.py` reads `lanes` and nothing else. `turn:lanes`, `turn:lanes:forward`,
`turn:lanes:backward`, `lanes:forward`, `lanes:backward` and `placement=middle_of:N` are dropped at
import. Only the **first way's** whole tag dict survives per chain.

The viewer is further along than the bake here: `intersections.ts::loadJunctionFacts` already
fetches `osm.geojson` and parses all of those tags, and `buildLaneArrows` already draws per-lane
turn arrows. Two things gate it off:

1. it only iterates `manifest.intersections.list`, and this junction has no record;
2. it keys the map by one OSM **way** id while a road id is `r<smallest way id of the chain>` — so
   at best one arbitrary way's tags stand in for a whole multi-kilometre road.

Nothing anywhere turns `turn:lanes` into asphalt **width**: `pavedWidth` takes a single lane count
and there is no turn-pocket geometry. A turn pocket is a real modelling job, not a plumbing fix.

---

## Fault 4 — one node gives one signal, taken from `ways[0]`

Because the junction is outside the road graph, `intersections.py` never models it, and the
junction falls through to the raw transcriber in `export.py`, which does `way, vi = n["ways"][0]`.
At this node that list begins with Johns Hopkins Road, so: one node, one mast, `lanes=2`, bearing
taken from Johns Hopkins Road's tangent. That is exactly the "stop light only on Johns Hopkins Rd"
Rich sees, and the manifest's mast record confirms it.

Two aggravations at the same place: `JUNCTION_R` is 45 m but the two signal nodes here are **67 m**
apart, so they never group; and a single ungrouped node skips the "traffic runs toward the group
centre" logic, so the heads face along the way's arbitrary digitising direction.

**A signalised junction needs one mast per approach, not one per node.** That is the fix, and it is
independent of the radius question.

---

## Also worth knowing

`manifest.siblings` is written as bare coordinates with no attributes at all, and the viewer draws
siblings with a hard-coded two lanes. Not the path this site uses, but the same blind spot.

And the one place US 3 is drawn near its real width is the 80 m stub north of the junction, because
`stubs` records **do** carry `lanes: 4` — and it is drawn unpainted, as a driveway.

---

## In order of value

| | what | where | cost |
|---|---|---|---|
| 1 | per-station lane counts for branches, with the taper | `network.py`, `scene.ts` | bake change, medium |
| 2 | raise `radius_m` for `crofton-triangle` and re-bake | `site.json` | a re-bake, Rich's call |
| 3 | one mast per approach at a signalised junction | `export.py` | contained |
| 4 | carry `turn:lanes` through the bake and key it by chain | `network.py`, `intersections.ts` | medium |
| 5 | turn-pocket geometry (widen the approach, paint the arrows) | `props.ts`, `intersections.ts` | a modelling job |
