# TURBO RADRUN

https://radrun.siomporas.com

A sprite-scaling road racer in the lineage of the great 1986–1991 arcade
cabinets: three stages joined by forks, a countdown extended at checkpoints,
traffic to thread, turbo, hi/lo gear, a radio you tune before you leave — and
two projections, **chase** (car on screen) and **cockpit** (dashboard, wheel,
swinging dice). Pseudo-3D: segments, curves, hills and sprites, drawn on a
224-line logical screen. Modern and retro presentation from
[`packages/engine`](../../packages/engine).

```bash
just dev coast        # http://localhost:5182
just tunnel coast     # phones / remote
```

| Action | Keyboard | Gamepad |
|---|---|---|
| Steer | A / D, ← / → | left stick |
| Accelerate / brake | W / S | RT / LT |
| Gear hi / lo | Shift | A |
| Turbo | Space | B |
| View | C | Y |
| Pause | Esc | Start |

Phones: tilt to steer, GAS right, BRAKE left, GEAR / TURBO pills, VIEW pad.

## Worlds and the track editor

`WORLD` on the title screen picks what you drive: the built-in coast-to-coast
route, or a **track set** you built yourself. `BUILD A WORLD` opens the editor.

A world is a directed graph of tracks — one start, at least one finish, forks
that can branch and then rejoin on a common last stage, Turbo OutRun style. The
editor has two views (Tab switches):

* **Set** — every track as a box. Drag the boxes to arrange them; drag the green
  dot on a box's right edge onto another box to link them. Two links out of one
  box is a fork, drawn LEFT and RIGHT in the order you made them. ⌥-click a link
  to cut it, double-click a box to edit that track.
* **Track** — one track's centreline, in real metres. Waypoints with Bézier
  handles: drop them, drag them, and drag a handle to set the curvature between
  two of them. Below the canvas, a profile strip for the hills and a timeline
  strip carrying the scenes, the vibes, the macro elements and everything you
  placed by hand.

| Action | How |
|---|---|
| Extend the road | Add-waypoint tool, click past either end |
| Insert a waypoint | double-click the road |
| Bend the road | select a waypoint, drag its cyan handle (⌥-click a handle = back to automatic) |
| Cusp ↔ smooth | ⇧-click a waypoint |
| Bank in / out | `B` on a waypoint (banking eases between waypoints) |
| Hills | drag a waypoint in the profile strip, or `Q` / `E` (held to a gradient the car can climb — to climb higher, space the waypoints further apart) |
| Rolling swell | the Hills items at the top of the palette |
| Time on the clock | the Clock item in the palette — this stage's start time, or its checkpoint bonus |
| Widen the view across the road | `⇔` in the toolbar (Auto, true scale, or a fixed step) |
| Scene, vibe, prop, crossroads | pick it in the palette, click the road |
| Macro elements | pick one, drag along the road (or drop it in the timeline) |
| Move anything placed | drag it, on the canvas or in the timeline |
| Delete | ⌥-click it, or select and `Delete` |
| Open out corners the car can't hold | `◡ Smooth` |
| Undo / redo | ⌘Z / ⌘⇧Z |
| Test drive | `T` |

**Scenes** are the prebuilt road: palm coast, ocean strip, cliff road, causeway,
farm fields, pine forest, blue ridge, suburbs, red canyon, salt flats, high pass,
downtown, neon blocks, lit boulevard, docks. Each brings its own road width,
shoulders, guardrail, roadside mix and landmarks. A track can run through
several — the ground colours crossfade at the change.

**Vibes** are the hour and the weather, and they are separate from the scenery on
purpose: dawn, day, overcast, sea fog, rain, sunset, twilight, night, neon night,
rain · night, storm. Drop two or three along a track and it slides between them
as you drive, so a stage can leave in daylight and arrive in the rain after dark.

**Macro elements** run along a stretch: ocean front (a beach then water to the
screen edge), buildings at the kerb, a tunnel, roadworks (a barrier taper in, a
jersey barrier along the lane line, a taper out), extra barriers, or a cleared
roadside.

`⑂ Fork built-in` traces the whole coast-to-coast route into waypoints so you can
pull it about; the shipped route itself is sections and is never edited in place.

Edits are parked in the browser after every change, so a reload or a crash does not cost
them: the editor offers them back next time it opens, and the title carries a `•` until you
Save.

The pseudo-3D road is gentler than it looks: a 1.4 km-radius sweeper is already a
strong curve on screen, so corners under about 800 m have to be braked for and
ones under 470 m are opened out at compile time. The plan view colours those
amber and red, and `◡ Smooth` fixes them.

Which is why the plan view exaggerates the lateral axis by default, the way a road
engineer's long section does: a 5 km stage that wanders two hundred metres is a
hairline at true scale. Each axis carries its own grid and its own scale bar, and
the corner says how far the view is stretched. `⇔` walks through Auto, `×1` (true
scale, both axes the same) and fixed steps.

A stage takes the game's own timings unless you say otherwise: 75 s to start,
62 s at each checkpoint. That suits the shipped route's 4–5 km stages and leaves a
short authored one over before the clock has said anything, so the palette's Clock
item sets what this stage puts on the board — its start time when it is first, its
checkpoint bonus when you reach it. `✓ Check` complains if the clock cannot cover
the road.

## Sprites and assets

No sprite is hand-drawn. At startup the game loads CC0 low-poly models
(Kenney's Car, Racing and Nature kits) and renders each one into a sprite
atlas from a few yaws — traffic from behind and at ±20°, the hero car at seven
steering angles — then everything on the road is a scaled quad again. Swapping
a model in `src/render/models.ts` re-bakes automatically; nothing needs
Blender. See [public/assets/LICENSES.md](public/assets/LICENSES.md).

The bake camera is a long lens rather than an orthographic one: an ortho render
gives the near and far ends of a car the same width, which reads as an isometric
drawing instead of a photograph of a model, and photographs of models is what
the arcade sprites of this era were.

The hero car, the buildings and the signs are not from a kit — they are built in
`src/render/procgen.ts`. Judging one of those from a 40-pixel sprite is hopeless,
so **/model.html** puts the actual meshes on a turntable under the bake's own
lights, with camera presets on the angles the atlas really bakes. `just
model-shots` shoots the lot headlessly into `shots/model/`.

## Layout

```
src/sim/      Road (segments from sections or compiled, scenery, forks, runway),
              Stages (built-in route tree + themes), Sim (player, traffic, timer,
              forks), Snapshot
src/world/    types (the authored world), path (the centreline), compile (track →
              segments), scenes, vibes, Route (what the sim asks a world), builtin
              (tracing the shipped route), WorldStore
src/editor/   Editor (set view + plan view + strips)
src/render/   Projection, RoadMesh (per-frame trapezoids), SpriteAtlas (bake),
              SpriteBatch (instanced quads with hill clipping), Background
              (sky + procedural parallax), Cockpit, RenderWorld
src/app/      Game, Settings, Hud, menus, main
src/input/    bindings, InputMap, TouchSource
src/audio/    engine, tyres, bumps and three radio stations
test/         route tree, stage builder, determinism, checkpoints, full run
```
