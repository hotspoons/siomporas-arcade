#!/usr/bin/env node
// assetsvc — the backend the editor talks to, and the ONLY thing that talks to an AI workload.
//
// THE CONSTRAINT THIS EXISTS TO ENFORCE. No browser may call flux or TRELLIS directly. Those are
// GPU services on the cluster's own network; reaching them from a page means either exposing them
// publicly or port-forwarding to a laptop, and the first is a way to hand strangers a GH200. So
// the editor knows exactly one origin — this service — and this service reaches the models over
// cluster DNS (`http://recon.default.svc`). In development the same binary runs on a laptop with
// those URLs pointed at port-forwards; nothing about the editor changes between the two.
//
//   editor ──HTTP──> assetsvc ──cluster DNS──> flux.2 / TRELLIS
//                       │
//                       ├── catalog on a volume (PVC in the cluster, a folder on a laptop)
//                       └── S3-compatible bucket, for save and load
//
// Everything slow is a JOB (jobs.mjs): POST starts one, GET polls it. Nothing holds a connection
// open through an ingress for the two minutes a reconstruction takes.
//
//   node tools/assetsvc/server.mjs --port 8770
//
// Configuration is environment; see models.example.json and README.md.

import http from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { buildRegistry } from './adapters.mjs'
import { Catalog } from './catalog.mjs'
import { Jobs } from './jobs.mjs'
import { S3 } from './s3.mjs'
import { recipeFor, roster } from './specs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}

const PORT = Number(arg('port', process.env.ASSETSVC_PORT ?? 8770))
const HOST = arg('host', process.env.ASSETSVC_HOST ?? '0.0.0.0')
const DATA = path.resolve(arg('data', process.env.ASSETSVC_DATA ?? path.join(REPO, 'ext/assetsvc')))
const CONFIG = arg('models', process.env.ASSETSVC_MODELS ?? path.join(HERE, 'models.example.json'))

const config = existsSync(CONFIG) ? JSON.parse(await readFile(CONFIG, 'utf8')) : { models: {}, defaults: {} }
const registry = buildRegistry(config)
const catalog = new Catalog(path.join(DATA, 'catalog'))
const jobs = new Jobs()
const s3 = new S3()
await catalog.init()

/* ---- tiny http helpers ---------------------------------------------------------------------- */

const json = (res, status, body) => {
  const buf = Buffer.from(JSON.stringify(body, null, 2))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...cors() })
  res.end(buf)
}
const send = (res, status, buf, type) => {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...cors() })
  res.end(buf)
}
// The editor is served by Vite on another port in development, so it is cross-origin. In the
// cluster both sit behind one host and this costs nothing.
const cors = () => ({
  'Access-Control-Allow-Origin': process.env.ASSETSVC_CORS ?? '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
})

async function body(req, limit = 32 * 1024 * 1024) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) throw Object.assign(new Error('payload too large'), { status: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}
const readJson = async (req) => {
  const b = await body(req)
  return b.length ? JSON.parse(b.toString('utf8')) : {}
}

// `.jpg` WAS MISSING and every albedo in the library is one — they were served as
// application/octet-stream, which a browser will still decode as an <img> but which defeats
// caching heuristics and is simply wrong.
const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ktx2': 'image/ktx2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.json': 'application/json',
}

/* ---- the work ------------------------------------------------------------------------------- */

/** Draw a view for an item. Optionally from source images already in the item (an edit). */
function startImage(id, opts) {
  return jobs.start('image', `image ${id}`, async (report) => {
    const item = await catalog.get(id)
    const model = registry.image
    report({ state: 'generating', model: model.id })
    const sources = []
    for (const name of opts.sources ?? []) {
      sources.push({ name, buf: await catalog.read(id, path.join('views', name)) })
    }
    const out = await model.generate({
      prompt: opts.prompt ?? item.prompt,
      negative: opts.negative ?? item.negative,
      size: opts.size,
      steps: opts.steps,
      seed: opts.seed,
      trueCfg: opts.trueCfg,
      sources,
    })
    const file = await catalog.addView(id, out.png, { model: model.id, seconds: out.seconds, ...out.meta })
    return { file: `views/${file}`, seconds: out.seconds, model: model.id }
  })
}

