// What covers the ground here, and what colour it is this month.
//
// The verge of a county road in the Maryland piedmont is not the verge of a farm road in the
// Central Valley and not the dunes behind a Pacific beach, and the difference is mostly SHAPE —
// how tall, how wide, how much it leans, how tightly it packs — with colour a second-order tint on
// top of the season. So a ground-cover class is a set of multipliers over the season palette and
// the tuning knobs, not a table of hand-picked colours nobody can keep consistent.
//
// SELECTION comes from the bake. `tools/corridor/corridor/flora.py` reads LANDFIRE's Existing
// Vegetation Type over the corridor and files every class under one of eighteen ground classes
// using LANDFIRE's OWN lifeform and subclass fields — `Herb` + "Annual Graminoid/Forb" is annual
// grassland, `Shrub` + "Evergreen shrubland" is chaparral, `Tree` + "Evergreen closed tree canopy"
// over a Conifer physiognomy is needle duff — and hands over the area share of each. Nothing in
// this file names a state or a region. The old latitude/land-use rule is still here and still runs,
// as the fallback for a bake made before the flora layer existed.
//
// ── WHY CALIFORNIA IS BROWN, since Rich asked ────────────────────────────────────────────────
// It is not dirt and it is not sand. A Big Sur hillside in September is three things:
//
//   annual grassland   naturalised Mediterranean annuals — wild oat (Avena), ripgut brome (Bromus
//                      diandrus), foxtail barley — that germinate with the first winter rain, are
//                      brilliant green from December to March, set seed in April and are DEAD by
//                      May. What you see in summer is standing straw over last year's thatch. It
//                      is a living community with a season, and its season is the opposite of
//                      Maryland's. LANDFIRE calls it "Annual Graminoid/Forb" and separates it from
//                      the perennial bunchgrass ("Perennial graminoid grassland") that was there
//                      before 1800 and survives in patches.
//   chaparral          chamise, manzanita, ceanothus — hard woody evergreen scrub, grey-green and
//                      about waist to shoulder height, that stays exactly that colour all year.
//                      It is the dark stipple between the straw.
//   coastal sage scrub the softer, greyer, lower version on the seaward slopes: sagebrush,
//                      buckwheat, sage. Summer-deciduous — it drops leaves in the drought, which
//                      is why it goes paler in August and greens again in January.
//
// Which of those a pixel is comes from EVT. WHEN the annual grass is straw comes from Daymet, not
// from a rule about California: Bixby Bridge takes 2 mm of rain in June–August, 0.2 % of its year,
// and Chesterfield Road takes 419 mm, 32 % of its year. `Flora.curing()` turns those into a
// number, and the same code makes a Maryland verge stay olive through August and go straw in
// January — because there the thing that stops the grass is the cold, not the drought.
//
// Acadia is a third problem and is handled by the same machinery: granite ledge, lichen, blueberry
// heath ("Evergreen dwarf-shrubland") and spruce duff, which EVT files as `Sparse`, `Shrub` and
// `Tree`/Conifer respectively.
import * as THREE from 'three'
import type { Flora, GroundClass } from './flora'
import type { Manifest } from './site'

/** The blade shape. A ground class picks one of these and scales it. */
export type GrassType = 'common' | 'wheat' | 'bermuda' | 'coastal' | 'annual' | 'meadow' | 'heath'
export const GRASS_TYPES: GrassType[] = ['common', 'wheat', 'bermuda', 'coastal', 'annual', 'meadow', 'heath']

export interface GrassTypeLook {
  /** rough-grass height × this */
  height: number
  /** mown height × this: a warm-season turf is cut shorter and reads shorter */
  mown: number
  /** blade width × this */
  width: number
  /** added to GRASS_LEAN: how far a blade arcs over from the root */
  lean: number
  /** blades per m² × this */
  density: number
  /** clump scatter × this: bunch grasses clump, turf grasses do not */
  scatter: number
  /** added to the season's dryness, 0…1 */
  dry: number
  /** degrees of hue rotation over the season ramp */
  hue: number
  /** saturation × this */
  sat: number
}

