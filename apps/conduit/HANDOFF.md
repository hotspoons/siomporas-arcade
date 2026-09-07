# APEX CONDUIT — handoff

For the next agent or human picking this up. Read [MILESTONE.md](MILESTONE.md)
first for status, then [DECISIONS.md](DECISIONS.md).

## State (2026-09-07)

The React/R3F prototype was replaced wholesale with the architecture in the
engineering handoff: a deterministic `src/sim` (no three.js) ticking at 120 Hz,
a three.js renderer reading interpolated snapshots, DOM HUD/menus, procedural
audio, two visual styles, and a WebXR mode. Three courses plus a proving run.
24 unit tests, lint and typecheck clean, `vite build` clean.

| Thing | Status |
|---|---|
| Sim: track, vehicle, traffic, combat, spawner | done, unit-tested, deterministic |
| Renderer, modern + retro styles, HUD, menus | done, verified in headless Chromium |
| Audio | done, **never heard** (container has no audio) |
| Gamepad | done, **never held** (no pad here) |
| VR | code-complete, **never entered** (no headset) |
| Real-GPU look and feel | **not yet observed** — see below |
| Mobile touch/tilt | done, verified in emulation; tilt untested on a real phone |

### The one thing to do first

Reload the host browser tab on `http://localhost:5180` with `just bridge-dev conduit`
running, then play. The bridge was attached before the rewrite and never
re-attached. Every visual judgement so far was made from SwiftShader
screenshots at 960×540 — bloom width, line thickness and the steering feel
all need eyes on a real GPU. `just bridge 'apex.screenshot()'` returns a JPEG
data URL of the live frame; `apex.snap`, `apex.world`, `apex.settings`,
`apex.loop.stats`, `apex.view.stats` are live.

### Remote testing

`just tunnel` prints an anonymous `https://…trycloudflare.com` URL (also in
`.tunnel-url`); phones opened on it attach to the bridge like any tab.

### Working agreement (unchanged)

No tooling on the macOS host. Browsers and Playwright live in the container.

## Architecture in five lines

- `SimWorld.tick(dt, InputFrame, SimSnapshot)` is the whole game. Seeded RNG,
  `hash2(seed, cell)` spawns, no `Math.random`, no allocation in steady state.
- Track space is `(s, theta, lift)`; `Track.frameAt(s, branch)` is the only way
  anything becomes world-space. Collision is analytic in track space, never
  against meshes.
- `Game` (app) owns flow; `GameLoop` runs fixed ticks and interpolated renders;
  retro's 20 Hz is render-skipping, the sim never slows.
- `RenderWorld` owns the scene; a `Style` owns presentation. Both styles share
  geometry and swap at runtime (`F2`).
- `XrSession.applyState()` is the single place XR-vs-flat rules are enforced.

## Workspace

On 2026-09-07 the repo became a workspace: this app moved to `apps/conduit`,
the reusable runtime to `packages/engine` (`@apex/engine/*` imports), and a
second game started in `apps/drivin`. Both are meant to split into their own
repos later; nothing in `packages/engine` may import from an app.

## Known rough edges

- Steering/camera feel constants (`THETA_*`, `CAM_*`, `FOV_*`) are the spec's
  starting values, untuned by hand.
- The tunnel exterior (seen from open air) is a plain dark hull.
- Ghost replay only in single-course mode; the tape is per (course, seed), so
  a ghost appears only when the seed repeats (`Restart` reuses the seed).
- Allocation audit: closures removed, but the DevTools allocation profile
  (M7) has not been run.
- `Settings.vr.headTurret` exists but nothing reads it.
- Retro vertex snapping uses the 320×240 grid regardless of the chosen
  internal resolution.

## Where to take it next

1. Real-GPU play-test → tune M1 feel → then everything else.
2. VR on Quest 3: `ENTER VR` on the title menu when `navigator.xr` supports it.
3. Perf pass against §8 budgets with the F3 overlay.
4. Lock the name; find-and-replace `APEX CONDUIT` / `apex-conduit`.
