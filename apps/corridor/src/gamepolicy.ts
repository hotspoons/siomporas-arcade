// What the player is allowed to do with the interface, and which interface they get.
//
// Rich, 2026-09-30: a GAME MODE that is "the default deployment style" — no hamburger, no world
// picker, no search box, no readout in the bar, no buttons in the corner — with an Escape menu,
// settings folded into it, and a way back to the developer view "which is the current default,
// but make this disableable via the game script". The map's double-click teleport and the
// transport switch are "similarly disableable", and "make an API where we can turn off whole
// tabs or individual controls from the settings view accessible from the game script".
//
// So this file is the POLICY: a handful of booleans and a set of hidden setting ids, with no DOM
// in it, so a program's `api.ui.*` calls and the menus that read them can be played in a test.
// The viewer (`main.ts`) applies it; the game menu (`ui/gamemenu.ts`) and the developer dialog
// (`ui/viewer.ts`) both ask `allows()` before showing a tab or a control, which is what keeps the
// two views agreeing about what a level has switched off.

/** the two interfaces: the developer's chrome, or the game's HUD and Escape menu */
export type UiMode = 'game' | 'dev'

/**
 * Which interface a page STARTS in.
 *
 *   `?ui=game` / `?ui=dev`   the link decides: nobody types it by accident
 *   the player's choice      the Developer view toggle in the Escape menu, remembered
 *   the deployment           a production build is a game; the dev server is a workbench
 *
 * Only the start: the toggle is the player's afterwards, whatever the link said. The program's
 * `api.ui.developer(false)` does not appear here because it is not a choice of mode: it removes
 * the OPTION, and `main.ts` shows `game` while it is gone (unless the link said `?ui=dev`, the
 * developer's own hatch).
 */
export function resolveUiMode(o: { param: string | null; stored: UiMode | null; prod: boolean }): UiMode {
  if (o.param === 'game' || o.param === 'dev') return o.param
  if (o.stored === 'game' || o.stored === 'dev') return o.stored
  return o.prod ? 'game' : 'dev'
}

/**
 * The settings, as ids a program can name. A TAB is `display`; a CONTROL is `display.theme`.
 *
 * A CLOSED LIST, for the reason `HIDEABLE` is one: a program that hides `display.thme` must be an
 * error in the editor, not a control that quietly stays on screen. Both renderers of the settings
 * — the Escape menu and the developer dialog — key their tabs and controls by these same ids.
 */
export const SETTING_TABS = {
  display: 'season, style, relief, trees, weather, rendering, theme',
  layers: 'what is drawn: imagery, trees, buildings, furniture and the rest',
  audio: 'volumes and mute',
  controls: 'key and pad bindings, haptics, what R does',
  site: "the developer's readouts about the bake (developer view only)",
  game: 'the Escape menu itself: the tuning panel and the developer view',
} as const
export type SettingTab = keyof typeof SETTING_TABS

export const SETTING_CONTROLS = {
  'display.season': 'the season selector',
  'display.style': 'the style (realistic, fantasy, …)',
  'display.relief': 'terrain exaggeration',
  'display.trees': 'which trees to draw',
  'display.weather': 'the weather selector',
  'display.perf': 'the performance stats panel toggle',
  'display.aa': 'anti-aliasing',
  'display.theme': 'dark or light chrome',
  'display.interface': 'the hide-the-interface toggle (M)',
  'display.units': 'mph or km/h',
  'layers.imagery': 'aerial imagery', 'layers.horizon': 'far hills', 'layers.canopy': 'canopy blanket',
  'layers.trees': 'trees', 'layers.splats': 'captured worlds', 'layers.grass': 'grass', 'layers.rocks': 'rock', 'layers.water': 'water',
  'layers.road': 'the road', 'layers.structures': 'bridges and overpasses', 'layers.barriers': 'barriers', 'layers.sidewalks': 'sidewalks', 'layers.parking': 'parking',
  'layers.buildings': 'buildings', 'layers.power': 'power lines', 'layers.furniture': 'street furniture', 'layers.signals': 'signals', 'layers.stopbars': 'stop bars', 'layers.blades': 'street-name blades',
  'layers.spine': 'the centreline overlay', 'layers.markers': 'the photo-station markers', 'layers.wire': 'wireframe',
  'audio.master': 'master volume',
  'audio.engine': 'engine volume',
  'audio.sfx': 'interface and effects volume',
  'audio.mute': 'the mute toggle',
  'controls.bindings': 'the rebinding rows',
  'controls.gamepad': 'the gamepad on/off toggle',
  'controls.haptics': 'rumble strength',
  'controls.recover': 'whether R also repairs the car',
  'controls.reset': 'reset bindings to the defaults',
  'game.tuning': 'the tuning panel (F6) entry',
  'game.developer': 'the developer view toggle',
  'game.restart': 'restart from the start point',
  'game.transport': 'the drive / fly switch in the menu',
  'game.physics': 'the physics world: the world’s default, or on, or off',
} as const
export type SettingControl = keyof typeof SETTING_CONTROLS
export type SettingId = SettingTab | SettingControl

