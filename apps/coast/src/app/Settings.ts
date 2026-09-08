import { SettingsStore } from '@apex/engine/app/SettingsStore'
import { isTouchDevice } from '@apex/engine/app/platform'
import type { KeyBindings, PadBindings } from '@apex/engine/input/bindings'
import type { ModernOptions, RetroOptions } from '@apex/engine/render/styles/Style'
import { DEFAULT_KEYS, DEFAULT_PAD } from '../input/bindings'

export interface SettingsData {
  /** Bindings migration version (see the constructor). */
  keysV?: number
  style: 'modern' | 'retro'
  retro: RetroOptions
  modern: ModernOptions
  audio: { master: number; music: number; sfx: number; engine: number }
  keys: KeyBindings
  pad: PadBindings
  view: 'chase' | 'cockpit'
  /** Two-speed box: shift it yourself, or let it shift (and give up a little top speed). */
  gearbox: 'manual' | 'auto'
  /** Hero livery id (see procgen LIVERIES) or 'formula'. */
  car: string
  station: number
  /** Stage id to begin the run on (STAGES). */
  startStage: string
  units: 'kmh' | 'mph'
  access: { reducedMotion: boolean; hudScale: number }
  /** Phone tilt steering the other way round from this game's default. */
  tiltInvert?: boolean
  haptics: number
  showPerf: boolean
}

const KEY = 'apex-coast.settings.v1'

export const DEFAULT_SETTINGS: SettingsData = {
  keysV: 2,
  style: 'modern',
  // 320×224 at 60 Hz: the arcade board's own numbers (OutRun ran a full 60).
  retro: { width: 320, height: 224, presentHz: 60, scanlines: true, barrel: true, dither: false, phosphor: true, paletteLevels: 8, quantizeVerts: false, ringSegments: 12 },
  modern: { bloom: true, motionBlur: false, chromatic: true, grain: true, smaa: true, slowmo: false },
  audio: { master: 0.8, music: 0.6, sfx: 0.9, engine: 0.6 },
  keys: DEFAULT_KEYS,
  pad: DEFAULT_PAD,
  view: 'chase',
  gearbox: 'manual',
  car: 'rosso',
  station: 0,
  startStage: 'A',
  units: 'kmh',
  access: { reducedMotion: false, hudScale: 1 },
  tiltInvert: false,
  haptics: 1,
  showPerf: false,
}

export class Settings extends SettingsStore<SettingsData> {
  constructor() {
    const stored = SettingsStore.hasStored(KEY)
    super(KEY, DEFAULT_SETTINGS)
    // Bindings are saved per browser, so aliases added later (P for pause, say) never reached anyone
    // who had already played. Merge in any default key an action is missing, once.
    if ((this.data.keysV ?? 0) < 2) {
      for (const [action, keys] of Object.entries(DEFAULT_KEYS)) {
        const mine = this.data.keys[action as keyof typeof DEFAULT_KEYS]
        if (!mine) this.data.keys[action as keyof typeof DEFAULT_KEYS] = [...keys]
        else for (const k of keys) if (!mine.includes(k)) mine.push(k)
      }
      this.data.keysV = 2
      this.save()
    }
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
