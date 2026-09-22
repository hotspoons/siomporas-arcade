// "Find me the Stelvio Pass" — global search, which Overpass is the wrong tool for.
//
// Overpass answers questions about a BOX. A name search over the planet is a regex across every
// node in the database, which on a public mirror is either refused or is somebody else's afternoon.
// Nominatim is the OSM project's own geocoder and is the right tool: it answers a name with a
// point, a bounding box and an administrative class, which is what "fly me to Lombardy" needs.
//
// USING IT POLITELY IS PART OF THE DESIGN, not an afterthought. Nominatim's usage policy is one
// request a second, an identifying User-Agent, and no bulk work. So:
//   * every request is serialised behind a one-per-second gate;
//   * every result is cached on the volume for ever, keyed by the query — a place does not move;
//   * the editor's search box is debounced before it ever reaches here.
// A world editor makes a handful of searches a session. If that ever stops being true, the answer
// is our own Nominatim, not a faster loop.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const UA = 'apex-conduit corridor world editor (github.com/hotspoons; road-corridor extraction for a driving game)'

export class Geocoder {
  constructor(store, { url = 'https://nominatim.openstreetmap.org', minIntervalMs = 1100 } = {}) {
    this.store = store
    this.url = url.replace(/\/$/, '')
    this.minIntervalMs = minIntervalMs
    this.dir = path.join(store.root, 'cache', 'geocode')
    this.gate = Promise.resolve()
    this.last = 0
  }

  #file(q) {
    return path.join(this.dir, `${createHash('sha1').update(q.toLowerCase().trim()).digest('hex').slice(0, 16)}.json`)
  }

  /** One request a second, whatever the caller does. */
  async #polite(fn) {
    const run = this.gate.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.last)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      this.last = Date.now()
      return fn()
    })
    this.gate = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /**
   * Search, cached for ever.
   *
   * `bbox` is the interesting field and the reason this exists rather than a point lookup: a
   * country, a region or a mountain pass each come back with the extent they occupy, so the editor
   * can frame them instead of dropping a pin in the middle of Lombardy at street zoom.
   */
  async search(q, { limit = 8, refresh = false } = {}) {
    const query = String(q ?? '').trim()
    if (query.length < 2) return { places: [], cache: 'none' }
    const file = this.#file(query)
    if (!refresh) {
      const hit = await readFile(file, 'utf8').catch(() => null)
      if (hit) return { ...JSON.parse(hit), cache: 'hit' }
    }
    const url = `${this.url}/search?${new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: String(limit),
      addressdetails: '0',
    })}`
    const r = await this.#polite(() => fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }))
    if (!r.ok) throw Object.assign(new Error(`nominatim: HTTP ${r.status}`), { status: 502 })
    const raw = await r.json()
    const places = raw.map((p) => ({
      name: p.display_name,
      short: p.name || String(p.display_name).split(',')[0],
      kind: p.type,
      category: p.category,
      lat: Number(p.lat),
      lon: Number(p.lon),
      // Nominatim gives [south, north, west, east] as strings.
      bbox: p.boundingbox
        ? { south: Number(p.boundingbox[0]), north: Number(p.boundingbox[1]), west: Number(p.boundingbox[2]), east: Number(p.boundingbox[3]) }
        : null,
      importance: p.importance ?? 0,
    }))
    const doc = { query, places, source: this.url, fetched: new Date().toISOString() }
    await this.store.writeAtomic(file, Buffer.from(JSON.stringify(doc)))
    return { ...doc, cache: 'miss' }
  }

  describe() {
    return { url: this.url, minIntervalMs: this.minIntervalMs, cache: this.dir }
  }
}
