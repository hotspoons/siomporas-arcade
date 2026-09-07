# Milestone log

Status as of 2026-09-07, one autonomous pass from the engineering handoff.
"Verified" means observed running; the two environments differ:

- **headless** — Playwright Chromium on SwiftShader inside the dev container
  (`just probe`, `just smoke`): correctness and rendering, ~25 fps, useless for
  perf numbers.
- **host GPU** — the owner's Chrome attached through `just bridge-dev`. Not yet
  re-attached since the rewrite (the tab needs a reload), so **no real-GPU
  observation has happened yet.** Everything below marked *unverified on GPU*
  needs that.

## M0 — Skeleton ✅
Fixed-step loop (120 Hz sim, `MAX_SUBSTEPS` clamp, retro present cadence by
render skipping), `SimSnapshot` double buffer with interpolation, settings in
localStorage, F3 perf overlay (frame graph, ticks/frame, draws, tris, chunks,
heap), URL params `?style=retro`, `?perf=1`.

## M1 — Tunnel + movement ✅ (feel unverified on GPU)
`TrackSpline` (2 m arc-length table, parallel transport + smoothed roll),
`TrackBuilder`, `Track`, chunk pool (200 m, 12 ahead / 3 behind, in-place
rewrite, branch chunks), vehicle ground motion, chase camera, keyboard +
gamepad, test course. Tests: uniform arc length, orthonormal frames with no
twist, round-trip projection, input-tape determinism.
**Open:** the go/no-go "does it feel fast and controllable" call needs a human
on a real GPU. Tune `THETA_ACCEL`, `THETA_DAMP`, `CAM_THETA_LAG`, `FOV_*`.

## M2 — Combat ✅
Laser (heat, lock, soft auto-aim cone, roof-mounted beam), shockwave (charges,
radius clear, invuln, slow-mo request), shield (regen, gate restore, pods),
swept capsule collision in (s, lateral), DRONE/BLOCKER/MINE (chain reaction),
deterministic cell spawner, timer + gates, score/combo/streak charges, HUD with
peripheral shield rim. Verified headless: 22 kills / 7 k points in a 9 s run.

## M3 — Full track vocabulary ✅
HALFPIPE, OPEN, BERM_IN/OUT, GAP (speed-normalised flight, rings, undershoot
tolerance, centring assist), SPLIT (two branches, traffic mirrored), fall off
an OPEN edge (hold into the lip for 0.35 s), boost strips (baked per-vertex,
scrolling chevrons), sky dome + starfield, `tools/preview.html` top-down +
side elevation. Course 01 "Meridian Line" ~12.3 km. Tests: every jump lands at
cruise / full throttle / nose-up / nose-down / minimum speed; every course is
completable hands-off.

## M4 — Dual aesthetics ✅ (unverified on GPU)
`StyleManager` role is played by `RenderWorld.setStyle` + `Game.applyStyle`.
Modern: HDR composer, radial motion blur (own pass), bloom, chromatic
aberration, vignette, grain, ACES, SMAA. Retro: 320×240 nearest target,
posterise + Bayer dither, scanlines, barrel, phosphor bleed, flat facets via
derivatives, 12-segment rings, vertex snapping, 20/30/60/uncapped present, a
"clean retro" preset. F2 toggles mid-run; both reachable from menus.

## M5 — VR ⚠️ code-complete, unverified
Session lifecycle (`local-floor`, foveation), cockpit frame, in-world canvas
HUD, acceleration-driven vignette, three comfort presets (Maximum also scales
`SPEED_MAX` and the aim cone through `SimParams`), controllers as an input
source, haptics, world-stable up with `VR_ROLL_BLEND`, post/CRT/cadence/FOV
kick all forced off in XR in code. **No headset and no GPU in the container**:
never entered a session. Head-tracked turret not built.

## M6 — Content and meta ✅ (audio unverified by ear)
Three courses of escalating difficulty plus the proving run, INTERCEPTOR /
ARMORED / GATE_BOSS, circuit mode, menus (title, pause, settings, controls
with live remap, records, summary), local leaderboards, best-run input tape
with ghost craft replay (single-course mode), procedural audio (engine, reverb
by openness, weapons, impacts, tempo-linked music, limiter, mute on blur).

