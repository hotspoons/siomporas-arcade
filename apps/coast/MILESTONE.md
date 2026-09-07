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

## Aesthetic pass (same day, Rad Mobile as the bar)
- Procedural Group-6-style hero prototype (four liveries) baked into the atlas
  for the chase view; the cockpit is now inside that car — fender humps in the
  corners, long nose with the stripe, thin rim wheel, three round gauges,
  offset mirror with dice, wipers in the rain.
- Per-theme road: 2–4 lanes with solid edge lines, sand/gravel/kerb shoulders,
  guardrails with posts, procedural diners/motels/gas stations/towers/signs
  (original slogans) and arches among the CC0 scenery.
- Weather and time: rain on the forest and alpine stages; night city with
  headlight fall-off, glowing signage and lit windows; clouds layer.
- Car choice (liveries or the formula car) and a view hint on the HUD.

## Feel pass (after the first look)
- Bottom-of-road popping fixed: the row under the camera is pinned just in
  front of it instead of being skipped every segment.
- Hills: each hump climbs and returns; a gentle whole-period swell
  (`ROLL_AMPLITUDE`) runs under every stage so the road always rolls.
- Speed cues: 2-segment bands, lower/closer chase camera, 78° FOV.
- Sprite atlas cached in IndexedDB (keyed by manifest hash + bake version).

## Not yet
- Hero car catalogue (one car), rival cars, high-score table, route map on
  the results screen, weather/time-of-day variants, more landmarks (signs with
  text), animated roadside (birds, water), a proper attract demo loop.
- Real-GPU feel pass: sprite sizes, fog distance, curve strength, steering.
