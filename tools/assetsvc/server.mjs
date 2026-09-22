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
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { buildRegistry } from './adapters.mjs'
import { Catalog } from './catalog.mjs'
import { Jobs } from './jobs.mjs'
import { S3 } from './s3.mjs'

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

const TYPES = { '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json', '.webp': 'image/webp' }

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
