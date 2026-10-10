// The Geofabrik extract index: what regions exist, their outlines, where their .pbf and diff
// stream are. It is the catalogue the OSM data dialog picks from and the source of every
// coverage polygon (coverage.mjs).
//
// https://download.geofabrik.de/index-v1.json is ~3.7 MB with geometry, 554 regions on
// 2026-10-10, and changes when Geofabrik adds a region — months apart. So it is fetched at most
// once a week onto the volume and read from there; a pod with no route out still has the copy it
// last read, and a NEW volume with no route out has `geofabrik-seed.json`, five regions vendored
// so that routing the deployment's own instances never depends on reaching Germany at boot.
//
// Each region's `geometry` is exactly the polygon its extract is cut with: maryland.poly against
// the index geometry, symmetric difference 0.000000 of its area (measured 2026-10-10).
//
// A REGION IN THE INDEX CAN HAVE NO OUTLINE. Geofabrik's index of 2026-10-10 (Last-Modified
// 03:55:30 GMT) lists japan, laos, myanmar, thailand, us/alabama, us/georgia, us/maryland,
// us/tennessee, us/virginia, us/west-virginia and uzbekistan with `"coordinates": []` (another
// mirror's copy that evening, Japan's eight sub-regions as well; virginia.poly beside it was 0
// bytes); the index of the day before had all 554, and Geofabrik's mirrors served both. The editor took
// that index, recorded Maryland's outline as nothing, and from then on the Maryland instance held
// "nothing" and every Maryland bake went to the public mirrors, which were answering 504 — with no
// problem reported anywhere. So an outline is a thing to check, region by region: a region the
// live index cannot outline keeps the outline of the copy the volume had before, else the seed's,
// and one that nobody can outline is reported (`status()`), never routed to.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasOutline } from './coverage.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const INDEX_URL = 'https://download.geofabrik.de/index-v1.json'
const UA = 'apex-conduit corridor (github.com/hotspoons; road-corridor extraction for a driving game)'

export { hasOutline }

let tmpSeq = 0

export class Geofabrik {
  /**
   * @param dataDir the volume; the copy is `<data>/overpass/geofabrik-index.json`
   * @param o.fetch   injectable, for the tests
   * @param o.retryMs after a failed fetch, how long before the network is asked again (a failed
   *                  fetch can take the whole 60 s timeout, and every lookup would otherwise wait it)
   * @param o.log     where the loud lines go
   */
  constructor(dataDir, { url = INDEX_URL, maxAgeMs = 7 * 86400e3, retryMs = 3600e3, fetch: f = globalThis.fetch, seed = path.join(HERE, 'geofabrik-seed.json'), log = console } = {}) {
    this.file = path.join(dataDir, 'overpass', 'geofabrik-index.json')
    this.url = url
    this.maxAgeMs = maxAgeMs
    this.retryMs = retryMs
    this.fetch = f
    this.seed = seed
    this.log = log
    this.doc = null
    /** 'geofabrik' (fetched by this process) | 'volume' (the copy on the volume) | 'seed' */
    this.source = null
    /** when the index in use was written by Geofabrik's fetch (ms), or null for the seed */
    this.fetchedAt = null
    this.lastAttempt = null
    /** the last fetch's failure, `{ at, message }`, cleared by a fetch that works */
    this.error = null
    /** regions the index in use lists with no outline, and the ones whose outline came from elsewhere */
    this.missing = []
    this.patched = []
    this.sizes = new Map()
    this.inflight = null
  }

