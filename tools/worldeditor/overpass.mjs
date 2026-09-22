// OSM, through our own Overpass, cached in the same place and by the same key as the bake.
//
// WHY NOT A GENERIC PROXY. The browser never sends Overpass QL. This module owns two queries — the
// drivable network in a box, and a place-name search — and builds them itself. A page that could
// post arbitrary QL could put our own extract on the floor (which is what happened to the public
// mirrors on 2026-09-21 and is the reason tools/overpass exists), and the cache key would be
// whatever a page felt like, so nothing would ever hit.
//
// THE CACHE IS THE BAKE'S CACHE. `osm.py` keys on sha1(query)[:16] under <data>/cache/overpass/,
// and so does this, on the same volume. Panning the map is free after the first look, and a
// re-pan costs one stat().
//
// WHAT THE BAKE ACTUALLY SEES, AND WHERE THIS DIFFERS. `network.roads` queries a bbox derived
// from a UTM square of side 2·radius_m about the site (`frame.bbox_wgs(ox±R, oy±R)`), NOT a
// circle — there is no circular clip on roads anywhere in the bake. That square is rotated
// relative to geodetic north by the grid convergence (1.06° at Crofton), so its geodetic bounding
// box is LARGER than the geodetic square this module draws, by about R·(cosθ + sinθ − 1). So the
// preview is CONSERVATIVE in every direction — everything it shows is inside what the bake takes,
// and the bake adds a margin. Measured against the real `corridor.geo.Frame`, by probe.mjs
// `--bbox`, which fails if any margin is negative:
//
//   crofton-triangle   -76.683, 39.004  R 2600   EPSG 32618   W +47.6  S +51.2  E +45.8  N +50.4 m
//   crofton-crownsville -76.62, 39.0    R 9000   EPSG 32618   W +166.0 S +174.5 E +145.5 N +165.0 m
//   a Big Sur centre   -121.9, 36.37    R 3000   EPSG 32610   W +32.7  S +39.8  E +34.8  N +38.9 m
//
// Zone 10 near its central meridian has less convergence than zone 18 at Crofton and a smaller
// margin, which is the check that the explanation is the right one. Reproducing the bake's box
// exactly would mean reimplementing UTM here to match a cache key — precisely the guess that
// rotated four lanes' work on 2026-09-21.

import { readFile } from 'node:fs/promises'

/** `osm.py`'s own list, so the fallback path is the one the bake already trusts. */
export const PUBLIC_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
]

// A public mirror answers 406 to a request with no User-Agent, and the polite thing on a shared
// free service is to say who is asking. Same string osm.py sends.
const UA = 'apex-conduit corridor (github.com/hotspoons; road-corridor extraction for a driving game)'

/** Every highway kind a car can drive on. Copied from `network.py` DRIVABLE — keep them equal. */
export const DRIVABLE = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]

