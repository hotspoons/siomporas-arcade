// Player settings for the driving game, persisted via the engine store.

import { SettingsStore } from '@apex/engine/app/SettingsStore'
import { isTouchDevice } from '@apex/engine/app/platform'
import type { KeyBindings, PadBindings } from '@apex/engine/input/bindings'
import type { ModernOptions, RetroOptions } from '@apex/engine/render/styles/Style'
import { DEFAULT_KEYS, DEFAULT_PAD } from '../input/bindings'

export interface SettingsData {
  style: 'modern' | 'retro'
  retro: RetroOptions
  modern: ModernOptions
  audio: { master: number; music: number; sfx: number; engine: number }
  keys: KeyBindings
  pad: PadBindings
  units: 'mph' | 'kmh'
  camera: 'chase' | 'hood'
  carId: string
  trackId: string
  laps: number
  access: { reducedMotion: boolean; hudScale: number }
  /** 0..1 rumble / trigger / phone vibration strength. */
  haptics: number
  showPerf: boolean
  playerName: string
}

const KEY = 'apex-drivin.settings.v1'

export const DEFAULT_SETTINGS: SettingsData = {
  style: 'modern',
  retro: { width: 320, height: 240, presentHz: 20, scanlines: true, barrel: true, dither: true, phosphor: true, paletteLevels: 6, quantizeVerts: true, ringSegments: 10 },
  modern: { bloom: true, motionBlur: true, chromatic: false, grain: true, smaa: true, slowmo: false },
  audio: { master: 0.8, music: 0.4, sfx: 0.9, engine: 0.8 },
  keys: DEFAULT_KEYS,
  pad: DEFAULT_PAD,
  units: 'mph',
  camera: 'chase',
  carId: 'kestrel',
  trackId: 'builtin:0',
  laps: 3,
  access: { reducedMotion: false, hudScale: 1 },
  haptics: 1,
  showPerf: false,
  playerName: 'ACE',
}

export class Settings extends SettingsStore<SettingsData> {
  constructor() {
    const stored = SettingsStore.hasStored(KEY)
    super(KEY, DEFAULT_SETTINGS)
    if (!stored && isTouchDevice()) {
      this.data.modern.motionBlur = false
      this.data.modern.smaa = false
      this.data.modern.grain = false
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