## M7 — Hardening ◐
Done: shader pre-warm behind a loading card, WebGL context-loss pause/restore,
error boundary overlay, reduced motion, colour-vision hazard palette, HUD scale,
`just check` = lint + tsc + vitest, CI runs tests + build.
Not done / unverifiable here: perf budgets on RTX 3060 / Iris Xe / Quest 3,
DevTools allocation profile (known per-frame closures removed; headless heap
grew 3.8 MB over 19 s including menus and HUD strings — inconclusive), browser
matrix (only Chromium), gamepad on real XInput/DualSense, accessibility pass
beyond the above.

## Mobile (owner request, overrides the handoff's non-goal) ✅
`TouchSource`: tilt steering from `devicemotion` gravity (orientation-aware,
neutral calibrated at run start, iOS permission prompt in the start gesture),
hot zones for thrust/brake/fire/shockwave/pause, drag fallback, fullscreen +
landscape lock, portrait "rotate" card, lighter post defaults and a 1.5
pixel-ratio cap on first run. Verified in emulated Chromium touch over the
tunnel; **tilt never tried on a real phone** (emulation has no sensors).
`just tunnel` gives an anonymous HTTPS URL for that.

## Owner pass 2 (same day) ✅
- **Laser sound** rebuilt as a continuous beam (detuned saws + whine through a
  sine-swept resonant lowpass) — the square-wave gated version "yapped".
- **Craft** redesigned: red angular rocket-bike, rider tuck, passenger seat,
  twin cannons, flank shield plates that fade/flicker with the shield.
- **Six new vehicle kinds** (12 hostile total): TRAIN (6-car transit line, one
  agent / many bodies, horn + HUD warning, indestructible), LIGHTBIKE
  (indestructible weaving cycle with a light ribbon; shockwave shoves it),
  HAULER (drops a shield pod), SWARM (formation of four), TURRET (static gun),
  SPINNER (bar sweeping the tube). Auto-aim ignores indestructibles.
- **Course 4 "Cloverleaf"**: four banked lobes, construction gaps in closed
  tubes, narrow flats, split, transit line. Circuit order is now 1 → 2 → 4 → 3.

## Tuning changes from the handoff table (§9)
| Constant | Spec | Now | Why |
|---|---|---|---|
| `TIMER_START` | 60 | 20 | clock was decorative |
| `TIMER_GATE_BONUS` | 20 | 8 | same |
| `G_AIR` | 22 | 22 × (v/235)² | speed-independent arc (DECISIONS #4) |
| `AIR_PITCH_AUTHORITY` | 0.8 rad/s | `AIR_LIFT_AUTHORITY` 0.3 g | DECISIONS #5 |
| `AIR_YAW_AUTHORITY` | 0.5 rad/s | `AIR_STRAFE_AUTHORITY` 30 m/s² | DECISIONS #5 |
| `LAND_TOLERANCE` | 3 | 3 (+ `LAND_UNDERSHOOT` 9) | lip clips are harsh, not fatal |
| new | — | `GAP_DESIGN_SPEED` 235 | just under `SPEED_MIN` |
| new | — | `THETA_VEL_MAX` 3.4 rad/s | cap in wide tubes |
| new | — | `COLLISION_SPEED_KEEP` 0.72, `COLLISION_SPIN_TIME` 0.7 | owner: slow + spin, never stop |
| new | — | `SCRAPE_SHIELD_PER_SEC` 6, `ENEMY_SHOT_SHIELD_COST` 12 | |
| new | — | `KILL_STREAK_FOR_CHARGE` 8, `COMBO_STEP` 0.25, `COMBO_MAX` 4 | |
| `RING_SPACING` | — | 4 m rings, ribs every 20 m | speed legibility |
| `FOG_DENSITY` | — | 0.0011 modern / 0.0016 retro | |
Everything else is at the spec's starting value.

## Deferred / open for the owner
- Play it on the host GPU and tune feel (M1 gate).
- VR validation on Quest 3 / SteamVR.
- Course length vs run length: circuit mode is the current answer.
- Name, art direction beyond neon-on-dark (palette hue per course is a knob).