/** And what `network.roads` drops after the query. Same list, same order, for the same reason. */
export const DROPPED = ['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'bridleway', 'service', 'track', 'proposed', 'construction']

const UNNAMED = '«unnamed»'

export class Overpass {
  /**
   * @param store  the volume, for the shared cache
   * @param urls   ours first; `osm.py` keeps the public mirrors as a fallback and so do we, because
   *               our extract is one region and a California site still needs a mirror
   */
  constructor(store, urls, { timeoutMs = 180000 } = {}) {
    this.store = store
    this.urls = urls.filter(Boolean)
    this.timeoutMs = timeoutMs
    this.inflight = new Map()
  }

  get configured() {
    return this.urls.length > 0
  }

  describe() {
    return { urls: this.urls, cache: this.store.overpassCache }
  }

  /** Is the first upstream answering? A slow extract is normal; a 503 is nginx with no pod. */
  async available() {
    if (!this.configured) return { ok: false, detail: 'no upstream configured' }
    const t0 = Date.now()
    try {
      const r = await fetch(`${this.urls[0]}?data=${encodeURIComponent('[out:json][timeout:10];out count;')}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      })
      const body = await r.text()
      return { ok: r.ok, status: r.status, ms: Date.now() - t0, detail: r.ok ? undefined : body.slice(0, 160) }
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, detail: String(e.message ?? e) }
    }
  }

  /**
   * Run a query, answering from the shared cache when it is there.
   *
   * Identical queries in flight are coalesced: dragging the map fires the same box repeatedly and
   * without this each drag would be its own 20-second query against our one extract.
   */
  async run(query, { refresh = false } = {}) {
    const file = this.store.cacheFile(query)
    if (!refresh) {
      const hit = await readFile(file, 'utf8').catch(() => null)
      if (hit) return { ...JSON.parse(hit), _cache: 'hit' }
    }
    if (this.inflight.has(file)) return this.inflight.get(file)
    const p = (async () => {
      if (!this.configured) throw Object.assign(new Error('no Overpass upstream configured (WORLDEDITOR_OVERPASS_URL)'), { status: 503 })
      let last = null
      for (let attempt = 0; attempt < this.urls.length * 2; attempt++) {
        const url = this.urls[attempt % this.urls.length]
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'User-Agent': UA },
            body: query,
            signal: AbortSignal.timeout(this.timeoutMs),
          })
          const text = await r.text()
          if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
          const json = JSON.parse(text)
          await this.store.writeAtomic(file, Buffer.from(text))
          return { ...json, _cache: 'miss' }
        } catch (e) {
          last = e
          await new Promise((r) => setTimeout(r, attempt < this.urls.length ? 2000 : 8000))
        }
      }
      throw Object.assign(new Error(`overpass failed: ${last?.message ?? last}`), { status: 502 })
    })().finally(() => this.inflight.delete(file))
    this.inflight.set(file, p)
    return p
  }

  /**
   * Every drivable way in a lon/lat box, as the bake would chain them.
   *
   * The query is `network.roads`' `all_streets` branch verbatim, and the post-filter is its drop
   * list, so what comes back here is what the bake would keep. `ident` is computed the same way
   * (name, else the first ref, else «unnamed») — that is what a `roads:` list has to name and what
   * a chain is grouped by, so the editor can show a person the actual strings to pick from.
   */
  async drivable(bbox, opts = {}) {
    const { south, west, north, east } = bbox
    const q = `[out:json][timeout:300];(way(${f(south)},${f(west)},${f(north)},${f(east)})[highway~"^(${DRIVABLE.join('|')})$"];);out geom;`
    const res = await this.run(q, opts)
    const ways = []
    for (const el of res.elements ?? []) {
      if (!el.geometry || !el.nodes) continue
      const t = el.tags ?? {}
      if (DROPPED.includes(t.highway)) continue
      ways.push({
        id: el.id,
        ident: t.name || (t.ref ? String(t.ref).split(';')[0].trim() : null) || UNNAMED,
        name: t.name ?? null,
        ref: t.ref ?? null,
        highway: t.highway,
        lanes: t.lanes ?? null,
        oneway: t.oneway ?? null,
        line: el.geometry.map((p) => [round7(p.lon), round7(p.lat)]),
      })
    }
    return { ways, cache: res._cache, query: q, key: this.store.cacheKey(q) }
  }

  /**
   * Find a place by name in the extract, so a person can type "Crofton" instead of a coordinate.
   *
   * Nominatim is not used: it is a third-party service with its own usage policy, this pod may
   * have no route to it, and our extract already holds every `place` node in the region. The
   * trade is honest and visible — this finds places in the loaded extract and nothing else, which
   * is exactly the area a bake can succeed in anyway.
   */
  async search(text, { limit = 20 } = {}) {
    const safe = String(text).replace(/["\\]/g, '').trim()
    if (safe.length < 2) return { places: [], query: null }
    const q = `[out:json][timeout:60];(node[place][name~"^${safe}",i];node[place][name~"^${safe}",i];);out tags 60;`
    const res = await this.run(q)
    const rank = { city: 0, town: 1, village: 2, suburb: 3, neighbourhood: 4, hamlet: 5, locality: 6 }
    const places = (res.elements ?? [])
      .filter((e) => e.lat != null && e.tags?.name)
      .map((e) => ({ name: e.tags.name, kind: e.tags.place, lat: e.lat, lon: e.lon, state: e.tags['is_in:state'] ?? null }))
      .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.name.localeCompare(b.name))
      .slice(0, limit)
    return { places, cache: res._cache }
  }
}

const f = (v) => Number(v).toFixed(6)
const round7 = (v) => Math.round(v * 1e7) / 1e7
