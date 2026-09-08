# Decisions — drivin

1. **Track-space car physics, not a rigid body.** On a piece the car's state is
   (lane, s, lateral, speed, heading offset, lateral velocity). Curves are
   followed by construction; the player fights the centrifugal term with
   steering and tyre grip, banking adds a gravity term, and a normal-force check
   (`v²·k_up + g·up_y < 0`) decides when you leave the surface — so loops need
   speed and crests launch you. It is deterministic, cheap, and the same idea
   that made the tunnel game testable.
2. **Three regimes: track / air / ground.** Airborne is ballistic with *no*
   player attitude control (nose follows the arc, roll settles level): landings
   are about speed and angle. Ground is flat-world grass driving that rejoins
   a level-0 lane only when heading along it.
3. **Pieces are data + a path function.** Each piece: footprint in cells, ports
   (cell, side, level delta), lanes (`t → point, up hint, roll, surface?`).
   Baking resamples to 1 m with parallel-transport-free frames (the up hint is
   explicit, so loops and helices need no twist fixing).
4. **Ports match on shared grid edges at equal level.** The graph is walked
   from the start piece in driving direction; a piece entered "backwards" gets
   a reversed lane (a ramp driven downhill, a join used as a split).
5. **Laps count only when the start lane is entered from its predecessor.**
   Cutting across the grass is not a lap.
6. **Grip is arcade-high (2.2 g).** Tight 20 m curves are ~70 km/h; wide ones
   ~130; banking buys more. Tuned so the built-in tracks are drivable at speed
   without a sim-racer's discipline.
7. **Crash replay is a pose ring, not a re-simulation.** Six seconds of
   position/forward/up at 120 Hz, played back from a trackside camera.
8. **Tunnels are visual.** The road is the tube's floor; walls bounce you back.
   Riding the tube wall (as in the tunnel game) is a later expansion, as is
   non-tile geometry (real-road stages from gaussworks, see the reminder).
9. **The happy glitch is a feature.** In the 1990 original, leaving the ground
   near top speed with the throttle held accelerated the car straight back to
   vmax in mid-air, even after a corner had scrubbed speed. Rich loves it, so
   `Car.tickAir` recreates it deliberately (`AIR_GLITCH_THRESHOLD`,
   `AIR_GLITCH_ACCEL`); lifting the throttle disarms it for that flight.
10. **No teleporting, ever.** The world is drivable everywhere: the grass is
    infinite, crashes replay and then resume where the car came to rest, and
    `R` only rights the car in place. A lap counts whenever you cross the start
    line; every required segment you skipped adds `SEGMENT_PENALTY` seconds
    (split alternatives are optional). Lap times get worse, runs never get
    interrupted.
11. **Blue sky by default.** The original's sky was odd; ours is a clear day
    with light haze fog, no stars.
12. **Heading sign.** `forward = tan rotated by +heading about up` (right =
    up × forward = −z when facing +x). An earlier `-heading` pointed the nose
    left while the car drifted right, and `toGround` inherited it — which is
    what made leaving the road feel like bouncing off a wall.

## Frame handedness (2026-09-07)
`right = tan × up` is the driver's right (+z when heading +x, y up). `heading > 0`
turns right, so world forward is `tan.rotateAxis(up, -heading)`; on grass
`forward = (cos yaw, 0, sin yaw)` and steering right increases yaw. An earlier
`up × tan` "right" was physically the left, which is why steering read mirrored.

## Loop is two tiles (2026-09-07)
The loop drifts sideways by a full road width (`LOOP_SHIFT`) across the circle so
the exit clears the entry instead of the tube intersecting itself; it needs a
cell either side to ease in and out, hence `w: 2`.

## Experiments (2026-09-07)
Settings → EXPERIMENTS holds rule-breaking switches. `Crashes` off turns a hard
landing into `resumeInPlace(0.6)` (back on your wheels, 60 % of your speed).
Airborne with the throttle down the fake gearbox revs away through the gears
(`AIR_REV_RATE`), Stunts-style, and snaps back to the speed-derived note on landing.

