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
  view: 'chase' | 'cockpit'
  station: number
  units: 'kmh' | 'mph'
  access: { reducedMotion: boolean; hudScale: number }
  haptics: number
  showPerf: boolean
}

const KEY = 'apex-coast.settings.v1'

export const DEFAULT_SETTINGS: SettingsData = {
  style: 'modern',
  // 320×224 at 30 Hz: the arcade board's own numbers.
  retro: { width: 320, height: 224, presentHz: 30, scanlines: true, barrel: true, dither: false, phosphor: true, paletteLevels: 8, quantizeVerts: false, ringSegments: 12 },
  modern: { bloom: true, motionBlur: false, chromatic: true, grain: true, smaa: true, slowmo: false },
  audio: { master: 0.8, music: 0.6, sfx: 0.9, engine: 0.6 },
  keys: DEFAULT_KEYS,
  pad: DEFAULT_PAD,
  view: 'chase',
  station: 0,
  units: 'kmh',
  access: { reducedMotion: false, hudScale: 1 },
  haptics: 1,
  showPerf: false,
}

export class Settings extends SettingsStore<SettingsData> {
  constructor() {
    const stored = SettingsStore.hasStored(KEY)
    super(KEY, DEFAULT_SETTINGS)
    if (!stored && isTouchDevice()) {
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
