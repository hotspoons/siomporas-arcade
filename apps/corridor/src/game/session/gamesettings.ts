// The player's own settings: bindings, volumes, haptics, units, and which interface they chose.
//
// Separate from the F6 tuning knobs on purpose. A knob is a fact about the WORLD (a preset may
// carry it, a site's tuning.json may set it); a setting is a fact about the PERSON at the keyboard,
// kept in this browser and never written into a level. `ENGINE_MASTER` used to be the only
// volume, and it sat in a `scope: 'world'` section — which is how a level could have shipped
// somebody's volume.
//
// The engine's `SettingsStore` deep-merges what is saved over the defaults, so a field added
// later arrives with its default for everyone who already played. Bindings are the exception it
// documents: a NEW default key never reaches a saved binding list, hence `KEYS_VERSION`.
import { SettingsStore } from '@apex/engine/app/SettingsStore'
import { mergeMissingKeys, type KeyBindings, type PadBindings } from '@apex/engine/input/bindings'
import type { UiMode } from './gamepolicy'

/**
 * The rebindable actions. Everything the viewer's keydown handler used to switch on by key code,
 * plus the held driving inputs. P, H, X, F6, F7 and Shift+R stay fixed: they are the developer's
 * keys, and rebinding "copy a link to this view" is not a thing a player wants.
 */
export type Action =
  | 'throttle' | 'brake' | 'steerLeft' | 'steerRight' | 'handbrake'
  | 'drive' | 'recover' | 'lights' | 'camera' | 'map' | 'fire' | 'gun' | 'craft' | 'walk' | 'interface'
  | 'objPrev' | 'objNext'
  | 'pause' | 'confirm'
export const ACTIONS: Action[] = [
  'throttle', 'brake', 'steerLeft', 'steerRight', 'handbrake',
  'drive', 'recover', 'lights', 'camera', 'map', 'fire', 'gun', 'craft', 'walk', 'interface',
  'objPrev', 'objNext',
  'pause', 'confirm',
]
export const ACTION_LABELS: Record<Action, string> = {
  throttle: 'Accelerate',
  brake: 'Brake / reverse',
  steerLeft: 'Steer left',
  steerRight: 'Steer right',
  handbrake: 'Handbrake',
  drive: 'Get in / out of the car',
  recover: 'Recover the car',
  lights: 'Headlights',
  camera: 'Chase / cockpit view',
  map: 'Map: full screen',
  fire: 'Fire a missile',
  gun: 'Machine gun (hold)',
  craft: 'Next craft (Shift: previous)',
  walk: 'On foot / fly',
  interface: 'Hide the interface',
  objPrev: 'Previous objective',
  objNext: 'Next objective',
  pause: 'Pause menu',
  confirm: 'Confirm',
}
export const DEFAULT_KEYS: KeyBindings = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  handbrake: ['ShiftLeft'],
  drive: ['Tab'],
  recover: ['KeyR'],
  lights: ['KeyL'],
  camera: ['KeyC'],
  map: ['KeyN'],
  fire: ['ControlLeft'],
  gun: ['Space'],
  craft: ['KeyV'],
  walk: ['KeyB'],
  interface: ['KeyM'],
  // the objective list pages with Q / E on the keyboard; the D-pad on a pad (Rich, 2026-09-30)
  objPrev: ['KeyQ'],
  objNext: ['KeyE'],
  pause: ['Escape'],
  confirm: ['Enter'],
}
/**
 * Standard-mapping pad, laid out the way a driving game is (Rich, 2026-09-30, with an Xbox-style
 * pad in hand):
 *
 *   RT / LT        accelerate / brake            A   handbrake        Y   recover the car
 *   left stick     steer                         X   headlights       RB  missile   LB  machine gun
 *   right stick    look round the car (main.ts)  LS  the map, once Expand the map is on
 *                                                 Start  pause
 *   D-pad ◀ ▶      the objective list            View (the left centre button)  chase / cockpit
 *
 * B is the menus' "back" and is left free in play. Getting in and out of the car, the craft and
 * walking are NOT on the pad: a flight mode is a level's decision, not a button (Rich: "flight
 * modes should not be a button at all, this should be an internal game mechanic"). The keyboard
 * keeps Tab, V and B for the developer.
 */