export const GRASS_LOOK: Record<GrassType, GrassTypeLook> = {
  common: { height: 1, mown: 1, width: 1, lean: 0, density: 1, scatter: 1, dry: 0, hue: 0, sat: 1 },
  // standing seed heads: half again as tall, a third fewer stems, wide leaves, heavy arc, straw
  wheat: { height: 1.55, mown: 1.1, width: 1.35, lean: 0.3, density: 0.65, scatter: 1.35, dry: 0.3, hue: -8, sat: 0.85 },
  // a warm-season turf: short, fine, dense, upright, and a touch bluer than fescue
  bermuda: { height: 0.55, mown: 0.75, width: 0.7, lean: -0.1, density: 1.5, scatter: 0.6, dry: -0.05, hue: 6, sat: 1.05 },
  // dune grass: tall thin clumps far apart, leaning away, grey-green
  coastal: { height: 1.3, mown: 1, width: 0.8, lean: 0.45, density: 0.4, scatter: 1.8, dry: 0.15, hue: 14, sat: 0.6 },
  // Mediterranean annuals gone over: wild oat and ripgut stand 60–90 cm, thin, sparse at the root
  // because they are stems rather than a sward, and lean hard because there is nothing holding
  // them up any more. `dry` is deliberately 0 — the curing is seasonal and comes from the climate,
  // not from the blade type, or a January hillside would be straw too
  annual: { height: 1.45, mown: 1.0, width: 0.85, lean: 0.38, density: 0.7, scatter: 1.5, dry: 0, hue: -4, sat: 0.9 },
  // native perennial bunchgrass and ruderal meadow: taller and clumpier than a roadside mix,
  // and it stays green at the base long after the seed heads have gone over
  meadow: { height: 1.25, mown: 1, width: 1.05, lean: 0.12, density: 0.85, scatter: 1.45, dry: 0.05, hue: 2, sat: 0.95 },
  // heath: blueberry, huckleberry, crowberry over granite — not grass at all, so it is short,
  // very dense, wide-leaved and barely leans. Acadia's ground between the ledges
  heath: { height: 0.4, mown: 0.6, width: 1.6, lean: -0.15, density: 1.7, scatter: 0.5, dry: -0.1, hue: -6, sat: 0.8 },
}

/** The floor texture under a canopy or in place of grass. */
export type FloorKind = 'hardwood_litter' | 'conifer_duff' | 'broadleaf_evergreen_litter' | 'mixed_litter' | 'chaparral' | 'ledge' | 'sand' | 'thatch' | 'bare'

export interface CoverLook {
  /** the blade style, and how much of it there is: 0 = no blades at all, this is not a sward */
  grass: GrassType
  blades: number
  /** what the ground itself is painted with */
  floor: FloorKind
  /** how much of this class's colour is seasonal: 1 = cures completely, 0 = evergreen woody */
  cures: number
}

/**
 * One LANDFIRE-derived ground class -> how it is drawn.
 *
 * Every row is a statement about a plant community, and the community was chosen by the data. The
 * one judgement here is what a community looks like, which is the same judgement species.ts makes
 * for trees and for the same reason: no public dataset ships a blade width.
 */
export const GROUND_COVER: Record<GroundClass, CoverLook> = {
  mown: { grass: 'common', blades: 1, floor: 'bare', cures: 1 },
  perennial_grass: { grass: 'meadow', blades: 1, floor: 'thatch', cures: 0.85 },
  // the brown one. Standing dead stems over a mat of last year's thatch; the thatch is what you
  // are actually looking at on a bare hillside, and it is straw-coloured all summer
  annual_grass: { grass: 'annual', blades: 1, floor: 'thatch', cures: 1 },
  forb: { grass: 'meadow', blades: 0.8, floor: 'thatch', cures: 0.9 },
  crop: { grass: 'wheat', blades: 1, floor: 'bare', cures: 1 },
  marsh: { grass: 'coastal', blades: 1.1, floor: 'bare', cures: 0.5 },
  // chaparral and coastal sage: woody, grey-green, and the ground under it is leaf litter and
  // gravel rather than turf. Very few blades — what reads as texture is the shrub, not grass
  evergreen_scrub: { grass: 'heath', blades: 0.35, floor: 'chaparral', cures: 0.15 },
  deciduous_scrub: { grass: 'meadow', blades: 0.5, floor: 'chaparral', cures: 0.8 },
  mixed_scrub: { grass: 'heath', blades: 0.45, floor: 'chaparral', cures: 0.45 },
  // blueberry barrens on granite: low, dense, and it turns crimson in October rather than straw
  dwarf_heath: { grass: 'heath', blades: 0.9, floor: 'ledge', cures: 0.5 },
  conifer_duff: { grass: 'common', blades: 0.15, floor: 'conifer_duff', cures: 0.3 },
  hardwood_litter: { grass: 'common', blades: 0.3, floor: 'hardwood_litter', cures: 1 },
  broadleaf_evergreen_litter: { grass: 'common', blades: 0.2, floor: 'broadleaf_evergreen_litter', cures: 0.3 },
  mixed_litter: { grass: 'common', blades: 0.3, floor: 'mixed_litter', cures: 0.8 },
  dune: { grass: 'coastal', blades: 0.5, floor: 'sand', cures: 0.6 },
  ledge: { grass: 'heath', blades: 0.2, floor: 'ledge', cures: 0.3 },
  barren: { grass: 'common', blades: 0.05, floor: 'bare', cures: 0.5 },
  water: { grass: 'common', blades: 0, floor: 'bare', cures: 0 },
}

