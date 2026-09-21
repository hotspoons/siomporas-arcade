// What kind of grass grows here.
//
// The verge of a county road in the Maryland piedmont is not the verge of a farm road in the
// Central Valley and not the dunes behind a Pacific beach, and the difference is mostly SHAPE —
// how tall, how wide, how much it leans, how tightly it packs — with colour a second-order
// tint on top of the season. So a grass type is a set of multipliers over the season palette and
// the tuning knobs, not a sixteen-cell table of hand-picked colours nobody can keep consistent.
//
//   common    cool-season roadside mix (fescue / rye / bluegrass). The reference.
//   wheat     tall, sparse, straw-coloured, heavy lean — a verge beside standing crop, and the
//             grass of a farmland site once it has gone to seed
//   bermuda   warm-season turf: low, tight, fine-bladed, holds colour into autumn and browns
//             hard in winter. The South and coastal southern California
//   coastal   dune grass: sparse clumps, tall, long lean, pale and blue-green
//
// Selection is from the bake, not from a person: the site's latitude and longitude put it in a
// warm- or cool-season region, and the OSM land use around the corridor decides between a
// roadside mix and a crop verge.
import * as THREE from 'three'
import type { Manifest } from './site'

export type GrassType = 'common' | 'wheat' | 'bermuda' | 'coastal'
export const GRASS_TYPES: GrassType[] = ['common', 'wheat', 'bermuda', 'coastal']

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
 * The grass this site grows, from the bake alone.
 *
 * Land use is weighted by AREA, not counted: one 40 ha field beside the road says more about the
 * verge than six suburban gardens, and `manifest.landuse` carries the rings to measure it with.
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

/**
 * Leaf litter, painted once to a tiling canvas.
 *
 * A PLACEHOLDER, and deliberately a cheap one. Main's brief (inbox 002) is that the real ground
 * sets come out of flux.2 through `tools/surfaces/gen.py`, one per class per region — piedmont
 * oak-hickory litter, Appalachian shale scree, coastal chaparral, rainforest moss and needles,
 * granite duff, crop stubble — with colour, normal and height and three variants each, using
 * ez-tree's `dirt_color.jpg` as the conditioning image. This is what stands in until they exist,
 * so the shader path and the CHM blend below can be built and checked now: under a closed canopy
 * a verge has to read as forest floor, and Chesterfield is 68 % closed canopy over its verge
 * (probes/corridor-canopycover.mjs). Straw-coloured turf under old-growth oak is worse than a
 * rough litter. Swap the texture, keep everything else.
 *
 * Tiles because every leaf is drawn nine times, once per wrap of the torus.
 */
export function forestFloorTexture(size = 1024): THREE.Texture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')!
  let seed = 20260921
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  // loam, mottled
  ctx.fillStyle = '#3d3024'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 2600; i++) {
    const r = 6 + rnd() * 46
    ctx.fillStyle = `rgba(${40 + rnd() * 34 | 0},${32 + rnd() * 26 | 0},${22 + rnd() * 18 | 0},0.5)`
    ctx.beginPath()
    ctx.arc(rnd() * size, rnd() * size, r, 0, 6.2832)
    ctx.fill()
  }
  // leaves: oak and hickory, browns through russet to olive, lying flat and overlapping
  const LEAF = [[122, 82, 42], [146, 102, 50], [101, 72, 38], [138, 116, 58], [92, 84, 44], [160, 118, 62], [78, 60, 34]]
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * size, y = rnd() * size
    const a = rnd() * Math.PI
    // ~3–9 cm across at the shader's 2 m tile: litter is small and there is a great deal of it
    const w = 4 + rnd() * 9, h = w * (0.42 + rnd() * 0.3)
    const c = LEAF[(rnd() * LEAF.length) | 0]
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
  // a few twigs
  ctx.lineCap = 'round'
  for (let i = 0; i < 260; i++) {
    const x = rnd() * size, y = rnd() * size, a = rnd() * Math.PI, len = 12 + rnd() * 52
    ctx.strokeStyle = `rgba(${52 + rnd() * 26 | 0},${40 + rnd() * 20 | 0},${28 + rnd() * 14 | 0},0.8)`
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
    const n = (rnd() - 0.5) * 34
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
