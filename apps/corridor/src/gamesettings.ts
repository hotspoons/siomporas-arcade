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
  | 'drive' | 'recover' | 'lights' | 'camera' | 'map' | 'fire' | 'craft' | 'walk' | 'interface'
  | 'pause' | 'confirm'
export const ACTIONS: Action[] = [
  'throttle', 'brake', 'steerLeft', 'steerRight', 'handbrake',
  'drive', 'recover', 'lights', 'camera', 'map', 'fire', 'craft', 'walk', 'interface',
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
  fire: 'Fire',
  craft: 'Next craft (Shift: previous)',
  walk: 'On foot / fly',
  interface: 'Hide the interface',
  pause: 'Pause menu',
  confirm: 'Confirm',
}
export const DEFAULT_KEYS: KeyBindings = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  drive: ['Tab'],
  recover: ['KeyR'],
  lights: ['KeyL'],
  camera: ['KeyC'],
  map: ['KeyN'],
  fire: ['KeyM'],
  craft: ['KeyV'],
  walk: ['KeyB'],
  interface: ['KeyM'],
  pause: ['Escape'],
  confirm: ['Enter'],
}
/**
 * Standard-mapping pad: triggers are the pedals, the left stick steers, A is the handbrake as it
 * is in most driving games, Start pauses. B is the menus' "back" and is left free in play.
 */
export const DEFAULT_PAD: PadBindings = {
  throttle: ['b7'],
  brake: ['b6'],
  steerLeft: ['a0-'],
  steerRight: ['a0+'],
  handbrake: ['b0'],
  drive: ['b1'],
  recover: ['b2'],
  lights: ['b8'],
  camera: ['b3'],
  map: ['b10'],
  fire: ['b5'],
  craft: ['b4'],
  walk: [],
  interface: [],
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
  audio: AudioSettings
  keys: KeyBindings
  pad: PadBindings
  /** the gamepad is read at all */
  gamepad: boolean
  /** rumble strength 0..1 */
  haptics: number
  units: 'mph' | 'kmh'
  /** the interface the player chose in the Escape menu; null = the deployment's default */
  ui: UiMode | null
}

export const SETTINGS_KEY = 'apex-corridor.settings.v1'
const KEYS_VERSION = 1

export const DEFAULT_SETTINGS: GameSettingsData = {
  keysV: KEYS_VERSION,
  audio: { master: 0.8, engine: 1, sfx: 0.7, muted: false },
  keys: DEFAULT_KEYS,
  pad: DEFAULT_PAD,
  gamepad: true,
  haptics: 1,
  units: 'mph',
  ui: null,
}

export class GameSettings extends SettingsStore<GameSettingsData> {
  constructor(key = SETTINGS_KEY) {
    const savedKeysV = Number(SettingsStore.stored(key)?.keysV ?? 0)
    super(key, DEFAULT_SETTINGS)
    if (savedKeysV < KEYS_VERSION) {
      mergeMissingKeys(this.data.keys, DEFAULT_KEYS)
      this.data.keysV = KEYS_VERSION
      this.save()
    }
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
