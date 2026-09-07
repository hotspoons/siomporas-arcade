# Decisions

Places where the implementation deliberately departs from the engineering
handoff, or where the handoff left a choice open. Newest last.

1. **npm + oxlint, not pnpm + ESLint.** Both were already wired into the dev
   container and CI. Vitest was added as specified. Zero gameplay impact.
2. **`noUncheckedIndexedAccess` is off.** The sim is typed-array arithmetic in
   hot loops; the flag turns every `table[i]` into `number | undefined` and the
   code into a wall of `!`. `strict`, `noUnusedLocals/Parameters` stay on.
3. **The 2D chase camera follows theta fully (with lag).** The owner explicitly
   likes "down is relative" — the wall you ride is always screen-down. The
   handoff's "partial roll follow" is applied only to the craft's *bank* into
   turns (`CAM_BANK_FOLLOW`). In XR the up vector defaults to world-stable
   (`VR_ROLL_BLEND = 0`) as the handoff demands, exposed as a setting.
4. **Air gravity scales with (speed / GAP_DESIGN_SPEED)².** At 240–500 m/s a
   fixed 22 m/s² makes the arc shape wildly speed-dependent: an 8° ramp at full
   throttle is a 2 km flight, and a slow craft undershoots by tens of metres.
   Scaling g keeps every craft on the authored arc; speed only changes how fast
   the gap is crossed. Jumps are now deterministic and fair, rings line up.
5. **Air control is lift/strafe acceleration, not velocity rotation.** Rotating
   the velocity vector 0.8 rad/s at 400 m/s ruins any landing in a fraction of
   a second, and `W` is both throttle and air-pitch per the handoff's bindings.
   Lift is ±30 % of g, strafe is 30 m/s²; a soft spring recentres un-steered
   flights laterally. Clipping the receiving lip by up to 9 m is a harsh landing,
   not a death.
6. **GAP centrelines are the design ballistic arc.** The builder integrates the
   arc at `GAP_DESIGN_SPEED` from the entry pitch, so geometry, rings and the
   flight agree; `levelOut: true` on the next segment pitches back to level.
7. **Open profiles level themselves.** Parallel-transport frames drift; for
   HALFPIPE/OPEN/BERM/GAP/SPLIT the floor is steered toward world-down (fading
   out when the track goes vertical), TUBEs carry authored banking on top, and
   the whole roll signal is unwrapped and box-filtered over 140 m so nothing
   snaps. Gravity in flight is world -Y, so this is what makes jumps possible.
8. **Splits.** The trunk spline bends left, a second spline bends right, both
   parameterised over the split's arc length (branch 1 by proportion). Entry
   commits by `sin(theta) > 0` → right. Both branches are level tubes sharing
   a floor so theta carries across.
9. **Timer: 20 s start / +8 s per gate (spec: 60 / +20).** At 313 m/s a gate
   every ~1 km is ~3 s; the spec values made the clock decorative.
10. **Circuit mode.** A 12–16 km course is 45–60 s at these speeds — the owner
    wanted 3–5 minute runs. Rather than author 60 km of tunnel, the circuit
    chains all courses with score and remaining time carried over. Single
    courses remain playable and are where ghost replays live.
11. **The prototype's "hop" is gone.** The handoff has no jump button; blockers
    are shot or dodged around theta.
12. **Dev bridge kept and extended.** `just bridge-dev` exposes `window.__apex`
    with a `screenshot()` helper; `scripts/probe.mjs` drives headless Chromium
    on SwiftShader for render/regression checks. Neither reaches a build.
13. **Head-tracked turret not built.** Listed as optional/advanced in the
    handoff; the setting exists in `Settings` but is not surfaced or wired.
14. **Homage, not replica.** After the owner asked for more of the original's
    flavour, the craft became a red rocket-bike (rider in a tuck over a tank,
    angular shell, second seat, twin roof cannons, shield plates on the flanks
    that dim with the shield) and six vehicle types were added (transit train,
    indestructible light-cycles with ribbons, hauler, swarm, turret, spinner).
    Course 4 "Cloverleaf" borrows the *vocabulary* the original's level names
    describe publicly — banked lobes, narrow flats, tunnel under construction,
    branching — from written descriptions only. No layout data, art or audio
    from the original was viewed or used; everything remains authored here.
15. **You can't wreck.** Per the owner (and the original): an empty shield plus
    a hit is a spin-out — most of your speed and a second or two of control —
    never game over; leaving the track (missed landing, over an edge) drops you
    back on the surface minus `OFFTRACK_TIME_PENALTY`. Only the clock ends a run.

## Type (2026-09-07)
S.T.U.N. Runner / Tron: Audiowide for titles and messages, Orbitron (variable) for numerals, Rajdhani 500–700 for body, Press Start 2P for the arcade credit line. Bundled in `public/fonts` (OFL); `scripts/fetch-fonts.mjs` regenerates the latin woff2 subsets and license file.
