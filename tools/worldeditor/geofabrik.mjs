// The Geofabrik extract index: what regions exist, their outlines, where their .pbf and diff
// stream are. It is the catalogue the OSM data dialog picks from and the source of every
// coverage polygon (coverage.mjs).
//
// https://download.geofabrik.de/index-v1.json is ~3.8 MB with geometry, 554 regions on
// 2026-10-10, and changes when Geofabrik adds a region — months apart. So it is fetched at most
// once a week onto the volume and read from there; a pod with no route out still has the copy it
// last read, and a NEW volume with no route out has `geofabrik-seed.json`, five regions vendored
// so that routing the deployment's own instances never depends on reaching Germany at boot.
//
// Each region's `geometry` is exactly the polygon its extract is cut with: maryland.poly against
// the index geometry, symmetric difference 0.000000 of its area (measured 2026-10-10).

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const INDEX_URL = 'https://download.geofabrik.de/index-v1.json'
const UA = 'apex-conduit corridor (github.com/hotspoons; road-corridor extraction for a driving game)'

export class Geofabrik {
  /**
   * @param dataDir the volume; the copy is `<data>/overpass/geofabrik-index.json`
   * @param o.fetch injectable, for the tests
   */
  constructor(dataDir, { url = INDEX_URL, maxAgeMs = 7 * 86400e3, fetch: f = globalThis.fetch, seed = path.join(HERE, 'geofabrik-seed.json') } = {}) {
    this.file = path.join(dataDir, 'overpass', 'geofabrik-index.json')
    this.url = url
    this.maxAgeMs = maxAgeMs
    this.fetch = f
    this.seed = seed
    this.doc = null
    this.source = null
    this.sizes = new Map()
    this.inflight = null
  }

  /**
   * The index, from memory, the volume, Geofabrik, or the seed — in that order of preference.
   *
   * `offline` never goes to the network: the volume's copy whatever its age, else the seed. That is
   * what start-up uses, so a pod that cannot reach Geofabrik is not held for a minute before it
   * serves, and the deployment's own instances are routed from the first request.
   */
  async index({ refresh = false, offline = false } = {}) {
    if (this.doc && !refresh && (offline || this.source !== 'seed')) return this.doc
    if (offline) {
      const vol = await readJson(this.file)
      if (vol) return this.#use(vol, 'volume')
      const seed = await readJson(this.seed)
      if (seed) return this.#use(seed, 'seed')
      throw new Error('no Geofabrik index on the volume and no seed')
    }
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      const age = await stat(this.file).then((s) => Date.now() - s.mtimeMs).catch(() => Infinity)
      if (!refresh && age < this.maxAgeMs) {
        const doc = await readJson(this.file)
        if (doc) return this.#use(doc, 'volume')
      }
      try {
        const r = await this.fetch(this.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const doc = await r.json()
        // content, not status: a 200 with no features is the silent-success family again
        if (!Array.isArray(doc?.features) || doc.features.length < 50) throw new Error(`index has ${doc?.features?.length ?? 0} regions`)
        await mkdir(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.${process.pid}.tmp`
        await writeFile(tmp, JSON.stringify(doc))
        await rename(tmp, this.file)
        return this.#use(doc, 'geofabrik')
      } catch (e) {
        const doc = (await readJson(this.file)) ?? (await readJson(this.seed))
        if (!doc) throw e
        return this.#use(doc, (await readJson(this.file)) ? 'volume (stale; Geofabrik did not answer)' : 'seed (Geofabrik did not answer)')
      }
    })().finally(() => { this.inflight = null })
    return this.inflight
  }

  #use(doc, source) {
    this.doc = doc
    this.source = source
    this.byId = new Map(doc.features.map((f) => [f.properties.id, f]))
    return doc
  }

  /** One region's feature, geometry and all, or null. The seed answers when the index cannot. */
  async region(id, { offline = false } = {}) {
    await this.index({ offline }).catch(() => null)
    const hit = this.byId?.get(id)
    if (hit) return hit
    const seed = await readJson(this.seed)
    return seed?.features?.find((f) => f.properties.id === id) ?? null
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
      })),
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

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}
