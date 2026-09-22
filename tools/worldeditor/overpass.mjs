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
  /**
   * @param timeoutMs  per ATTEMPT. The largest real road query measured cold was 79 s
   *                   (0.15 x 0.21 degrees, 4 721 ways), so this has to be generous; 180 s was
   *                   generous to the point of being a hazard — see `#down`.
   * @param deadlineMs for the whole call, across every upstream. Without one, ten attempts at the
   *                   per-attempt timeout is half an hour of a page saying "reading OSM".
   */
  constructor(store, urls, { timeoutMs = 120000, deadlineMs = 240000, downForMs = 45000 } = {}) {
    this.store = store
    const parsed = urls.filter(Boolean).map(parseUpstream).filter((u) => {
      try {
        new URL(u.url)
        return true
      } catch {
        // A malformed entry used to travel all the way to `new URL(url).host` inside the retry
        // loop and throw there, which reads as "overpass failed" rather than "your configuration
        // is wrong". Refuse it here, by name, once.
        console.warn(`overpass: ignoring "${u.url}" — not a URL. Upstreams are comma-separated; a coverage box is #south/west/north/east on the end of one.`)
        return false
      }
    })
    this.urls = parsed.map((u) => u.url)
    /**
     * An upstream's declared extent, `url -> {south, west, north, east}`, from
     * `https://host/api/interpreter#38.9,-79.5,39.8,-75.0`.
     *
     * THE SILENT EMPTY, which is the reason this exists. Our own instance holds one region. Asked
     * for the Stelvio Pass it answers **HTTP 200 with zero ways** — not an error, not a 404, a
     * success with nothing in it. The rotation below turns on an exception or a non-2xx and
     * neither fires, so a regional instance placed first silently reports that Italy has no roads
     * and the editor draws an empty map over the Alps. Measured by the overpass lane on
     * 2026-09-22; see docs/corridor/OVERPASS-PLANET.md.
     *
     * So a regional upstream declares what it holds and is SKIPPED for a box it does not contain.
     * Nothing is inferred: an upstream with no declared coverage is assumed to hold everything,
     * because that is what a public mirror does and what our own will do once it holds the planet.
     */
    this.coverage = new Map(parsed.filter((u) => u.bbox).map((u) => [u.url, u.bbox]))
    this.timeoutMs = timeoutMs
    this.deadlineMs = deadlineMs
    this.downForMs = downForMs
    this.inflight = new Map()
    /**
     * Upstreams that just failed, and when.
     *
     * A HANGING upstream costs a full `timeoutMs` before anything else is tried, and while our own
     * Overpass is being rebuilt that is the normal state, not the exception — every pan of the map
     * would pay it. So a failure is remembered for `downForMs` and that upstream is SKIPPED with no
     * wait at all until the memo expires. Costs nothing when everything is healthy (nothing fails,
     * so nothing is memoed), and turns "every query takes two minutes" into "one query a minute
     * takes two minutes, the rest are immediate".
     *
     * Deliberately not a background health check: a poller that says an upstream is up tells you
     * about a moment that has passed, and this only ever needs to know about failures it has just
     * seen for itself.
     */
    this.down = new Map()
  }

  /** True when this upstream failed recently enough that trying it again is just waiting. */
  #skip(url) {
    const at = this.down.get(url)
    if (at === undefined) return false
    if (Date.now() - at < this.downForMs) return true
    this.down.delete(url)
    return false
  }

  get configured() {
    return this.urls.length > 0
  }

  describe() {
    return {
      urls: this.urls,
      coverage: Object.fromEntries([...this.coverage].map(([u, b]) => [new URL(u).host, b])),
      cache: this.store.overpassCache,
    }
  }

  /** Is the first upstream answering? A slow extract is normal; a 503 is nginx with no pod. */
  async available() {
    if (!this.configured) return { ok: false, detail: 'no upstream configured' }
    const [first] = await this.probe(1)
    return { ok: first.ok, status: first.status, ms: first.ms, detail: first.detail, url: first.url }
  }

  /**
   * Probe each upstream IN ORDER and say what it answered.
   *
   * This exists to answer one question a person actually asks — "is it using ours or did it fall
   * back?" — without reading a log. `available()` only ever probed the first URL, which reports
   * that OURS is down while saying nothing about whether anything else is up, and the page then
   * works perfectly for reasons nobody can see.
   */
  async probe(limit = this.urls.length) {
    const out = []
    for (const url of this.urls.slice(0, limit)) {
      const t0 = Date.now()
      try {
        const r = await fetch(`${url}?data=${encodeURIComponent('[out:json][timeout:10];out count;')}`, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(15000),
        })
        const body = await r.text()
        if (r.ok) this.down.delete(url)
        out.push({ url, host: new URL(url).host, ok: r.ok, status: r.status, ms: Date.now() - t0, detail: r.ok ? undefined : body.slice(0, 120).replace(/\s+/g, ' '), skipping: this.#skip(url) })
      } catch (e) {
        out.push({ url, host: new URL(url).host, ok: false, ms: Date.now() - t0, detail: String(e.message ?? e) })
      }
    }
    return out
  }

  /** Which upstream is ours, for a UI that wants to say "fell back to a public mirror". */
  get ours() {
    return this.urls[0] ?? null
  }

  /**
   * Run a query, answering from the shared cache when it is there.
   *
   * Identical queries in flight are coalesced: dragging the map fires the same box repeatedly and
   * without this each drag would be its own 20-second query against our one extract.
   */
  /** Does this upstream hold the box being asked about? No declaration means "assume yes". */
  #covers(url, bbox) {
    const c = this.coverage.get(url)
    if (!c || !bbox) return true
    return bbox.south >= c.south && bbox.north <= c.north && bbox.west >= c.west && bbox.east <= c.east
  }

  async run(query, { refresh = false, bbox = null } = {}) {
    const file = this.store.cacheFile(query)
    if (!refresh) {
      const hit = await readFile(file, 'utf8').catch(() => null)
      if (hit) {
        // Who answered it originally, if we were the ones who stored it. A file osm.py wrote has
        // no sidecar, and saying "unknown" is the honest answer there rather than claiming ours.
        const prov = await readFile(`${file}.upstream`, 'utf8').then(JSON.parse).catch(() => null)
        return { ...JSON.parse(hit), _cache: 'hit', _upstream: prov?.host ?? null, _fellBack: prov ? prov.url !== this.urls[0] : null }
      }
    }
    if (this.inflight.has(file)) return this.inflight.get(file)
    const p = (async () => {
      if (!this.configured) throw Object.assign(new Error('no Overpass upstream configured (WORLDEDITOR_OVERPASS_URL)'), { status: 503 })
      const until = Date.now() + this.deadlineMs
      const tried = []
      let last = null
      /** An empty 200 we have not yet decided to believe — see the backstop below. */
      let empty = null
      for (let attempt = 0; attempt < this.urls.length * 2; attempt++) {
        const url = this.urls[attempt % this.urls.length]
        if (!this.#covers(url, bbox)) {
          tried.push(`${new URL(url).host}: does not hold this area`)
          continue
        }
        if (this.#skip(url)) {
          tried.push(`${new URL(url).host}: skipped, failed < ${Math.round(this.downForMs / 1000)}s ago`)
          continue
        }
        const left = until - Date.now()
        if (left <= 0) break
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'User-Agent': UA },
            body: query,
            signal: AbortSignal.timeout(Math.min(this.timeoutMs, left)),
          })
          const text = await r.text()
          if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
          const json = JSON.parse(text)
          this.down.delete(url)
          // THE BACKSTOP FOR AN UNDECLARED REGIONAL UPSTREAM. An empty answer is a legitimate
          // result over the sea and a LIE from an instance that does not hold the area, and the
          // two are byte-identical. So an empty answer from an upstream that is not the last one
          // is treated as inconclusive: remember it, try the next, and only believe the emptiness
          // when something else agrees or nothing else is left. Costs one extra query in the rare
          // case that the answer really is empty, and an empty query is the cheap kind.
          if (!json.elements?.length && attempt < this.urls.length - 1) {
            empty = { json, text, url }
            tried.push(`${new URL(url).host}: 200 with nothing in it — trying the next before believing it`)
            continue
          }
          // Beside the response, never inside it: the cache file has to stay byte-compatible with
          // what osm.py wrote and what osm.py will read, so the provenance goes in a sidecar.
          await this.store
            .writeAtomic(`${file}.upstream`, Buffer.from(JSON.stringify({ url, host: new URL(url).host, at: new Date().toISOString(), attempt })))
            .catch(() => {})
          // `_empty` is set on ANY empty answer, not only on one the backstop deliberated over: a
          // caller wants to know "there is nothing here", and with a single upstream configured
          // there is no deliberation to do and the answer is no less empty.
          return { ...json, _cache: 'miss', _upstream: new URL(url).host, _fellBack: url !== this.urls[0], _empty: !json.elements?.length }
        } catch (e) {
          last = e
          this.down.set(url, Date.now())
          tried.push(`${new URL(url).host}: ${String(e.message ?? e).slice(0, 90)}`)
          // Only pause before coming back round to a host already tried. Pausing between two
          // DIFFERENT hosts is pure delay — the next one has no idea the last one was busy.
          if (attempt >= this.urls.length - 1) await new Promise((r) => setTimeout(r, 4000))
        }
      }
      // Nothing better turned up, so the empty answer was the real one after all.
      if (empty) {
        await this.store.writeAtomic(file, Buffer.from(empty.text))
        await this.store
          .writeAtomic(`${file}.upstream`, Buffer.from(JSON.stringify({ url: empty.url, host: new URL(empty.url).host, at: new Date().toISOString(), empty: true })))
          .catch(() => {})
        return { ...empty.json, _cache: 'miss', _upstream: new URL(empty.url).host, _fellBack: empty.url !== this.urls[0], _empty: true }
      }
      throw Object.assign(
        new Error(`every Overpass upstream failed or was skipped — ${tried.join(' | ')}`),
        { status: 502, tried, last: String(last?.message ?? last ?? 'none') },
      )
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
    const res = await this.run(q, { ...opts, bbox })
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
    return { ways, cache: res._cache, upstream: res._upstream ?? null, fellBack: res._fellBack ?? null, empty: !!res._empty, query: q, key: this.store.cacheKey(q) }
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

