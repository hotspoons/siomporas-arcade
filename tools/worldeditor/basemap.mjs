// Country outlines, so the world view is a world rather than a black rectangle.
//
// NOT FROM OVERPASS, AND NOT COMMITTED TO THE REPO.
//
// Not Overpass, because a national border there is a `relation[boundary=administrative]
// [admin_level=2]` whose geometry is the country's entire coastline at full resolution — megabytes
// per country, minutes per query, for a line that is forty pixels long at world zoom. Overpass is
// the right tool for "what is on this road" and the wrong one for "which country is that".
//
// Not committed, because the instruction was to fetch and maintain a cache, and a 200 kB blob in
// git that nobody can regenerate is the opposite of that. It is fetched ONCE, simplified, and
// written to the same volume as everything else; after that it is local for ever and works with no
// network at all. If the fetch fails the map simply has no borders and says so — a world editor
// with no coastlines is degraded, not broken.
//
// Natural Earth is public domain (explicitly: "no permission needed"), already generalised for
// exactly these zoom levels by cartographers, and 110m is the scale meant for a whole-world view.

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { simplifyGeometry } from './simplify.mjs'

const SOURCES = {
  // The Natural Earth CDN serves shapefiles; this mirror is the same data as GeoJSON, which saves
  // shipping a shapefile reader for two files we read once.
  countries: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson',
  // 50m rather than 110m: 1 251 cities worldwide against 243, which is the difference between
  // "Rome is in Italy somewhere" and a usable list of where you might want to drive. 850 kB raw,
  // ~120 kB once the twenty unused fields are dropped.
  cities: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson',
}

export class Basemap {
  constructor(store, { enabled = true } = {}) {
    this.store = store
    this.enabled = enabled
    this.dir = path.join(store.root, 'cache', 'basemap')
    this.memo = new Map()
    this.failed = new Map()
  }

  file(name) {
    return path.join(this.dir, `${name}.json`)
  }

  /**
   * The countries layer, from the volume, fetching it once if it is not there.
   *
   * Held in memory after the first read as well: it is ~150 kB simplified and every viewport at
   * world zoom wants all of it, so re-reading it off the volume per request is pure syscall.
   */
  countries() {
    return this.layer('countries')
  }

  /** World cities with population and country — the overview's place layer. */
  cities() {
    return this.layer('cities')
  }

  async layer(name) {
    if (this.memo.has(name)) return this.memo.get(name)
    const file = this.file(name)
    const local = await readFile(file, 'utf8').catch(() => null)
    if (local) {
      const doc = JSON.parse(local)
      this.memo.set(name, doc)
      return doc
    }
    if (!this.enabled) return { features: [], source: null, note: 'basemap fetching is off' }
    const failedAt = this.failed.get(name)
    // Don't re-try a failing fetch on every pan; an hour is long enough that a person who fixed
    // the network will not wait for it, because `?refresh=1` exists.
    if (failedAt && Date.now() - failedAt < 3600000) {
      return { features: [], source: null, note: `the ${name} fetch failed recently; retry with ?refresh=1` }
    }
    return this.fetch(name)
  }

  async fetch(name) {
    const url = SOURCES[name]
    if (!url) throw Object.assign(new Error(`no basemap source "${name}"`), { status: 404 })
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': UA } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const raw = await r.json()
      const doc =
        name === 'cities'
          ? {
              // Points, so nothing to simplify — but twenty-odd fields per place to throw away.
              cities: (raw.features ?? [])
                .filter((f) => f.geometry?.type === 'Point' && f.properties?.name)
                .map((f) => ({
                  name: f.properties.name,
                  country: f.properties.adm0name ?? null,
                  region: f.properties.adm1name ?? null,
                  pop: f.properties.pop_max ?? 0,
                  // Natural Earth's own importance ranking, 0 the most prominent. It is what lets
                  // a world view draw thirty cities instead of the first thirty alphabetically.
                  rank: f.properties.scalerank ?? 10,
                  lon: round4(f.geometry.coordinates[0]),
                  lat: round4(f.geometry.coordinates[1]),
                }))
                .sort((a, b) => a.rank - b.rank || b.pop - a.pop),
              source: 'Natural Earth 50m populated places (public domain) via natural-earth-vector',
              fetched: new Date().toISOString(),
            }
          : {
              // 0.02 degrees is about 2 km. Natural Earth 110m is already generalised for a
              // whole-world view, so this removes very little — the win on this layer is dropping
              // the properties and gzip, not the geometry. Kept because the same code path will
              // matter the day somebody points it at a finer scale.
              features: (raw.features ?? [])
                .map((f) => ({
                  type: 'Feature',
                  properties: { name: f.properties?.NAME ?? f.properties?.name ?? null, iso: f.properties?.ISO_A2 ?? null },
                  geometry: simplifyGeometry(f.geometry, 0.02),
                }))
                .filter((f) => f.geometry),
              source: 'Natural Earth 110m (public domain) via natural-earth-vector',
              simplified_deg: 0.02,
              fetched: new Date().toISOString(),
            }
      await this.store.writeAtomic(this.file(name), Buffer.from(JSON.stringify(doc)))
      this.memo.set(name, doc)
      this.failed.delete(name)
      return doc
    } catch (e) {
      this.failed.set(name, Date.now())
      return { features: [], source: null, note: `borders unavailable: ${String(e.message ?? e)}` }
    }
  }

  describe() {
    return { enabled: this.enabled, dir: this.dir, cached: [...this.memo.keys()], sources: Object.keys(SOURCES) }
  }
}

const UA = 'apex-conduit corridor world editor (github.com/hotspoons)'
const round4 = (v) => Math.round(v * 1e4) / 1e4
