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
//   <data>/places/<id>.json        a place somebody found and kept — the INDEX, upstream of a world
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
/**
 * What may live under `programs/`.
 *
 * A closed list rather than "anything": this directory is served to a browser and projected into
 * the shell, and a place a browser can write arbitrary filenames into is a place to put something
 * that gets executed by something else. TypeScript is the point; the rest are the files that sit
 * beside code — data it imports, notes about it, a shader it needs.
 */
const PROGRAM_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.txt', '.glsl', '.frag', '.vert', '.css', '.yaml', '.yml'])

export const AUTHORED = ['adjustments', 'placements', 'structures', 'dead_ends', 'tuning']
const AUTHORED_RE = new RegExp(`^[a-z0-9-]+/(${AUTHORED.join('|')})\\.json$`)

export class Store {
  constructor(root) {
    this.root = path.resolve(root)
    this.sites = path.join(this.root, 'sites')
    this.worlds = path.join(this.root, 'worlds')
    this.places = path.join(this.root, 'places')
    this.runs = path.join(this.root, 'runs')
    this.levels = path.join(this.root, 'levels')
    this.programs = path.join(this.root, 'programs')
    this.overpassCache = path.join(this.root, 'cache', 'overpass')
    this.assets = path.join(this.root, 'assets')
  }

  async init() {
    for (const d of [this.sites, this.worlds, this.places, this.runs, this.levels, this.programs, this.overpassCache, this.assets]) await mkdir(d, { recursive: true })
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
    await this.applyLook(world)
    return world
  }

