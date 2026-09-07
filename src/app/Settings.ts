// Player-facing settings, persisted to localStorage. Everything here is
// presentation or control — nothing in the sim reads Settings.

import { DEFAULT_KEYS, DEFAULT_PAD, type KeyBindings, type PadBindings } from '../input/bindings'

export type StyleName = 'modern' | 'retro'
export type ComfortPreset = 'intense' | 'standard' | 'maximum'
export type RetroPresentHz = 20 | 30 | 60 | 0

export interface SettingsData {
  style: StyleName
  retro: {
    width: number
    height: number
    presentHz: RetroPresentHz
    scanlines: boolean
    barrel: boolean
    dither: boolean
    phosphor: boolean
    paletteLevels: number
    quantizeVerts: boolean
    ringSegments: number
  }
  modern: {
    bloom: boolean
    motionBlur: boolean
    chromatic: boolean
    grain: boolean
    smaa: boolean
    slowmo: boolean
  }
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
  access: {
    reducedMotion: boolean
    colorblind: 'none' | 'deuteranopia' | 'protanopia' | 'tritanopia'
    hudScale: number
  }
  visualSpeedGain: number
  showPerf: boolean
  playerName: string
}

const KEY = 'apex-conduit.settings.v1'

export const DEFAULT_SETTINGS: SettingsData = {
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
  access: { reducedMotion: false, colorblind: 'none', hudScale: 1 },
  visualSpeedGain: 1,
  showPerf: false,
  playerName: 'ACE',
}

type Listener = (s: SettingsData) => void

export class Settings {
  data: SettingsData
  private readonly listeners = new Set<Listener>()

  constructor() {
    this.data = load()
    const params = new URLSearchParams(location.search)
    const style = params.get('style')
    if (style === 'retro' || style === 'modern') this.data.style = style
    if (params.get('perf') === '1') this.data.showPerf = true
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Mutate via the callback, then persist and notify. */
  update(fn: (d: SettingsData) => void): void {
    fn(this.data)
    save(this.data)
    for (const l of this.listeners) l(this.data)
  }

  resetBindings(): void {
    this.update((d) => {
      d.keys = structuredClone(DEFAULT_KEYS)
      d.pad = structuredClone(DEFAULT_PAD)
    })
  }
}

function load(): SettingsData {
  const base = structuredClone(DEFAULT_SETTINGS)
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Partial<SettingsData>
    return deepMerge(base as unknown as Record<string, unknown>, parsed as Record<string, unknown>) as unknown as SettingsData
  } catch {
    return base
  }
}

function save(d: SettingsData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
  } catch {
    /* storage unavailable; settings are session-only */
  }
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(over)) {
    const b = base[k]
    const o = over[k]
    if (b && o && typeof b === 'object' && typeof o === 'object' && !Array.isArray(b) && !Array.isArray(o)) {
      base[k] = deepMerge(b as Record<string, unknown>, o as Record<string, unknown>)
    } else if (o !== undefined) {
      base[k] = o
    }
  }
  return base
}
