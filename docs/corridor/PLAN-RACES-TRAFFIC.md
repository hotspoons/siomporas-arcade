# Traffic areas, circuits and stages, and games that autowire

Queued by Rich on 2026-09-29, in his own words, while the vehicles/actors/weapons screens were
being finished. This is the brief; nothing here is built yet. Written down first because it is four
features that only make sense together, and because the thing that makes them cheap — one set of
ECS constructs underneath all of them — is the thing that gets lost if they are picked up one at a
time.

> we need to add our traffic system as something you can place on levels, and we need to have
> entities from the placement interface for the traffic blobs (I imagine just painting a strip of
> road like google maps and reversing the yellow/orange/red/maroon back to varying levels of
> traffic) - we can use the bounding box we use for things like canopy or rendering overrides to
> also draw the box on the road, then apply a traffic color. Each area should be able to have a
> swing too, so either always jammed up, or a min and a max and random.
>
> There should already be rudiments of a traffic system, but let's wire it up. Would be good to hook
> it to the ECS system so we can define things from code as well and trigger a traffic area, but
> first we need a bounds.
>
> Other thing - in the placement editor, we need to be able to define circuits and stages. Circuits
> have a start/finish line, stages have a start and end line and checkpoints that need to be entered
> or you will get a penalty. Again, things for our ECS that we can track.
>
> It would be awesome to have a ready-to-go rally stage game (pick multiple stages in a world,
> complete in order) and a ready-to-go circuit racing game that you can pick from the program tab,
> and all you need to do is provide a list of stages or a list of circuits (select them from the
> list) and the game autowires. You'd need to add vehicles to be opponents as well esp for circuit
> races.
>
> It would be great if those constructs were flexible enough we could wire in a crazy taxi-type
> game, a pizza delivery game, and a paperboy game (paperboy game would be hitting a target or
> waypoint with a paper chucking weapon from a bicycle) and just a little glue code.
>
> Oh we'll need title sequences, text, completion, failure messages, points, all that stuff.

## The shape this wants to be

Four asks, but only **three primitives** underneath them, and every game named above is those three
plus glue:

| primitive | what it is | what reads it |
| --- | --- | --- |
| **Area** | a bounded region of the world with a payload | traffic density, canopy, render overrides |
| **Gate** | an oriented line you can cross, with a direction | start, finish, checkpoint, split |
| **Objective** | an ordered or unordered set of gates and areas, with rules | rally stage, circuit lap, delivery, target |

A rally stage is gates in order with a penalty for a missed one. A circuit is the same gates with
the last one wired back to the first and a lap count. Crazy Taxi is an objective that picks a random
destination area and pays by how long it took. Pizza delivery is the same with a failure condition
on damage. Paperboy is a target that is satisfied by a weapon impulse arriving inside an area rather
than by a car entering one — which is why the weapon work matters here and why weapons already carry
an `impulse` in newton-seconds.

So: build the three primitives properly, and the five games are configuration.

## 1. Areas, and traffic as the first payload

**The bounds come first.** Rich is explicit: *"first we need a bounds"*. The editor already draws
bounded regions for canopy and for render overrides, so the work is to lift that into a named,
saved, typed thing rather than inventing a second kind of box.

- An area is a polygon or an oriented box, plus a `kind` and a payload.
- The traffic payload is a **density 0…1** and a **swing**: either fixed, or a min/max the level
  picks from at random each time it loads. Rich: *"either always jammed up, or a min and a max and
  random."*
- The editor paints it on the road the way a map application does, and the colour scale is the one
  everybody already knows — **green, yellow, orange, red, maroon** — read backwards into density.
  That scale is the interface; nobody types 0.72.
- On the ECS side an area is an entity with `Area` + `TrafficDensity`, so code can raise the density
  on one at runtime (a crash ahead, a race event closing a road) exactly as the editor can set it.

Check `src/traffic.ts` and `test/traffic.test.ts` first — the rudiments Rich mentions are there, and
the density is currently global. The work is to make the existing spawner ask "what area am I in"
rather than to write a new one.

## 2. Gates: circuits and stages in the placement editor

- A gate is a **line segment with a direction** — crossing it the wrong way does not count, which is
  what makes a start/finish line different from a trigger volume.
- A **circuit** is one gate that is both start and finish, plus optional split gates, plus a lap
  count.
- A **stage** is a start gate, an end gate, and checkpoints in order. Missing one is a **penalty**,
  not a failure — Rich: *"checkpoints that need to be entered or you will get a penalty"* — so the
  result carries a time and a penalty total, and both are shown.
- Both are saved with the world, listed by name, and selectable. The rally and circuit games take a
  LIST of them, so the list has to be a first-class thing the program tab can offer.

