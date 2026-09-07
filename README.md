# APEX CONDUIT (working title)

A browser tunnel racer-shooter: pilot a low-slung craft down glowing tubes at
700–1000 mph, roll around the wall to dodge, burn traffic with a roof laser,
clear the screen with a shockwave, ride jumps into open air, and beat a
countdown that only checkpoints extend. Two looks — a modern post-processed
one and a deliberate 20 fps flat-shaded CRT one — plus a WebXR mode.

TypeScript · Vite · three.js · postprocessing · Vitest · oxlint. No framework.
See [MILESTONE.md](MILESTONE.md) for what is done and verified,
[DECISIONS.md](DECISIONS.md) for where the build departs from the design
handoff, and [HANDOFF.md](HANDOFF.md) for the next agent.

## Run it

Open in the dev container (VS Code → *Reopen in Container*), then:

```bash
just dev          # http://localhost:5180
just check        # oxlint + tsc + vitest
just build        # production bundle in dist/
just              # every recipe
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

## Layout

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
src/input/     keyboard, gamepad, bindings, InputMap
src/xr/        WebXR session, cockpit, comfort vignette, in-world HUD
src/audio/     procedural Web Audio
src/app/       main, GameLoop, Game (flow), Settings, Menus, Records, PerfOverlay
tools/         preview.html — top-down / side view of any course
test/          vitest: spline invariants, determinism, courses, jumps
scripts/       probe.mjs (headless screenshots), smoke.mjs, bridge.mjs
dev/           Vite plugin for the dev operator shell
```

## Dev tools

```bash
just bridge-dev                    # dev server with the live JS shell enabled
just bridge 'apex.snap.vehicle.s'  # evaluate in the attached browser tab
just probe shots/x.png 5 KeyW KeyD # headless SwiftShader run + screenshot
just smoke                         # headless play-test, fails on console errors
# course authoring preview: http://localhost:5180/tools/preview.html
```