/**
 * Latitude and longitude from a UTM bake frame. Approximate on purpose — it decides which side of
 * the warm/cool-season line a site is on, a question whose answer changes over hundreds of
 * kilometres, so the ~0.3° a spherical inverse costs does not matter.
 */
export function latLonOf(manifest: Manifest): { lat: number; lon: number } | null {
  const epsg = manifest.frame?.epsg
  const origin = manifest.frame?.origin
  if (!epsg || !origin) return null
  const north = epsg >= 32601 && epsg <= 32660
  const zone = north ? epsg - 32600 : epsg >= 32701 && epsg <= 32760 ? epsg - 32700 : 0
  if (!zone) return null
  const [easting, northing] = origin
  const lat = ((north ? northing : northing - 10_000_000) / 0.9996) / 110946.26
  const lon = -183 + 6 * zone + (easting - 500_000) / 0.9996 / (111_320 * Math.cos((lat * Math.PI) / 180))
  return { lat, lon }
}

/** Shoelace area of a landuse ring, m². */
function ringArea(ring: [number, number][]): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return Math.abs(a) / 2
}

/**
 * The grass this site grows from the OSM land use alone — the FALLBACK, for a bake with no flora
 * layer. It was the whole mechanism until 2026-09-21 and it is why everything looked mid-Atlantic:
 * it can tell a beach from a farm, and nothing else.
 */
export function grassTypeFor(manifest: Manifest): GrassType {
  const by = new Map<string, number>()
  for (const l of manifest.landuse ?? []) by.set(l.class, (by.get(l.class) ?? 0) + ringArea(l.ring as [number, number][]))
  const area = (k: string) => by.get(k) ?? 0
  const total = [...by.values()].reduce((t, v) => t + v, 0)

  // a beach or a dune field beside the road, wherever it is
  if (area('beach') + area('sand') > 0.05 * Math.max(1, total)) return 'coastal'

  const ll = latLonOf(manifest)
  // The warm-season transition zone runs across the United States at roughly 36°N in the east and
  // lifts into the desert southwest, where bermuda and its relatives are the roadside grass well
  // up the California coast.
  if (ll && (ll.lat < 36 || (ll.lon < -114 && ll.lat < 38.5))) return 'bermuda'

  // farmland (or its farmyards) taking a real share of the corridor: a crop verge, gone to seed
  if (area('farmland') + area('farmyard') > 0.3 * Math.max(1, total)) return 'wheat'
  return 'common'
}

export interface SiteCover {
  /** the commonest OPEN-GROUND class in the corridor: what the verge is */
  open: GroundClass
  /** the commonest class UNDER CANOPY: what the forest floor is painted with */
  under: GroundClass
  grass: GrassType
  floor: FloorKind
  source: 'flora' | 'landuse'
}

const OPEN: GroundClass[] = ['mown', 'perennial_grass', 'annual_grass', 'forb', 'crop', 'evergreen_scrub', 'deciduous_scrub', 'mixed_scrub', 'dwarf_heath', 'dune', 'ledge', 'marsh']
const UNDER: GroundClass[] = ['conifer_duff', 'hardwood_litter', 'broadleaf_evergreen_litter', 'mixed_litter']

/**
 * What this site's verge and forest floor are.
 *
 * Two answers, not one, because the corridor has two grounds: the open verge beside the pavement
 * and the floor under the canopy that starts ten metres further out. The verge is the heaviest
 * OPEN class by area and the floor is the heaviest TREE class — `mown` is excluded from the verge
 * vote when anything else is available, because "Developed-Roads" is by construction a large share
 * of every corridor we bake and it would win everywhere.
 */
