// Where is 1053 Route 3 North, and how do I get there?
//
// Rich, 2026-09-26: "We need an address search with autocomplete that pulls from the OSM data for
// a scene, and picking the address flies you to it."
//
// The data is already baked and the viewer already downloads it. `osm.geojson` is the site's raw
// OSM extract, fetched today by the minimap and by the junction-facts loader; on crofton-triangle
// it carries 3,875 features with `addr:housenumber` and `addr:street`, 1,098 with a name, and
// every road's name besides. Nothing new has to be baked, and nothing leaves the machine — this
// is a local index over a file that is already on disk, not a geocoder.
//
// THE COORDINATES ARE THE INTERESTING PART. osm.geojson is WGS84; the world is ENU metres about
// the site's frame anchor, with world = (east, up, -north). `siteProjector` is the same projector
// the minimap draws with, so a search result and the blue dot on the map cannot disagree about
// where a thing is.

import { siteProjector } from './minimap'
import type { Manifest } from '../../world/site'

export interface Hit {
  /** what to show in the list */
  label: string
  /** the smaller line under it: the street, the town, the road class */
  detail: string
  /** world position (x, y is not known here — the caller asks the ground) */
  x: number
  z: number
  kind: 'address' | 'place' | 'road'
  /** for ranking: how good a match this was */
  score: number
}

interface Entry {
  label: string
  detail: string
  x: number
  z: number
  kind: Hit['kind']
  /** lowercased haystack, built once */
  hay: string
}

const DATA_BASE = '/sites'

/** Centroid of whatever geometry a feature has, in lon/lat. */
function centroid(g: { type: string; coordinates: unknown }): [number, number] | null {
  const walk = (c: unknown, out: number[][]): void => {
    if (!Array.isArray(c)) return
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      out.push(c as number[])
      return
    }
    for (const q of c) walk(q, out)
  }
  const pts: number[][] = []
  walk(g.coordinates, pts)
  if (!pts.length) return null
  let sx = 0
  let sy = 0
  for (const p of pts) {
    sx += p[0]
    sy += p[1]
  }
  return [sx / pts.length, sy / pts.length]
}

export class SiteSearch {
  private entries: Entry[] = []
  ready = false
  counts = { address: 0, place: 0, road: 0 }

  /**
   * Build the index. Cheap enough to do on a worker-free main thread once — thirteen thousand
   * features on crofton-triangle — and `force-cache` means the file is usually already local
   * because the minimap asked for it first.
   */
  async load(manifest: Manifest): Promise<void> {
    if (this.ready) return
    const proj = siteProjector(manifest.frame as Parameters<typeof siteProjector>[0])
    const r = await fetch(`${DATA_BASE}/${manifest.slug}/osm.geojson`, { cache: 'force-cache' })
    if (!r.ok) throw new Error(`osm.geojson: ${r.status}`)
    const gj = (await r.json()) as { features?: { properties?: Record<string, string>; geometry?: { type: string; coordinates: unknown } }[] }
    // one entry per named ROAD, not per way: a road is split into dozens of ways and a list with
    // "Crofton Parkway" in it forty times is not a list
    const roadSeen = new Map<string, { x: number; z: number; n: number; cls: string }>()
    for (const f of gj.features ?? []) {
      const p = f.properties ?? {}
      const g = f.geometry
      if (!g) continue
      const c = centroid(g)
      if (!c) continue
      const [px, py] = proj(c[0], c[1])
      const x = px
      const z = -py // plan north is -worldZ

      const num = p['addr:housenumber']
      const street = p['addr:street']
      const name = p.name
      if (num && street) {
        const town = p['addr:city'] ?? ''
        this.entries.push({
          label: `${num} ${street}`,
          detail: [name, town, p['addr:postcode']].filter(Boolean).join(' · '),
          x, z, kind: 'address',
          hay: `${num} ${street} ${name ?? ''} ${town}`.toLowerCase(),
        })
        this.counts.address++
        continue
      }
      if (name && p.highway) {
        const cur = roadSeen.get(name)
        if (cur) {
          cur.x += x
          cur.z += z
          cur.n++
        } else roadSeen.set(name, { x, z, n: 1, cls: p.highway })
        continue
      }
      if (name) {
        this.entries.push({
          label: name,
          detail: [p.amenity, p.shop, p.leisure, p.building !== 'yes' ? p.building : null, p['addr:street']].filter(Boolean).join(' · ') || 'place',
          x, z, kind: 'place',
          hay: `${name} ${p.amenity ?? ''} ${p.shop ?? ''} ${p['addr:street'] ?? ''}`.toLowerCase(),
        })
        this.counts.place++
      }
    }
    for (const [name, v] of roadSeen) {
      this.entries.push({ label: name, detail: v.cls.replace(/_/g, ' '), x: v.x / v.n, z: v.z / v.n, kind: 'road', hay: name.toLowerCase() })
      this.counts.road++
    }
    this.ready = true
  }

  /**
   * Autocomplete.
   *
   * Every term must appear, so "3 north" and "north 3" both find Route 3 North, and a house number
   * narrows a street rather than fighting it. Ranking is by where the match lands and what kind of
   * thing it is: a match at the start of the label beats one in the middle, an address beats a
   * place, and a road comes last because a road is a hint, not a destination.
   */
  find(q: string, limit = 12): Hit[] {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    const kindBonus = { address: 0, place: 6, road: 12 }
    const out: Hit[] = []
    for (const e of this.entries) {
      let score = kindBonus[e.kind]
      let ok = true
      for (const t of terms) {
        const i = e.hay.indexOf(t)
        if (i < 0) {
          ok = false
          break
        }
        score += i === 0 ? 0 : i < 8 ? 2 : 5
      }
      if (!ok) continue
      out.push({ label: e.label, detail: e.detail, x: e.x, z: e.z, kind: e.kind, score })
      // an early exit would bias the list toward whatever the file happens to list first, so the
      // whole set is scored and only then cut
    }
    out.sort((a, b) => a.score - b.score || a.label.length - b.label.length || a.label.localeCompare(b.label))
    return out.slice(0, limit)
  }
}
