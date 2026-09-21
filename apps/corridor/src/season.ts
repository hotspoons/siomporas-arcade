// Seasons, as a palette everything living reads from.
//
// Maryland piedmont, four snapshots: dead of winter (bare hardwoods, straw verges, pale sky),
// early spring (thin lime canopy, bright short grass), late summer (full canopy going leathery,
// verges gone to seed — SEPTEMBER, which is when Rich's reference photography and the NAIP were
// both shot, and what the default season has to look like), late autumn (oak russet, ash
// purple-gold, aspen yellow, thinning). Trees take a leaf tint and a density; grass a colour ramp
// and a height; the imagery-draped ground a tint, because NAIP is flown leaf-on and has to be
// pushed toward the season by hand.
//
// The grass here was reading as April in every season. Two reasons, both fixed:
//   - `summer` was high summer — a saturated, blue-leaning green with dry = 0.1. A Maryland verge
//     in September is olive under straw seed heads, not lush.
//   - the straw was being added OUTSIDE the palette. GRASS_DRY_ADD was sitting at 0.3, so every
//     season was really its own dryness plus a third, and nobody could see the real value or set
//     one season without moving the other three. That 0.3 is folded into the palettes and the
//     knob is back to 0, free for Rich to push a single site drier.
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
  /**
   * Leaf litter on the ground. `spread` is how far past the crowns it reaches, 0…1 — a hardwood
   * wood in leaf drops almost nothing on the verge, and the same wood in November has covered it,
   * which is a large part of why a bare wood reads as winter rather than as summer with no leaves.
   */
  litter: { tint: THREE.Color; spread: number }
  ground: THREE.Color // multiplies the imagery drape
  sky: THREE.Color
  fog: number
  /**
   * The light. The sun did not change by season, and the ground tint alone had to carry it, so a
   * winter scene came out as a summer scene multiplied by 0.79 — dark rather than cold, with the
   * darkening compounding on everything the tint touched. A low bright winter sun and a colder,
   * stronger sky give the same answer honestly.
   */
  sun: { colour: THREE.Color; intensity: number }
  ambient: { sky: THREE.Color; ground: THREE.Color; intensity: number }
}

const c = (hex: number) => new THREE.Color(hex)

export const LOOK: Record<Season, SeasonLook> = {
  winter: {
    leaves: { oak: { tint: c(0x6b5a48), density: 0.08 }, ash: { tint: c(0x7a6a58), density: 0 }, aspen: { tint: c(0x8a7a66), density: 0 }, pine: { tint: c(0x3f5a3a), density: 1 } },
    grass: { base: c(0x877a58), tip: c(0xc3b189), height: 0.18, dry: 1 },
    litter: { tint: c(0xa89a86), spread: 1.0 }, // matted and grey by February, but the winter ground tint already darkens it
    ground: c(0xc9c0b2),
    sky: c(0xd6dde6),
    fog: 0.000035,
    sun: { colour: c(0xfff4e2), intensity: 2.2 },
    ambient: { sky: c(0xdfe8f2), ground: c(0x8f8878), intensity: 1.05 },
  },
  spring: {
    leaves: { oak: { tint: c(0xc6e07e), density: 0.55 }, ash: { tint: c(0xd2ea92), density: 0.5 }, aspen: { tint: c(0xdcf0a0), density: 0.5 }, pine: { tint: c(0x6a9a5a), density: 1 } },
    // April, and the only season allowed to look like it
    grass: { base: c(0x5f9a3a), tip: c(0xa6d66a), height: 0.22, dry: 0.12 },
    litter: { tint: c(0x6e6350), spread: 0.15 },
    ground: c(0xf2f7e6),
    sky: c(0xcfdcec),
    fog: 0.000022,
    sun: { colour: c(0xfff2dc), intensity: 2.1 },
    ambient: { sky: c(0xe6eef6), ground: c(0x7f7658), intensity: 0.82 },
  },
  summer: {
    leaves: { oak: { tint: c(0x7fb54a), density: 1 }, ash: { tint: c(0x8cc45a), density: 1 }, aspen: { tint: c(0x9ed065), density: 1 }, pine: { tint: c(0x5a8a50), density: 1 } },
    // September: olive at the root, straw at the tip, seed heads standing a little taller
    grass: { base: c(0x4c6b2e), tip: c(0x97a054), height: 0.46, dry: 0.45 },
    litter: { tint: c(0x7a6e56), spread: 0.2 },
    ground: c(0xfaf6ec),
    sky: c(0xbfd2ea),
    fog: 0.000018,
    sun: { colour: c(0xfff0d8), intensity: 2.0 },
    ambient: { sky: c(0xe9eef2), ground: c(0x7a6a50), intensity: 0.75 },
  },
  autumn: {
    leaves: { oak: { tint: c(0xd6823a), density: 0.75 }, ash: { tint: c(0xe0b24a), density: 0.6 }, aspen: { tint: c(0xf7d23a), density: 0.65 }, pine: { tint: c(0x5a8a50), density: 1 } },
    grass: { base: c(0x77803f), tip: c(0xc0b268), height: 0.36, dry: 0.85 },
    litter: { tint: c(0xb07a44), spread: 0.85 },
    ground: c(0xf5e6cf),
    sky: c(0xd2d9df),
    fog: 0.000028,
    sun: { colour: c(0xffeacc), intensity: 1.95 },
    ambient: { sky: c(0xe4e8ec), ground: c(0x7d6c4e), intensity: 0.85 },
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
