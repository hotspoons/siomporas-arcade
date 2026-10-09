// Deploy: one or more baked worlds, as a running copy on Cloudflare — R2 for the data, a Worker
// for the app.
//
// Rich, 2026-09-30: "from the world editor, if I want to bake a single world into something I
// can deploy to Cloudflare using R2 for assets and tiles and CF workers for the main app … copy
// just the assets used in the game, not the full library … support world multiplexing too so you
// can deploy multiple worlds to one URL."
//
// TWO HALVES. `plan()` is pure: given the store, the asset service and a list of worlds it
// produces the OBJECT LIST — every key the bucket will hold under the deploy's prefix, where each
// one comes from (a file on the volume, a fetch from the asset service, or a JSON body made here),
// and what it is for. The Deploy panel shows that list as a dry run. `run()` executes it: writes
// the objects, records what it wrote, prunes what it was asked to, and publishes the Worker.
//
// THE KEYS ARE THE VIEWER'S OWN PATHS. `sites/<slug>/web/tiles/…`, `levels/<id>.json`,
// `assetsvc/catalog/<id>/file/mesh.finished.glb`: exactly what the viewer fetches from its
// origin today, so the Worker (deploy/worker.mjs) is a prefix and a lookup and the viewer is
// deployed unchanged. Multiplexing is nothing extra: several worlds' `sites/<slug>/…` under one
// prefix and one `sites/index.json` listing them, which is what the viewer's site picker reads.
//
// WHAT IS USED IS MEASURED, NOT LISTED. The asset closure is every string in the bundled
// documents (site docs, levels, builds) that is a catalog id or a build id, followed through
// builds to their assets until nothing new appears. A program's quoted literals are in that set
// too: `api.models.spawn('pizza-stack')` is one string inside the built file, and walking the
// JSON would see the whole source as a single value and never the name. No table of "fields
// that hold asset ids" — the last four hand-typed tables in this repo are why things ended up
// in the road.

import { open, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MULTIPART_OVER } from './cloudflare.mjs'
import { SITE_DOCS } from './mcp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** the Worker module, as published */
export const WORKER_SOURCE = path.join(HERE, 'deploy', 'worker.mjs')
/** the bucket-level ledger of every deploy made with this tool, so a prune knows what exists */
export const LEDGER_KEY = 'corridor/deployments.json'

export const BUILD_KINDS = ['vehicles', 'actors', 'weapons', 'presets', 'traffic']

const TYPES = {
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.pack': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.ply': 'application/octet-stream',
  '.splat': 'application/octet-stream',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
}

export function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** the site's files the viewer can read: the export's `web/`, the manifest, the docs, the OSM */
const SITE_TOP = new Set(['.json', '.geojson', '.png'])

/**
 * THE TOP-LEVEL FILES THE GAME READS. Everything under `web/` is the game's own export and always
 * goes; at the top of a site the game reads only the documents people author (`SITE_DOCS`, the same
 * list the MCP projects), the manifest, the splats list, and `context.json` — the bake's compact
 * projection of the OSM extract that the minimap and the junctions read. The rest is what the bake
 * worked from: on dc-metro that was osm.geojson 389 MB, branches.json 81 MB, spine_utm.json 30 MB
 * and a dozen more, ~520 MB a deploy for nothing the game opens (Rich, 2026-10-08: "keep my free R2
 * bucket size down"). `deploy.test.mjs` scans the client for every `sites/<slug>/<file>` it fetches
 * and fails if one is missing here, so this cannot drift into breaking a deployed game.
 */
export const GAME_TOP = new Set([...SITE_DOCS, 'manifest.json', 'context.json', 'splats.json'])
/** read only when a site has no context.json (bakes from before it), as the fallback the viewer takes */
const GAME_FALLBACK = { 'osm.geojson': 'context.json' }

/** a default prefix: `corridor/<worlds>-<stamp>`, which is what Rich asked for */
export function defaultPrefix(worlds, at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')
  const name = worlds.length === 1 ? worlds[0] : worlds.length ? `${worlds[0]}+${worlds.length - 1}` : 'empty'
  return `corridor/${name}-${stamp}`
}

/** a Worker name Cloudflare accepts: lower-case, digits and dashes, 63 characters */
export function workerName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'corridor'
}

