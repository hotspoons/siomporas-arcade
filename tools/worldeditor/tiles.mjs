// The OSM tile cache: one file per (layer, z, x, y), trimmed and simplified on the way in.
//
// WHY A TILE AND NOT A VIEWPORT. The first design cached whatever box the screen happened to be,
// which means every pan is a box nobody has ever asked for and therefore a miss. Quantising to a
// fixed grid makes panning free after the first look, makes the cache bounded and inspectable
// (`du -sh` per layer tells you what the world costs), and means two people looking at the same
// place share the work. It is the same geographic quadtree as `packages/engine/src/geo/wgs84.ts`
// and trailworks, so the ids mean the same thing across the project.
//
// The Overpass response cache (`overpass.mjs`) is still there and still keyed the way `osm.py`
// keys it — that one exists so the BAKE gets the editor's queries for free. This is a second,
// higher cache of the trimmed result, because what the map draws is a twentieth of what Overpass
// sent and re-trimming it on every read would be silly.
//
// Tiles are fetched ONE AT A TIME per layer, not in parallel. Overpass is a shared service and a
// screen can touch nine tiles; firing nine at once is how a public mirror decides it has heard
// enough from you. The client gets them as they land.

import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { layerById, tileBounds, variantOf } from './layers.mjs'

export class Tiles {
  constructor(store, overpass) {
    this.store = store
    this.overpass = overpass
    this.root = path.join(store.root, 'cache', 'osmtiles')
    this.inflight = new Map()
    /** Per-layer serialisation, so one screenful is a queue rather than a stampede. */
    this.queues = new Map()
  }

  /**
   * The variant's key is part of the file name, not just the tile id — see `variantOf`. Two
   * different questions about the same tile are two different files.
   */
  file(layerId, z, x, y, zoom) {
    const layer = layerById(layerId)
    const key = layer ? variantOf(layer, zoom).key : 'a'
    return path.join(this.root, layerId, String(z), String(x), `${y}.${key}.json`)
  }

  async #queue(layer, fn) {
    const prev = this.queues.get(layer) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.queues.set(
      layer,
      next.catch(() => {}),
    )
    return next
  }

  /**
   * One tile, from the cache or from Overpass.
   *
   * Identical in-flight requests are coalesced: a client asking for nine tiles while a previous
   * pan is still fetching three of them must not queue them twice.
   */
  async tile(layerId, z, x, y, zoom, { refresh = false } = {}) {
    const layer = layerById(layerId)
    if (!layer) throw Object.assign(new Error(`no layer "${layerId}"`), { status: 404 })
    const file = this.file(layerId, z, x, y, zoom)
    if (!refresh) {
      const hit = await readFile(file, 'utf8').catch(() => null)
      if (hit) return { ...JSON.parse(hit), cache: 'hit' }
    }
    if (this.inflight.has(file)) return this.inflight.get(file)

    const p = this.#queue(layerId, async () => {
      const bounds = tileBounds(z, x, y)
      const v = variantOf(layer, zoom)
      const t0 = Date.now()
      const res = await this.overpass.run(layer.query(bounds, v), { bbox: bounds, refresh })
      const raw = res.elements ?? []
      const items = layer.trim(raw, v)
      const doc = {
        layer: layerId,
        z,
        x,
        y,
        bounds,
        kind: layer.kind,
        variant: v.key,
        items,
        raw: raw.length,
        seconds: Math.round((Date.now() - t0) / 100) / 10,
        upstream: res._upstream ?? null,
        fetched: new Date().toISOString(),
      }
      // A PROVISIONAL answer is never written. `overpass.run` marks an empty result it could not
      // get corroborated — every other upstream timed out, the deadline ran out — and writing that
      // as a tile bakes "there is nothing here" into the volume permanently, because a cache hit
      // does not ask again. One slow afternoon would leave the Alps blank for ever.
      if (res._provisional) {
        return { ...doc, cache: 'miss', provisional: true, tried: res._tried ?? [], note: 'no upstream could confirm this is really empty — not cached, it will be asked again' }
      }
      // THE TRIM ATE EVERYTHING. Overpass sent a full response and nothing survived the trim: that
      // is a mismatch between the QUERY and the trim, not a fact about the world. It happened for
      // real — `out tags` returns place nodes with no coordinates, the trim requires a position,
      // and 3 751 cities became an empty tile that cached like any other. Data-shaped bugs are
      // invisible precisely because the result is well-formed, so this refuses to cache and says
      // which layer is wrong.
      if (raw.length > 0 && items.length === 0) {
        console.warn(`worldeditor: layer "${layerId}" trimmed ${raw.length} elements to nothing — the query and the trim disagree`)
        return {
          ...doc,
          cache: 'miss',
          provisional: true,
          note: `the ${layerId} layer received ${raw.length} elements and kept none of them — that is a bug in this layer, not an empty area. Not cached.`,
        }
      }
      await mkdir(path.dirname(file), { recursive: true })
      await this.store.writeAtomic(file, Buffer.from(JSON.stringify(doc)))
      return { ...doc, cache: 'miss' }
    }).finally(() => this.inflight.delete(file))

    this.inflight.set(file, p)
    return p
  }

  /** The tile half of the cure — see `Overpass.purgeEmpty`. A tile with no items is re-askable. */
  async purgeEmpty() {
    const { rm } = await import('node:fs/promises')
    const removed = []
    const walk = async (dir) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const f = path.join(dir, e.name)
        if (e.isDirectory()) {
          await walk(f)
          continue
        }
        const doc = await readFile(f, 'utf8').then(JSON.parse).catch(() => null)
        if (doc && !doc.items?.length) {
          await rm(f, { force: true })
          removed.push({ layer: doc.layer, z: doc.z, x: doc.x, y: doc.y, from: doc.upstream ?? null })
        }
      }
    }
    await walk(this.root)
    return removed
  }

  /** What is on the volume, per layer — so "maintain a cache" is a thing you can look at. */
  async stats() {
    const out = []
    for (const layer of await readdir(this.root).catch(() => [])) {
      let tiles = 0
      let bytes = 0
      const walk = async (dir) => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const f = path.join(dir, e.name)
          if (e.isDirectory()) await walk(f)
          else {
            tiles++
            bytes += (await stat(f)).size
          }
        }
      }
      await walk(path.join(this.root, layer))
      out.push({ layer, tiles, bytes })
    }
    return out.sort((a, b) => b.bytes - a.bytes)
  }
}
