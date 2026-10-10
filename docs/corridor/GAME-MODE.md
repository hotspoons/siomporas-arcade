# Game mode

The viewer has two interfaces over the same page.

| | developer view | game view |
|---|---|---|
| top bar (hamburger, world picker, search, readout, buttons) | shown | hidden |
| lower-left widget | the waypoint arrow | the waypoint, the objective, the dashboard |
| Escape | closes what is open, leaves a race, then the menu | the menu |
| settings | the Settings dialog (tabs) | the Escape menu (screens) |

Both views share one settings store, one policy, one input map. Nothing is duplicated: the
Settings dialog and the Escape menu read and write the same fields, and both ask the same
`policy.allows(id)` before showing a tab or a control.

## Which view you get

Where a page starts (`resolveUiMode` in `src/gamepolicy.ts`):

1. `ui=game` or `ui=dev` in the address: `#<world>?ui=game` (`src/url.ts`; an old `?ui=game#<world>`
   link still works and is rewritten).
2. The player's remembered choice (`apex-corridor.settings.v1`, field `ui`).
3. Otherwise a **production build is a game**; the **dev server is a workbench**
   (`import.meta.env.PROD`).

After that the **Developer view** toggle in the Escape menu (or the dialog's **Interface**
select) is the player's, whatever the link said, and is remembered. A program that called
`api.ui.developer(false)` shows the game view and removes the toggle — unless the link said
`?ui=dev`, which is the developer's own hatch into a level that forbids it.

So a deployed world opens as a game. `just corridor-view` opens as the developer view it always
was. A link from the world editor that wants the developer view should carry `#<world>?ui=dev`.

## The Escape menu

`src/ui/gamemenu.ts`, on the engine's `MenuStack` (`packages/engine/src/app/Menus.ts`), the same
one Turbo Radrun, stuntin and conduit use. Screens are data; the menu asks a `GameMenuHost` for
each setting's getter and setter, and `main.ts` implements that host over the viewer's real
state.

```
Paused
  Resume
  Restart                     back to the start point; the program and the race from the top
  Abandon the race            only while one is on
  Leave the car / Drive       only while the policy allows transport
  Mute
  Levels ▸                    the world's other stages — only when it has more than one
  Settings ▸
    Display ▸                 season · style · relief · trees · weather · AA · perf · units · theme · hide interface
    Layers ▸                  every LAYER_GROUPS toggle
    Audio ▸                   mute · master · engine · interface
    Controls ▸                gamepad · rumble · recover repairs · one remap row per action · reset
    Tuning panel              opens F6
  Tuning panel
  Developer view              only while the policy allows it
```

Escape on a sub-screen steps back; on the root it resumes. Arrows and WASD move, Enter / Space /
A select, Backspace / B back, Start pauses. The menu pauses the world: the car, the traffic, the
physics, the program's clock and any preset tween stand still; the renderer and the sky keep
going, because the menu sits over the world.

## Settings, and the policy

The player's settings live in `src/gamesettings.ts` (`GameSettings`, an engine `SettingsStore`):

```ts
audio: { master, engine, sfx, muted }   // the engine bus gets ENGINE_MASTER × master × engine
keys, pad                                // bindings by action (below)
gamepad, haptics                          // the pad on/off, rumble strength 0..1
units: 'mph' | 'kmh'
ui: 'game' | 'dev' | null                // the player's choice of view
```

What a program may take away lives in `src/gamepolicy.ts` (`GamePolicy`). It is pure, so a
program's calls and the menus that read them are played in `test/gamepolicy.test.ts`.

The setting ids are a closed list — `SETTING_TABS` and `SETTING_CONTROLS` — so a program that
hides `display.thme` is an error in the editor and a toast in the viewer, not a control that
quietly stays. A tab id hides the tab and everything in it.

## The program API

```ts
export default defineGame({
  setup(api) {
    api.ui.mode('game')                       // this run is a game whatever the player chose
    api.ui.developer(false)                   // no way to the developer view from the menu
    api.ui.teleport(false)                    // the map's double-click does nothing
    api.ui.transport(false)                   // Tab, V, B and the menu's Drive/Leave the car do nothing
    api.ui.settings.hide('display', 'controls.reset', 'game.tuning')
    api.ui.settings.show('display')
    api.ui.hud.hide('gear')                   // speed · gear · heading · road · elevation · objectives · waypoint
  },
})
```