  /**
   * The index, from memory, the volume, Geofabrik, or the seed — in that order of preference.
   *
   * `offline` never goes to the network: the volume's copy whatever its age, else the seed. That is
   * what start-up uses, so a pod that cannot reach Geofabrik is not held for a minute before it
   * serves, and the deployment's own instances are routed from the first request.
   *
   * Otherwise the network is asked when the copy in use is older than `maxAgeMs` or is the seed —
   * and, after a failure, not again for `retryMs`. A failure is logged and kept in `status()`; the
   * index falls back to the volume's copy or the seed, which still outline what they outline.
   */
  async index({ refresh = false, offline = false } = {}) {
    await this.#loadSeed()
    if (this.doc && !refresh && (offline || this.#current())) return this.doc
    if (offline) {
      const vol = await readJson(this.file)
      if (vol?.features) return this.#use(vol, 'volume', await this.#mtime())
      const seed = await readJson(this.seed)
      if (seed?.features) return this.#use(seed, 'seed', null)
      throw new Error('no Geofabrik index on the volume and no seed')
    }
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      const mtime = await this.#mtime()
      if (!refresh && mtime != null && Date.now() - mtime < this.maxAgeMs) {
        const doc = await readJson(this.file)
        if (doc?.features) return this.#use(doc, 'volume', mtime)
      }
      this.lastAttempt = Date.now()
      try {
        const r = await this.fetch(this.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const doc = await r.json()
        // content, not status: a 200 with no features is the silent-success family again
        if (!Array.isArray(doc?.features) || doc.features.length < 50) throw new Error(`index has ${doc?.features?.length ?? 0} regions`)
        // and a region with no outline is the same family one level down: fill it from what we had
        const previous = await readJson(this.file)
        const seed = await readJson(this.seed)
        fillOutlines(doc, [['the copy on the volume before this fetch', previous], ['the vendored seed', seed]])
        await mkdir(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp-${process.pid}-${++tmpSeq}`
        await writeFile(tmp, JSON.stringify(doc))
        await rename(tmp, this.file)
        this.error = null
        const out = this.#use(doc, 'geofabrik', Date.now())
        this.log.log?.(`geofabrik index: fetched ${doc.features.length} regions from ${this.url}${this.#outlineNote()}`)
        return out
      } catch (e) {
        this.error = { at: new Date().toISOString(), message: `${e?.message ?? e}${e?.cause?.code ? ` (${e.cause.code})` : ''}` }
        const vol = await readJson(this.file)
        const doc = vol?.features ? vol : await readJson(this.seed)
        if (!doc?.features) throw e
        this.#use(doc, vol?.features ? 'volume' : 'seed', vol?.features ? mtime : null)
        this.log.warn?.(`GEOFABRIK INDEX NOT FETCHED (${this.url}): ${this.error.message} — routing from ${this.source === 'seed' ? `the vendored seed (${doc.features.length} regions)` : `the volume's copy of ${new Date(mtime).toISOString()}`}; retrying in ${Math.round(this.retryMs / 60000)} min${this.#outlineNote()}`)
        return doc
      }
    })().finally(() => { this.inflight = null })
    return this.inflight
  }

  /** In use and good enough not to ask the network again yet. */
  #current() {
    if (this.lastAttempt != null && Date.now() - this.lastAttempt < this.retryMs) return true
    return this.source !== 'seed' && this.fetchedAt != null && Date.now() - this.fetchedAt < this.maxAgeMs
  }

  async #mtime() {
    return stat(this.file).then((s) => s.mtimeMs).catch(() => null)
  }

  #use(doc, source, fetchedAt) {
    // a copy written before outlines were checked (or by the arcade's editor) can lack some; the
    // seed fills what it can, in memory
    if (source !== 'geofabrik') fillOutlines(doc, [['the vendored seed', this.seedDoc ?? null]])
    this.doc = doc
    this.source = source
    this.fetchedAt = fetchedAt
    this.byId = new Map(doc.features.map((f) => [f.properties.id, f]))
    this.missing = doc.features.filter((f) => !hasOutline(f.geometry)).map((f) => f.properties.id)
    this.patched = doc.features.filter((f) => f.properties['corridor:outlineFrom']).map((f) => ({ id: f.properties.id, from: f.properties['corridor:outlineFrom'] }))
    return doc
  }

  #outlineNote() {
    const parts = []
    if (this.patched.length) parts.push(`${this.patched.length} outline(s) Geofabrik left empty taken from elsewhere (${this.patched.map((p) => p.id).join(', ')})`)
    if (this.missing.length) parts.push(`${this.missing.length} region(s) with NO outline, never routed to (${this.missing.join(', ')})`)
    return parts.length ? `; ${parts.join('; ')}` : ''
  }

