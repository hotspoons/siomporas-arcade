// The volume. Everything this service knows that outlives a pod restart is here.
//
// THIS FILE IS THE ANSWER TO THE BIGGEST HIDDEN PIECE OF THE JOB. The corridor editor saves its
// authored files — adjustments / placements / structures / dead_ends / tuning — with a PUT to
// `/sites/<slug>/<name>.json`, and in development that is served by a middleware inside
// `apps/corridor/vite.config.ts`. There is no Vite in a pod. Rather than change the editor, this
// service implements the SAME contract against the volume: same paths, same whitelist, same
// {ok,bytes} reply, same atomic tmp+rename. `schema.ts` and `sitetuning.ts` are untouched and
// cannot tell the difference, which is also why a bug fixed in one place stays fixed in both.
//
//   <data>/sites/<slug>/...        the bake's own output — CORRIDOR_DATA points a bake Job here
//   <data>/sites/index.json        what the viewer lists
//   <data>/cache/overpass/*.json   SHARED with the bake: same sha1(query)[:16] key (osm.py)
//   <data>/worlds/<slug>.json      a world definition drawn in the editor (superset of a site)
//   <data>/sites.json              worlds materialised as the array `corridor fetch` reads
//   <data>/runs/<id>.json|.log     bakes and publishes, and their output
//   <data>/assets/catalog.json     the placement catalog, MERGED, served at /assets/catalog.json
//
// The volume is shared with the bake on purpose (RWX). The editor writing `placements.json` and a
// Job writing `web/` into the same site directory is the whole point: nothing is copied anywhere.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * The files the editor may write beside a bake. Exactly the vite middleware's list.
 *
 * A whitelist and not a path check: the bake owns `web/` and every raster in the site directory,
 * and an editor bug that PUT over `manifest.json` would destroy a bake that cost an hour of USGS
 * bandwidth. Adding a name here is a decision about who owns that file.
 */
export const AUTHORED = ['adjustments', 'placements', 'structures', 'dead_ends', 'tuning']
const AUTHORED_RE = new RegExp(`^[a-z0-9-]+/(${AUTHORED.join('|')})\\.json$`)

export class Store {
  constructor(root) {
    this.root = path.resolve(root)
    this.sites = path.join(this.root, 'sites')
    this.worlds = path.join(this.root, 'worlds')
    this.runs = path.join(this.root, 'runs')
    this.overpassCache = path.join(this.root, 'cache', 'overpass')
    this.assets = path.join(this.root, 'assets')
  }

  async init() {
    for (const d of [this.sites, this.worlds, this.runs, this.overpassCache, this.assets]) await mkdir(d, { recursive: true })
  }

