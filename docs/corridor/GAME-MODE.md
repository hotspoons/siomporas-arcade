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

1. `?ui=game` or `?ui=dev` in the URL.
2. The player's remembered choice (`apex-corridor.settings.v1`, field `ui`).
3. Otherwise a **production build is a game**; the **dev server is a workbench**
   (`import.meta.env.PROD`).

After that the **Developer view** toggle in the Escape menu (or the dialog's **Interface**
select) is the player's, whatever the link said, and is remembered. A program that called
`api.ui.developer(false)` shows the game view and removes the toggle — unless the link said
`?ui=dev`, which is the developer's own hatch into a level that forbids it.

So a deployed world opens as a game. `just corridor-view` opens as the developer view it always
was. A link from the world editor that wants the developer view should carry `?ui=dev`.

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
