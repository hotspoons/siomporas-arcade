// Kept or rural: what the grass beside a road should look like, from OSM.
//
// Rich, 2026-09-26: "if something is purely residential and not mixed zoning, we could render
// grass using a tightly trimmed preset and we don't need to worry about it swaying in the wind.
// For rural or unclassified, especially B roads, we can let the grass grow much larger."
//
// OSM has no zoning, but it has two things that say the same: `landuse` polygons (the bake
// carries them as `manifest.landuse`: residential, commercial, retail, industrial, farmland,
// meadow, forest…) and every road's `highway` class. A point inside a built-up landuse polygon is
// KEPT — mown lawn everywhere, short and still. Inside farmland, meadow, forest or the like it is
// RURAL — a mown shoulder a few metres wide, then tall rough grass. Outside any polygon the road
// decides: residential, living_street and service roads are kept; everything else — unclassified,
// tertiary, secondary (the B roads), primary, trunk — is rural.

import type { Manifest } from './site'
import { BoundsIndex } from './strip'

export type Zone = 'kept' | 'rural'

const KEPT = new Set(['residential', 'commercial', 'retail', 'industrial', 'recreation_ground', 'religious', 'education', 'civic_admin', 'cemetery', 'construction', 'grass', 'flowerbed', 'military', 'garages', 'institutional', 'school', 'village_green'])
const RURAL = new Set(['farmland', 'farmyard', 'meadow', 'forest', 'orchard', 'vineyard', 'quarry', 'basin', 'greenhouse_horticulture', 'plant_nursery', 'wood', 'scrub', 'grassland', 'heath'])
const KEPT_ROADS = new Set(['residential', 'living_street', 'service'])

/** what a road class implies where no landuse polygon says otherwise */
export function zoneOfRoad(highway: string | null | undefined): Zone | null {
  if (!highway) return null
  return KEPT_ROADS.has(highway) ? 'kept' : 'rural'
}

/** a point-in-polygon classifier over the bake's landuse rings, in site (x, y) */
export interface LanduseIndex {
  /** stream another cell's (or the whole resident) rings in; the index rebuilds on the next query */
  add: (list: NonNullable<Manifest['landuse']>) => void
  /** the zone at site (x, y), or null where no polygon answers */
  zoneAt: (x: number, y: number) => Zone | null
  /** how many rings are held (diagnostics) */
  count: () => number
}

/**
 * Build the classifier over a manifest's resident `landuse`, then add streamed cells as they arrive.
 *
 * The index is rebuilt lazily — only when a query follows an `add` — so a burst of cells costs one
 * rebuild, not one per cell, and the "smaller polygons first" rule holds exactly as it did when the
 * whole array was resident.
 */
export function landuseZone(manifest: Manifest): LanduseIndex {
  type Item = { zone: Zone; ring: [number, number][]; bounds: [number, number, number, number] }
  const items: Item[] = []
  let index: BoundsIndex<Item> | null = null
  const add = (list: NonNullable<Manifest['landuse']>) => {
    let grew = false
    for (const l of list ?? []) {
      const zone: Zone | null = KEPT.has(l.class) ? 'kept' : RURAL.has(l.class) ? 'rural' : null
      if (!zone || !l.ring || l.ring.length < 3) continue
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const [x, y] of l.ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
      items.push({ zone, ring: l.ring, bounds: [x0, y0, x1, y1] })
      grew = true
    }
    if (grew) index = null
  }
  add(manifest.landuse ?? [])
  // a point OUTSIDE every polygon but within ZONE_NEAR_M of a built-up one is still in town: OSM's
  // residential polygons stop at the kerb, and the parkway threading a subdivision is not rural
  const NEAR = 40
  const nearRing = (ring: [number, number][], x: number, y: number, r: number) => {
    const r2 = r * r
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1], [bx, by] = ring[i]
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L))
      const qx = ax + u * dx - x, qy = ay + u * dy - y
      if (qx * qx + qy * qy < r2) return true
    }
    return false
  }
  const inside = (ring: [number, number][], x: number, y: number) => {
    let hit = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
    }
    return hit
  }
  const at = (x: number, y: number): Zone | null => {
    if (!index) {
      // smaller polygons first: a lawn inside a residential area is the more specific answer
      const sorted = [...items].sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]))
      index = new BoundsIndex(sorted, 250, NEAR)
    }
    return index.firstAt(x, y, (it) => (inside(it.ring, x, y) ? it.zone : null)) ?? index.firstAt(x, y, (it) => (it.zone === 'kept' && nearRing(it.ring, x, y, NEAR) ? 'kept' : null))
  }
  return { add, zoneAt: at, count: () => items.length }
}