Everything defaults to on. Every restriction ends when the program stops (`policy.reset()` in
`stopProgram`). A dry run has no interface and every call is a no-op.

## Finishing

Rich, 2026-10-10: *"when the mission is complete we should have a finish screen that defaults to
showing the hero car or main character depending on game mode, along with a representation of
winnings (cash for our simple game), and an option to restart or exit to menu. This should all
have API hooks that are in the example game engine code in the editor."*

### What a program says

The score is the winnings — one number, not a second "money" beside the points:

```ts
api.score.currency('$')                 // money on the HUD and the finish screen; '' or null is points
api.score.add(20, 'Hits')               // a line of the breakdown; the same label again adds and counts
api.score.set(500, 'Time bonus')        // that line, exactly; with no label, the total exactly
api.award(7)                            // still works: score.add(7) with no label
api.score.get(); api.score.lines()      // 527; [{ label: 'Hits', amount: 20, count: 1 }, …]
```

And the run ends with a result:

```ts
api.finish({
  outcome: 'win',                       // default; 'lose', 'abandoned'
  title: 'Beltway cleared',             // default "Mission complete" / "Mission failed" / "Mission abandoned"
  text: 'Five appointments kept.',      // under the headline, and said on screen as the run ends
  winnings: { currency: '$', total: 2_310_000, lines: [{ label: 'Fees', amount: 2_150_000, count: 5 }] },
  stats: [{ label: 'Legs', value: '5/5' }, { label: 'Top speed', value: '142 mph' }],
  show: 'car',                          // 'character' | 'none'; absent: the car driving, the character on foot
  model: 'some-catalog-id',             // a library asset on the turntable instead
  screen: false,                        // this ending draws its own screen
})
api.on('finish', (r) => { /* r: FinishResult — everything the screen is about to show */ })
defineGame({ finishScreen: false, setup(api) { … } })   // never the app's screen for this program
```

`win(text)` and `lose(text)` are `finish({ outcome, text })`. Every field is optional; `winnings`
absent is the score as it stands (null when nothing was ever scored and no currency named),
`winnings: null` is "nothing worth a count-up". The first ending is the only one. A run the
program never ended — the level closed, a restart — is abandoned with no screen; an abandon gets
the screen only when the program says `finish({ outcome: 'abandoned' })`. The order is
`on('ends')` listeners, then `on('finish')`, then the app. A dry run (the editor's, a test's)
has no screen and nothing throws; the Program pane's dry-run report gains a "finish screen" line.

### What the player sees

