# APEX CONDUIT

https://apex.siomporas.com

A browser tunnel racer-shooter: pilot a low-slung craft down glowing tubes at
700–1000 mph, roll around the wall to dodge, burn traffic with a roof laser,
clear the screen with a shockwave, ride jumps into open air, and beat a
countdown that only checkpoints extend. Two looks — a modern post-processed
one and a deliberate 20 fps flat-shaded CRT one — plus WebXR and phone (tilt)
modes. Four courses, twelve hostile vehicle types, a circuit mode.

TypeScript · Vite · three.js · postprocessing · Vitest · oxlint. No framework.
See [MILESTONE.md](MILESTONE.md) for what is done and verified,
[DECISIONS.md](DECISIONS.md) for where the build departs from the design
handoff, and [HANDOFF.md](HANDOFF.md) for the next agent.

## Run it

From the repo root (this app lives in a workspace — see the root README):

```bash
just dev conduit          # http://localhost:5180
just check                # oxlint + tsc + vitest, whole workspace
just build                # production bundles in apps/*/dist
```

`?style=retro` and `?perf=1` are honoured on the URL.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Steer around the tube | A / D, ← / → | left stick |
| Throttle / brake | W or Shift / S | RT / LT |
| Fire laser | Space or LMB | A / RB |
| Shockwave | E or RMB | B / LB |
| Air lift / dive | W / S while airborne | left stick Y |
| Pause | Esc | Start |
| Style toggle / perf overlay | F2 / F3 | — |

Everything is remappable from *Controls*; bindings persist in localStorage.

**Phones** (landscape): tilt to steer (⟲ recalibrates the neutral hold; drag
steers if sensors are unavailable), left pads = thrust / brake, right pad =
fire, bottom pill = shockwave, II = pause. Starting a run goes fullscreen.
Motion sensors need HTTPS — use the tunnel below.

## Test remotely

```bash
just tunnel conduit   # anonymous Cloudflare quick tunnel; prints https://…trycloudflare.com
```
Attaches to a running dev server or starts one (bridge enabled). The URL is
also written to `.tunnel-url`. Pages opened through it attach to the bridge
too, so `just bridge 'apex.snap.vehicle.speed'` works against your phone.

## Layout

Shared runtime (fixed-step loop, modern/retro styles, input sources, menus,
settings store, math, sky, particles, dev bridge) lives in
[`packages/engine`](../../packages/engine); this app owns everything below.

```
src/sim/       deterministic gameplay — no three.js, unit-tested headlessly
  math/        Vec3, scalar helpers, Catmull-Rom
  track/       TrackSpline (baked table), TrackBuilder, Track, profiles, courses/
  player/      Vehicle (ground + air)
  combat/      laser, shockwave, shield, collision, score
  traffic/     agent pool, spawner, behaviours, projectiles
  SimWorld.ts  fixed-step tick(); SimSnapshot.ts is what the renderer reads
src/render/    three.js scene: tunnel chunk pool + shader, craft, traffic
               instancing, VFX, camera rig, styles/ (modern, retro), hud/
src/input/     keyboard, gamepad, touch (tilt + hot zones), bindings, InputMap
src/xr/        WebXR session, cockpit, comfort vignette, in-world HUD
src/audio/     procedural Web Audio
src/app/       main, GameLoop, Game (flow), Settings, Menus, Records, PerfOverlay
tools/         preview.html — top-down / side view of any course
test/          vitest: spline invariants, determinism, courses, jumps
scripts/       probe.mjs / probe-mobile.mjs (headless screenshots), smoke.mjs,
               bridge.mjs, tunnel.sh
dev/           Vite plugin for the dev operator shell
```

## Dev tools

```bash
just bridge-dev conduit            # dev server with the live JS shell enabled
just bridge 'apex.snap.vehicle.s'  # evaluate in the attached browser tab
just probe shots/x.png 5 KeyW KeyD # headless SwiftShader run + screenshot
just smoke                         # headless play-test, fails on console errors
# course authoring preview: http://localhost:5180/tools/preview.html
```
