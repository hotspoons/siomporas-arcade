// Seasons, as a palette everything living reads from.
//
// Maryland piedmont, four snapshots: dead of winter (bare hardwoods, straw verges, pale sky),
// early spring (thin lime canopy, bright short grass), mid summer (full dark-green canopy, the
// NAIP look), late autumn (oak russet, ash purple-gold, aspen yellow, thinning). Trees take a
// leaf tint and a density; grass a colour ramp and a height; the imagery-draped ground a tint,
// because NAIP is flown leaf-on and has to be pushed toward the season by hand.
import * as THREE from 'three'

export type Season = 'winter' | 'spring' | 'summer' | 'autumn'
export const SEASONS: Season[] = ['winter', 'spring', 'summer', 'autumn']

export interface LeafLook {
  tint: THREE.Color // multiplies a GREYSCALE leaf mask, so this is the leaf colour outright
  density: number // 0 = bare
}

export interface SeasonLook {
  leaves: Record<'oak' | 'ash' | 'aspen' | 'pine', LeafLook>
  grass: { base: THREE.Color; tip: THREE.Color; height: number; dry: number }
  ground: THREE.Color // multiplies the imagery drape
  sky: THREE.Color
  fog: number
}

const c = (hex: number) => new THREE.Color(hex)

export const LOOK: Record<Season, SeasonLook> = {
  winter: {
    leaves: { oak: { tint: c(0x6b5a48), density: 0.08 }, ash: { tint: c(0x7a6a58), density: 0 }, aspen: { tint: c(0x8a7a66), density: 0 }, pine: { tint: c(0x3f5a3a), density: 1 } },
    grass: { base: c(0x8a7d55), tip: c(0xc9b98a), height: 0.18, dry: 1 },
    ground: c(0xc9c0b2),
    sky: c(0xd6dde6),
    fog: 0.000035,
  },
  spring: {
    leaves: { oak: { tint: c(0xc6e07e), density: 0.55 }, ash: { tint: c(0xd2ea92), density: 0.5 }, aspen: { tint: c(0xdcf0a0), density: 0.5 }, pine: { tint: c(0x6a9a5a), density: 1 } },
    grass: { base: c(0x5f9a3a), tip: c(0xa6d66a), height: 0.22, dry: 0 },
    ground: c(0xf2f7e6),
    sky: c(0xcfdcec),
    fog: 0.000022,
  },
  summer: {
    leaves: { oak: { tint: c(0x7fb54a), density: 1 }, ash: { tint: c(0x8cc45a), density: 1 }, aspen: { tint: c(0x9ed065), density: 1 }, pine: { tint: c(0x5a8a50), density: 1 } },
    grass: { base: c(0x3f6f26), tip: c(0x8ab84f), height: 0.42, dry: 0.1 },
    ground: c(0xffffff),
    sky: c(0xbfd2ea),
    fog: 0.000018,
  },
  autumn: {
    leaves: { oak: { tint: c(0xd6823a), density: 0.75 }, ash: { tint: c(0xe0b24a), density: 0.6 }, aspen: { tint: c(0xf7d23a), density: 0.65 }, pine: { tint: c(0x5a8a50), density: 1 } },
    grass: { base: c(0x7f8a45), tip: c(0xc2b96a), height: 0.36, dry: 0.6 },
    ground: c(0xf5e6cf),
    sky: c(0xd2d9df),
    fog: 0.000028,
  },
}

/** A greyscale copy of a leaf texture (alpha kept), so a tint IS the leaf colour. */
export function greyscaleTexture(src: THREE.Texture): THREE.Texture | null {
  const img = src.image as HTMLImageElement | undefined
  if (!img || !img.width) return null
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height)
  const px = d.data
  for (let i = 0; i < px.length; i += 4) {
    // luminance, lifted so mid-greens map to ~0.8 and a tint reads at full strength
    const l = Math.min(255, (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * 1.35 + 20)
    px[i] = px[i + 1] = px[i + 2] = l
  }
  ctx.putImageData(d, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.premultiplyAlpha = src.premultiplyAlpha
  t.flipY = src.flipY
  return t
}