export function siteCover(manifest: Manifest, flora: Flora | null): SiteCover {
  if (flora) {
    const w = new Map<GroundClass, number>()
    for (const c of flora.block.ground.classes) w.set(c.key, c.weight)
    const best = (from: GroundClass[]): GroundClass | null => {
      let top: GroundClass | null = null
      let hi = 0
      for (const k of from) {
        const v = w.get(k) ?? 0
        if (v > hi) {
          hi = v
          top = k
        }
      }
      return top
    }
    const open = best(OPEN.filter((k) => k !== 'mown')) ?? best(OPEN) ?? 'mown'
    const under = best(UNDER) ?? 'mixed_litter'
    return { open, under, grass: GROUND_COVER[open].grass, floor: GROUND_COVER[under].floor, source: 'flora' }
  }
  const g = grassTypeFor(manifest)
  return { open: 'perennial_grass', under: 'hardwood_litter', grass: g, floor: 'hardwood_litter', source: 'landuse' }
}

// ---------------------------------------------------------------------------------------------
// the ground textures
//
// STILL PLACEHOLDERS, and deliberately cheap ones, exactly as the single oak-hickory canvas they
// replace was. Main's brief (inbox 002) is that the real ground sets come out of flux.2 through
// `tools/surfaces/gen.py`, one per class per region, with colour, normal and height and three
// variants each. What has changed is that there is now a CLASS to generate for, named by the data:
// Acadia asks for spruce duff and granite-and-lichen, Big Sur for chaparral litter and straw
// thatch, Chesterfield for the oak-hickory litter that used to be painted everywhere. Swap the
// textures, keep the selection.
//
// Each tiles, because every element is drawn nine times, once per wrap of the torus.

interface FloorRecipe {
  /** base soil/rock, mottled */
  base: string
  mottle: [number, number, number]
  /** the litter elements: colour, count, size range, and how elongated they are */
  litter: [number, number, number][]
  count: number
  size: [number, number]
  aspect: [number, number]
  /** twigs / stems */
  twigs: number
  grain: number
}

const FLOOR: Record<FloorKind, FloorRecipe> = {
  // piedmont oak-hickory: broad flat leaves, browns through russet to olive, deep loam
  hardwood_litter: { base: '#3d3024', mottle: [40, 32, 22], litter: [[122, 82, 42], [146, 102, 50], [101, 72, 38], [138, 116, 58], [92, 84, 44], [160, 118, 62], [78, 60, 34]], count: 9000, size: [4, 13], aspect: [0.42, 0.72], twigs: 260, grain: 34 },
  // spruce-fir duff: NEEDLES. Thin, dark, red-brown, and there are a great many of them — the
  // floor of an Acadian spruce stand is a mat with no mineral soil showing and almost no plants
  conifer_duff: { base: '#33251a', mottle: [34, 26, 18], litter: [[96, 62, 34], [112, 74, 40], [78, 50, 28], [124, 88, 50], [66, 44, 26]], count: 16000, size: [5, 16], aspect: [0.08, 0.16], twigs: 420, grain: 26 },
  // bay laurel, live oak and tanoak: small, stiff, leathery leaves that stay olive as they dry
  broadleaf_evergreen_litter: { base: '#3a3126', mottle: [42, 36, 26], litter: [[104, 92, 52], [124, 108, 62], [86, 78, 46], [138, 118, 70], [72, 68, 42]], count: 11000, size: [3, 9], aspect: [0.3, 0.55], twigs: 300, grain: 30 },
  mixed_litter: { base: '#382c20', mottle: [38, 30, 21], litter: [[116, 80, 42], [104, 70, 36], [96, 62, 34], [134, 106, 56], [84, 74, 42]], count: 12000, size: [4, 12], aspect: [0.2, 0.55], twigs: 340, grain: 32 },
  // under chaparral: gravel and grit with hard little leaves and a lot of bare mineral ground.
  // It reads GREY, which is most of what separates a California hillside from an eastern one
  chaparral: { base: '#6b6050', mottle: [96, 88, 74], litter: [[120, 112, 88], [92, 86, 66], [138, 128, 100], [78, 80, 62], [150, 140, 116]], count: 6000, size: [3, 8], aspect: [0.3, 0.6], twigs: 520, grain: 40 },
  // granite with lichen: pale grey rock, crusty grey-green and rust patches, very little organic
  ledge: { base: '#8d8b86', mottle: [140, 138, 134], litter: [[168, 172, 150], [126, 136, 112], [186, 182, 170], [148, 126, 96], [110, 112, 104]], count: 3400, size: [8, 30], aspect: [0.7, 1.0], twigs: 60, grain: 26 },
  // dune sand: pale, almost featureless, a little shell and dry stem
  sand: { base: '#cdbd9d', mottle: [206, 192, 162], litter: [[214, 202, 176], [188, 172, 142], [226, 216, 194]], count: 2600, size: [2, 6], aspect: [0.5, 1.0], twigs: 90, grain: 18 },
  // cured annual grassland: a mat of last year's flattened straw, which is the actual colour of a
  // brown California hill — paler and yellower than any leaf litter
  thatch: { base: '#8f7c4e', mottle: [154, 134, 86], litter: [[198, 176, 116], [176, 152, 96], [212, 194, 140], [158, 136, 86], [186, 168, 112]], count: 14000, size: [8, 26], aspect: [0.05, 0.12], twigs: 180, grain: 24 },
  bare: { base: '#4a4034', mottle: [64, 56, 44], litter: [[86, 74, 56], [70, 62, 48]], count: 2000, size: [4, 12], aspect: [0.4, 0.8], twigs: 60, grain: 30 },
}

