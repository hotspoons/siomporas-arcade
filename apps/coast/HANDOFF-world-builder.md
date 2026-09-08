# Handing over the COASTLINE world builder

For whoever merges this into `main`. Written 2026-09-08 from the worktree
`.claude/worktrees/coast-editor`, branch **`worktree-coast-editor`**, two commits on top of
`a8e09be`:

```
f5d2b7e  Coast: a world builder — plan-view tracks, vibes that shift mid-stage, track sets
ac81e6a  Coast: hills the car can climb, edits that survive a reload, and menu rows that fit
```

Read `DECISIONS.md` (the last three sections) before changing anything under `src/world/`.
`README.md` has the user-facing controls; `MILESTONE.md` has what is and is not done.

## What it is

`WORLD` on the title screen picks what the run drives: the built-in coast-to-coast route, or a
track set the player built. `BUILD A WORLD` opens an editor with a set view (tracks as boxes,
wired into a directed route with forks that can rejoin) and a track view (one centreline laid
out in real metres as a poly-Bézier through waypoints with handles), plus a profile strip for
the hills and a timeline strip for scenes, vibes, macro elements and placed props.

## First: it does not touch `packages/engine`

```
git diff --name-only a8e09be..HEAD -- packages/     # empty
```

Everything is inside `apps/coast`, plus one `justfile` recipe and one new script. That was
deliberate — the engine was being rewritten in the main checkout while this was built.

**A trap worth knowing about:** a worktree under `.claude/worktrees/` has no `node_modules` of
its own, so `@apex/engine` resolves up to the *main* checkout's `packages/engine`. Worktrees
do not isolate the engine. While this was being built, coast oscillated between running and
paused after a single Escape press, which turned out to be a half-finished `frameEdges` set in
the main checkout's `KeyboardSource.ts` — not this branch. `just editor-smoke` therefore
leaves the editor with the Menu button rather than Escape. If that keyboard work has landed
and settled, switch that check back to `page.keyboard.press('Escape')`; if Escape still
latches, that is the thing to fix, and it affects the whole game, not just the editor.

## The merge surface

Eleven new files, sixteen modified. The new ones are self-contained:

```
src/world/types.ts      the authored world (tracks, stops, spans, props) + checkWorld
src/world/path.ts       the centreline: Bézier spans, arc-length sampling, gradient limits
src/world/compile.ts    CoastTrack → Segment[] (the only file that knows the mapping)
src/world/scenes.ts     15 scenes, broken out of the existing THEMES
src/world/vibes.ts      11 vibes + blending; night and rain as amounts
src/world/Route.ts      RouteSource: what the sim asks a world for
src/world/builtin.ts    tracing the shipped route into waypoints
src/world/WorldStore.ts localStorage-backed worlds
src/editor/Editor.ts    the editor (set view, plan view, both strips) — 2.7k lines, one file
test/world.test.ts      39 unit tests
scripts/editor-smoke.mjs  22 pointer-level checks against a running dev server
```

The modified ones, and what to watch for in each:

| File | Change | Conflict risk |
|---|---|---|
| `sim/Road.ts` | `Segment.scene`; `blankSegment()`; `Stage` gained `scenes`, `vibes`, `themeAt()`, `fractionAt()`, a `theme` getter, and an optional `StageParts` constructor arg for pre-compiled stages. Also **one behaviour fix**: a landmark no longer gets built in the sea on a shoreline segment. | low |
| `sim/Sim.ts` | Reads a `RouteSource` instead of importing `STAGES`/`THEMES`. Constructor is `(seed, startId, world = BUILTIN_ROUTE)`. Traffic asks `stage.themeAt(z)` for `oncoming` so a scene change mid-track works. New `nightAmount`/`rainAmount`. | low |
| `sim/Snapshot.ts` | `night` and `rain` floats. | low |
| `render/RenderWorld.ts` | The big one. `setStage` no longer reads `THEMES`; a new `refreshLook(z)` resolves palette + night + rain + fog per frame; `night` became `nightAmt` (an amount) through the road pass, `brightAt` and the sprite glow; lanes and rails are read per row from `stage.scenes[seg.scene]`. | **high** — see below |
| `render/Background.ts` | Split `setPalette` (re-bakes the canvas layers, keyed) from a new `setSky` (uniforms only, safe per frame). Stars fade in with `uNight` instead of switching at 0.5. | medium |
| `render/Rain.ts` | `enabled: boolean` → `intensity: 0..1`. | low |
| `render/RenderTuning.ts` | Two palettes appended (`suburb`, `industrial`). | low |
| `app/Game.ts` | `WorldStore`, an `Editor`, `route: RouteSource`, `state: 'editor'`, `openEditor` / `closeEditor` / `applyWorld` / test-drive-from-editor, and the weather nags now follow `curr.rain` / `curr.night` instead of theme flags. | **high** — this file was being edited in parallel |
| `app/menus.ts` | `WORLD`, `BUILD A WORLD`, `BACK TO THE EDITOR`; `START AT` reads a live array so switching world refills it without bouncing the cursor; subtitle no longer names the world. | **high** — same reason |
| `app/Settings.ts` | `world: string` (default `'builtin'`). | low |
| `style.css` | An editor block appended, plus a menu-row fix: a long value was squeezing the label column to one word per line. | medium |
| `justfile` | `just editor-smoke [port]`. | low |