/** Reconstruct a mesh from the chosen view (or whichever views were named). */
function startMesh(id, opts) {
  return jobs.start('mesh', `mesh ${id}`, async (report) => {
    const item = await catalog.get(id)
    const names = opts.views?.length ? opts.views : item.chosen ? [item.chosen] : item.views.slice(-1)
    if (!names.length) throw new Error(`${id} has no views to reconstruct from — draw one first`)
    const views = []
    for (const n of names) views.push({ name: n, buf: await catalog.read(id, path.join('views', n)) })

    const model = registry.mesh
    report({ state: 'submitting', model: model.id, views: names })
    const out = await model.reconstruct({ views, seed: opts.seed ?? 1, onProgress: (s) => report({ state: s.state ?? 'running', ...s }) })
    await catalog.writeFileFor(id, 'mesh.glb', out.glb, { step: 'mesh', model: model.id, seconds: out.seconds, ...out.meta })

    let finished = null
    if (opts.finish !== false) {
      report({ state: 'finishing' })
      finished = await finish(id).catch((e) => ({ error: String(e.message ?? e) }))
    }
    return { mesh: 'mesh.glb', bytes: out.glb.length, seconds: out.seconds, model: model.id, meta: out.meta, finished }
  })
}

/**
 * Hand the raw reconstruction to the existing finisher rather than reimplementing it.
 *
 * `tools/assetgen/finish.mjs` knows the things that took someone a week — that meshoptimizer must
 * do the simplifying because a collapse decimator rips the UV seams, and that the unlit transform
 * has to run BEFORE Draco or it decompresses and undoes itself. It is not called through its own
 * CLI, which resolves paths out of assets.json by `--id` and cannot address a catalog file; it is
 * called through its exported `finish(src, out)` by `finish-one.mjs`.
 *
 * In a CHILD process, and that is not tidiness: that export runs execFileSync three times for
 * about thirty seconds, which in-process would block this service's event loop for all of it —
 * `/health` included, which is how a pod gets killed by its own liveness probe while working
 * perfectly.
 */
async function finish(id) {
  const script = path.join(HERE, 'finish-one.mjs')
  if (!existsSync(path.join(REPO, 'tools/assetgen/finish.mjs'))) return { skipped: 'tools/assetgen/finish.mjs not present' }
  const dir = catalog.dir(id)
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, '--in', path.join(dir, 'mesh.glb'), '--out', path.join(dir, 'mesh.finished.glb')], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`finish exited ${code}: ${(err || out).trim().slice(-400)}`))
      let stats = null
      try {
        stats = JSON.parse(out.trim().split('\n').pop())
      } catch {
        /* the numbers are a bonus; a zero exit and a file on disk is the result */
      }
      resolve({ ok: true, ...(stats ? { bytes: stats.bytes, from: stats.from } : {}), log: (err || out).trim().split('\n').slice(-4).join('\n') })
    })
  })
}

