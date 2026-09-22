#!/usr/bin/env node
// worldeditor — the pod that turns OSM into a corridor world.
//
// One origin. The browser knows this service and nothing else: not Overpass, not the Kubernetes
// API, not flux, not TRELLIS, not the bucket. That is the same constraint assetsvc exists to
// enforce, extended to the rest of the pipeline, and it is why there is a reverse proxy to
// assetsvc here rather than a second hostname in the page.
//
//   browser ──HTTP──> worldeditor ──┬─► Overpass (ours, cached on the volume with the bake)
//                                   ├─► the Kubernetes API (start a bake Job, read its log)
//                                   ├─► assetsvc (proxied; it reaches the GPUs, we never do)
//                                   └─► the volume: sites, worlds, runs, authored files, catalog
//
// WHAT IT SERVES, AND WHY IT IS ALSO A STATIC SERVER. `apps/corridor` is three pages — the viewer,
// the editor and the world editor — and the editor SAVES by PUTing to `/sites/<slug>/<file>.json`.
// In development that PUT is answered by a middleware inside `apps/corridor/vite.config.ts`, which
// does not exist in a pod. Serving the built app and the bake from the same origin here means the
// editor's save path is the same path in both places, with no `?data=`, no CORS, and no second
// implementation to drift (store.mjs putAuthored).
//
//   node tools/worldeditor/server.mjs --port 8780 --data tools/corridor/data
//
// Configuration is environment, so the chart and a laptop run the same code. See README.md.

import http from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createGzip } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Store } from './store.mjs'
import { Overpass, PUBLIC_MIRRORS } from './overpass.mjs'
import { K8s } from './k8s.mjs'
import { Runs } from './runs.mjs'
import { bboxOf, circleFor } from './geo.mjs'
import * as worlds from './worlds.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const env = process.env

const PORT = Number(arg('port', env.WORLDEDITOR_PORT ?? 8780))
const HOST = arg('host', env.WORLDEDITOR_HOST ?? '0.0.0.0')
const DATA = path.resolve(arg('data', env.WORLDEDITOR_DATA ?? path.join(REPO, 'tools/corridor/data')))
const APP = path.resolve(arg('app', env.WORLDEDITOR_APP ?? path.join(REPO, 'apps/corridor/dist')))
const ASSETSVC = (env.WORLDEDITOR_ASSETSVC ?? '').replace(/\/$/, '')

const store = new Store(DATA)
store.catalogSeed = path.join(REPO, 'apps/corridor/public/assets/catalog.json')
await store.init()
await store.seedWorlds(env.WORLDEDITOR_SEED_SITES ?? path.join(REPO, 'tools/corridor/sites.json'))

// Ours first, the public mirrors behind it — the same order and the same list osm.py uses, for
// the same reason: our extract is one region, so a California site still needs a mirror, and every
// mirror refused connections for an hour on 2026-09-21.
const overpass = new Overpass(store, [
  ...(env.WORLDEDITOR_OVERPASS_URL ?? 'https://overpass.richard-siomporas.basedweights.com/api/interpreter').split(',').map((s) => s.trim()),
  ...PUBLIC_MIRRORS,
])
const k8s = new K8s(env)
const runs = new Runs(store, k8s, {
  force: env.WORLDEDITOR_RUNNER ?? null,
  image: env.WORLDEDITOR_BAKE_IMAGE ?? 'ghcr.io/hotspoons/corridor:latest',
  claim: env.WORLDEDITOR_CLAIM ?? 'corridor-data',
  secretName: env.WORLDEDITOR_S3_SECRET ?? 'corridor-r2',
  bucket: env.WORLDEDITOR_S3_BUCKET ?? '',
  endpoint: env.WORLDEDITOR_S3_ENDPOINT ?? '',
  region: env.WORLDEDITOR_S3_REGION ?? 'auto',
  prefix: env.WORLDEDITOR_S3_PREFIX ?? 'corridor',
  overpassUrl: env.WORLDEDITOR_OVERPASS_URL ?? '',
  horizonM: Number(env.WORLDEDITOR_HORIZON_M ?? 30000),
  resources: JSON.parse(env.WORLDEDITOR_BAKE_RESOURCES ?? '{"requests":{"cpu":"4","memory":"16Gi"},"limits":{"cpu":"16","memory":"48Gi"}}'),
  python: env.WORLDEDITOR_PYTHON ?? path.join(REPO, 'tools/corridor/.venv/bin/python'),
  cwd: env.WORLDEDITOR_CORRIDOR ?? path.join(REPO, 'tools/corridor'),
})
const adopted = await runs.reconcile()

/* ---- http plumbing ---------------------------------------------------------------------------- */