## 3. The two ready-made games

In the program tab, picking one and choosing from a list is the whole setup:

- **Rally**: pick stages, in order. Sequential, timed, penalties accumulate, a stage result screen
  between them and an overall time at the end.
- **Circuit**: pick a circuit, a lap count, and a field of opponents. Opponents are **vehicle
  builds** — the thing the Vehicles screen now makes — driven by the existing traffic/AI code with
  a racing line rather than a route.

Both need the presentation layer Rich listed last and which is easy to forget until the game is
unplayable without it: **title sequence, countdown, on-screen text, completion and failure messages,
points and a results screen.** That is a shared module, not per-game code, and it should be built
with the first game rather than retrofitted to both.

## 4. The glue-code games

Not to be built now, but the primitives must not make them impossible:

- **Crazy Taxi**: pick a random destination area, pay on arrival, a clock that the fare extends.
- **Pizza delivery**: the same, plus a damage-based failure condition and a per-drop timer.
- **Paperboy**: a bicycle vehicle build, a thrown weapon, and targets satisfied by an impulse
  landing inside an area. Needs weapons mounted to a vehicle, which the vehicle document now
  carries as `mounts`.

## Order of work

1. **Area bounds + storage + editor painting.** Nothing else can start until an area is a thing.
2. **Traffic payload on an area**, wired to the existing spawner, with the map colour scale.
3. **Gates**, then circuits and stages built out of them, saved with the world.
4. **The presentation module** — titles, countdown, messages, points, results.
5. **Rally**, which is the simpler of the two (no opponents).
6. **Circuit + opponents.**
7. Leave the glue-code games to glue code, and see whether it really is glue.

---

## 5. Stunt fixtures on real roads

Added to the queue by Rich on 2026-09-29, mid-build:

> can you also look at pulling in the stuntin' library of props for stunt racing games. It would be
> so dope to be able to stick a loop-de-loop over a section of road. To make it work we would need
> to be able to place the stunts at any orientation. There is already a good algorithm for
> automatically hooking up waypoints to the start and finish of a stunt fixture … place the stunt
> and then connect it to a start and finish waypoints and then don't render the openstreet map road
> underneath the stunt. This has been on my mind since I was a little kid.
>
> hooking up the waypoints should go through a bezier curve and link naturally from the end of the
> stunt fixture to the continuation of road.

The library is `apps/stuntin` in this repo — a tile-grid stunt-track game with loops, corkscrews,
banked sixths, jumps, drawbridges, splits and tunnels — and the algorithm he remembers is
`apps/stuntin/src/sim/links.ts`, a cubic Hermite between two ports with the tangents along each
port's facing and a tightness factor.

### What is done (`src/stunts.ts`, `test/stunts.test.ts`)

- **The vocabulary is imported, not copied.** `pieces.ts` is 592 lines of tuned lane paths; a copy
  would drift the first time somebody fixes the corkscrew in STUNTIN'. Corridor imports
  `PIECE_BY_TYPE` across the app boundary and adds only what a grid game never needed.
- **Any position, any angle.** A fixture is `{ piece, at, yaw_deg, lift_m }`; `toSite` converts the
  grid frame (x east, z north, y up, min corner at the origin) to the site frame (x east, y north,
  height sampled) with the footprint centred on the placement.
- **Ports come from the LANE, not the port table.** Sampling the lane at t=0 and t=1 gives the
  mouth and the exit with their headings, and cannot disagree with the surface.
- **The link is the Hermite**, with one change: STUNTIN' port facings point out of their piece, so
  it negates the far tangent; a corridor `Pose` points along travel at both ends, so a road anchor
  and a fixture port join without either knowing what the other is.
- **A backwards fixture is reported**, because it is the easiest mistake to make, it looks correct
  from above, and the only symptom is that the course is undriveable.
- **`Stunts.coversRoad(x, y)`** answers the "don't render the OSM road underneath" question.

### What is left

1. **The road mesh.** `apps/stuntin/src/render/RoadBuilder.ts` builds the ribbon, curbs, pillars and
   tube sections, but it takes STUNTIN's own `Track`, not a bare path. Either extract the ribbon
   generator to take a polyline plus normals and rolls, or build a synthetic `Track`. The first is
   more work and leaves both games sharing one builder.
2. **Wiring `coversRoad` into the corridor road build**, so the tarmac stops at the footprint.
3. **Placing one in the editor** — the Traffic mode's polygon tool is the wrong shape; this wants a
   click to place, a drag to turn, and two draggable handles on the road for entry and exit.
4. **The gates come free**: a fixture with an entry and an exit is a stage with two gates, so a
   loop can be a checkpoint on a rally stage with no new concepts.


---

## Where this got to, 2026-09-29 overnight