### `RenderWorld.ts` and `Game.ts`

These two carry almost all the risk. If they conflict, take **this branch's structure** and
re-apply the other side's changes on top, rather than the reverse:

- In `RenderWorld`, the whole point is that `night`, `rain` and `silhouette` stopped being
  booleans read off a theme and became amounts resolved per frame. A merge that reinstates
  `Boolean(theme.night)` anywhere will silently kill the vibe crossfade — the thing the
  feature is for. Grep for `nightAmt`, `silAmt`, `rainAmt`, `refreshLook`, `sceneBase`.
- In `Game`, the editor owns the frame while `state === 'editor'`: `beginFrame` returns early
  after `input.poll`, and `simTick` and `render` return immediately. Keep that early return
  above the tune-panel and style-toggle handling, or F6 will fight the editor's own keys.

## The invariant that matters most

**The shipped route must look and drive exactly as it did.** A `Stage` with no vibe stops takes
its theme's palette verbatim and never goes near `paletteFor`, which is how the hand-picked
look of the thirteen stages survives night and rain becoming continuous. The existing
`coast.test.ts` (unchanged, still passing) covers the route tree, determinism, checkpoints and
a full autopilot run. If you change anything in `refreshLook`, check that first.

Verify the whole thing:

```bash
npx tsc -b && npx vitest run && npm run lint     # 90 tests
just dev coast                                    # then, in another terminal:
just smoke coast                                  # the base game still plays
just editor-smoke                                 # 22 checks: build a track, save, reload, drive
```

`just editor-smoke` is the only coverage the editor's pointer handling has, and it is the
check to run after any merge into `Editor.ts`. It builds a track from nothing with a real
mouse, bends it by its handles, places a prop / scene / two vibes / an ocean front / a
crossroads, drags a waypoint into a cliff and confirms it is refused, undoes, smooths, forks
into a second track, saves, reloads the page mid-edit and recovers the draft, then drives both
the new world and the built-in one. It fails on any console message.

## Things to decide, not merge

1. **The plan view is honest about how gentle these roads are.** `curve = Δheading ×
   SEG_LENGTH / CURVE_UNIT` puts a 1.4 km-radius sweeper at curve 3, which is where the
   hand-authored stages already sit — so a real OutRun stage is a near-straight road with a
   gentle meander, and you cannot draw a recognisable bay or hairpin at true scale. Corners
   under 800 m must be braked for, under 470 m they are opened out (painted amber and red,
   and `◡ Smooth` fixes them). If drawing a *shape* matters more than the 1:1 truth, a
   per-track curvature exaggeration is the one knob to add. Rich's call.
2. **`Downtown` (stage F3) is unreachable in the shipped route.** `E2.next` is `['F2']` only,
   though the comment beside it says it forks through downtown. The editor surfaces it as
   "nothing leads here from the start". Left alone here because it changes the live route.
3. **Nothing has been played on a real GPU or a real keyboard.** Hit radii, palette widths and
   the plan view's usability were all chosen headlessly. Expect a tuning pass.
4. **Traffic and the clock are still global.** `TIME_START` is 75 s and each checkpoint adds
   62, so a short authored track finishes before the clock has said anything; the compiler
   warns under 30 s but cannot fix it. Per-track overrides are the obvious next thing.