/**
 * `https://host/api/interpreter` or `https://host/api/interpreter#south/west/north/east`.
 *
 * The fragment is never sent — it is not part of a URL on the wire — so it is a place to put
 * per-upstream configuration in one environment variable without inventing a second one.
 *
 * SLASHES INSIDE THE BOX, NOT COMMAS, and that is not taste. The list of upstreams is itself
 * comma-separated (matching `CORRIDOR_OVERPASS_URL`), so a comma in the box splits it into four
 * fragments: the first became a URL with a truncated fragment and the other three became
 * "upstreams" called `-79.5`, `39.8` and `-75.0`. The coverage silently did not exist and the
 * rotation tried to parse a number as a URL. Caught by the probe asking `/api/config` what
 * coverage it had actually read, which answered `{}`.
 */
function parseUpstream(raw) {
  const i = raw.indexOf('#')
  if (i < 0) return { url: raw, bbox: null }
  const url = raw.slice(0, i)
  const n = raw
    .slice(i + 1)
    .split('/')
    .map(Number)
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) {
    console.warn(`overpass: ignoring an unreadable coverage box on ${url} — want #south/west/north/east`)
    return { url, bbox: null }
  }
  return { url, bbox: { south: n[0], west: n[1], north: n[2], east: n[3] } }
}

const f = (v) => Number(v).toFixed(6)
const round7 = (v) => Math.round(v * 1e7) / 1e7