Worked through in this order, each with a probe that was shown able to fail.

### Done

| what | where | proved by |
| --- | --- | --- |
| **Areas / zones** — bounds, density as cars per km per lane, the swing, the map colour scale | `src/zones.ts`, `src/zones-ecs.ts`, `src/editor/zones.ts` | `probes/corridor-trafficzone.mjs` — the painted zone reads as jammed ON the centreline, and a control point a kilometre away reads zero |
| **Traffic planning** — density to actual car positions, asked per car rather than per road | `src/trafficplan.ts` | `test/trafficplan.test.ts` — a zone on half a road fills half a road |
| **Gates, circuits, stages** — oriented lines, penalties, laps, wrong-way | `src/races.ts` | `test/races.test.ts` — cannot be jumped at any step size, cutting a checkpoint charges for it |
| **Races in the editor** — one click lays a gate square across the road | `src/editor/coursemode.ts` | `probes/corridor-races.mjs` — four clicks, four gates, each facing the road to within 0.001, and driving the centreline finishes with no penalties |
| **Stunt fixtures** — any position and yaw on a real road, bezier links, road suppression | `src/stunts.ts`, `src/stuntmesh.ts`, `src/editor/stuntmode.ts` | `probes/corridor-stuntmode.mjs` |
| **Stunts are DRIVEABLE** — a trimesh collider from the same arrays the renderer draws | `src/stuntworld.ts`, `packages/engine/.../terrain.ts#addSurface` | `probes/corridor-stunt-drive.mjs` — a ray down at the loop hits 64.4 m against 28.4 m of terrain |
| **Stunt surfacing** — the site's own tarmac, or STUNTIN's red-and-white kerbs | `src/stuntmesh.ts` | the `style` field, per fixture, with a picker |
| **Program references** — `api.traffic.set(id, d, { over })`, `api.stunts.show(id, on)` | `src/program.ts` | `test/program-layers.test.ts` — and safe with no world, which is the half that matters |
| **The vocabulary as a package** — `@apex/stunt-pieces`, zero dependencies | `packages/stunt-pieces` | `test/standalone.test.ts`, which fails if anyone adds an import |

### Left

1. **The ready-made rally and circuit games.** Everything under them exists: courses load and
   validate, `Run` tracks a stage or a lap, vehicle builds can be opponents. What is missing is the
   presentation — titles, a countdown, on-screen text, results, points — which is a shared module
   and should be built with the first game rather than retrofitted to both.
2. **Wiring `ProgramHost.layers`.** The API and its types are in; nothing constructs a `GameRun`
   yet, so there is no host to attach it to. That is the same piece of work as (1).
3. **Suppressing the baked road under a fixture on a BRANCH.** A branch's road is built lazily per
   chunk and cached, so hiding one means invalidating that cache. Spine fixtures are handled.
4. **Doubled trees in the preview.** Measured headlessly: `doubled` is 0, one site group, one
   near-trees group. Not reproduced, so not yet diagnosed. The editor never calls `site.updateNear`
   and the preview does, which is the asymmetry to look at next.


---

## The morning goal, 2026-09-29 overnight

Rich, going to bed: *"Goal for the morning is being able to hook up a rally stage or a circuit from
waypoints … we'll need to be able to place entry points you drive through to commit you into a race
and the ability to exit the race … Think race areas in Forza Horizon where you drive into a throbber
and you enter the race."*

**Done, and driven end to end.** `probes/corridor-race-drive.mjs` authors a stage in the editor,
saves it, loads the viewer, and drives the real centreline:

```
idle → armed → countdown → running → finished     29.40 s, 0 penalties
```

| piece | where |
| --- | --- |
| the entry marker — a circle, not a gate, so you can arrive from any direction | `races.ts` `RaceEntry`, `entryAt` |
| the session: commit, roll up, count down, race, finish, give up | `racerun.ts` `RaceSession` |
| the throbber, the gate banners, the next-gate highlight | `raceworld.ts` |
| placing the ring and the gates | `editor/coursemode.ts`, mode **7** |
| Escape leaves the race, and again clears the result | `main.ts` |
| `api.races.ids/get/start/abandon/state` | `program.ts` |

### Decisions worth keeping

- **The marker is not the start line.** Driving in commits you; the clock starts at the start gate,
  which may be a hundred metres on. That gap is the roll-up and it is what makes a standing start
  feel deliberate.
- **The countdown rewinds the run.** Crossing the line while armed would otherwise start the clock
  before the countdown finished — so the crossing is discarded, the car is held, and the clock
  starts on GO from the line.
- **Entering is edge-triggered.** Sitting in the ring does not re-arm, and finishing a circuit
  inside its own marker — the normal layout — does not restart it. Both have tests.