export const SETTING_IDS: readonly SettingId[] = [
  ...(Object.keys(SETTING_TABS) as SettingTab[]),
  ...(Object.keys(SETTING_CONTROLS) as SettingControl[]),
]

/** the pieces of the game HUD a program may switch off one at a time */
export const HUD_PARTS = {
  speed: 'the big number',
  gear: 'the gear and the rev counter',
  heading: 'the compass',
  road: 'the name of the road',
  elevation: 'height above the datum',
  objectives: 'the goal, the score and the last few messages',
  waypoint: 'the arrow to the next waypoint',
} as const
export type HudPart = keyof typeof HUD_PARTS

/** the freedoms a program may take away — each defaults to ON (Rich: "default these to on") */
export type Freedom = 'developer' | 'teleport' | 'transport'

export class GamePolicy {
  /** the Developer view toggle is offered, and `?ui=dev`'s stored counterpart honoured */
  developer = true
  /** a double-click on the map drops the car there */
  teleport = true
  /** Tab, V, B and the Fly button: the player may change how they get about */
  transport = true
  readonly hud: Record<HudPart, boolean> = { speed: true, gear: true, heading: true, road: true, elevation: true, objectives: true, waypoint: true }
  private readonly hidden = new Set<SettingId>()
  /** ids a program named that are not on the list — surfaced, never silently ignored */
  readonly unknown: string[] = []
  /** told when anything changes, so the open menu and the dialog can redraw */
  onChange: (() => void) | null = null

  allow(what: Freedom, allowed: boolean): void {
    this[what] = !!allowed
    this.onChange?.()
  }

  /** hide settings by id. A tab id hides the whole tab; a control id hides one row. */
  hide(...ids: string[]): void {
    for (const id of ids) {
      if ((SETTING_IDS as readonly string[]).includes(id)) this.hidden.add(id as SettingId)
      else if (!this.unknown.includes(id)) this.unknown.push(id)
    }
    this.onChange?.()
  }

  show(...ids: string[]): void {
    for (const id of ids) this.hidden.delete(id as SettingId)
    this.onChange?.()
  }

  /**
   * May this tab or control be shown? A control is also hidden when its tab is: `display.theme`
   * goes with `display`, which is what "turn off whole tabs" has to mean for the menu that draws
   * a tab as a screen and for the dialog that draws it as a strip.
   */
  allows(id: string): boolean {
    if (this.hidden.has(id as SettingId)) return false
    const dot = id.indexOf('.')
    if (dot > 0 && this.hidden.has(id.slice(0, dot) as SettingId)) return false
    return true
  }

  setHud(part: HudPart, on: boolean): void {
    if (part in this.hud) this.hud[part] = !!on
    this.onChange?.()
  }

  /** what the program hid, for the probe surface */
  hiddenIds(): SettingId[] {
    return [...this.hidden]
  }

  /** a program's restrictions end with it */
  reset(): void {
    this.developer = this.teleport = this.transport = true
    for (const k of Object.keys(this.hud) as HudPart[]) this.hud[k] = true
    this.hidden.clear()
    this.unknown.length = 0
    this.onChange?.()
  }
}
