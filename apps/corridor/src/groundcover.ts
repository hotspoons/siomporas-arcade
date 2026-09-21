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
