# HARD LINE (working title)

A stunt-track driving game in the spirit of the late-'80s sit-down racers and
the tile-based track editors that followed: a fictitious hero sports car, a
grid editor that links track pieces by their ports, loops, corkscrews, banked
curves, splits and joins, jumps, humps, ramps and round tunnels. Same stack and
the same modern / retro presentation as the sibling tunnel game, via
[`packages/engine`](../../packages/engine).

```bash
just dev drivin        # http://localhost:5181
just tunnel drivin     # phone / remote testing over HTTPS
```

## Play

| Action | Keyboard | Gamepad |
|---|---|---|
| Steer | A / D, ← / → | left stick |
| Throttle / brake (reverse when stopped) | W / S | RT / LT |
| Handbrake | Space | A |
| Reset to track | R | Y |
| Camera (chase / hood) | C | X |
| Pause | Esc | Start |

Laps are timed; crashing (landing inverted, hitting anything at over ~80 km/h
vertically, falling off the world) plays a trackside replay of the last few
seconds and respawns you one piece back with a rolling start.

## Editor

Title → **TRACK EDITOR**. Pick a piece from the palette, click a cell to place
it with the current rotation (`R`) and level (`Q`/`E`); click a placed piece to
select it (Delete removes, `R` rotates it). Green dots are matched ports, red
are open. The status bar reports pieces, loop length, and the first error.
Save keeps tracks in your browser; Export/Import moves JSON between machines.
`T` or **Test drive** hands the track to the game; Esc in the pause menu returns.

Pieces connect when their ports share a cell edge at the same elevation level.
Ramps climb one level per cell; anything at level > 0 stands on pillars and has
no grass to catch you.

## Layout

```
src/sim/       deterministic: pieces (path generators), Track (placement →
               port graph → baked lanes), PathTable, Car (track/air/ground
               regimes), Sim (laps, crash replay), CarSpec (the catalogue)
src/sim/tracks lay.ts (turtle layout) + built-in tracks
src/render/    RoadBuilder (ribbons, tubes, pillars), RoadMaterial, Ground,
               CarMesh, CameraRig, RenderWorld
src/editor/    the grid editor
src/app/       Game (flow), Settings, Hud, menus, TrackStore, main
src/input/     bindings + InputMap (sources from the engine)
src/audio/     procedural engine / tyres / wind / impacts
test/          pieces & connectivity, tracks closed, autopilot laps, loop physics
```