- **Multiple races per map** fall out of `courses.json` being a list; the gates of only the race you
  are in are drawn, or a world with four stages is a forest of banners.

### Still left

1. **Menus.** `packages/engine/src/app/Menus.ts` has a `MenuStack` with screens-as-data; the race
   result is a `resultLines(state)` away from being one. Rich asked to *"port menus from the other
   games"* — this is where.
2. **Opponents.** A circuit with a field is the one thing in the original brief still untouched;
   vehicle builds are ready to be one.
3. **Wiring `ProgramHost.layers`** to `RaceWorld`, `StuntWorld` and the zones. The API and its types
   are in and listed in the code editor; nothing constructs a `GameRun` yet, so there is no host to
   attach it to. That is the same piece of work as the ready-made games.

## Tracks in a field, and why a loop was not drivable (2026-09-29, later)

Rich: *"the original ask was to be able to drop a stunt piece and place it anywhere, not just on the
existing roads, then connect it on both ends to the roads with waypoints and then have curved
sections of road link both ends… I do like the auto-road-snapping feature and that should be the
default, but we should have the ability to toggle this off and place the pieces freely… That way I
can build complete stunt tracks in a field."*

### An end is a choice of three

`entry_s` / `exit_s` were a distance along a chain that might be missing, and "missing" meant both
"not joined to anything" and "you forgot". They are now a `StuntEnd`:

| kind | what it joins to | who writes it |
| --- | --- | --- |
| `road` | a station on any chain | snapping, a handle drag, or **join it to a road…** then a click |
| `fixture` | another piece's port | **join it to a piece…**, or placing one while another is selected |
| `none` | nothing, deliberately | **leave it open**, and every free placement |

The old fields are still read (`endsOf` migrates) and never written. A mutual join — A's exit names
B's entry and B's entry names A's exit, which is what the editor writes so both panels tell the
truth — is drawn **once**, by the arriving side; two coincident ribbons z-fight and hand the physics
a doubled surface.

### The gizmo

Rich: *"Make sure the pieces can be moved and rotated with a gizmo."* `TransformControls` on an
anchor object, G toggles move/turn, shift is fine control, and the same capture-phase rule as
`place.ts`: the press must reach the bubble phase or TransformControls never sees it. The white ball
still slides a piece along the tarmac; the gizmo moves it freely, because a handle you drag along X
that jumps onto a road is a handle that lies.

### Why a loop rendered perfectly and could not be driven

Three faults stacked, and each one alone is enough:

1. **`PHYS_ENABLED` is 0.** No physics world, so a fixture's trimesh had nowhere to go. A world
   whose `stunts.json` has fixtures now starts physics by itself (`?phys=0` still wins).
2. **The kinematic car follows `groundAt`** — one height per column, which cannot describe a surface
   that is above itself. A world with fixtures drives the Rapier car unless `?car=` says otherwise.
3. **The fixture stood at the height of its centre.** A piece's base is a flat plane and a loop is
   80 m across, so on a slope one end is buried: measured on Race Track Road, the mouth sat 3.0 m
   under the hillside and a car at 44 m/s stopped dead against it. `standOn` now samples the whole
   lane and stands the piece on the highest ground it touches, and `linkPath` holds the approach and
   departure curves above the terrain (max, then smoothed, ends fixed).

`probes/corridor-stunt-drivable.mjs` drives it with no query parameters at all: onto the fixture, over
it, and back onto the road.

**What is still not drivable is a full vertical loop**, and it is a vehicle problem rather than a
geometry one: Rapier's ray-cast vehicle has no downforce, so the car climbs onto the loop and stops
where the lane passes about 25°. A stunt profile that pulls toward the surface normal is the fix, and
it belongs beside the other drive profiles.

### The code editor lists every layer

Rich: *"Nothing shows up in the programming world listing except a set of apartments, no traffic
zones, no stunts, nothing."* It read `placements.json` alone. `worldthings.ts` reads all four and
each row inserts the call that takes it — `api.placed`, `api.traffic.set`, `api.stunts.show`,
`api.races.start`. Checked against Rich's own `arrowhead-farms-network`: 1 placed, 2 traffic zones,
2 stunt fixtures.

### The editor's preview drives it too

Rich: *"It doesn't look like that works in the preview from the editor"*, and then *"that car needs a
lot more power in the preview! Also changing the car's performance stats from the tuner does not seem
to alter the performance."*

The preview built a `Car` — the kinematic one — and had no physics world at all, so a fixture was
scenery there however solid it was in the game. It now mirrors the viewer's rule, from the **tool's**
fixtures rather than the file, so a piece is solid the moment you look at it:

