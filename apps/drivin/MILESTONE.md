# Milestone log — drivin

Started 2026-09-07 in one pass after the workspace split. Verified only in
headless SwiftShader Chromium (`just probe`, `just smoke drivin`) and unit tests.

## Shipped
- Sim: 14 piece types (start, straight, ramp, hump, jump, tight/wide/banked
  curves, loop, corkscrew, split, join, tunnel, tunnel curve), port graph,
  baked lanes, spatial index, car physics in three regimes, laps, crash replay,
  respawn with a rolling start, car catalogue with one car.
- Tracks: Oval, Highline (ramp to an elevated back straight), Stunt Park
  (everything once, with a split/join). Turtle layout helper.
- Editor: palette, place/rotate/level/select/delete, live port matching,
  validation, save/load (localStorage), export/import JSON, test drive.
- Render: road ribbons with curbs, tube tunnels, pillars, grid ground, dusk
  sky, procedural car with spinning/steering wheels, chase/hood/orbit/replay
  cameras, modern + retro styles from the engine.
- HUD (speed, gear, lap timer, best/last, minimap), menus, settings, remap,
  procedural audio (engine, tyres, wind, impacts, chime).
- Tests (13): rotation math, every lane meets its neighbour, loop frames turn
  fully over, all built-ins closed, autopilot laps the oval and the stunt park
  without crashing, a crawling car falls off the loop.

## Not yet
- Phone controls (tilt/touch) — engine has the pattern from conduit.
- Ghost/replay of whole laps (tape recording exists in conduit, not here).
- Editor: pan/zoom for big grids, undo, multi-select, non-90° pieces.
- More cars, damage model, opponents, split-time/ghost comparisons.
- Real-GPU play-test and feel tuning (`GRIP_LATERAL`, `STEER_RATE`,
  `ALIGN_RATE`, camera distances).
