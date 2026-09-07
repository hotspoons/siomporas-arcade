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

- Phones: tilt steering (shared `@apex/engine/input/TiltSensor`), GAS / BRAKE
  thumb pads, handbrake pill, reset / cam / pause / recalibrate, drag-steer
  fallback, fullscreen + landscape lock, compact HUD. Verified in emulated
  touch over the tunnel; tilt untested on a real phone.
- Haptics (`@apex/engine/input/Haptics`): gamepad dual-rumble, Xbox impulse
  **trigger rumble** (Chromium `trigger-rumble`: brake trigger under braking
  slip, throttle trigger on power slides), phone vibration (Android). Crash,
  landing, curbs, grass, slides. Strength slider in Settings. Real
  force-feedback wheels are not reachable from the web platform.

## Owner rules (same day)
- **Free roaming**: infinite grass, no auto-reset, crashes resume in place,
  `R` rights the car where it is; laps always count at the line, skipped
  required segments add 5 s each (split alternatives are optional).
- **Blue daytime sky** with light haze fog replaces the dusk look.
- **The Stunts air glitch**: near-vmax take-off + throttle held → speed pins
  back to vmax mid-air. Tested.

## Not yet
- Ghost/replay of whole laps (tape recording exists in conduit, not here).
- Editor: pan/zoom for big grids, undo, multi-select, non-90° pieces.
- More cars, damage model, opponents, split-time/ghost comparisons.
- Real-GPU play-test and feel tuning (`GRIP_LATERAL`, `STEER_RATE`,
  `ALIGN_RATE`, camera distances).
