# Apex Conduit — handoff

A retro-inspired tube racer in the spirit of **S.T.U.N. Runner**: you ride the
inside wall of a neon wireframe conduit at speed, roll around it to dodge
pylons, graze boost pads, and hit checkpoint arches before the clock runs out.

The repo was scaffolded by copying trailworks' dev container + web tech stack
and stripping everything geo/Python/Android/Rust/k8s. **Nothing has been run
inside a dev container yet** — see "State" below.

---

## State (as of 2026-09-07)

| Thing | Status |
| --- | --- |
| Dev container, justfile, CI, tsconfigs, oxlint | written, **never opened in a container** |
| `npm install`, `tsc -b`, `oxlint`, `vite build` | ✅ all pass (run on the macOS host) |
| Game code (track, physics, world, HUD, menus) | complete, **never seen in a browser** |
| Dev operator shell (`virtual:dev-bridge`) | complete, wired, **never exercised end-to-end** |
| `scripts/smoke.mjs` (Playwright) | written, **never run** — the host had no matching Chromium build and installing one was declined |

**First job for the next agent: reopen in the dev container, `just dev`, and
actually look at the game.** Everything below is a description of intent that a
typecheck agreed with — not of behaviour anyone has observed.

### Working agreement

The owner does not want tooling installed on the macOS host. Browsers,
Playwright and any other heavyweight dev dependency go **inside the dev
container**. `.devcontainer/post-create.sh` already installs `just`, the npm
deps and headless Chromium there.

---

## Layout

```
.devcontainer/     Node 22 image + git feature, host networking, ~/.claude mounts
dev/               bridge-plugin.ts — the dev-only operator shell (server half)
scripts/           bridge.mjs (operator CLI), smoke.mjs (Playwright loop)
src/game/          the game: no React below Game.tsx
  constants.ts     every tunable in one file — start balance passes here
  track.ts         seeded spline + arc-length table; conduit space ↔ world space
  course.ts        blocks / pads / checkpoint arches, sorted by distance
  input.ts         keyboard + gamepad + touch, flattened to one poll-per-frame
  state.ts         the mutable run state (plain object, not React state)
  simulate.ts      one physics step; all collision is interval compares
  world.ts         the Three.js scene, built and driven imperatively
  Game.tsx         the only React ↔ Three.js seam (R3F <Canvas> + useFrame)
src/ui/            HUD and menus — React, polls state at 20Hz
src/dev/bridge.ts  operator shell (browser half); reachable only via the plugin
```

### The one architectural decision worth knowing

React owns the canvas element, the HUD and the menus. **It owns nothing that
runs per frame.** `world.ts` is plain Three.js reading straight from the mutable
`game` object, so there is no reconciliation on the render path and no
per-frame allocation (all scratch vectors are instance fields).

If you add a feature, ask which side it belongs on. A new HUD readout is React.
A new obstacle type is `course.ts` + `simulate.ts` + `world.ts`, and React never
hears about it.

### Conduit space

Everything is expressed as `(s, theta, lift)` — distance along the centreline,
roll angle around the tube, height off the wall — and converted to world space
through `Track`. That is why collision is three interval compares instead of a
physics engine, and why it holds up at 500 units/s.

`Track.sample(s)` extrapolates along the end tangent outside `[0, length]`, so
the entrance and exit tunnels stay straight instead of collapsing.

### Recycling

- **Conduit geometry**: a pool of `CHUNK_COUNT` chunks. Slot `i` always holds
  the chunk whose index ≡ `i (mod CHUNK_COUNT)` inside the visible window, so
  advancing one chunk length rewrites exactly one slot's vertex buffer.
- **Course props**: three `InstancedMesh`es refilled each frame from a sliding
  window over the sorted course list, walked with a monotonic cursor.

---

## Running it

```bash
just dev          # Vite on :5180
just check        # oxlint + tsc -b
just build        # typecheck + production bundle
just smoke        # headless Chromium plays a run, screenshots to shots/
```

`just smoke` needs `just dev` already running in another terminal.

---

## The dev operator shell (opt-in, dev-only)

Ported from trailworks' `devbridge`, which rode a Python backend's `/api/ws`.
There is no backend here, so the **Vite dev server** carries it
(`dev/bridge-plugin.ts`).

```bash
just bridge-dev                              # dev server WITH the shell on
just bridge 'apex.game.v'                    # evaluate in the live page
just bridge 'apex.three.gl.info.render'      # draw calls, triangles
just bridge 'apex.actions.startRun(); "ok"'
just bridge-clients                          # which pages are attached
```

Bare expressions work; multi-line code supplies its own `return`. `await` is
supported either way. Results come back through a JSON-safe serializer that
caps depth, unwraps Three math types and breaks cycles, so returning `scene` or
`renderer.info` gives you data instead of a crash.

The evaluated code gets `apex` — `{ game, world, input, constants, three: { gl,
scene, camera }, actions }`, registered in `Game.tsx` — plus everything on
`window`.

**Why it is safe to have in the repo:**

1. The switch is the `APEX_BRIDGE` env var (a token). Unset ⇒ `virtual:dev-bridge`
   resolves to empty no-op functions, so no bridge code and no `window` handle
   onto the game reach the runtime.
2. `load()` only emits the real client module when `config.command === 'serve'`,
   so `vite build` can only ever get the stub. Verified: `grep __bridge dist/`
   found nothing.
3. Every HTTP request carries `x-bridge-token`, and the WebSocket's first frame
   must be the token or the socket is closed.

---

## Where to take it next

Ordered roughly by "what the prototype is missing most".

1. **Play it and re-balance `constants.ts`.** Speeds, turn rate, `START_TIME`,
   `CHECKPOINT_SPACING` and obstacle density in `course.ts` were all picked by
   reasoning, not by feel. Expect them to be wrong.
2. **Audio.** Nothing exists. An engine tone pitched to `game.v`, a hit thud, a
   checkpoint chime — this is most of the arcade feel and it is entirely absent.
3. **Enemy craft and the gun.** S.T.U.N. Runner had both. Enemies fit the
   existing model well: give them `(s, theta)` and reuse the collision compares.
   Shots are the same, moving forward faster than the player.
4. **Track set pieces.** `Track.radiusAt()` breathes the tube with two sines.
   Real courses want authored features — a wide cavern, a tight squeeze, a
   fork, an open-air section where the tube's top half is missing.
5. **Bloom.** The neon look would carry much further with a real bloom pass
   (`@react-three/postprocessing`), currently avoided to keep the dep list at
   five packages. Check the frame cost on the target device first.
6. **A real title/attract sequence.** `stepAttract()` just drifts the camera
   forward; a scripted fly-through would sell the game better.
7. **Mobile.** Touch input works (drag steers, contact thrusts, tap the top
   third hops) but has never been tried on a phone.

### Known rough edges

- `scripts/smoke.mjs` scrapes the distance out of the HUD's DOM text. Once the
  bridge is proven, read it from `apex.game.s` instead — less brittle.
- The bridge always targets the most recently attached page. With several tabs
  open, pass `--target <id>` from `just bridge-clients`.
- `World.dispose()` is never called: `Game.tsx` deliberately skips it in the
  effect cleanup, because StrictMode's double teardown/setup would free the
  geometry the second setup goes on to use. The world lives as long as the page.
- No tests. The sim is pure enough to test headlessly (`stepRun` takes an
  `InputState`), and `Track` invariants — arc-length monotonicity, frame
  orthonormality — are worth pinning down.
