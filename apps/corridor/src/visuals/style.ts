// Styles: the third input to the one look everything reads.
//
// Rich (2026-09-26): "instead of late summer tired dark green trees and drab looking box houses,
// we can pick from a palette of style including alien, fantasy, medieval, etc. — let's build one
// that is definitely not trying to pretend to be crofton."
//
// A season says what a Maryland September looks like; the weather modifies it; a STYLE decides
// whether it is Maryland at all. It is applied last, to the same `SeasonLook` object the trees,
// grass, strips, terrain, horizon and sky already read (`look = style(weather(siteLook(season)))`),
// plus a handful of colours a season never touched — building walls and roofs, water, road paint
// — and one number: how much of the air photo survives. `realistic` is the identity; every knob
// here is a no-op there, so nothing about the realistic world changed by adding this file.
//
// The imagery is the one input a palette cannot recolour honestly: an air photo of Crofton is an
// air photo of Crofton. So a style that wants to leave Crofton lowers the photo's weight — the
// terrain and strips desaturate it and tint it hard toward the palette — and lets the turf, the
// trees and the houses carry the picture. It stops looking like a photograph, which is the point.
import * as THREE from 'three'
import type { SeasonLook } from './season'

export type Style = 'realistic' | 'fantasy'
export const STYLES: Style[] = ['realistic', 'fantasy']

const c = (hex: number) => new THREE.Color(hex)

export interface StyleDef {
  name: Style
  /** leaf colour per leaf kind, replacing the season's; absent = keep the season's */
  leaves?: Partial<Record<keyof SeasonLook['leaves'], THREE.Color>>
  grass?: { base: THREE.Color; tip: THREE.Color }
  litter?: THREE.Color
  /** multiplies the imagery drape (terrain, strips, horizon) */
  ground?: THREE.Color
  sky?: { horizon: THREE.Color; zenith: THREE.Color; cloudBias: number }
  sun?: THREE.Color
  /** 0 = the photo as shot, 1 = greyscale under the ground tint */
  desaturate: number
  water: { stream: THREE.Color; still: THREE.Color; sea: THREE.Color; opacityBias: number }
  walls: [number, number, number][]
  roofs: [number, number, number][]
  /** road paint: the centre line and the edge line */
  paint: { centre: THREE.Color; edge: THREE.Color }
}

/** The seven sidings and four roofs `buildings.ts` was born with; realistic keeps them. */
export const REAL_WALLS: [number, number, number][] = [
  [0.82, 0.78, 0.70], [0.72, 0.73, 0.68], [0.68, 0.60, 0.52], [0.55, 0.42, 0.36], [0.80, 0.80, 0.80], [0.48, 0.52, 0.50], [0.64, 0.56, 0.44],
]
export const REAL_ROOFS: [number, number, number][] = [
  [0.28, 0.26, 0.25], [0.34, 0.30, 0.27], [0.24, 0.24, 0.26], [0.38, 0.28, 0.24],
]

export const STYLE: Record<Style, StyleDef> = {
  realistic: {
    name: 'realistic',
    desaturate: 0,
    water: { stream: c(0x3d6b73), still: c(0x46707a), sea: c(0x2f5d6b), opacityBias: 0 },
    walls: REAL_WALLS,
    roofs: REAL_ROOFS,
    paint: { centre: c(0xf2c400), edge: c(0xf2f2ee) },
  },
  // Not Crofton. Violet and teal canopies over lilac turf, whitewash and pale stone under slate
  // and copper roofs, a peach horizon going to deep violet overhead, turquoise water you cannot
  // see the bed through, pale-gold lane paint. The photo is two thirds of the way to greyscale
  // and tinted mauve, so what is left of it reads as shading, not as a satellite.
  fantasy: {
    name: 'fantasy',
    leaves: { oak: c(0x8a4fd6), ash: c(0x3fb8b0), aspen: c(0xe6c34a), pine: c(0x3d3f9e), live: c(0xc84f9a) },
    grass: { base: c(0x8a6fb4), tip: c(0xe9c7ef) },
    litter: c(0x5b3a6e),
    ground: c(0xb99ec9),
    sky: { horizon: c(0xf3c6a8), zenith: c(0x4b2a8a), cloudBias: 0.1 },
    sun: c(0xffd6a8),
    desaturate: 0.65,
    water: { stream: c(0x2fc9c0), still: c(0x33bfc4), sea: c(0x1fa5b8), opacityBias: 0.12 },
    walls: [
      [0.93, 0.90, 0.84], [0.86, 0.80, 0.70], [0.78, 0.74, 0.80], [0.90, 0.86, 0.92], [0.70, 0.66, 0.60], [0.82, 0.72, 0.62], [0.88, 0.84, 0.76],
    ],
    roofs: [
      [0.24, 0.30, 0.48], [0.22, 0.48, 0.42], [0.42, 0.24, 0.40], [0.30, 0.36, 0.56],
    ],
    paint: { centre: c(0xf0d890), edge: c(0xf8f4e8) },
  },
}

/** The season's look with the style applied over it. `realistic` returns the input untouched. */
export function styled(look: SeasonLook, style: Style): SeasonLook {
  const s = STYLE[style]
  if (style === 'realistic') return look
  const leaves = { ...look.leaves }
  if (s.leaves) for (const k of Object.keys(s.leaves) as (keyof SeasonLook['leaves'])[]) {
    const tint = s.leaves[k]
    if (tint) leaves[k] = { tint: tint.clone(), density: Math.max(look.leaves[k].density, 0.85) }
  }
  return {
    ...look,
    leaves,
    grass: s.grass ? { ...look.grass, base: s.grass.base.clone(), tip: s.grass.tip.clone() } : look.grass,
    litter: s.litter ? { ...look.litter, tint: s.litter.clone() } : look.litter,
    ground: s.ground ? s.ground.clone() : look.ground,
    sky: s.sky ? s.sky.horizon.clone() : look.sky,
    sun: s.sun ? { ...look.sun, colour: s.sun.clone() } : look.sun,
  }
}

export function isStyle(v: unknown): v is Style {
  return typeof v === 'string' && (STYLES as string[]).includes(v)
}