const CORS = {
  // In the pod the app is served from this origin and this costs nothing. In development Vite is
  // on 5212 and proxies to here, which is also same-origin — so `*` is only ever reached by a
  // person poking at the API with curl.
  'Access-Control-Allow-Origin': env.WORLDEDITOR_CORS ?? '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Returns true, always — `api()` hands that back so the router knows the route was handled. A
// helper that returned undefined here made every API call fall through to the static handler and
// then to the 404, writing headers twice; the symptom was ERR_HTTP_HEADERS_SENT on a route that
// had in fact answered correctly.
const json = (res, status, body) => {
  const buf = Buffer.from(JSON.stringify(body, null, 2))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...CORS })
  res.end(buf)
  return true
}

async function readBody(req, limit = 8 * 1024 * 1024) {
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
  const b = await readBody(req)
  return b.length ? JSON.parse(b.toString('utf8')) : {}
}

const TYPES = {
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.ktx2': 'image/ktx2',
  '.pack': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.laz': 'application/vnd.laszip',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}
const typeOf = (f) => TYPES[path.extname(f).toLowerCase()] ?? 'application/octet-stream'

/**
 * Send a file, gzipping JSON on the way out.
 *
 * crofton-triangle's manifest is 6.5 MB of JSON and uncompressed it was 1 348 ms of the viewer's
 * load against 13 ms to parse — transfer, not compute. The rasters are already compressed and
 * gzipping them again only burns CPU, so the test is on the extension, exactly as the dev
 * middleware does it.
 */
async function sendFile(req, res, file, { cache = 'no-cache' } = {}) {
  const st = await stat(file).catch(() => null)
  if (!st || !st.isFile()) return false
  const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && /\.(json|geojson|js|mjs|css|html|svg|txt)$/i.test(file)
  const head = { 'Content-Type': typeOf(file), 'Cache-Control': cache, ...CORS }
  if (gz) {
    res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' })
    createReadStream(file).pipe(createGzip()).pipe(res)
  } else {
    res.writeHead(200, { ...head, 'Content-Length': st.size })
    createReadStream(file).pipe(res)
  }
  return true
}

/* ---- the assetsvc reverse proxy ---------------------------------------------------------------- */

/**
 * `/assetsvc/*` → assetsvc, unmodified.
 *
 * `apps/corridor/src/assetsvc.ts` already resolves to same-origin `/assetsvc` when it is served
 * from port 80/443, "which is how it looks in the cluster, behind one ingress". That sentence was
 * written before there was anything to be behind. This is it. Proxying rather than putting a
 * second hostname in the page keeps the browser's origin count at one, which is the property the
 * whole design rests on.
 */
async function proxyAssetsvc(req, res, rest) {
  if (!ASSETSVC) return json(res, 503, { error: 'assetsvc is not configured', hint: 'set WORLDEDITOR_ASSETSVC' })
  const url = `${ASSETSVC}/${rest}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`
  const init = { method: req.method, headers: {}, signal: AbortSignal.timeout(300000) }
  if (req.headers['content-type']) init.headers['content-type'] = req.headers['content-type']
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') init.body = await readBody(req, 64 * 1024 * 1024)
  const up = await fetch(url, init)
  const buf = Buffer.from(await up.arrayBuffer())
  res.writeHead(up.status, {
    'Content-Type': up.headers.get('content-type') ?? 'application/octet-stream',
    'Content-Length': buf.length,
    ...CORS,
  })
  res.end(buf)
}

/* ---- routes ------------------------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const seg = url.pathname.split('/').filter(Boolean)
  const q = url.searchParams
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }

    /* the bake tree, and the editor's save — the dev middleware's contract, in a pod */
    if (seg[0] === 'sites') {
      const rel = seg.slice(1).join('/')
      if (req.method === 'PUT') {
        const bytes = await store.putAuthored(rel, await readBody(req))
        return json(res, 200, { ok: true, bytes })
      }
      const file = store.fileFor(rel)
      if (file && (await sendFile(req, res, file))) return
      // never an HTML fallback: `r.json()` on '<!doctype' is a bug two agents have already paid for
      return json(res, 404, { error: 'not found', path: url.pathname })
    }

    /* the placement catalog, merged on the volume, at the path the editor already fetches */
    if (url.pathname === '/assets/catalog.json') return json(res, 200, await store.catalog())

    if (seg[0] === 'assetsvc') return await proxyAssetsvc(req, res, seg.slice(1).join('/'))

    if (seg[0] === 'api') {
      const r = await api(req, res, seg.slice(1), q, url)
      if (r !== undefined) return r
    }

    /* the built app, last, so nothing above can be shadowed by a file in dist */
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'world.html' : url.pathname.replace(/^\/+/, '')
      const file = path.resolve(APP, rel)
      if (file.startsWith(APP) && (await sendFile(req, res, file, { cache: /\/assets\/.*-[A-Za-z0-9_]{8}\./.test(url.pathname) ? 'public, max-age=31536000, immutable' : 'no-cache' }))) return
    }

    return json(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
  } catch (e) {
    const status = e?.status ?? (e?.code === 'ENOENT' ? 404 : 500)
    if (status >= 500) console.error(`${req.method} ${url.pathname}:`, e)
    return json(res, status, { error: String(e?.message ?? e) })
  }
})