/* ---- routes --------------------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const seg = url.pathname.split('/').filter(Boolean)
  try {
    if (req.method === 'OPTIONS') return send(res, 204, Buffer.alloc(0), 'text/plain')

    // liveness for the kubelet, and a readiness that says what it can actually reach
    if (url.pathname === '/health') return json(res, 200, { ok: true, data: DATA, catalog: catalog.root })
    if (url.pathname === '/ready') {
      const [image, mesh] = await Promise.all([
        registry.models.get(registry.defaults.image)?.available() ?? { ok: false, detail: 'unset' },
        registry.models.get(registry.defaults.mesh)?.available() ?? { ok: false, detail: 'unset' },
      ])
      return json(res, image.ok && mesh.ok ? 200 : 503, { image, mesh })
    }
    if (url.pathname === '/models') {
      const d = registry.describe()
      const checks = await Promise.all([...registry.models.values()].map(async (m) => [m.id, await m.available()]))
      return json(res, 200, { ...d, reachable: Object.fromEntries(checks), s3: s3.describe() })
    }

    /*
     * ---- the roster, and drawing from it ------------------------------------------------------
     *
     * The recipe lives in tools/assetlib and this calls it (specs.mjs). What the editor needs on
     * top is the asymmetry made visible: an image is ten seconds and a mesh is thirty to forty on
     * one serialised GPU, so you draw SEVERAL and a human picks one, and only then is a GPU spent
     * on geometry. Pick from pictures, commit to meshes.
     */
    if (seg[0] === 'specs' && seg.length === 1) {
      const r = await roster({ refresh: url.searchParams.get('refresh') === '1' })
      const byClass = {}
      for (const s of r.byId.values()) (byClass[s.class ?? 'unclassified'] ??= []).push({ id: s.id, subject: s.subject ?? null, paint: s.paint ?? null, era: s.era ?? null, roster: s.roster })
      return json(res, 200, { rosters: r.files, count: r.byId.size, classes: byClass })
    }
    if (seg[0] === 'specs' && seg.length === 2 && req.method === 'GET') {
      const rec = await recipeFor(seg[1], { view: url.searchParams.get('view') ?? undefined })
      return rec ? json(res, 200, rec) : json(res, 404, { error: `no spec ${seg[1]}` })
    }
    /** draw N candidates for a spec, each with its own seed, into a catalog item */
    if (seg[0] === 'specs' && seg[2] === 'candidates' && req.method === 'POST') {
      const id = seg[1]
      const body = await readJson(req).catch(() => ({}))
      const rec = await recipeFor(id, { view: body.view, chroma: body.chroma, glassKey: body.glassKey })
      if (!rec) return json(res, 404, { error: `no spec ${id}` })
      const n = Math.min(8, Math.max(1, Number(body.count ?? 4)))
      // seeds are EXPLICIT and reported, so the one a person picks can be pinned
      const seeds = body.seeds?.length ? body.seeds.slice(0, n) : Array.from({ length: n }, (_, i) => Number(body.seed ?? 1) + i)
      await catalog.put(id, { subject: rec.subject ?? id, kind: rec.class ?? 'prop', prompt: rec.prompt, negative: rec.negative, spec: { id: rec.id, roster: rec.roster, chroma: rec.chroma, glassKey: rec.glassKey } })
      const job = jobs.start('image', `candidates ${id} x${n}`, async (report) => {
        const drawn = []
        for (const [i, seed] of seeds.entries()) {
          report({ state: 'generating', drawn: i, of: n, seed })
          const out = await registry.image.generate({ prompt: rec.prompt, negative: body.negative ?? rec.negative, size: body.size, steps: body.steps, seed, trueCfg: body.trueCfg })
          const file = await catalog.addView(id, out.png, { model: registry.image.id, seconds: out.seconds, seed, spec: rec.id, ...out.meta })
          drawn.push({ file: `views/${file}`, seed, seconds: out.seconds })
        }
        return { id, drawn, recipe: { chroma: rec.chroma, glassKey: rec.glassKey, why: rec.why } }
      })
      return json(res, 202, { job, recipe: rec })
    }
    /** a human picked one: pin the view AND its seed, which is what makes it reproducible */
    if (seg[0] === 'catalog' && seg[2] === 'choose' && req.method === 'POST') {
      const id = seg[1]
      const body = await readJson(req)
      const item = await catalog.get(id)
      if (!item) return json(res, 404, { error: `no item ${id}` })
      const view = String(body.view ?? '').replace(/^views\//, '')
      if (!item.views?.includes(view)) return json(res, 400, { error: `${id} has no view ${JSON.stringify(view)}`, views: item.views ?? [] })
      // the seed comes from the provenance of that view, not from the caller: the caller is a
      // person clicking a picture and does not know what made it
      const made = (item.history ?? []).filter((h) => h.file === `views/${view}` || h.name === view).pop()
      const seed = body.seed ?? made?.seed ?? null
      await catalog.record(id, { step: 'choose', file: `views/${view}`, seed })
      return json(res, 200, { item: await catalog.put(id, { chosen: view, seed }) })
    }

    if (seg[0] === 'jobs') {
      if (seg.length === 1) return json(res, 200, { jobs: jobs.list() })
      const j = jobs.status(seg[1])
      return j ? json(res, 200, j) : json(res, 404, { error: 'no such job' })
    }

    if (seg[0] === 'catalog') {
      if (seg.length === 1) {
        if (req.method === 'GET') return json(res, 200, { items: await catalog.list() })
        if (req.method === 'POST') {
          const spec = await readJson(req)
          if (!spec.id) return json(res, 400, { error: 'id is required' })
          return json(res, 200, await catalog.put(spec.id, spec))
        }
      }
      const id = seg[1]
      if (seg.length === 2) {
        if (req.method === 'GET') return json(res, 200, await catalog.get(id))
        if (req.method === 'PUT' || req.method === 'POST') return json(res, 200, await catalog.put(id, await readJson(req)))
        if (req.method === 'DELETE') {
          await catalog.remove(id)
          return json(res, 200, { deleted: id })
        }
      }
      if (seg.length === 3 && req.method === 'POST' && seg[2] === 'image') return json(res, 202, startImage(id, await readJson(req)))
      if (seg.length === 3 && req.method === 'POST' && seg[2] === 'mesh') return json(res, 202, startMesh(id, await readJson(req)))
      if (seg.length >= 3 && seg[2] === 'file') {
        const rel = seg.slice(3).map(decodeURIComponent).join('/')
        const buf = await catalog.read(id, rel)
        return send(res, 200, buf, TYPES[path.extname(rel).toLowerCase()] ?? 'application/octet-stream')
      }
    }

    /*
     * MATERIALS: the tileable surfaces half of the library.
     *
     * A second kind of asset with a different shape. A prop is a mesh; a material is three maps
     * and one number — `metres_per_tile`, which is the whole game: it is what turns a picture of
     * bricks into a wall of the right size, and it is the field a generated texture gets wrong.
     *
     * Served from `<data>/surfaces/`, alongside the catalog rather than inside it, because a
     * material belongs to no item — several buildings share one brick.
     */
    if (seg[0] === 'materials') {
      const dir = path.join(DATA, 'surfaces')
      if (seg.length === 1) {
        const f = path.join(dir, 'materials.json')
        const raw = await readFile(f, 'utf8').catch(() => null)
        if (!raw) return json(res, 200, { materials: [] })
        const doc = JSON.parse(raw)
        return json(res, 200, { materials: doc.materials ?? doc })
      }
      /*
       * UPLOAD AND MANAGE. Rich, 2026-09-28: "there is a pain free way to upload and manage these
       * textures."
       *
       * Raw bytes to a named file, and a JSON record beside it — the same two-part shape the
       * baked-world import uses, and for the same reason: a dependency-free server parsing
       * multipart is a lot of code to get subtly wrong, and the client already knows how to PUT a
       * Blob. One file per request means a failed upload loses one map rather than a material.
       */
      if (seg.length >= 4 && seg[2] === 'file' && req.method === 'PUT') {
        const id = seg[1]
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return json(res, 400, { error: `bad material id ${JSON.stringify(id)}` })
        const name = seg.slice(3).map(decodeURIComponent).join('/')
        if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(name) || name.includes('..')) {
          return json(res, 400, { error: `bad file name ${JSON.stringify(name)}` })
        }
        const ext = path.extname(name).toLowerCase()
        if (!['.jpg', '.jpeg', '.png', '.webp', '.ktx2'].includes(ext)) {
          return json(res, 400, { error: `${ext || 'no extension'} is not a texture — jpg, png, webp or ktx2` })
        }
        const buf = await body(req, 64 * 2 ** 20)
        await mkdir(path.join(dir, id), { recursive: true })
        await writeFile(path.join(dir, id, name), buf)
        return json(res, 200, { id, file: name, bytes: buf.length })
      }

      // PUT /materials/<id> — the record. Merged, so uploading a normal map later keeps the rest.
      if (seg.length === 2 && req.method === 'PUT') {
        const id = seg[1]
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return json(res, 400, { error: `bad material id ${JSON.stringify(id)}` })
        const patch = await readJson(req)
        const f = path.join(dir, 'materials.json')
        const doc = JSON.parse(await readFile(f, 'utf8').catch(() => '{"materials":[]}'))
        const list = doc.materials ?? []
        const at = list.findIndex((m) => m.id === id)
        const next = { ...(at >= 0 ? list[at] : {}), ...patch, id }
        if (!(next.metres_per_tile > 0)) return json(res, 400, { error: 'metres_per_tile must be a positive number — it is what makes the texture the right size' })
        if (at >= 0) list[at] = next
        else list.push(next)
        list.sort((a, b) => ((a.category ?? '') + a.id < (b.category ?? '') + b.id ? -1 : 1))
        await mkdir(dir, { recursive: true })
        await writeFile(f, JSON.stringify({ materials: list }, null, 1))
        return json(res, 200, { material: next })
      }

      if (seg.length === 2 && req.method === 'DELETE') {
        const id = seg[1]
        const f = path.join(dir, 'materials.json')
        const doc = JSON.parse(await readFile(f, 'utf8').catch(() => '{"materials":[]}'))
        const list = (doc.materials ?? []).filter((m) => m.id !== id)
        await writeFile(f, JSON.stringify({ materials: list }, null, 1))
        // the files stay: a record removed by accident is one PUT away, a directory is not
        return json(res, 200, { deleted: id, filesKept: true })
      }

      // /materials/<id>/file/<name>
      if (seg.length >= 4 && seg[2] === 'file') {
        const id = seg[1]
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return json(res, 400, { error: `bad material id ${JSON.stringify(id)}` })
        const rel = seg.slice(3).map(decodeURIComponent).join('/')
        // no traversal: a material's files are its own directory and nothing above it
        if (rel.includes('..') || rel.startsWith('/')) return json(res, 400, { error: 'bad path' })
        const buf = await readFile(path.join(dir, id, rel))
        return send(res, 200, buf, TYPES[path.extname(rel).toLowerCase()] ?? 'application/octet-stream')
      }
    }

    if (seg[0] === 'sync' && req.method === 'POST') {
      if (!s3.configured) return json(res, 400, { error: 'S3 is not configured', s3: s3.describe() })
      if (seg[1] === 'push') return json(res, 200, await s3.pushDir(catalog.root, 'catalog/'))
      if (seg[1] === 'pull') return json(res, 200, await s3.pullDir(catalog.root, 'catalog/'))
    }

    return json(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
  } catch (e) {
    const status = e?.status ?? (e?.code === 'ENOENT' ? 404 : 500)
    if (status >= 500) console.error(`${req.method} ${url.pathname}:`, e)
    return json(res, status, { error: String(e?.message ?? e) })
  }
})