| | preview |
| --- | --- |
| physics | built when the stunt tool has fixtures, freed on close |
| colliders | `addStuntColliders` — the physics half only, since the ribbons are already drawn |
| car | `RapierCar`, on the **stunts** profile (11 m/s² per kg, 82 m/s) rather than `street` (7.5, 58) |
| picker | handling model **and** your own vehicle builds, in the preview bar |

Two separate reasons the tuner looked dead, and both are fixed: the profile was read **once, at
spawn**, so every later change was a change to the next car (`RapierCar.setProfile` applies it live,
and the F6 knob is re-read every frame); and the vehicle **build** — the screen with the power and
the gearing on it — was never consulted at all, because the preview span a default car. Choosing a
build respawns where you stood, because mass, wheelbase and wheel radius are the collider.

An explicit choice still beats the inference: a knob moved off `street`, a level that names a
profile, or `?car=` all win.

## The loop, the frame, and the game board through MCP (2026-09-29, night)

Three asks from Rich, in order, all measured rather than reasoned.

### The loop was a ghost collision, not friction

`probes/looprig-real.sh` — the engine's real `Vehicle`, the real `@apex/stunt-pieces` loop through
`connectFixture`, the real assist, in Node in two seconds — reproduced the game's stop to the lane
sample. Under ~5 g at the entry the 6 cm springs bottom, the box chassis rests on the ribbon, and a
trimesh **internal edge** flips the contact normal from the road's up to straight backward: 29 m/s
gone in one physics step. The old `probes/looprig.mjs` never saw it because it drives a different
car on the repo root's Rapier 0.12 (the engine ships 0.21). Fixes, all in the engine:
`FIX_INTERNAL_EDGES_TWO_SIDED` on every `addSurface` trimesh, a `sled` chassis hull (raked belly,
rounded corners — Rich's "off-road SUV with skid plates"), and `Min` friction combining so the 0.04
skid plate is 0.04 and not the 0.57 Rapier's default average made of it. With the assist the loop
completes from 20 to 45 m/s; without it a 30 m/s car leaves over the top, as STUNTIN's
`normal < 0 → launch` says it should. `PIECE=loop MPS=30|40` and `PIECE=hump` pass in the browser.
The chase and cockpit cameras now roll with the car (`CHASE_ROLL`, `CHASE_ROLL_LAG`), which Rich
asked for the first time he went round.

### The frame budget was leaf fill

On Rich's Mac (2560 × 1323): the main thread is ~1 ms; an EMPTY scene is 16.7 ms, the 60 Hz
display. Hiding the near trees took a 41.5 ms frame to that floor. Not triangles — FILL: alpha-tested
double-sided leaf cards, every fragment shaded before it can be discarded, with a PBR shader. The
same leaves as `MeshLambertMaterial`: 22.7 ms. Then the defaults: 700 full trees within 240 m were
"insane"; now radius 110, 90 a species, a cheap far canopy past 70 m, and a view CONE
(`TREE_CONE_DEG` 80) instead of a circle. Worst spot found: 19.5 ms. Splats not yet measured.

### The game board, 100% through MCP

What was missing and is now in:

| piece | where | proved by |
| --- | --- | --- |
| traffic in the world — planned from zones, spawned from a traffic SET's vehicle builds, driven by `traffic.ts`, drawn, kinematic bodies | `src/trafficlayer.ts`, `physics.spawnKinematic`, `scene.chains()` now carries lanes/twoWay/half/highway | `probes/corridor-traffic-level.mjs` |
| a level's program runs in the VIEWER against the real host (car, clock, presets, races, traffic zones, stunts) | `src/programload.ts` (shims shared with the pane), `main.ts` `startProgram`/`programHost` | `probes/.build/probe-game.mjs`, and the crofton probe |
| `player.vehicle` may name a vehicle BUILD; a level with traffic starts physics and drives the physics car | `main.ts` | crofton probe |
| server-side program build + typecheck against the generated bundle | `tools/worldeditor/programs.mjs`, `GET /api/programs/<id>?js=1 | ?check=1` | `program_check` catches a typo with a line |
| MCP: `vehicle_*`, `traffic_set_*`, `site_roads`, `site_road_polygon`, `site_road_gate`, `traffic_zone_add`, `course_save`, `program_check`, `program_build`; zones/courses/stunts as documents; `level_save` creates | `tools/worldeditor/mcptools.mjs`, `mcp.mjs`, `store.mjs` AUTHORED, `levels.mjs` | 88 tools; `probes/corridor-crofton-jam.mjs` |

**The Route 3 jam** (`levels/crofton-jam.json`, `programs/crofton/jam.ts`, four zones and the
stage `route-3-jam` in `sites/crofton-triangle/`) was authored by a script of MCP calls and nothing
else: two hero builds on `190e-evo` and `3000gt-vr4`, ten traffic builds, the set `crofton-jam`,
both Crain Highway carriageways painted 0.8–0.95, a ring and five gates laid square across the
southbound carriageway. Loaded in the viewer: 240 cars, density 0.93 at the checkpoints and 0 three
kilometres away, 80 cars within 300 m of the start, ring → countdown → running → finished → win.

### Left

- Traffic cars do not brake for the PLAYER (the player is not an ECS vehicle); they push it.
- Signal heads are not in the viewer's ECS, so every driver sees green.
- A chain's end wraps to its start; a proper network walk would turn cars round at junctions.
- Traffic is not in the editor preview yet — the viewer only.
- Splats' ~9 ms, unmeasured; Rich's 100+ fps wish needs a 120 Hz mode, the browser is vsync-locked at 60.

## The editor as a set of palettes (2026-09-30)

Rich's morning list, each fixed where it was measured to be broken (`probes/corridor-editor-palettes.mjs`,
21 checks):