`src/ui/finishscreen.ts`. The world is held still the way the menu holds it (the car, the traffic,
the physics, the program's clock), and the screen goes up: on the left the car **as it is on
screen** — the level's model, the build's paint, the run's dents — slowly turning on a turntable,
lit like the library's mesh viewer (room environment, key + rim, ACES for this pass only); on the
right a panel in the menu's own tokens with the headline, the program's line, the total counting
up (ease-out, 0.9–2.4 s, landing exactly — cents only when there are cents), the breakdown arriving
a row at a time ("Hits ×12 — $240"), the time and the program's stats, and the buttons:

- **Next stage** — only when the level names one for this outcome (`next`, `onFail`). A finish
  screen replaces the old automatic jump 1.4 s after the line; with no screen it still jumps.
- **Restart** — the Escape menu's own restart (`restartLevel`): back to the start point, the car
  straightened, the program's `setup` again on a fresh clock. Hidden by `ui.settings.hide('game.restart')`.
- **Exit to menu** — the Escape menu's root, over the world where the run ended. The root now
  has **Levels ▸** when the world has more than one stage (`game.levels` hides it).

Arrows / the stick move, Enter / Space / A / Start choose, Escape / Backspace / B is Exit. Nothing
can be chosen for the first 0.8 s (the handbrake is Space, and it is often held across the line);
the first press during the count-up finishes the count instead. A tall screen puts the panel along
the bottom and the turntable above it. The sting is synthesised on the interface bus (master ×
interface volume, silent when muted) — a rising arpeggio for a win, a falling one otherwise — because
the sound bank has crashes, guns and tyres and nothing that sounds like an ending.

With no car anywhere (flying from the start of a carless level) `show: 'car'` falls back to the
figure. The figure is a stand-in mannequin: the library's actors are unrigged and on foot is a
camera, so there is no player character model yet — `model:` puts any library asset there.

### What it costs

The world is **not drawn** while the screen is up. The frame the run ended on is drawn once more
and copied off the canvas into a sixth-size texture in the same task (before the browser presents
it, so no `preserveDrawingBuffer`); after that each frame is two passes on the app's own renderer
— that copy blurred and darkened in one 25-tap full-screen quad, then the turntable. Measured on crofton-triangle with `probes/corridor-finish.mjs` (headless, software
GL — the agent box has no GPU, so these are counts and relative times, not a real card's
milliseconds):

| | draw calls | triangles | frame interval p50 / p95 (SwiftShader) |
|---|---|---|---|
| the world, driving | 150 | 3,176,197 | 1,433 / 10,683 ms |
| the finish screen, the default car | 30 | 948 | 450 / 4,050 ms |
| the finish screen, the figure | 13 | 2,340 | — |

One full-screen quad (25 taps on a sixth-size texture) and the subject is a rounding error on any
real card; what is left of the frame under the screen is the CPU work the paused world still does
(the tile and tree pumps). The one-off costs are on the frame the screen opens: the copy
(`drawImage` of the canvas, a few ms), the room environment (one PMREM, made once per page), and
the turntable's shader programs, compiled with `compileAsync` before the swap so they are not a
hitch — the world keeps drawing, held still, until they are ready (1.5 s at most).
A CSS `backdrop-filter` over the live world was the alternative: it keeps paying for the world
every frame and blurs the car with it.

### Probing it

```
PORT=5198 OUT=/tmp/shots node probes/corridor-finish.mjs [slug]
```

The probe serves its own level and program by route (nothing is written to a world editor), and
checks the screen is hidden until the finish, the count-up lands on the reported total, the world's
draw calls stop, the turntable turns, the keys move and choose, Restart is a second `setup` on a
fresh clock, Escape lands on the menu's root with Levels, and `'character'` (asked for, and by
default on foot) puts the figure up. From a console or a bridge: `corridor.finish` — `open`,
`result`, `buttons`, `choose(id)`, `draws`.

## The map's double-click

Double-clicking the inset map (or the full-screen map) drops the car on the nearest road to that
spot, facing along it — the same gradient step the search box and "drive here" take. If you were
flying you are driving now; the full-screen map closes so you can see where you landed. The
button, N and Escape still grow and shrink the map. `api.ui.teleport(false)` turns it off.

## Keys, the gamepad, rumble

`src/gameinput.ts`. The keyboard's hotkeys still arrive by DOM event, but through
`input.actionOf(code)` — so a key rebound in the menu changes what the keydown switch does. The
pedals, the sticks and the menu edges are polled once a frame.

Rebindable actions (`gamesettings.ts` `ACTIONS`): throttle, brake, steer left/right, handbrake,
drive (Tab), recover (R), lights (L), camera (C), map (N), fire (M from the seat), craft (V),
walk (B), interface (M from the air), pause (Escape), confirm (Enter). P, H, X, F6, F7 and
Shift+R stay fixed — they are the developer's.

Default pad (standard mapping): RT / LT pedals, left stick steers, A handbrake, B out of the car,
X recover, Y camera, LB next craft, RB fire, Select lights, Start pause, LS-click the map. In the
air the left stick moves, the right stick looks, the triggers climb and descend.

Rumble (`@apex/engine/input/Haptics`): a bump, the grass, and the player's own impacts scaled by
the peak contact impulse (6 kN·s is "all of it"). Strength is the Rumble slider.

## Audio

The engine bus is `ENGINE_MASTER` (a world knob, a preset may carry it) × the player's master ×
engine. The player's mute is combined with the tab-hidden mute, never replaced by it: focus
coming back must not unmute somebody who asked for silence (`EngineSound.setUserAudio`). The
menu blips (`src/ui/uisound.ts`) sit on master × interface.

## Probing it

```
PORT=5185 node probes/corridor-gamemode.mjs [slug]
```

and from the console or a bridge: `corridor.chrome` — `mode`, `set(mode)`, `policy`, `settings`,
`input`, `menu`, `hud`, `pause()`, `resume()`, `paused`, `teleport(x, y)`.