async function api(req, res, seg, q) {
  /* ---- liveness, readiness, what this is pointed at ---- */
  if (seg[0] === 'health') return json(res, 200, { ok: true, data: store.root })
  if (seg[0] === 'ready') {
    // Readiness reports; it does NOT gate. If Overpass is down this can still serve baked sites,
    // save authored files and watch a run, and taking the pod out of the Service for that would
    // break the editor for a fault it can work around and report. The kubelet probes /api/health.
    const [op, kube] = await Promise.all([overpass.available(), k8s.permitted()])
    return json(res, 200, { ok: true, overpass: op, kubernetes: kube, runner: runs.runner, assetsvc: ASSETSVC || null })
  }
  if (seg[0] === 'config') {
    return json(res, 200, {
      data: store.root,
      app: APP,
      overpass: overpass.describe(),
      runs: runs.describe(),
      assetsvc: ASSETSVC ? '/assetsvc' : null,
      bucket: runs.cfg.bucket ? { bucket: runs.cfg.bucket, endpoint: runs.cfg.endpoint || 'aws', prefix: runs.cfg.prefix } : null,
      authored: (await import('./store.mjs')).AUTHORED,
      limits: { min_radius_m: worlds.MIN_M, warn_radius_m: worlds.WARN_M, max_radius_m: worlds.MAX_M },
      adoptedRuns: adopted,
    })
  }

  /* ---- the map ---- */
  if (seg[0] === 'osm' && seg[1] === 'roads' && req.method === 'GET') {
    const bbox = { south: Number(q.get('south')), west: Number(q.get('west')), north: Number(q.get('north')), east: Number(q.get('east')) }
    for (const [k, v] of Object.entries(bbox)) if (!Number.isFinite(v)) return json(res, 400, { error: `${k} is required` })
    // A box this service will actually answer. Overpass does not care how big a bbox is until it
    // has spent five minutes finding out, and a page that has zoomed out to the state does not
    // want the state.
    const spanLat = bbox.north - bbox.south
    const spanLon = bbox.east - bbox.west
    if (spanLat > 0.35 || spanLon > 0.45) return json(res, 400, { error: 'zoom in — the road query is capped at about 40 km a side', span: { spanLat, spanLon } })
    return json(res, 200, await overpass.drivable(bbox, { refresh: q.get('refresh') === '1' }))
  }
  if (seg[0] === 'osm' && seg[1] === 'search' && req.method === 'GET') {
    return json(res, 200, await overpass.search(q.get('q') ?? ''))
  }

  /* ---- worlds ---- */
  if (seg[0] === 'worlds' && seg.length === 1) {
    if (req.method === 'GET') {
      const baked = await store.bakedSlugs()
      const list = (await store.listWorlds()).map((w) => ({ ...w, baked: baked.get(w.slug) ?? null }))
      // a bake on the volume with no definition beside it is still a world a person can open
      for (const [slug, b] of baked) if (!list.some((w) => w.slug === slug)) list.push({ slug, source: 'bake-only', baked: b })
      return json(res, 200, { worlds: list })
    }
    if (req.method === 'POST') {
      const world = worlds.fromDraw(await readJson(req))
      const v = worlds.validate(world)
      if (!v.ok) return json(res, 400, { error: v.errors.join('; '), ...v })
      if (await store.getWorld(world.slug)) return json(res, 409, { error: `a world called "${world.slug}" already exists` })
      return json(res, 201, { world: await store.putWorld(world), ...v })
    }
  }
  if (seg[0] === 'worlds' && seg[1] === 'preview' && req.method === 'POST') {
    const body = await readJson(req)
    const ring = (body.boundary ?? []).map((p) => (Array.isArray(p) ? { lon: p[0], lat: p[1] } : p))
    const circle = body.centre && body.radius_m ? { ...body.centre, radius_m: Number(body.radius_m) } : ring.length >= 3 ? circleFor(ring) : null
    if (!circle) return json(res, 400, { error: 'give a boundary of at least three points, or a centre and a radius' })
    const v = worlds.validate({ slug: 'preview-x', kind: null, ...circle })
    if (!v.ok) return json(res, 400, { error: v.errors.join('; '), circle, ...v })
    // The bake's own box, as near as this service will claim: a geodetic square of side 2R. The
    // bake's is the geodetic bbox of a UTM square, which is LARGER — see overpass.mjs.
    const bbox = bboxOf(
      [
        { lat: circle.lat - circle.radius_m / 111132, lon: circle.lon - circle.radius_m / (111412.84 * Math.cos((circle.lat * Math.PI) / 180)) },
        { lat: circle.lat + circle.radius_m / 111132, lon: circle.lon + circle.radius_m / (111412.84 * Math.cos((circle.lat * Math.PI) / 180)) },
      ],
      0,
    )
    const { ways, cache } = await overpass.drivable(bbox)
    const selection = worlds.selectWays(ways, { centre: circle, radius_m: circle.radius_m, boundary: ring })
    return json(res, 200, { circle, bbox, selection, primary: worlds.suggestPrimary(selection), cache, warnings: v.warnings })
  }
  if (seg[0] === 'worlds' && seg.length === 2) {
    const slug = seg[1]
    if (req.method === 'GET') {
      const w = await store.getWorld(slug)
      return w ? json(res, 200, { world: w }) : json(res, 404, { error: `no world ${slug}` })
    }
    if (req.method === 'PUT') {
      const body = await readJson(req)
      const prev = await store.getWorld(slug)
      const world = { ...(prev ?? {}), ...body, slug }
      const v = worlds.validate(world)
      if (!v.ok) return json(res, 400, { error: v.errors.join('; '), ...v })
      return json(res, 200, { world: await store.putWorld(world), ...v, movedM: prev ? worlds.centreMoveM(prev, world) : 0 })
    }
    if (req.method === 'DELETE') {
      // The DEFINITION only. A bake costs hours of somebody else's bandwidth and this endpoint
      // will not delete one; removing a baked site is a decision made against the volume.
      await store.removeWorld(slug)
      return json(res, 200, { deleted: slug, note: 'the definition only — anything already baked under sites/ is untouched' })
    }
  }

  /* ---- runs ---- */
  if (seg[0] === 'runs' && seg.length === 1 && req.method === 'GET') return json(res, 200, { runs: await runs.list(Number(q.get('limit') ?? 50)), runner: runs.runner })
  if (seg[0] === 'runs' && seg[1] === 'bake' && req.method === 'POST') {
    const body = await readJson(req)
    if (!body.slug) return json(res, 400, { error: 'slug is required' })
    if (body.slug !== 'all' && !(await store.getWorld(body.slug))) return json(res, 404, { error: `no world ${body.slug} — define it first` })
    return json(res, 202, { run: await runs.bake(body.slug, body) })
  }
  if (seg[0] === 'runs' && seg[1] === 'publish' && req.method === 'POST') {
    const body = await readJson(req)
    return json(res, 202, { run: await runs.publish(body.slug ?? 'all', body) })
  }
  if (seg[0] === 'runs' && seg.length === 2 && req.method === 'GET') {
    const run = await runs.get(seg[1])
    return run ? json(res, 200, { run }) : json(res, 404, { error: `no run ${seg[1]}` })
  }
  if (seg[0] === 'runs' && seg[2] === 'log' && req.method === 'GET') {
    return json(res, 200, await runs.log(seg[1], Number(q.get('offset') ?? 0)))
  }
  if (seg[0] === 'runs' && seg[2] === 'cancel' && req.method === 'POST') {
    return json(res, 200, { run: await runs.cancel(seg[1]) })
  }

  /* ---- the placement catalog ---- */
  if (seg[0] === 'catalog' && req.method === 'GET') return json(res, 200, await store.catalog())
  if (seg[0] === 'catalog' && req.method === 'POST') {
    const body = await readJson(req)
    const entries = Array.isArray(body) ? body : body.assets ? body.assets : [body]
    return json(res, 200, await store.mergeCatalog(entries))
  }
  return undefined
}

server.listen(PORT, HOST, () => {
  console.log(`worldeditor on http://${HOST}:${PORT}`)
  console.log(`  data      ${store.root}`)
  console.log(`  app       ${APP}`)
  console.log(`  overpass  ${overpass.urls[0] ?? '(none)'}`)
  console.log(`  runner    ${runs.runner}${runs.runner === 'kubernetes' ? ` (${k8s.namespace}, ${runs.cfg.image}, pvc ${runs.cfg.claim})` : ` (${runs.cfg.python})`}`)
  console.log(`  assetsvc  ${ASSETSVC || 'not configured'}`)
  console.log(`  bucket    ${runs.cfg.bucket ? `${runs.cfg.bucket}/${runs.cfg.prefix}` : 'not configured'}`)
  if (adopted.length) console.log(`  adopted   ${adopted.length} run(s) that were live when this last stopped`)
})