- **The stunt list vanished on select.** Not a render bug: `.list` is a scroll container whose
  automatic minimum is zero, inside a grid whose rows size to content — with a `.detail` below it
  the grid handed the detail its height and squeezed the list to its two borders (2 px, one 26 px
  row inside). `.list { min-height }` in editor.css; every mode's list had this.
- **Only the place palette dragged.** Every mode now has the same two tabs — what you can ADD
  (draggable chips, `dragChip`) and what is PLACED (list + detail) — built by `paneTabs` in
  editor/ui.ts with the shell's own `tab-strip`/`tab` classes; the inspector's grey-button rule
  now excludes `.tab`, which is why they looked wrong. One drop protocol (`text/apex-drop`, mode +
  id) and `dropThing` in main.ts: a stunt piece lands on the road, a gate is laid square across it
  (in the selected race, or a new one), a traffic level paints a 400 m strip of the road
  (`roadStrip`), an area square lands where dropped, a structure kind cuts an 80 m interval.
- **Click anything, go to its tab.** `routeClick` already did this for stunts, placements, zones
  and areas; gates and entry rings were missing (`CourseMode.pick`/`select`), and the panel now
  re-renders on the placed tab with the row selected. With a palette item ARMED a click places
  and never selects — the `busy` rule, unchanged.
- **The road under a stunt on a BRANCH.** Branch roads are built lazily per chunk, so the hole is
  now cut where they are built (`holeBranch` in scene.ts): a holed copy per touched branch, the
  base hidden, and `applyRoadSkip` in both stuntmode and stuntworld covers every chain.
- **Trees.** Settings → Display → Trees: Realistic / Basic (cards) / Lollipops — the editor's
  crowns in the game, a new `TREE_LOLLIPOP` knob (with a renderer `TREE_SIMPLE` gave cards, never
  lollipops). The far-canopy LOD from the night before is off by default: it cost nothing and
  looked like lollipops beside real trees.
- **Splats.** `SPLAT_ENABLED` off dropped the tiles but never told Spark, which draws what it was
  last handed — one more `spark.update` on the way out. Settings → Layers has a "Captured world"
  toggle now, so it is not an F6 knob.

### Sideways cars and one lane (2026-09-30, later)

- Every reconstruction was mounted a quarter turn off: `fitToChassis` scaled by the longest
  horizontal axis but never turned it onto the nose axis (+X), and these models are long along Z.
  It now does, then guesses the front from the roofline (the tail's climb is the steeper one on a
  saloon, hatch, van, bus and pickup) — `noseSign` in carmodel.ts — and `spec.nose` (`keep` /
  `flip`, on the vehicles screen as "Which end is the front") overrides the guess.
- A three-lane one-way carriageway had every car in one lane: `lanesPerDirection(3)` is 1, and
  the planner ran both directions on a one-way road. `RoadChain.twoWay` now tells it; a carriageway
  gets all its lanes one way. And the cap stopped planning when reached — first chain, first lane
  — instead of thinning; it thins evenly now, and `TRAFFIC_MAX` is 600. Route 3: 182/182/183 cars
  across its three lanes.

## Fixtures, colliders and the waypoint (2026-09-30, evening)

- **Fixtures.** A new asset TYPE (`classes.ts`): race-gate, race-marker, stop-sign, give-way-sign,
  signal, power-pole, lamp-post, street-sign, plus `building` under props. `fixtures.ts` is the
  registry — per class: the built-in, its settings (per placed fixture), the procedural batches it
  replaces and where the bake stands each one — and `FixtureLayer` applies a world's
  `sites/<slug>/fixtures.json`: a chosen catalog asset of that class is fitted to the class height,
  cloned onto every bake position, and the built-in batch is hidden; choose the built-in and it
  comes back. The asset manager has a Fixtures tab (both editors); the document is a site doc for
  the MCP tools. Proven with a stand-in on 523 stop signs (`probes/corridor-fixtures.mjs`).