  /** Write through a temp file in the same directory, so a reader never sees a half-written JSON. */
  async writeAtomic(file, body) {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, body)
    await rename(tmp, file)
    return body.length
  }

  async readJson(file, dflt = null) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (e) {
      if (e.code === 'ENOENT') return dflt
      throw e
    }
  }

  /* ---- serving the bake, and writing back the authored files ------------------------------- */

  /**
   * Resolve a `/sites/...` request to a file, refusing anything outside the tree.
   *
   * `path.resolve` collapses `..` before the prefix check, so a traversal cannot escape by
   * spelling. Returns null rather than throwing: a caller turns that into a 404, and a 404 is what
   * an editor asking for an optional file it has never authored must get. It must NOT get an HTML
   * fallback — two agents lost time to `r.json()` choking on `<!doctype`, which is why the dev
   * middleware refuses to call next() here and why this refuses too.
   */
  fileFor(rel) {
    const clean = path.posix.normalize(decodeURIComponent(rel)).replace(/^\/+/, '')
    if (clean.startsWith('..')) return null
    const file = path.resolve(this.sites, clean)
    return file.startsWith(this.sites + path.sep) || file === this.sites ? file : null
  }

  /** True when `rel` (e.g. `crofton-triangle/placements.json`) is a file the editor may write. */
  canWrite(rel) {
    return AUTHORED_RE.test(path.posix.normalize(rel).replace(/^\/+/, ''))
  }

  /** The editor's save. Parses first: a file that is not JSON never reaches the volume. */
  async putAuthored(rel, body) {
    if (!this.canWrite(rel)) throw Object.assign(new Error(`${rel} is not an authored file — ${AUTHORED.join(', ')} only`), { status: 403 })
    const file = this.fileFor(rel)
    if (!file) throw Object.assign(new Error('path escapes the site tree'), { status: 400 })
    // Must be JSON, and must be JSON BEFORE anything is written. The status matters: an unparseable
    // body is the client's fault and a 400, and letting SyntaxError travel un-tagged made it a 500,
    // which tells a person the service is broken when their editor sent rubbish.
    try {
      JSON.parse(body.toString('utf8'))
    } catch (e) {
      throw Object.assign(new Error(`not JSON: ${e.message}`), { status: 400 })
    }
    if (!existsSync(path.dirname(file))) throw Object.assign(new Error(`no site ${path.dirname(rel)} on this volume`), { status: 404 })
    return this.writeAtomic(file, body)
  }

  /* ---- world definitions ------------------------------------------------------------------- */

  async listWorlds() {
    const out = []
    for (const f of await readdir(this.worlds).catch(() => [])) {
      if (!f.endsWith('.json')) continue
      const w = await this.readJson(path.join(this.worlds, f))
      if (w) out.push(w)
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug))
  }

  getWorld(slug) {
    return this.readJson(path.join(this.worlds, `${slug}.json`))
  }

  async putWorld(world) {
    await this.writeAtomic(path.join(this.worlds, `${world.slug}.json`), Buffer.from(JSON.stringify(world, null, 1)))
    await this.materialise()
    return world
  }

  async removeWorld(slug) {
    await rm(path.join(this.worlds, `${slug}.json`), { force: true })
    await this.materialise()
  }

  /**
   * Every world, written as the JSON array `corridor fetch` reads, at `<data>/sites.json`.
   *
   * A bake Job gets `CORRIDOR_SITES=/data/sites.json` and reads this — the chart already supports
   * overriding the image's baked-in copy, so nothing in the bake changes to accept a world that
   * was drawn ten seconds ago. The editor-only keys (`boundary`, `created`, `source`) ride along;
   * `cmd_fetch` reads by `slug` and hands the whole dict to `network.fetch_site`, which reads the
   * keys it knows. Verified against the real thing by probe.mjs `--sitesjson`.
   */
  async materialise() {
    const worlds = await this.listWorlds()
    const file = path.join(this.root, 'sites.json')
    await this.writeAtomic(file, Buffer.from(JSON.stringify(worlds, null, 1)))
    return { file, count: worlds.length }
  }

  /** First start on an empty volume: seed the worlds from a sites.json (the repo's, or the image's). */
  async seedWorlds(from) {
    if ((await readdir(this.worlds).catch(() => [])).length) return { seeded: 0, reason: 'worlds already present' }
    const arr = await this.readJson(from, null)
    if (!Array.isArray(arr)) return { seeded: 0, reason: `no array at ${from}` }
    for (const s of arr) {
      if (!s.slug) continue
      await this.writeAtomic(path.join(this.worlds, `${s.slug}.json`), Buffer.from(JSON.stringify({ ...s, source: 'seed' }, null, 1)))
    }
    await this.materialise()
    return { seeded: arr.length, from }
  }

  /**
   * Which worlds have actually been baked onto this volume, and what frame they are in.
   *
   * THE FRAME COMES FROM `web/manifest.json`, NOT FROM THE SITE MANIFEST. The site-level
   * `manifest.json` records `frame: {epsg, origin}` — the UTM zone the bake measured in — and has
   * no `kind` at all. `web/manifest.json`, which is the one the viewer reads, carries
   * `kind: "enu"`, the geodetic `anchor` and the convergence. Reading the site one and testing
   * `frame.kind !== 'enu'` put a red "this bake is in the old UTM metres" on a bake that had just
   * finished and was perfectly correct — a plausible warning about the wrong file.
   */
  async bakedSlugs() {
    const out = new Map()
    for (const d of await readdir(this.sites, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue
      const m = await this.readJson(path.join(this.sites, d.name, 'manifest.json'))
      if (!m) continue
      const web = await stat(path.join(this.sites, d.name, 'web')).then(() => true).catch(() => false)
      const wm = web ? await this.readJson(path.join(this.sites, d.name, 'web', 'manifest.json')) : null
      out.set(d.name, {
        slug: d.name,
        fetched: m.fetched ?? null,
        frame: wm?.frame ?? m.frame ?? null,
        seconds: m.seconds ?? null,
        web,
      })
    }
    return out
  }

  /* ---- the overpass cache, shared with the bake -------------------------------------------- */

  /** `osm.py`: sha1 of the query text, first 16 hex, `.json` in the same directory. */
  cacheKey(query) {
    return createHash('sha1').update(query).digest('hex').slice(0, 16)
  }

  cacheFile(query) {
    return path.join(this.overpassCache, `${this.cacheKey(query)}.json`)
  }

  /* ---- runs -------------------------------------------------------------------------------- */

  runFile(id) {
    return path.join(this.runs, `${id}.json`)
  }
  logFile(id) {
    return path.join(this.runs, `${id}.log`)
  }

  async listRuns(limit = 50) {
    const out = []
    for (const f of await readdir(this.runs).catch(() => [])) {
      if (!f.endsWith('.json')) continue
      const r = await this.readJson(path.join(this.runs, f))
      if (r) out.push(r)
    }
    return out.sort((a, b) => (a.started < b.started ? 1 : -1)).slice(0, limit)
  }

  /* ---- the placement catalog ---------------------------------------------------------------- */

  /**
   * Merge entries into the placement catalog. MERGE, NEVER REPLACE.
   *
   * `catalog.json` carries every lane's assets and has been clobbered once by a whole-file write.
   * So this reads what is there, replaces matching ids, appends the rest, and writes atomically.
   * A caller cannot express "replace the file" through this API at all, which is the point.
   */
  async mergeCatalog(entries) {
    const file = path.join(this.assets, 'catalog.json')
    const doc = (await this.readJson(file)) ?? (await this.readJson(this.catalogSeed ?? '', null)) ?? { assets: [] }
    if (!Array.isArray(doc.assets)) doc.assets = []
    const byId = new Map(doc.assets.map((a) => [a.id, a]))
    const added = []
    const updated = []
    for (const e of entries) {
      if (!e?.id) continue
      if (byId.has(e.id)) {
        Object.assign(byId.get(e.id), e)
        updated.push(e.id)
      } else {
        byId.set(e.id, e)
        doc.assets.push(e)
        added.push(e.id)
      }
    }
    await this.writeAtomic(file, Buffer.from(JSON.stringify(doc, null, 1)))
    return { file, total: doc.assets.length, added, updated }
  }

  async catalog() {
    const file = path.join(this.assets, 'catalog.json')
    return (await this.readJson(file)) ?? (await this.readJson(this.catalogSeed ?? '', null)) ?? { assets: [] }
  }
}
