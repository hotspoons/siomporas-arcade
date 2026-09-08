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

## Draped roads, tunnel mouths, jump facing, crash causes (2026-09-08)
Roads follow the landscape point by point; only pad pieces (loop, corkscrew, tunnels, banks) get level ground pinned under them at their centre height, and draping neighbours meet them there. Tube lanes ramp their walls up from curb height only where they meet plain road (`mouthIn/mouthOut`), so chained tunnel sections are one seamless bore; a spline link between two tunnel ports is a tube. The tunnel skin collision uses the ring's true half-width at roof height (beside a tunnel you drive under the flare). Placing a piece with an open lip auto-rotates it to face another open lip in line. Repeated crashes on a spot resume `RESUME_ADVANCE` further along each time. Crashes name their cause on the HUD (tunnel wall, pillar, tree, water, hard landing…). Connectors meeting at different levels are an error with both levels named; stale links are pruned on load and after edits; bad pieces/links pulse red, warnings amber.

## Banks join like tunnels (2026-09-08)
Bank pieces bake at full roll; the ramp in/out (first/last quarter) and the centreline lift (so the inner edge stays at grade) are applied when the lane is baked, and only against unbanked neighbours — a bank meeting a bank stays fully banked through the joint with matching heights. Spline links between two banked connectors carry the roll across (read back from the neighbours' end frames and blended end to end), lifted the same way, so an oval of banks and links is one continuous embankment.
Only banks leaning the same way (in driving direction) run through a joint; a left bank into a right bank eases to flat over the last/first quarter of each, and a link between opposite banks blends its roll through zero.

## Mirrored pieces (2026-09-08)
`PlacedPiece.mirror` flips a piece across its own direction of travel, before rotation: `portPlacement` swaps N/S ports and `applyMirror` mirrors the path point's z, up-z and roll. So a loop can shift its helix left instead of right, a corkscrew can wind the other way, and a bank can lean the other way without changing which way you enter it — the things that matter when a two-cell stunt piece has to fit an existing layout. The editor primes it with M (or the ⇅ Mirror button), the right-click menu mirrors a selection, and the ghost and top-down previews draw the mirrored path.

## Tilt steering direction (2026-09-08)
A car steers like a wheel: tilt the phone left and you go left (`TiltSensor.sign = -1` in both driving games). The tube racer keeps the craft leaning into the tilt (`sign = +1`), which is what it read like from the start. Settings → Invert tilt steering flips whichever default the game has, and only appears on touch devices.

## Piece descriptions in the editor (2026-09-08)
Every `PieceDef` carries a one-line `desc` ("what it is and how to use it"). The palette shows it as a native tooltip with the footprint size (so it still reads when the palette is collapsed to icons), placed tiles are captioned with their piece name once you are zoomed right in (LABEL_MIN_SCALE), and a tip appears beside the pointer after it rests for TIP_DELAY describing the piece under it (level, mirroring, rotation) or the link under it (tightness, camber, how to change them). Nothing is shown over empty grid — the palette already highlights what you are about to place.

## Bridges, water and one ramp piece (2026-09-08)
A road may share a cell with water — that is a bridge, and it is the only cell-sharing the checker allows (`canShareCell`). `RoadBuilder.bridgesFor` finds every run of a lane whose deck or edges are over water and builds the span from it: a parapet along each edge and a deck skirt under the tarmac, extended a sample onto the bank at both ends. Supports come from the usual elevated-road pillars, so a road at water level reads as a causeway and one up a level gets piers standing in the water. Water is drawn just above grade (it used to sit below the ground plane, which swallowed it) and just below the tarmac, so the road always wins. `Ramp` is one piece now — rotate it and it is the way down; the editor draws a green ▲ at the high end and an amber ▼ at the low end of anything whose ports differ in level. The old `rampDown` type still loads but is hidden from the palette.

## Editor placement (2026-09-08)
Placing a piece orients it for you: `orientFor` scores each rotation by how many of its connectors meet an open connector already on the grid and takes the best, so a straight dropped beside the end of a north-south run continues the line instead of sitting across it; ties keep the rotation you had, and a jump lip still looks down its line for another lip. The rotation that ends up used is remembered for the next piece. Palette entries can be dragged straight onto the grid (the ghost follows the pointer and the drop places it) without changing which piece is selected — a plain click still selects. Level arrows are drawn just outside the footprint so they never sit on the road.

## Published tracks and replay reset (2026-09-08)
`RICH2` (tracks/rich2.ts) is Rich's editor track shipped as a built-in: the layout and links are exactly as authored; the landscape is rebuilt with `brushTerrain` calls rather than a wall of exported numbers, so it reads in source and stays reproducible. Pressing reset during a crash replay skips it: the car goes back to the pose the replay opens on (a few seconds before the incident), stopped, for `RESET_PENALTY` seconds. Clicking the primed palette entry again (or Escape) clears it, so the pointer goes back to plain editing.

## Menu steppers and retro framing (2026-09-08, engine-wide)
Choice and slider rows render ‹ and › as real buttons: clicking ‹ steps back, › steps forward, clicking the row steps forward, and the keyboard is unchanged. Values no longer bake the arrows into their text. Retro mode fills the window instead of letterboxing: the chosen resolution sets the line count and the low-res buffer is cut to the window's aspect (rebuilt when that changes), so the barrel distortion curves over the whole picture rather than a 4:3 island.

## Copy JSON carries a repro (2026-09-08)
`TunePanel.context` lets each game attach where the copy was taken — drivin: track, camera, style, car, world position, cell, lane piece and s, speed, lap; coast: stage and route, seed, view, gearbox, z/x and segment, switches; conduit: course, seed, s/theta, speed. It rides in the copied JSON as `where` (with `at`, a timestamp), so pasting a tuning dump is enough to put the camera back exactly where a problem was seen. Roads are also a built-up slab now (tarmac 0.16 m, curbs 0.34 m), the ground mesh is finer (~6.7 m) and drawn a little lower, and the graded corridor feathers out into the sculpted land over a couple of cells instead of ending in a step.