- **Race furniture.** Built-in gates are posts, a banner, and a chequered stripe at start/finish,
  drawn for every course all the time (dim, bright in your race, brightest for the next gate);
  the entry marker is a ring to trigger on and a standing arch facing the start. Height, colours
  and the arch are fixture settings; a chosen model replaces either.
- **Colliders.** A signal mast's collider is its post, not its arm (the invisible wall under the
  lights). A detached sign takes its `:face` batch with it (the vanishing or floating octagon).
  Street-name blades are one merged mesh per site and still cannot be hit or detached; that needs
  them built as instances.
- **Waypoint.** `ui/waypoint.ts`: a tilted-plane arrow in the corner, the distance, a message that
  folds on a click. A program sets it with `api.waypoint(at, text)`; otherwise the races supply it:
  the nearest ring and its road, "cross the start line", then each next gate.
- **Also:** a level opened from the menu starts physics and rebuilds the car (collisions and the
  hero model were missing that way); models lie along the nose axis with a wheel-overhang guess
  and `spec.nose` to overrule (five builds flipped over MCP); one-way carriageways use every lane
  and the cap thins evenly (Route 3: 182/182/183).

## Crashes, missiles, and the things that gave way (2026-09-30, night)

- **Traffic is physical.** A traffic car is kinematic while it drives and becomes a loose dynamic
  body when hit harder than `TRAFFIC_WAKE_NS`, or when a blast reaches it: it bounces, tumbles,
  goes where it was sent, and blocks its lane as a wreck. Both cars in a collision dent
  (`dents.ts`, the engine's `Deformable`, geometry cloned per car on the first knock). Drivers see
  the player now (`TrafficOpts.obstacle`) and brake for him in their lane — the "stuck in place"
  in the jam was cars driving through him.
- **The mass trap.** Rapier recomputes a body's mass on the NEXT step, so an impulse in the step
  that woke a body is divided by its stale kinematic mass; a 1500 kg car left a blast at under a
  metre a second. `TrafficBody.kick` sets VELOCITY instead, and `TrafficLayer.blast` throws its
  own cars that way before `physics.explode` handles the rest. The same for a broken sign.
- **Missiles.** `missiles.ts`: M fires from the bonnet along the nose (a point flown by hand, a
  0.9 m ball swept over each frame's travel — a ray missed cars by a metre), landing is a blast
  (`MISSILE_RADIUS`, `MISSILE_IMPULSE`) and a flash. `api.physics.explode` lands in the same
  `boom`. `probes/corridor-crash.mjs`: a blast throws a car 42 m, a missile 33 m.
- **Soft breakables.** A sign or post (breaking under `PHYS_SOFT_BREAK_NS`) is a sensor until it
  is touched: no contact impulse, so no launch — a rigid post against the sled's raked nose had
  put a 40 m/s stop into the car, upward, end over end. The touch breaks it and sets its velocity;
  it flies, the car keeps going (`probes/corridor-stopsign.mjs`).
- **Waypoint.** Lower left, off the corner, steps over the attribution block, turns with the
  CAMERA; the goal no longer echoes on the bottom readout.

## The pile-up, made to last (2026-09-30, later)

Rich, driving the Route 3 jam: cars "appear out of thin air"; at speed a hit car "turns into one
of these giant blobs"; the frame rate falls to 12 as the pile grows; the drivers "don't know to
stop or slow down"; and at 12 fps "trying to straighten my car out was in slow motion". Then:
"I wish we could have the cars keep piling up in a game mode where all of the drivers are blind
… limit whatever is causing the CPU and GPU decline to a maximum number of bodies".

- **The blob.** `Deformable` measured its radius (1.1 m) and its cap (0.35 m) in the MESH's
  units, and a reconstruction is a unit cube scaled ×4.5 — so one knock reached the whole car and
  folded every vertex a metre and a half. Every length is now divided by the mesh's world scale.
  Nothing ever flushed a dent to the GPU either (the first showed by accident, as a fresh geometry
  upload); `flushDents()` runs from the frame, two meshes a frame. A car is dented at most every
  90 ms, and a kerb tap below the dent threshold no longer clones 130k vertices to find that out.
- **Thin air.** A car that ran off the end of its chain came back at the chain's START, and on
  Route 3 the chains run junction to junction, so the start was often in front of the player. It
  now comes back at the first spot on its chain at least `TRAFFIC_RESPAWN_M` (260 m) from the
  player, clear of the car already there, at 0.8 of the limit — or waits hidden until there is
  one. `respawnMin` on the layer is the proof (the probe saw nothing nearer than 500 m).
- **Wrecks are leaders.** The drivers only looked at driven cars, and a wreck has no driver: the
  car behind a fresh wreck could not see it. Every car on a chain is a leader now; a wreck is
  re-projected on to its lane every half second and leaves the road (`OFF_ROAD`) once the solver
  has thrown it more than a lane's width off the line.
- **Blind drivers.** `simulations[].blind: true` (or `traffic.blind` over the bridge): nobody
  brakes for anybody — no leader, no light, no player. The game Rich asked for.
- **The cap.** `TRAFFIC_WRECKS_MAX` (40) loose wrecks at once. Past it the oldest is straightened
  (`repairObject`), put back on rails (`TrafficBody.rest`), given a driver again and respawned out
  of sight. Every wreck was a dynamic body plus a 130k-vertex mesh drawn at full detail; the
  screenshot with "962 draws · 27.65M tris · 13 fps" was a hundred of them.
- **Bodies only near the player.** `TRAFFIC_PHYS_M` (220 m): a kinematic car beyond it is
  disabled in the solver (`TrafficBody.enable`). Six hundred kinematic bodies were six hundred
  broad-phase updates a step for cars nobody could reach.
- **Slow motion.** `PHYS_MAX_STEPS` 4 at 120 Hz was 33 ms of world per frame: at 12 fps the world
  ran at 40% speed. The engine's step loop now has a time budget (`PHYS_STEP_BUDGET_MS`, 10 ms)
  and the cap is 12: a slow RENDER costs no world time, a slow SOLVE degrades to slow motion
  rather than a spiral, and what is still owed past one step is dropped rather than carried.
- **Wake threshold.** `TRAFFIC_WAKE_NS` 2500 → 8000. A kinematic car is infinitely heavy to the
  solver, so a 12 m/s bump reads as 33 kN·s on both cars; at 2500 a nudge woke half the jam
  through its neighbours. The tumble a blast gives now scales with the throw for the same reason.
- **R repairs.** Recover straightens the hero car's dents unless the level says
  `recoverRepairs: false`; Settings → Controls overrides either way (level / always / never).
- **Orientation on the asset.** `AssetItem.orient.yaw_deg`, a select in the asset form's
  "Described" group (0/90/180/270), turns the model wherever it is used and the preview with it
  (an axes helper shows +X, the front). A vehicle whose asset is oriented is not turned or guessed
  by the fitter; `spec.nose: 'flip'` still overrules.
- **Probe traps, three of them.** The chase camera and the drivers' view of the player are both
  set in `frame()`, which never runs inside a synchronous probe loop: the eye has to follow the
  car and `traffic.player` has to be fed by hand, or cars 3 km from the camera are never placed
  and a woken body falls from the origin for ever ("thrown 3218 m", green). And after an HMR
  update a probe's `import('/src/traffic.ts')` is a second copy of the module with empty arrays;
  `traffic.view(i)` reads the live one. `probes/corridor-pileup.mjs` covers all of the above;
  `test/traffic-wrecks.test.ts` the leader rule and blind mode.

Measured here (swiftshader, 600 cars): traffic actors 0.7 ms, place 0.3 ms, physics 0.2 ms a
frame. The main-loop cost Rich saw was the dents (a 130k-vertex walk per impact per mesh, every
step of a resting pile) and the pile itself on the GPU; both are bounded now.

## Stages from the viewer, L for the lights, and a deploy (2026-09-30, last)

- **Stages.** The viewer's drawer has a Stages section: every level set in the world on screen,
  the open one marked, "Free roam" to leave it. It reads `/api/levels` (the world editor's list,
  or a static object at that path in a deployed copy). Opening a stage over a bare world happens
  in place; leaving one or swapping is a reload — a level is not unloadable in place.
- **L.** The headlights still follow the night; L flips them, and the override lasts until the
  night changes (`lightsLevel` in main.ts). Listed in Settings → Controls.
- **Deploy.** World editor mode 9: token (env or typed, in memory only) → worlds (one or several,
  one URL) → query Cloudflare → worker name, workers.dev and/or a hostname in a zone, bucket (or a
  new one), prefix `corridor/<world>-<stamp>`, prune older copies → plan → deploy as a run.
  `tools/worldeditor/{cloudflare,deploy}.mjs`, `deploy/worker.mjs`; `docs/corridor/DEPLOY.md`.
  Only what the worlds use goes up, measured by following ids through the documents and builds
  (Route 3: 254 objects, 129 MB, 11 of the library's cars). No real deploy has been run: there is
  no token here. Probes: `corridor-stages-lights.mjs`; tests: `cloudflare.test.mjs`, `deploy.test.mjs`.