async function walk(dir, rel = '') {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), r)))
    else if (e.isFile() && !e.name.endsWith('.part')) out.push(r)
  }
  return out
}

/**
 * Quoted literals a program might name an asset by.
 *
 * The built program is stored as one JSON string. `stringsOf` would add that whole source as a
 * single value, which is never a catalog id, so a prop a level only spawns — the pizza stack,
 * the cash — never entered the deploy and drew as nothing on Cloudflare while the editor,
 * which asks the live library, showed them.
 */
export function literalsOf(src, into = new Set()) {
  if (typeof src !== 'string' || !src) return into
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n]){1,120})\1/g
  let m
  while ((m = re.exec(src))) {
    let s = m[2]
    if (s.includes('${')) continue
    if (s.includes('\\')) s = s.replace(/\\(['"`\\])/g, '$1')
    if (s && !/\s/.test(s)) into.add(s)
  }
  return into
}

/** every string in a JSON document, values and keys, once */
export function stringsOf(doc, into = new Set()) {
  if (typeof doc === 'string') into.add(doc)
  else if (Array.isArray(doc)) for (const x of doc) stringsOf(x, into)
  else if (doc && typeof doc === 'object') {
    for (const [k, v] of Object.entries(doc)) {
      into.add(k)
      stringsOf(v, into)
    }
  }
  return into
}

/**
 * The plan.
 *
 * @param {object} o
 * @param {import('./store.mjs').Store} o.store
 * @param {string[]} o.worlds           slugs
 * @param {string} o.assetsvc           the asset service's URL, or '' for none
 * @param {(src: string, name: string) => { js: string, errors: unknown[] }} o.transpile
 * @param {typeof fetch} [o.fetch]
 * @param {string} [o.appDir]           the built app (dist); listed for the summary only
 */
export async function plan({ store, worlds, assetsvc = '', transpile, fetch = globalThis.fetch, appDir = null, sources = false }) {
  const objects = []
  const warnings = []
  const problems = []
  const add = (o) => objects.push(o)
  const slugs = [...new Set(worlds)].filter(Boolean)
  if (!slugs.length) problems.push('no world chosen')
  const docs = [] // every JSON document bundled, for the closure

  /* ---- the worlds: the bake and the docs ------------------------------------------------- */
  const baked = []
  for (const slug of slugs) {
    const dir = path.join(store.sites, slug)
    const manifest = await store.readJson(path.join(dir, 'manifest.json'))
    if (!manifest) {
      problems.push(`${slug} is not baked (no sites/${slug}/manifest.json)`)
      continue
    }
    baked.push(slug)
    docs.push(manifest)
    const files = await walk(dir)
    const have = new Set(files)
    // what the web export's own manifest names: a loose file in web/ it does not name is a bake
    // leftover (dc-metro's web/chm_2m.png, 133 MiB, read by nothing — the 2 m canopy is in the tiles)
    const webManifest = await readFile(path.join(dir, 'web', 'manifest.json'), 'utf8').catch(() => null)
    /*
     * A PYRAMID SUPERSEDES THE FLAT TILES. The viewer loads `layers.tiles` only when there is no
     * pyramid (scene.ts: `if (L.tiles && anchor && !pyrSet)`, and the pyramid needs the frame's
     * anchor), and the imagery stream and the veg cover hang off that tile set. dc-metro carries both:
     * web/tiles/0, 3,464 files and 1,565 MiB — 43% of the deploy — that the game never opens.
     */
    let flatTilesDir = null
    try {
      const wm = webManifest ? JSON.parse(webManifest) : null
      if (wm?.layers?.pyramid && wm?.frame?.anchor && typeof wm?.layers?.tiles?.dir === 'string') flatTilesDir = `web/${wm.layers.tiles.dir.replace(/^\/+|\/+$/g, '')}/`
    } catch {
      /* not JSON: ship what is there */
    }
    const namedInWeb = (name) => webManifest === null || name === 'manifest.json' || new RegExp(`["/]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(webManifest)
    let skipped = 0
    let skippedBytes = 0
    for (const rel of files) {
      const top = !rel.includes('/')
      if (top ? !SITE_TOP.has(path.extname(rel)) : !rel.startsWith('web/')) continue
      // a bake source the game never opens stays home unless asked for (`sources`)
      const looseWeb = /^web\/[^/]+$/.test(rel)
      const superseded = flatTilesDir !== null && rel.startsWith(flatTilesDir)
      if (!sources && (superseded || (top && !GAME_TOP.has(rel) && !(GAME_FALLBACK[rel] && !have.has(GAME_FALLBACK[rel]))) || (looseWeb && !namedInWeb(rel.slice(4))))) {
        skipped++
        skippedBytes += (await stat(path.join(dir, rel))).size
        continue
      }
      const file = path.join(dir, rel)
      const size = (await stat(file)).size
      add({ key: `sites/${slug}/${rel}`, file, bytes: size, contentType: contentType(rel), group: rel.startsWith('web/') ? 'bake' : 'docs' })
      // the asset closure reads the authored docs; a bake source (tens of MB of JSON) is no asset list
      if (top && rel.endsWith('.json') && rel !== 'manifest.json' && GAME_TOP.has(rel)) docs.push(await store.readJson(file))
    }
    if (skipped) warnings.push(`${slug}: ${skipped} bake source file${skipped === 1 ? '' : 's'} left out (${(skippedBytes / 2 ** 20).toFixed(1)} MiB) — the game does not read them; tick "include bake sources" to ship them`)
  }

  /* ---- the index the viewer's site picker reads: the chosen worlds only ------------------- */
  const index = await store.readJson(path.join(store.sites, 'index.json'))
  const entries = []
  for (const slug of baked) {
    const e = index?.sites?.find((s) => s.slug === slug)
    if (e) entries.push(e)
    else {
      warnings.push(`${slug} is not in sites/index.json — listed from its manifest instead (run the export to fix)`)
      const m = await store.readJson(path.join(store.sites, slug, 'manifest.json'))
      entries.push({ slug, ident: m.ident ?? null, length_m: m.length_m ?? 0, structures: 0, formations: [], layers: m.layers ?? [], photos: [] })
    }
  }
  const indexBody = JSON.stringify({ sites: entries })
  add({ key: 'sites/index.json', body: indexBody, bytes: Buffer.byteLength(indexBody), contentType: 'application/json', group: 'docs' })

  /* ---- levels and their programs ---------------------------------------------------------- */
  const levels = (await store.listLevels()).filter((l) => baked.includes(l.world))
  const namedInPrograms = new Set()
  for (const l of levels) {
    const body = JSON.stringify(l)
    add({ key: `levels/${l.id}.json`, body, bytes: Buffer.byteLength(body), contentType: 'application/json', group: 'levels' })
    docs.push(l)
    if (l.program) {
      const p = await store.getProgram(l.program)
      if (!p) {
        problems.push(`level ${l.id} names program ${l.program}, which does not exist`)
        continue
      }
      const out = transpile(p.source, l.program)
      if (out.errors?.length) problems.push(`program ${l.program} does not build: ${out.errors.map((e) => e.message ?? e).join('; ')}`)
      literalsOf(p.source, namedInPrograms)
      literalsOf(out.js, namedInPrograms)
      const built = JSON.stringify({ id: l.program, js: out.js, errors: out.errors ?? [] })
      add({ key: `api/programs/${l.program}`, body: built, bytes: Buffer.byteLength(built), contentType: 'application/json', group: 'levels' })
    }
  }
  const list = JSON.stringify({ levels })
  add({ key: 'api/levels', body: list, bytes: Buffer.byteLength(list), contentType: 'application/json', group: 'levels' })
  const ordered = [...levels].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.id).localeCompare(String(b.id)))
  const launch = ordered.find((l) => l.launch)?.id ?? ordered.find((l) => l.home)?.id ?? null
  const game = JSON.stringify({ launch, order: ordered.map((l) => l.id) })
  add({ key: 'game.json', body: game, bytes: Buffer.byteLength(game), contentType: 'application/json', group: 'levels' })

  /* ---- the placement catalog, as far as it is used ---------------------------------------- */
  const catalogDoc = await store.catalog()

  /* ---- the asset closure ------------------------------------------------------------------ */
  const assets = { items: new Map(), builds: {}, materials: [] }
  if (!assetsvc) {
    warnings.push('no asset service configured — models, vehicle builds and traffic sets are not in this deploy')
  } else {
    const get = async (p) => {
      const r = await fetch(`${assetsvc}${p}`)
      if (!r.ok) throw new Error(`${assetsvc}${p}: HTTP ${r.status}`)
      return r.json()
    }
    let items = []
    try {
      items = (await get('/catalog')).items ?? []
    } catch (e) {
      problems.push(`asset service: ${e.message ?? e}`)
    }
    const byId = new Map(items.map((it) => [it.id, it]))
    const builds = {}
    for (const kind of BUILD_KINDS) {
      try {
        builds[kind] = (await get(`/${kind}`))[kind] ?? []
      } catch {
        builds[kind] = []
      }
    }
    // an id can name a catalog item or a build; builds are keyed by `id` or, older, by `asset`
    const buildId = (b) => b.id ?? b.asset ?? b.name
    const buildIndex = new Map()
    for (const kind of BUILD_KINDS) for (const b of builds[kind]) buildIndex.set(buildId(b), { kind, build: b })

    // THE FIXPOINT: strings of what is bundled → ids; ids that are builds → their documents'
    // strings → more ids; until a pass adds nothing
    const seen = new Set()
    const usedBuilds = new Map()
    let frontier = new Set()
    for (const d of docs) stringsOf(d, frontier)
    for (const s of namedInPrograms) frontier.add(s)
    for (let pass = 0; pass < 8 && frontier.size; pass++) {
      const next = new Set()
      for (const s of frontier) {
        if (seen.has(s)) continue
        seen.add(s)
        const b = buildIndex.get(s)
        if (b && !usedBuilds.has(s)) {
          usedBuilds.set(s, b)
          stringsOf(b.build, next)
        }
        if (byId.has(s) && !assets.items.has(s)) {
          assets.items.set(s, byId.get(s))
          stringsOf(byId.get(s).use ?? null, next)
        }
      }
      frontier = next
    }
    // also every catalog item whose `id` a placement names via the placement catalog
    for (const e of catalogDoc.assets ?? []) if (seen.has(e.id) && byId.has(e.id) && !assets.items.has(e.id)) assets.items.set(e.id, byId.get(e.id))

    for (const kind of BUILD_KINDS) {
      const used = builds[kind].filter((b) => usedBuilds.has(buildId(b)))
      assets.builds[kind] = used.map(buildId)
      const body = JSON.stringify({ [kind]: used })
      add({ key: `assetsvc/${kind}`, body, bytes: Buffer.byteLength(body), contentType: 'application/json', group: 'assets' })
    }
    /*
     * THE SOUNDS A USED BUILD UPLOADED. A document's `sounds` slots may name `asset:<id>/<file>`
     * (soundbank.ts); the file sits under the asset as sounds/<file> and the viewer fetches it by
     * the same /file/ route as a mesh. Without this the deployed car crashes in silence where the
     * local one had its own clip, and nothing says why.
     */
    const soundFiles = new Map()
    for (const b of usedBuilds.values()) {
      for (const entries of Object.values(b.build?.doc?.sounds ?? {})) {
        for (const e of Array.isArray(entries) ? entries : []) {
          const m = typeof e === 'string' && /^asset:([^/]+)\/(.+)$/.exec(e)
          if (!m) continue
          if (!soundFiles.has(m[1])) soundFiles.set(m[1], new Set())
          soundFiles.get(m[1]).add(`sounds/${m[2]}`)
        }
      }
    }
    for (const [id, it] of assets.items) {
      const rec = JSON.stringify(it)
      add({ key: `assetsvc/catalog/${id}`, body: rec, bytes: Buffer.byteLength(rec), contentType: 'application/json', group: 'assets' })
      // the mesh the viewer would load (carmodel.ts `variantOf`: finished, else raw), and the
      // glazed one when it exists — the raw 26 MB reconstruction only when nothing better does
      const files = []
      if (it.finished) files.push('mesh.finished.glb')
      else if (it.mesh) files.push('mesh.glb')
      if (it.glass) files.push('mesh.glass.glb')
      if (!files.length) warnings.push(`${id} is used but has no mesh yet (${it.state ?? 'no state'})`)
      files.push(...(soundFiles.get(id) ?? []))
      for (const f of files) {
        const url = `${assetsvc}/catalog/${encodeURIComponent(id)}/file/${f}`
        let bytes = 0
        try {
          const h = await fetch(url, { method: 'HEAD' })
          bytes = Number(h.headers.get('content-length') ?? 0) || 0
        } catch {
          /* sized at upload */
        }
        add({ key: `assetsvc/catalog/${id}/file/${f}`, url, bytes, contentType: contentType(f), group: 'assets' })
      }
    }
    // the list the viewer merges into the placeable catalog (`assetsvc.list()` → GET /assetsvc/catalog).
    // individual item records are not that list: without it a deployed prop has a mesh in the bucket
    // and still never appears, so spawn returns nothing
    const catalogList = JSON.stringify({ items: [...assets.items.values()] })
    add({ key: 'assetsvc/catalog', body: catalogList, bytes: Buffer.byteLength(catalogList), contentType: 'application/json', group: 'assets' })
    /*
     * MATERIALS. The viewer draws every road class, the verges and (when the world says so) the
     * buildings from the library's materials, so a deployed copy carries: every road, paving,
     * shoulder and ground material (the classes come from the bake and any of them may appear),
     * plus whatever else the world's documents name — a wall pool, a roof pool. Each material is
     * its record, its file listing (the viewer finds the hex-tiling variants and the macro map
     * through it) and every map in it.
     */
    try {
      const mats = (await get('/materials')).materials ?? []
      const surfaceish = new Set(['road', 'paving', 'shoulder', 'ground_cover', 'verge', 'sidewalk'])
      const carried = mats.filter((m) => surfaceish.has(m.category) || seen.has(m.id))
      const list = JSON.stringify({ materials: carried })
      add({ key: 'assetsvc/materials', body: list, bytes: Buffer.byteLength(list), contentType: 'application/json', group: 'assets' })
      for (const m of carried) {
        assets.materials.push(m.id)
        const rec = JSON.stringify({ material: m })
        add({ key: `assetsvc/materials/${m.id}`, body: rec, bytes: Buffer.byteLength(rec), contentType: 'application/json', group: 'assets' })
        let files = []
        try {
          files = (await get(`/materials/${encodeURIComponent(m.id)}/files`)).files ?? []
        } catch {
          files = [m.albedo, m.normal, m.roughness].filter((x) => typeof x === 'string' && x).map((x) => x.split('/').pop())
        }
        files = files.filter((f) => !/^raw/.test(f))
        const listing = JSON.stringify({ id: m.id, files })
        add({ key: `assetsvc/materials/${m.id}/files`, body: listing, bytes: Buffer.byteLength(listing), contentType: 'application/json', group: 'assets' })
        for (const f of files) {
          add({ key: `assetsvc/materials/${m.id}/file/${f}`, url: `${assetsvc}/materials/${encodeURIComponent(m.id)}/file/${encodeURIComponent(f)}`, bytes: 0, contentType: contentType(f), group: 'assets' })
        }
      }
    } catch {
      /* no materials route on an older service */
    }
  }
  const usedIds = new Set(assets.items.keys())
  const placed = (catalogDoc.assets ?? []).filter((e) => usedIds.has(e.id) || stringsOf(docs, new Set()).has(e.id))
  const catBody = JSON.stringify({ ...catalogDoc, assets: placed })
  add({ key: 'assets/catalog.json', body: catBody, bytes: Buffer.byteLength(catBody), contentType: 'application/json', group: 'docs' })

  /* ---- the app, for the summary --------------------------------------------------------- */
  let app = null
  if (appDir) {
    const files = await walk(appDir)
    if (!files.includes('index.html')) problems.push(`no built app at ${appDir} — build it first (npm run build -w apps/corridor)`)
    else {
      let bytes = 0
      for (const f of files) bytes += (await stat(path.join(appDir, f))).size
      app = { files: files.length, bytes }
    }
  }

  const byGroup = {}
  for (const o of objects) {
    const g = (byGroup[o.group] ??= { objects: 0, bytes: 0 })
    g.objects++
    g.bytes += o.bytes
  }
  /*
   * THE MONOLITHS. The game streams most of a world as tiles; anything it loads WHOLE is a cost every
   * player pays up front and in memory, however little of the world they see. The largest objects of
   * the game's own set are listed so each plan shows what is left to cut into tiles (Rich,
   * 2026-10-08: "a good tell how many monoliths we have left").
   */
  const tiled = (k) => /\/web\/(tiles|pyramid|vt|pyr)\//.test(k) || /\/web\/[^/]+\/\d+[_/]/.test(k)
  const largest = objects
    .filter((o) => o.key.startsWith('sites/') && !tiled(o.key) && o.bytes >= 2 ** 20)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 12)
    .map((o) => ({ key: o.key, bytes: o.bytes }))
  return {
    worlds: baked,
    sources,
    largest,
    levels: levels.map((l) => l.id),
    assets: { items: [...assets.items.keys()], builds: assets.builds, materials: assets.materials },
    objects,
    byGroup,
    bytes: objects.reduce((n, o) => n + o.bytes, 0),
    app,
    warnings,
    problems,
  }
}

/** the built app's files as Worker assets: everything under dist (the editor pages included; they are small) */
export async function appAssets(appDir) {
  const out = []
  for (const rel of await walk(appDir)) {
    out.push({ path: `/${rel}`, body: await readFile(path.join(appDir, rel)), contentType: contentType(rel) })
  }
  return out
}

/** one object's bytes, wherever the plan said they come from */
async function bodyOf(o, fetch) {
  if (o.body !== undefined) return Buffer.from(o.body)
  if (o.file) return readFile(o.file)
  const r = await fetch(o.url)
  if (!r.ok) throw new Error(`${o.url}: HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

const mib = (n) => `${(n / 2 ** 20).toFixed(1)} MiB`

/** One file from the volume as a multipart upload; its size is measured now, not taken from the plan. */
async function putFileLarge(cf, accountId, bucket, key, file, contentType, log) {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const read = async (off, len) => {
      const buf = Buffer.alloc(len)
      let got = 0
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, off + got)
        if (!bytesRead) throw new Error(`${file}: short read at ${off + got} of ${size}`)
        got += bytesRead
      }
      return buf
    }
    return await cf.putObjectLarge(accountId, bucket, key, { size, read }, contentType, { log })
  } finally {
    await fh.close()
  }
}

/**
 * `count` workers, each calling `step` until it answers false. THE FIRST FAILURE STOPS THEM ALL: a
 * plain Promise.all rejects on the first throw and leaves the other workers running, and the
 * dc-metro log showed exactly that — uploads carrying on to object 4,300 after the deploy had
 * already been reported failed at 3,230.
 */
async function pool(count, step) {
  let failed = null
  const worker = async () => {
    while (!failed) {
      try {
        if (!(await step())) return
      } catch (e) {
        failed ??= e
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, count) }, worker))
  if (failed) throw failed
}

/** Every object under a prefix, from its deploy manifest or by listing. */
async function deletePrefix(cf, accountId, bucket, prefix, concurrency) {
  prefix = String(prefix).replace(/^\/+|\/+$/g, '')
  const m = await cf.getJson(accountId, bucket, `${prefix}/deploy.json`)
  const listed = m?.keys
    ? m.keys.map((k) => `${prefix}/${k}`)
    : (await cf.listObjects(accountId, bucket, `${prefix}/`)).map((o) => o.key)
  const q = [...new Set([...listed, `${prefix}/deploy.json`])]
  let n = 0
  await pool(concurrency, async () => {
    const k = q.shift()
    if (!k) return false
    await cf.deleteObject(accountId, bucket, k)
    n++
    return true
  })
  return n
}

/**
 * DELETE ONE DEPLOYMENT: every object under its prefix (from its own deploy.json, else by listing —
 * a failed deploy never wrote one), and its line in the bucket's ledger. The Worker is left alone:
 * it may be serving a newer prefix, and deleting a Worker is a different decision. Rich, 2026-10-08:
 * "We need the ability to clear/delete old deployments."
 */
export async function removeDeployment({ cf, accountId, bucket, prefix, log = () => {}, concurrency = 8 }) {
  prefix = String(prefix).replace(/^\/+|\/+$/g, '')
  if (!prefix || prefix === 'corridor') throw Object.assign(new Error('refusing to delete without a deployment prefix'), { status: 400 })
  log(`deleting r2://${bucket}/${prefix}/`)
  const objects = await deletePrefix(cf, accountId, bucket, prefix, concurrency)
  log(`deleted ${objects} objects`)
  const ledger = await cf.getJson(accountId, bucket, LEDGER_KEY)
  if (ledger?.deployments?.some((d) => d.prefix === prefix)) {
    ledger.deployments = ledger.deployments.filter((d) => d.prefix !== prefix)
    await cf.putObject(accountId, bucket, LEDGER_KEY, JSON.stringify(ledger, null, 1), 'application/json')
    log('removed from the bucket ledger')
  }
  return { prefix, objects }
}

/**
 * Execute a plan.
 *
 * @param {object} o
 * @param {import('./cloudflare.mjs').Cloudflare} o.cf
 * @param {string} o.accountId
 * @param {string} o.bucket
 * @param {boolean} [o.createBucket]      make it when it does not exist
 * @param {string} o.prefix               where under the bucket this deploy lives
 * @param {Awaited<ReturnType<typeof plan>>} o.plan
 * @param {{ name: string, workersDev?: boolean, hostname?: string|null, zoneId?: string|null }} o.worker
 * @param {string} o.appDir
 * @param {boolean} [o.prune]             delete older deploys of these worlds from the bucket afterwards
 * @param {string|null} [o.replacePrefix] delete this prefix's objects before uploading, so a redeploy
 *                                         replaces that deployment with the current bake
 * @param {boolean} [o.dryRun]
 * @param {(line: string) => void} o.log
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.concurrency]
 */
export async function run({ cf, accountId, bucket, createBucket = true, prefix, plan: p, worker, appDir, prune = false, replacePrefix = null, dryRun = false, log, fetch = globalThis.fetch, concurrency = 8 }) {
  const at = new Date().toISOString()
  prefix = String(prefix).replace(/^\/+|\/+$/g, '')
  if (!prefix) throw new Error('a prefix is required (the default is corridor/<world>-<stamp>)')
  if (p.problems.length) throw new Error(`the plan has problems: ${p.problems.join('; ')}`)
  for (const w of p.warnings) log(`warning: ${w}`)
  log(`worlds: ${p.worlds.join(', ')} · levels: ${p.levels.length} · assets: ${p.assets.items.length} models · ${p.objects.length} objects, ${mib(p.bytes)} → r2://${bucket}/${prefix}/`)
  if (dryRun) {
    log('dry run: nothing written')
    return { dryRun: true, prefix, objects: p.objects.length, bytes: p.bytes }
  }

  /* ---- the bucket ----------------------------------------------------------------------- */
  const have = await cf.buckets(accountId)
  if (!have.some((b) => b.name === bucket)) {
    if (!createBucket) throw new Error(`no bucket ${bucket} in this account`)
    log(`creating bucket ${bucket}`)
    await cf.createBucket(accountId, bucket)
  }

  /* ---- replace one earlier deployment, before the new objects land -------------------- */
  if (replacePrefix && !dryRun) {
    const removed = await deletePrefix(cf, accountId, bucket, replacePrefix, concurrency)
    log(`removed ${replacePrefix}: ${removed} objects`)
  }

  /* ---- the objects ---------------------------------------------------------------------- */
  let sent = 0
  let bytes = 0
  const keys = []
  const queue = [...p.objects]
  await pool(concurrency, async () => {
    const o = queue.shift()
    if (!o) return false
    const key = `${prefix}/${o.key}`
    let n
    if (o.file && o.bytes > MULTIPART_OVER) {
      // A FILE TOO BIG FOR ONE REQUEST goes up in parts, read from the volume a part at a time:
      // the REST PUT's front answers a 371 MiB osm.geojson with a 413, and four of those held
      // in memory at once is a pod's whole allowance
      log(`  ${o.key}  (${mib(o.bytes)}) — multipart`)
      n = await putFileLarge(cf, accountId, bucket, key, o.file, o.contentType, log)
    } else {
      const body = await bodyOf(o, fetch)
      n = body.byteLength > MULTIPART_OVER
        ? await cf.putObjectLarge(accountId, bucket, key, { size: body.byteLength, read: async (off, len) => body.subarray(off, off + len) }, o.contentType, { log })
        : await cf.putObject(accountId, bucket, key, body, o.contentType)
    }
    keys.push(key)
    sent++
    bytes += n
    if (sent % 50 === 0 || n > 4 * 2 ** 20) log(`  ${sent}/${p.objects.length}  ${o.key}  (${mib(n)})`)
    return true
  })
  log(`uploaded ${sent} objects, ${mib(bytes)}`)

  /* ---- the ledger: this deploy, and every one before it ---------------------------------- */
  const manifestKey = `${prefix}/deploy.json`
  const record = { prefix, worlds: p.worlds, levels: p.levels, at, worker: worker.name, objects: sent, bytes, keys: keys.map((k) => k.slice(prefix.length + 1)) }
  await cf.putObject(accountId, bucket, manifestKey, JSON.stringify(record), 'application/json')
  const ledger = (await cf.getJson(accountId, bucket, LEDGER_KEY)) ?? { deployments: [] }
  ledger.deployments = ledger.deployments.filter((d) => d.prefix !== prefix && d.prefix !== replacePrefix)
  ledger.deployments.push({ prefix, worlds: p.worlds, at, worker: worker.name, objects: sent, bytes })
  await cf.putObject(accountId, bucket, LEDGER_KEY, JSON.stringify(ledger, null, 1), 'application/json')

  /* ---- the worker ----------------------------------------------------------------------- */
  const script = await readFile(WORKER_SOURCE, 'utf8')
  const assets = await appAssets(appDir)
  log(`app: ${assets.length} files, ${mib(assets.reduce((n, a) => n + a.body.byteLength, 0))}`)
  await cf.deployWorker(accountId, worker.name, {
    script,
    assets,
    bindings: [
      { type: 'r2_bucket', name: 'DATA', bucket_name: bucket },
      { type: 'plain_text', name: 'PREFIX', text: prefix },
    ],
    log,
  })
  const urls = []
  if (worker.workersDev !== false) {
    await cf.enableSubdomain(accountId, worker.name)
    const sub = await cf.workersSubdomain(accountId)
    if (sub) urls.push(`https://${worker.name}.${sub}.workers.dev`)
    else log('workers.dev: the account has no subdomain set yet — pick one in the dashboard once, and the worker is reachable there')
  }
  if (worker.hostname && worker.zoneId) {
    await cf.attachDomain(accountId, { zoneId: worker.zoneId, hostname: worker.hostname, service: worker.name })
    urls.push(`https://${worker.hostname}`)
  }
  for (const u of urls) log(`live: ${u}`)

  /* ---- older revisions of these worlds, if asked ---------------------------------------- */
  let pruned = { deployments: 0, objects: 0 }
  if (prune) {
    const old = ledger.deployments.filter((d) => d.prefix !== prefix && (d.worker === worker.name || d.worlds.some((w) => p.worlds.includes(w))))
    for (const d of old) {
      const m = await cf.getJson(accountId, bucket, `${d.prefix}/deploy.json`)
      const oldKeys = m?.keys ? m.keys.map((k) => `${d.prefix}/${k}`) : (await cf.listObjects(accountId, bucket, `${d.prefix}/`)).map((o) => o.key)
      log(`pruning ${d.prefix} (${d.worlds.join(', ')}, ${d.at}): ${oldKeys.length} objects`)
      const q = [...oldKeys, `${d.prefix}/deploy.json`]
      await pool(concurrency, async () => {
        const k = q.shift()
        if (!k) return false
        await cf.deleteObject(accountId, bucket, k)
        pruned.objects++
        return true
      })
      pruned.deployments++
    }
    if (old.length) {
      ledger.deployments = ledger.deployments.filter((d) => !old.includes(d))
      await cf.putObject(accountId, bucket, LEDGER_KEY, JSON.stringify(ledger, null, 1), 'application/json')
    }
    log(`pruned ${pruned.deployments} older deploy${pruned.deployments === 1 ? '' : 's'}, ${pruned.objects} objects`)
  }

  return { prefix, objects: sent, bytes, urls, pruned }
}