server.listen(PORT, HOST, () => {
  const d = registry.describe()
  console.log(`assetsvc on http://${HOST}:${PORT}`)
  console.log(`  catalog   ${catalog.root}`)
  console.log(`  image     ${d.defaults.image ?? '(none)'}  ${registry.models.get(d.defaults.image)?.url ?? ''}`)
  console.log(`  mesh      ${d.defaults.mesh ?? '(none)'}  ${registry.models.get(d.defaults.mesh)?.url ?? ''}`)
  console.log(`  s3        ${s3.configured ? `${s3.bucket}/${s3.prefix}` : 'not configured'}`)
})

/*
 * SHUT DOWN WHEN ASKED, because as PID 1 nothing else will.
 *
 * The same trap as tools/worldeditor/server.mjs, which is where it was found and measured. This
 * is the container's entrypoint, so `node` is process 1, and the kernel does not apply default
 * signal dispositions to PID 1 — a signal with no handler is IGNORED there, the opposite of what
 * happens for every other process. Kubernetes then waits out the whole termination grace period
 * and SIGKILLs, which on the world editor turned every rollout into a thirty-second 503.
 *
 * `closeIdleConnections` as well as `close`: a keep-alive socket from a browser doing nothing
 * still holds the server open, and `close` alone waits for it. Measured at 21 ms with one held
 * open, against a grace period of thirty seconds.
 */
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return process.exit(0) // a second one means "now"
    stopping = true
    console.log(`${signal}: closing`)
    const hard = setTimeout(() => process.exit(0), 5000)
    hard.unref()
    server.closeIdleConnections()
    server.close(() => process.exit(0))
  })
}