  /** The seed, read once; `#use` needs it synchronously. */
  async #loadSeed() {
    this.seedDoc ??= await readJson(this.seed)
    return this.seedDoc
  }

  /**
   * One region's feature, geometry and all, or null. A region the index cannot outline answers
   * with the seed's feature when the seed has it; otherwise the outline-less feature, which every
   * caller must check with `hasOutline` before routing by it.
   */
  async region(id, { offline = false } = {}) {
    await this.index({ offline }).catch(() => null)
    const seed = await this.#loadSeed()
    const hit = this.byId?.get(id)
    if (hit && hasOutline(hit.geometry)) return hit
    const fromSeed = seed?.features?.find((f) => f.properties.id === id)
    return fromSeed ?? hit ?? null
  }

  /** The catalogue without geometry: what the region picker lists. */
  async list() {
    const doc = await this.index()
    return {
      source: this.source,
      regions: doc.features.map((f) => ({
        id: f.properties.id,
        name: f.properties.name,
        parent: f.properties.parent ?? null,
        pbf: f.properties.urls?.pbf ?? null,
        updates: f.properties.urls?.updates ?? null,
        outline: hasOutline(f.geometry),
      })),
    }
  }

  /**
   * Where the index came from and what is wrong with it — for /api/osm/coverage, so that "routing
   * knows nothing" is never silent. `problems` are sentences for a person.
   */
  status() {
    const problems = []
    if (this.error) {
      problems.push(`Geofabrik index not fetched (${this.error.message}, ${this.error.at}); routing from ${this.source === 'seed' ? `the vendored seed, which outlines only ${(this.seedDoc?.features ?? []).map((f) => f.properties.id).join(', ')}` : this.source === 'volume' ? `the volume's copy of ${this.fetchedAt ? new Date(this.fetchedAt).toISOString() : 'unknown date'}` : 'nothing yet'}`)
    }
    // the regions with no outline are listed, not made problems: most are regions nobody here
    // uses, and a configured one is already a problem in coverage.mjs, by name
    return {
      url: this.url,
      file: this.file,
      source: this.source,
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      lastAttempt: this.lastAttempt ? new Date(this.lastAttempt).toISOString() : null,
      error: this.error,
      regions: this.doc?.features?.length ?? 0,
      missingOutlines: this.missing,
      outlinesFromElsewhere: this.patched,
      problems,
    }
  }

  /**
   * The size of a region's .pbf, by HEAD. Geofabrik's `-latest` is a redirect to a dated file (and
   * the biggest go on to a mirror), so the redirect is followed and the LAST length is the size.
   */
  async pbfBytes(id) {
    if (this.sizes.has(id)) return this.sizes.get(id)
    const f = await this.region(id)
    const url = f?.properties?.urls?.pbf
    if (!url) return null
    try {
      const r = await this.fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })
      const n = Number(r.headers.get('content-length'))
      const out = r.ok && Number.isFinite(n) && n > 0 ? { bytes: n, url: r.url || url } : null
      if (out) this.sizes.set(id, out)
      return out
    } catch {
      return null
    }
  }
}

/**
 * Give every outline-less feature of `doc` the outline of the first source that has one, in place,
 * and say where it came from (`properties['corridor:outlineFrom']`). Returns the ids filled.
 */
export function fillOutlines(doc, sources) {
  const filled = []
  for (const f of doc?.features ?? []) {
    if (hasOutline(f.geometry)) continue
    for (const [label, src] of sources) {
      const g = src?.features?.find((x) => x.properties?.id === f.properties?.id)
      if (g && hasOutline(g.geometry)) {
        f.geometry = g.geometry
        f.properties['corridor:outlineFrom'] = g.properties?.['corridor:outlineFrom'] ?? label
        filled.push(f.properties.id)
        break
      }
    }
  }
  return filled
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}
