// Player-facing settings, persisted to localStorage. Everything here is
// presentation or control — nothing in the sim reads Settings.

import { DEFAULT_KEYS, DEFAULT_PAD, type KeyBindings, type PadBindings } from '../input/bindings'
import { isTouchDevice } from '@apex/engine/app/platform'
import { SettingsStore } from '@apex/engine/app/SettingsStore'
import { mergeMissingKeys } from '@apex/engine/input/bindings'
import type { ModernOptions, RetroOptions } from '@apex/engine/render/styles/Style'

export type StyleName = 'modern' | 'retro'
export type ComfortPreset = 'intense' | 'standard' | 'maximum'
export type RetroPresentHz = 20 | 30 | 60 | 0

/** Bump when the steering scale is redefined, so a saved multiplier is not read against a new base. */
export const STEER_VERSION = 3

/**
 * What a steering multiplier saved against an older base means today, as a factor to apply to it.
 *
 * The base rate has been raised twice: doubled at version 2, and raised by two thirds at version 3,
 * where the 166% people were actually playing at became 100%. A number saved against either of those
 * means something different now, and a replay driven under one only replays faithfully under it.
 */
export function steerScaleFrom(version: number | undefined): number {
  const v = version ?? 1
  if (v >= 3) return 1
  return v === 2 ? 1 / 1.66 : 0.5 / 1.66
}

export interface SettingsData {
  /** Bindings migration version (see the constructor). */
  keysV?: number
  style: StyleName
  retro: RetroOptions
  modern: ModernOptions
  audio: {
    master: number
    music: number
    sfx: number
    engine: number
  }
  keys: KeyBindings
  pad: PadBindings
  vr: {
    comfort: ComfortPreset
    rollBlend: number
    headTurret: boolean
  }
  /** Phone tilt steering the other way round from this game's default. */
  tiltInvert?: boolean
  access: {
    reducedMotion: boolean
    colorblind: 'none' | 'deuteranopia' | 'protanopia' | 'tritanopia'
    hudScale: number
  }
  visualSpeedGain: number
  /** Steering speed, 1 = the original feel. */
  steering: number
  /** Which steering scale `steering` was saved against (see STEER_VERSION). */
  steerV?: number
  showPerf: boolean
  playerName: string
}

const KEY = 'apex-conduit.settings.v1'

/** Bump when a new default key alias must reach players who already have bindings saved. */
const KEYS_VERSION = 2

export const DEFAULT_SETTINGS: SettingsData = {
  keysV: KEYS_VERSION,
  style: 'modern',
  retro: {
    width: 320,
    height: 240,
    presentHz: 20,
    scanlines: true,
    barrel: true,
    dither: true,
    phosphor: true,
    paletteLevels: 5,
    quantizeVerts: true,
    ringSegments: 12,
  },
  modern: { bloom: true, motionBlur: true, chromatic: true, grain: true, smaa: true, slowmo: true },
  audio: { master: 0.8, music: 0.5, sfx: 0.9, engine: 0.7 },
  keys: DEFAULT_KEYS,
  pad: DEFAULT_PAD,
  vr: { comfort: 'standard', rollBlend: 0, headTurret: false },
  tiltInvert: false,
  access: { reducedMotion: false, colorblind: 'none', hudScale: 1 },
  visualSpeedGain: 1,
  steering: 1,
  steerV: STEER_VERSION,
  showPerf: false,
  playerName: 'ACE',
}

export class Settings extends SettingsStore<SettingsData> {
  constructor() {
    const stored = SettingsStore.hasStored(KEY)
    const savedKeysV = Number(SettingsStore.stored(KEY)?.keysV ?? 0)
    const savedSteerV = Number(SettingsStore.stored(KEY)?.steerV ?? 0)
    super(KEY, DEFAULT_SETTINGS)
    // Bindings are saved per browser, so aliases added later (P for pause, say) never reached anyone
    // who had already played. Merge in any default key an action is missing, once. The version comes
    // from the stored blob: read from `this.data` it would arrive from the defaults, already current.
    if (savedKeysV < KEYS_VERSION) {
      mergeMissingKeys(this.data.keys, DEFAULT_KEYS)
      this.data.keysV = KEYS_VERSION
      this.save()
    }
    // The steering multiplier is read against a base rate that has changed: a 1.5 saved against the old
    // one would be half as fast again as intended. Put it back to the standard rate rather than
    // guessing what the player meant by a number that no longer means the same thing.
    if (savedSteerV < STEER_VERSION) {
      this.data.steering = DEFAULT_SETTINGS.steering
      this.data.steerV = STEER_VERSION
      this.save()
    }
    // First run on a phone: keep the look, drop the expensive passes.
    if (!stored && isTouchDevice()) {
      this.data.modern.motionBlur = false
      this.data.modern.chromatic = false
      this.data.modern.grain = false
      this.data.modern.smaa = false
      this.data.access.hudScale = 0.85
    }
    const params = new URLSearchParams(location.search)
    const style = params.get('style')
    if (style === 'retro' || style === 'modern') this.data.style = style
    if (params.get('perf') === '1') this.data.showPerf = true
  }

  resetBindings(): void {
    this.update((d) => {
      d.keys = structuredClone(DEFAULT_KEYS)
      d.pad = structuredClone(DEFAULT_PAD)
    })
  }
}
