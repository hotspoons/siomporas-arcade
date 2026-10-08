# Working in this repository

This file is for agents (and people) running long tests against the corridor game. The design
documents are under `docs/corridor/`; the viewer's own README is `apps/corridor/README.md`.

## Extended testing of the corridor game

The agent box has no GPU. Frame-time numbers come from a real browser on a real card, driven over
the dev bridge (`scripts/bridge.mjs`; `APEX_BRIDGE=apex-dev just corridor-remote` serves the app on
`:5186` against the deployed world editor, then `APEX_ORIGIN=http://localhost:5186 node
scripts/bridge.mjs --file probe.js`). Inside a probe the app is `apex` (the bridge context) and
`window.corridor` (the console surface).

**Turn the screen wake lock on before any extended test.** A soak run, a profile window, a leak
watch — all of it stops the moment the display sleeps: the tab is hidden, `requestAnimationFrame`
stops, and every number after that is a tab doing nothing. The knob is `SCREEN_WAKE_LOCK` (F6 →
view → *long sessions and the test rig*). From a probe:

```js
if (!corridor.tune.get('SCREEN_WAKE_LOCK')) corridor.tune.set('SCREEN_WAKE_LOCK', 1)
apex.wakeLock() // { wanted, held, supported, error } — `held` must be true, or the test is not safe
```

It persists per browser like every other knob, and the browser releases it whenever the tab is
hidden; the page asks again when the tab comes back. Leave it on for the whole session and turn it
off when the work is done (`corridor.tune.set('SCREEN_WAKE_LOCK', 0)`).

**The test rig** drives the world's spine on its own and fires at the traffic, so a worst case can
be repeated exactly: `apex.rig.start({ speed: 28, fireEvery: 0.5, lane: 0 })`, `apex.rig.stats()`,
`apex.rig.stop()`. It drives whichever way the traffic beside it goes, keeps its lane with the same
`CarInput` the keys write, and while it is on the player's own car is excluded from missile blasts.
The knobs `RIG_SPEED_MPS`, `RIG_FIRE_EVERY_S`, `RIG_LANE_M` are its defaults. The game must not be
paused (Escape) while it runs.

**Measure, then change.** `apex.perfMeter.read()` is what the performance panel shows (open it with
`apex.perfHud.show(true)`); the JS Self-Profiling API works on the dev server when the bridge is on
(`new Profiler(...)`), and `EXT_disjoint_timer_query_webgl2` gives GPU time per render call. Hold a
change against the same rig run before and after, and report the percentiles, not the average.

**Before a change to the start-up path reaches a live tab**, boot the page headlessly (playwright,
`--use-gl=swiftshader`) and make sure it reaches `window.corridor.site` with no page errors. Vite
reloads every attached tab the moment the file is saved.
