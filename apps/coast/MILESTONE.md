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

## World builder (2026-09-08)
- Worlds: `WORLD` on the title screen drives the built-in coast-to-coast route or
  a track set you built; `BUILD A WORLD` opens the editor. Saved in localStorage,
  exportable and importable as JSON.
- Editor, two views: a **set** view wiring tracks into a directed route (drag a
  box's port onto another to link; two links out = a fork, branches may rejoin on
  a common last stage), and a **track** view laying one centreline out in real
  metres with Bézier handles per waypoint, a profile strip for the hills and a
  timeline strip for scenes, vibes, macro elements and placed props.
- 15 scenes broken out of the existing themes (palm coast, ocean strip, cliff
  road, causeway, farm fields, pine forest, blue ridge, suburbs, red canyon,
  salt flats, high pass, downtown, neon blocks, lit boulevard, docks) and 11
  vibes (dawn → day → overcast → sea fog → rain → sunset → twilight → night →
  neon night → rain·night → storm). Several of each per track; both crossfade.
- Macro elements laid along a stretch: ocean front, buildings at the kerb,
  tunnel, roadworks (leading taper → jersey barrier → trailing taper), extra
  barriers, cleared roadside. Crossroads and 40-odd props placed by hand.
- Banking per waypoint (`B`), easing between them; rolling swell per track.
- `◡ Smooth` opens out corners the car could never hold; `✓ Check` reports every
  track's length, seconds flat out and tightest corner; `▶ Test drive` runs the
  world as it stands, saved or not, and the pause and results screens offer a way
  straight back into the editor.
- `⑂ Fork built-in` traces the shipped 13-stage route into editable waypoints.
- Verified headless: 39 unit tests over the path, compiler, vibes, DAG and the
  traced route, plus `just editor-smoke` — 22 pointer-level checks that build a
  track, fork it, save it, recover it after a reload and drive it.

## World builder, second pass (2026-09-08)
- Unsaved edits are parked in localStorage after every change and offered back on the
  next open ("Unsaved edits to X from 3 minutes ago — pick them up?"); the title shows
  a `•` until you Save.
- Hills are held to a gradient the car can climb: waypoints clamp to 16 % against their
  neighbours as you drag them (with a message saying to space them further apart), and
  the compiler guarantees 32 % on the finished road by scaling the profile rather than
  clamping it, so a stage's end never leaves the datum.
- The profile strip now draws the compiler's own output, coloured by gradient, with a
  red ring on any waypoint that asked for more climb than the road can make.
- Menu rows no longer collapse to one word per line under a long value, START AT
  follows the selected world, and the title menu is wide enough for its hints.

## Not yet (world builder)
- Only the two-branch fork the sim understands; no three-way splits.
- No per-track traffic or clock overrides: `TIME_START` and the traffic mix are
  still global, so a very short track finishes before the clock says anything.
- The plan view is honest about how gentle these roads are, which makes drawing
  a recognisable shape (a bay, a loop) impossible at true scale. If that turns
  out to matter more than the honesty, a per-track curvature exaggeration is the
  knob to add.
- No real-GPU pass on the editor: sizes and hit radii were picked headlessly.