/**
 * A ground texture for one cover class, painted once to a tiling canvas.
 *
 * The recipe (element colour, count, size and ASPECT) is what separates the classes: a spruce
 * needle is a 12:1 sliver, an oak leaf is 2:1, a chaparral leaf is small and stiff, cured wild oat
 * is a 10:1 straw. Getting that right matters more than the colours do, because it is what decides
 * whether the floor reads as a mat or as mud when the eye is a metre from it.
 */
export function floorTexture(kind: FloorKind = 'hardwood_litter', size = 1024): THREE.Texture {
  const r = FLOOR[kind] ?? FLOOR.hardwood_litter
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')!
  let seed = 20260921
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  ctx.fillStyle = r.base
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 2600; i++) {
    const rad = 6 + rnd() * 46
    ctx.fillStyle = `rgba(${(r.mottle[0] + rnd() * 34) | 0},${(r.mottle[1] + rnd() * 26) | 0},${(r.mottle[2] + rnd() * 18) | 0},0.5)`
    ctx.beginPath()
    ctx.arc(rnd() * size, rnd() * size, rad, 0, 6.2832)
    ctx.fill()
  }
  for (let i = 0; i < r.count; i++) {
    const x = rnd() * size, y = rnd() * size
    const a = rnd() * Math.PI
    // ~3–9 cm across at the shader's 2 m tile: litter is small and there is a great deal of it
    const w = r.size[0] + rnd() * (r.size[1] - r.size[0])
    const h = w * (r.aspect[0] + rnd() * (r.aspect[1] - r.aspect[0]))
    const c = r.litter[(rnd() * r.litter.length) | 0]
    const k = 0.72 + rnd() * 0.5
    ctx.fillStyle = `rgba(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0},${0.55 + rnd() * 0.45})`
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        ctx.save()
        ctx.translate(x + dx, y + dy)
        ctx.rotate(a)
        ctx.beginPath()
        ctx.ellipse(0, 0, w, h, 0, 0, 6.2832)
        ctx.fill()
        ctx.restore()
      }
    }
  }
  ctx.lineCap = 'round'
  for (let i = 0; i < r.twigs; i++) {
    const x = rnd() * size, y = rnd() * size, a = rnd() * Math.PI, len = 12 + rnd() * 52
    ctx.strokeStyle = `rgba(${(52 + rnd() * 26) | 0},${(40 + rnd() * 20) | 0},${(28 + rnd() * 14) | 0},0.8)`
    ctx.lineWidth = 1 + rnd() * 2.2
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        ctx.beginPath()
        ctx.moveTo(x + dx, y + dy)
        ctx.lineTo(x + dx + Math.cos(a) * len, y + dy + Math.sin(a) * len)
        ctx.stroke()
      }
    }
  }
  // fine grain: without it the litter turns to flat blobs the moment the eye is a metre away
  const d = ctx.getImageData(0, 0, size, size)
  const px = d.data
  for (let i = 0; i < px.length; i += 4) {
    const n = (rnd() - 0.5) * r.grain
    px[i] = Math.max(0, Math.min(255, px[i] + n))
    px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + n))
    px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + n * 0.7))
  }
  ctx.putImageData(d, 0, 0)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 8
  return tex
}

/** Kept for callers that only want the old single texture. */
export function forestFloorTexture(size = 1024): THREE.Texture {
  return floorTexture('hardwood_litter', size)
}
