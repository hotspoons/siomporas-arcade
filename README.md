# Apex Conduit

A retro-inspired tube racer built with Three.js — ride the inside wall of a
neon wireframe conduit, roll around it to dodge pylons, graze boost pads, and
reach each checkpoint arch before the clock runs out. In the spirit of
**S.T.U.N. Runner**.

> Early prototype. See [HANDOFF.md](HANDOFF.md) for current state and where to
> take it next.

## Stack

Vite · React 19 · TypeScript · Three.js + react-three-fiber · oxlint ·
Playwright, in a Node 22 dev container. React owns the canvas element, the HUD
and the menus; everything that runs per frame is plain Three.js reading a
mutable game state (`src/game/world.ts`).

## Getting started

Open the repo in the dev container (VS Code: *Reopen in Container*).
`post-create.sh` installs `just`, the npm deps and headless Chromium.

```bash
just dev        # Vite dev server on http://localhost:5180
just check      # oxlint + tsc -b
just build      # typecheck + production bundle into dist/
just smoke      # headless Chromium plays a run and screenshots it
just            # list every recipe
```

## Controls

| Input | Action |
| --- | --- |
| `←` `→` / `A` `D` | roll around the conduit |
| `↑` / `W` | thrust |
| `↓` / `S` | brake |
| `Shift` | boost (burns the meter) |
| `Space` | hop off the wall |
| `Enter` | launch / restart |

Gamepad and touch are supported: on touch, horizontal position steers, any
contact thrusts, and a tap in the top third hops.

## Dev operator shell

An opt-in JS shell into the live page, for driving the running game from a
terminal on a real GPU. **Off by default and impossible to build into
production** — details in [HANDOFF.md](HANDOFF.md#the-dev-operator-shell-optin-devonly).

```bash
just bridge-dev                           # dev server with the shell enabled
just bridge 'apex.game.v'                 # current speed
just bridge 'apex.three.gl.info.render'   # draw calls, triangles
```

## Layout

```
.devcontainer/  container definition + post-create
dev/            dev-server-only Vite plugin (the operator shell)
scripts/        operator CLI + Playwright smoke harness
src/game/       track, course, input, state, simulation, scene
src/ui/         HUD and menus
```

Tuning lives in [src/game/constants.ts](src/game/constants.ts) — speeds, turn
rate, timers, collision envelopes, camera and fog, all in one file.