## Big pieces, half-pipe tunnels, grass (2026-09-07)
Tunnel is two cells and `TUBE_RADIUS` 11: `lateral` inside a tube is arc length around the
wall, gravity pulls you back down and the curve's centrifugal push rides you up, and an
airborne car is caught on whatever part of the wall it reaches. Banked sweeper is 4×4,
corkscrew 4×1 (`CORK_RADIUS`), loop radius 12. Grass barely slows a straight line
(`GRASS_DRAG` 1.5) but throttle/brake force is scaled by `GRASS_TRACTION` and steering by
`GRASS_STEER`; leaving the road keeps your lateral slide (no more "bounce" at the kerb).
Air glitch arms at 60 % of top speed and pins almost instantly. Hood camera gets a canvas
dashboard (`app/Dash.ts`); the start piece gets a chequered gantry.

## Type (2026-09-07)
Hard Drivin' / Stunts references: brush-script logo (Yellowtail, Apache 2.0) over DOS terminal body text (VT323) with arcade bitmap caps for labels and menu titles (Press Start 2P). Fonts are bundled under `public/fonts` (latin woff2 subsets, `scripts/fetch-fonts.mjs` regenerates them; licenses alongside). The hood-cam dash digits use VT323 too.

## Open-world car, speedlock, structures (2026-09-08)
The car keeps its own heading: on a lane the offset from the tangent grows as the path bends (`heading -= kRight·v·dt`) unless you steer, so nothing follows a curve for you. Steering asks for a yaw rate; the tyres deliver what grip allows (banking gravity helps or hurts), the handbrake lets the rear go. Past `HEADING_MAX` a ground-level lane hands you to the grass. Speedlock (the Stunts glitch) persists across air, road and grass while the throttle is held; speedlocked landings never crash. Grass is nearly as fast in a straight line (`GRASS_DRAG` 0.4, `GRASS_TRACTION` 0.75). Lanes have `prev` links so reversing crosses piece boundaries; grass mode collides with slabs, berms, tunnel skins and pillars (`bump`, or `crash` above `CRASH_IMPACT_SPEED`). Banked arcs lift their centreline so the inner edge is at grass level; `bank6` is the 6×6 speedbowl; `cross` lets the track cross itself. Tunnel walls rise from curb height over `TUBE_RAMP` at each mouth (sim and mesh agree). Loop radius 18. The start gantry's basis is right-handed now (it stood a quarter turn off).

## Editor v2, scenery, drawbridges, landscape (2026-09-08)
The editor is an unbounded pan/zoom grid with the conventions in Editor.ts' header (⌘/⇧/⌥ clicks, right-click menu, undo, save-over vs save-as with unique titles, drag-move). Occupancy is per level so bridges cross roads. Scenery pieces (`decor`) have no lanes: water sinks the car, trees/buildings/pumps are solids the grass mode bumps into; placement and collision boxes both come from `sim/decor.ts`. Drawbridge halves have an `open` port; the track links two facing halves across a gap (`lane.gap`) so laps and loop length still resolve, and the car launches at the lip. Landscape is a per-corner heightmap (`TrackData.terrain`, `sim/terrain.ts`); the ground under every road piece is pinned to the piece's base height so tarmac always meets grass, grass physics follows the slope (and launches off crests), the renderer draws a heightfield with slope shading. Editor "Landscape" mode (G) sculpts with a falloff brush.

## Spline links (2026-09-08)
Anchor pieces plus auto-filled road: clicking two open connectors creates a `Link` (sim/links.ts) — a cubic Hermite curve leaving along one port's facing and arriving against the other's, tangent length = tightness × distance (`,`/`.` or the menu), height eased between levels, optional camber into the curve (B). Each link is a synthetic piece appended after the real ones, with two ports on the linked edges (same edge keys) and one lane baked in world coordinates, so the lane graph, laps, reversing, landing and rendering need nothing special. Deleting or force-replacing pieces remaps link indices. The editor status bar has a fixed height so a flash never resizes the canvas mid-gesture.

## Editor palette (2026-09-08)
The palette is out of the flex negotiation (`flex: none`; the canvas is `flex: 1 1 0; min-width: 0`) — before, the canvas's pixel width fed back into layout every redraw and squeezed the palette on each mouse move. It has a drag grip to resize (56–440 px), collapses to icons below ~110 px or via the «/» button, and remembers both per browser. The landscape brush grows the grid when you paint past its edge.