export const DEFAULT_PAD: PadBindings = {
  throttle: ['b7'],
  brake: ['b6'],
  steerLeft: ['a0-'],
  steerRight: ['a0+'],
  handbrake: ['b0'],
  drive: [],
  recover: ['b3'],
  lights: ['b2'],
  camera: ['b8'],
  map: ['b10'],
  fire: ['b5'],
  gun: ['b4'],
  craft: [],
  walk: [],
  interface: [],
  objPrev: ['b14'],
  objNext: ['b15'],
  pause: ['b9'],
  confirm: ['b0'],
}

export interface AudioSettings {
  /** 0..1, over everything */
  master: number
  /** the engine bus */
  engine: number
  /** interface blips and, later, effects */
  sfx: number
  /** the player's own mute — combined with the tab-hidden mute, never replaced by it */
  muted: boolean
}

export interface GameSettingsData {
  keysV?: number
  padV?: number
  audio: AudioSettings
  keys: KeyBindings
  pad: PadBindings
  /** the gamepad is read at all */
  gamepad: boolean
  /** rumble strength 0..1 */
  haptics: number
  units: 'mph' | 'kmh'
  /** the physics world in the plain viewer: the world's own default, or forced on or off */
  physics: 'world' | 'on' | 'off'
  /**
   * Left stick click and N grow the map to the whole screen. Off until asked: a click of the
   * stick used to take the road away with no control a driver looks for.
   */
  mapExpand: boolean
  /** the map turns so the direction of driving is up */
  mapHeading: boolean
  /** the interface the player chose in the Escape menu; null = the deployment's default */
  ui: UiMode | null
}

export const SETTINGS_KEY = 'apex-corridor.settings.v1'
/** bump when a NEW default key arrives: saved key lists gain it (a player's own stay) */
const KEYS_VERSION = 4
/**
 * Bump when the default pad LAYOUT changes: the saved pad is replaced by the new defaults.
 *
 * Replaced, not merged, because a pad layout is one thing rather than a list of extras — moving
 * the throttle to the trigger is not a new binding to add beside the shoulder button. The
 * deep-merge in SettingsStore kept an earlier session's pad under the new defaults, which is how
 * the accelerator was still on the right shoulder after the defaults said trigger
 * (Rich, 2026-09-30).
 */
const PAD_VERSION = 3

export const DEFAULT_SETTINGS: GameSettingsData = {
  keysV: KEYS_VERSION,
  padV: PAD_VERSION,
  audio: { master: 0.8, engine: 1, sfx: 0.7, muted: false },
  keys: DEFAULT_KEYS,
  pad: DEFAULT_PAD,
  gamepad: true,
  haptics: 1,
  units: 'mph',
  physics: 'world',
  ui: null,
  mapExpand: false,
  mapHeading: false,
}

export class GameSettings extends SettingsStore<GameSettingsData> {
  constructor(key = SETTINGS_KEY) {
    const stored = SettingsStore.stored(key)
    const savedKeysV = Number(stored?.keysV ?? 0)
    const savedPadV = Number(stored?.padV ?? 0)
    super(key, DEFAULT_SETTINGS)
    let dirty = false
    if (savedKeysV < KEYS_VERSION) {
      mergeMissingKeys(this.data.keys, DEFAULT_KEYS)
      // v4 moves the missile to Ctrl, the gun to Space, and the handbrake to Shift — but only
      // where the saved binding is still the old default. A key the player chose stays.
      if (savedKeysV < 4) {
        const same = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((k, i) => k === b[i])
        if (same(this.data.keys.fire, ['KeyM'])) this.data.keys.fire = ['ControlLeft']
        if (same(this.data.keys.gun, ['KeyG'])) this.data.keys.gun = ['Space']
        if (same(this.data.keys.handbrake, ['Space'])) this.data.keys.handbrake = ['ShiftLeft']
      }
      this.data.keysV = KEYS_VERSION
      dirty = true
    }
    if (savedPadV < PAD_VERSION) {
      this.data.pad = structuredClone(DEFAULT_PAD)
      this.data.padV = PAD_VERSION
      dirty = true
    }
    if (dirty) this.save()
  }

  resetBindings(): void {
    this.update((d) => {
      d.keys = structuredClone(DEFAULT_KEYS)
      d.pad = structuredClone(DEFAULT_PAD)
    })
  }
}

/** the gain the engine bus actually gets: the player's two sliders, or nothing at all */
export function engineGain(a: AudioSettings): number {
  return a.muted ? 0 : clamp01(a.master) * clamp01(a.engine)
}

export function sfxGain(a: AudioSettings): number {
  return a.muted ? 0 : clamp01(a.master) * clamp01(a.sfx)
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