  /**
   * A world's `look` (style, season, water level) is carried to the viewer by the site's own
   * `tuning.json` — the file the viewer already fetches per site — so a published world opens as
   * its author meant it, with no new request and nothing for the bake to know. Written when the
   * world is saved (a site that exists gets it at once) and again when a bake finishes (the bake
   * never writes tuning.json, so the first bake of a new world lands on an empty site).
   * The URL's ?style / ?season still win in the viewer, so a shared link keeps its meaning.
   */
  async applyLook(world) {
    const dir = path.join(this.sites, world.slug)
    if (!world?.slug || !existsSync(dir)) return false
    const file = path.join(dir, 'tuning.json')
    const doc = (await this.readJson(file)) ?? { version: 1, values: {} }
    if (typeof doc.values !== 'object' || doc.values === null) doc.values = {}
    const L = world.look ?? {}
    const look = {}
    if (L.style) look.style = L.style
    if (L.season) look.season = L.season
    if (Number.isFinite(L.relief) && L.relief !== 1) look.relief = L.relief
    if (Object.keys(look).length) doc.look = look
    else delete doc.look
    if (Number.isFinite(L.water_level_m)) doc.values.WATER_LEVEL_M = L.water_level_m
    else delete doc.values.WATER_LEVEL_M
    await this.writeAtomic(file, Buffer.from(JSON.stringify(doc, null, 1)))
    return true
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

  /**
   * Every file of a baked site, for an archive. Relative paths, deterministic order.
   *
   * `web/` is what a viewer needs and the rest is what a RE-BAKE needs, so both go in and the
   * caller says which. The cache is never included: it is megabytes of somebody else's data that
   * the next machine can fetch for itself.
   */
  async siteFiles(slug, { webOnly = false } = {}) {
    const root = path.join(this.sites, slug)
    const out = []
    const walk = async (rel) => {
      const here = path.join(root, rel)
      for (const d of (await readdir(here, { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const r = rel ? `${rel}/${d.name}` : d.name
        if (d.isDirectory()) {
          if (d.name === 'cache' || d.name === 'web.staging') continue
          await walk(r)
        } else if (d.isFile()) {
          if (webOnly && !r.startsWith('web/')) continue
          const st = await stat(path.join(root, r))
          out.push({ rel: r, bytes: st.size, mtime: st.mtimeMs })
        }
      }
    }
    if (!(await stat(root).then(() => true).catch(() => false))) return null
    await walk('')
    return out
  }

  /** The absolute path of one file of a baked site, refusing anything outside it. */
  siteFile(slug, rel) {
    const root = path.join(this.sites, slug)
    const f = path.resolve(root, rel)
    if (f !== root && !f.startsWith(root + path.sep)) return null
    return f
  }

  /* ---- levels: a world, dressed and given something to do ---------------------------------- */

  async listLevels() {
    const out = []
    for (const f of await readdir(this.levels).catch(() => [])) {
      if (!f.endsWith('.json')) continue
      const l = await this.readJson(path.join(this.levels, f))
      if (l) out.push(l)
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  getLevel(id) {
    return this.readJson(path.join(this.levels, `${id}.json`))
  }

  async putLevel(level) {
    await this.writeAtomic(path.join(this.levels, `${level.id}.json`), Buffer.from(JSON.stringify(level, null, 1)))
    return level
  }

  removeLevel(id) {
    return rm(path.join(this.levels, `${id}.json`), { force: true })
  }

  /* ---- programs: the code half of a level -------------------------------------------------- */
  // (PROGRAM_EXT is at the top of this file, with the other constants)
  //
  // Stage 6 of the pipeline. A level's declarative `scenario` covers the simple path; a program is
  // what you write when it runs out — hiding street names is a flag, changing transport is a
  // choice between implementations, and "define new exploration techniques" is arbitrary code.
  //
  // TYPESCRIPT ON DISK, NOT JSON. It is source, people diff it, and the editor typechecks it in
  // the browser against generated declarations (apps/corridor/src/generated/program-types.json).
  // The service does not compile it and deliberately does not try: a service that refuses to save
  // code with a type error is a service you cannot save work-in-progress to.

  /**
   * PROGRAM IDS ARE PATHS WITH THEIR EXTENSION ON, so a game can be more than one file and the
   * files can be more than one kind of thing.
   *
   * Rich, 2026-09-28: "How are you supposed to manage multiple files in the editor, there is no
   * folders and no file system and no tabs". The id was one slug with no slash in it, which meant
   * every program in one flat directory and no way to write a level that imports a helper.
   *
   * A path is segments of `[a-z0-9][a-z0-9._-]*`, joined by single slashes. That grammar is what
   * refuses `..`, an absolute path, a dotfile and a trailing slash, all without a special case —
   * but it is NOT the check, because a grammar is an argument and the containing directory is a
   * fact. The resolve below is, and it still holds if this regexp is ever loosened.
   *
   * A FOLDER IS A PATH WITH NOTHING AFTER THE LAST SLASH, so the same routine checks both and
   * `isDir` decides whether the extension is required.
   */
  #programPath(id, isDir = false) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(id)) return null
    if (id.split('/').some((p) => p === '.' || p === '..' || p.startsWith('.'))) return null
    if (!isDir && !PROGRAM_EXT.has(path.extname(id))) return null
    const full = path.resolve(this.programs, id)
    return full.startsWith(path.resolve(this.programs) + path.sep) ? full : null
  }

  #programFile(id) {
    return this.#programPath(id, false)
  }

  /**
   * Every file and every folder under `programs/`.
   *
   * THE FOLDERS ARE LISTED SEPARATELY and not derived from the files, which is the difference
   * between a tree drawn from paths and a filesystem you can make a folder in: a folder somebody
   * just created is empty by definition, and deriving folders from files would make it vanish the
   * moment they looked away (Rich, 2026-09-28: "need ability to create folders...").
   */
  async listPrograms() {
    const out = []
    const dirs = []
    const walk = async (dir, prefix) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.name.startsWith('.')) continue
        const rel = prefix ? `${prefix}/${e.name}` : e.name
        if (e.isDirectory()) { dirs.push(rel); await walk(path.join(dir, e.name), rel); continue }
        if (!PROGRAM_EXT.has(path.extname(e.name))) continue
        const st = await stat(path.join(dir, e.name)).catch(() => null)
        out.push({ id: rel, bytes: st?.size ?? 0, modified: st?.mtime?.toISOString() ?? null })
      }
    }
    await walk(this.programs, '')
    out.sort((a, b) => (a.id < b.id ? -1 : 1))
    dirs.sort()
    return { programs: out, dirs }
  }

  async getProgram(id) {
    const file = this.#programFile(id)
    if (!file) return null
    const text = await readFile(file, 'utf8').catch(() => null)
    return text === null ? null : { id, source: text }
  }

  async putProgram(id, source) {
    const file = this.#programFile(id)
    if (!file) throw Object.assign(new Error(`${JSON.stringify(id)} is not a usable path — ${[...PROGRAM_EXT].join(' ')} only`), { status: 400 })
    if (typeof source !== 'string') throw Object.assign(new Error('a program is a string of TypeScript'), { status: 400 })
    // a cap, because this arrives over HTTP from a browser and a runaway paste should be refused
    // here rather than fill the volume
    if (source.length > 512 * 1024) throw Object.assign(new Error(`a program may be 512 kB; that is ${Math.round(source.length / 1024)} kB`), { status: 413 })
    await this.writeAtomic(file, Buffer.from(source))
    return { id, bytes: source.length }
  }

  async removeProgram(id) {
    const file = this.#programFile(id)
    if (!file) return
    await rm(file, { force: true })
    await this.#pruneEmpty(path.dirname(file))
  }

  /**
   * Rename or move — a file OR a folder, whichever the path names.
   *
   * ONE OPERATION FOR BOTH, because they are the same operation: changing a file's extension,
   * moving it into another folder, and renaming a folder full of files are all `rename(2)`, and
   * it is atomic, so none of them can leave two copies or none.
   */
  async moveProgram(from, to) {
    const dir = existsSync(this.#programPath(from, true) ?? '\u0000') && (await stat(this.#programPath(from, true))).isDirectory()
    const src = this.#programPath(from, dir)
    const dst = this.#programPath(to, dir)
    if (!src || !dst) throw Object.assign(new Error(`${JSON.stringify(to)} is not a usable path`), { status: 400 })
    if (!existsSync(src)) throw Object.assign(new Error(`no ${from}`), { status: 404 })
    if (existsSync(dst)) throw Object.assign(new Error(`${to} already exists`), { status: 409 })
    // a folder cannot be moved inside itself: rename(2) allows it and the tree becomes unreachable
    if (dir && (dst + path.sep).startsWith(src + path.sep)) {
      throw Object.assign(new Error(`${to} is inside ${from}`), { status: 400 })
    }
    await mkdir(path.dirname(dst), { recursive: true })
    await rename(src, dst)
    await this.#pruneEmpty(path.dirname(src))
    return { id: to, dir }
  }

  /** Make an empty folder. It exists on disk, which is why it survives being looked away from. */
  async makeProgramDir(id) {
    const dir = this.#programPath(id, true)
    if (!dir) throw Object.assign(new Error(`${JSON.stringify(id)} is not a usable folder name`), { status: 400 })
    if (existsSync(dir)) throw Object.assign(new Error(`${id} already exists`), { status: 409 })
    await mkdir(dir, { recursive: true })
    return { id, dir: true }
  }

  /** Delete a folder AND what is in it. The caller is the one that has to ask first. */
  async removeProgramDir(id) {
    const dir = this.#programPath(id, true)
    if (!dir) return { deleted: null }
    await rm(dir, { recursive: true, force: true })
    await this.#pruneEmpty(path.dirname(dir))
    return { deleted: id }
  }

  /** Walk up from a folder that just lost something, removing the ones nothing is left in. */
  async #pruneEmpty(from) {
    const root = path.resolve(this.programs)
    for (let dir = from; dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      const left = await readdir(dir).catch(() => ['.'])
      if (left.length) break
      await rm(dir, { recursive: false, force: true }).catch(() => {})
    }
  }

  /* ---- the place index --------------------------------------------------------------------- */

  /**
   * A place somebody found and wants to keep.
   *
   * THIS IS NOT A WORLD, and the distinction is the point. Finding somewhere worth driving is a
   * different activity from deciding the extent of a bake, and it happens first, in bulk, and
   * mostly ends in "not that one". A world costs a slug, a radius, a primary road and an argument
   * about what the bake will take; a place costs a name and a pin. So the index is cheap to add to
   * — a click on the map, or a search result — and a world is PROMOTED from one when it earns it.
   *
   * The shape is deliberately close to a geocoder result (`bbox` included) so that framing a place
   * on the map means reading one field rather than guessing a zoom from its category.
   */
  async listPlaces() {
    const out = []
    for (const f of await readdir(this.places).catch(() => [])) {
      if (!f.endsWith('.json')) continue
      const p = await this.readJson(path.join(this.places, f))
      if (p) out.push(p)
    }
    return out.sort((a, b) => (a.added < b.added ? 1 : -1))
  }

  getPlace(id) {
    return this.readJson(path.join(this.places, `${id}.json`))
  }

  async putPlace(place) {
    const doc = { ...place, added: place.added ?? new Date().toISOString() }
    await this.writeAtomic(path.join(this.places, `${doc.id}.json`), Buffer.from(JSON.stringify(doc, null, 1)))
    return doc
  }

  removePlace(id) {
    return rm(path.join(this.places, `${id}.json`), { force: true })
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

  /**
   * Take one out of the placeable catalog.
   *
   * The pair of `mergeCatalog`, and it exists because the editor's control for this is a CHECKBOX
   * now — a tick you cannot untick is not a tick. The asset itself is untouched: this is the list
   * of what a level may place, not the library.
   */
  async unlistCatalog(id) {
    const file = path.join(this.assets, 'catalog.json')
    const doc = (await this.readJson(file)) ?? (await this.readJson(this.catalogSeed ?? '', null)) ?? { assets: [] }
    const before = (doc.assets ?? []).length
    doc.assets = (doc.assets ?? []).filter((a) => a.id !== id)
    await this.writeAtomic(file, Buffer.from(JSON.stringify(doc, null, 1)))
    return { removed: before - doc.assets.length, total: doc.assets.length }
  }
}
