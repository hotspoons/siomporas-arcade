# Milestone log — coast

Started 2026-09-07. Verified in headless SwiftShader Chromium and unit tests only.

## Shipped
- Sim: segment road builder (straights, eased curves, S-bends, hills, level
  return), six themes with weighted roadside scenery and landmarks, route tree
  with forks, player (hi/lo gear, turbo, off-road drag, centrifugal), traffic
  with lane changes and passing score, roadside collision (scrape vs tumble),
  checkpoint clock, finish/timeout. 8 tests incl. a full autopilot run.
- Render: sprite atlas baked from 36 CC0 models, road/rumble/lanes with fog,
  fork roads, hill clipping, parallax sky/mountains/sea/city/dunes/peaks,
  chase and cockpit views, modern + retro (320×224 @ 30 Hz default).
- App: HUD (time, score, stage, speed, gear, turbo, fork arrows, station),
  menus with radio tuner, settings, remap, phone controls, haptics.
- Audio: engine, tyres, bumps, checkpoint jingle, three sequenced stations.

## Not yet
- Hero car catalogue (one car), rival cars, high-score table, route map on
  the results screen, weather/time-of-day variants, more landmarks (signs with
  text), animated roadside (birds, water), a proper attract demo loop.
- Real-GPU feel pass: sprite sizes, fog distance, curve strength, steering.
