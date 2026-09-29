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
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createGzip, gzip } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Store } from './store.mjs'
import { zipRead, zipWrite } from './zip.mjs'
import { Captures } from './captures.mjs'
import { ModelResolver } from './models.mjs'
import * as levels from './levels.mjs'
import { GitRepo, scan as gitScan } from './gitrepo.mjs'
import { Platform } from './platform.mjs'
import { attachAgentRelay } from './agentws.mjs'
import { McpAuth } from './mcpauth.mjs'
import { McpBridge } from './mcpbridge.mjs'
import * as mcp from './mcp.mjs'
import * as training from './training.mjs'
import { Overpass, PUBLIC_MIRRORS } from './overpass.mjs'
import { Tiles } from './tiles.mjs'
import { Basemap } from './basemap.mjs'
import { Geocoder } from './geocode.mjs'
import { LAYERS, layersAt, tilesFor, variantOf, tileLevelOf } from './layers.mjs'
import { K8s } from './k8s.mjs'
import { Runs } from './runs.mjs'
import { bboxOf, circleFor } from './geo.mjs'
import * as worlds from './worlds.mjs'
import * as rooms from './rooms.mjs'

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

/**
 * The biggest road query this will run, MEASURED rather than guessed.
 *
 * Every drivable way in a box around Crofton, warm cache excluded, on 2026-09-22:
 *
 *   0.10 x 0.14   2 066 ways    2.1 MB     9 s
 *   0.15 x 0.21   4 721 ways    4.6 MB    79 s
 *   0.25 x 0.35  17 173 ways   15.0 MB    11 s
 *   0.34 x 0.44  31 053 ways   26.5 MB   > 300 s cold (it completed and cached; the CLIENT gave up)
 *
 * The first cap here was 0.35 x 0.45 "about 40 km a side", which permits that last row: 26 MB of
 * JSON, minutes of somebody else's Overpass, to draw 31 000 residential streets into a window
 * where each is a fraction of a pixel wide. A cap should be the largest query worth running, not
 * the largest one that eventually returns. 0.25 x 0.35 is about 28 x 30 km and is the last row
 * that comes back in a time a person will wait for.
 *
 * The client does not rely on this: it sizes its own request to fit (see loadRoads) and tells the
 * person to zoom in rather than firing something it knows will be refused. This is the backstop.
 */
const MAX_SPAN_LAT = 0.25
const MAX_SPAN_LON = 0.35

const captures = new Captures(DATA)
await captures.init()
const store = new Store(DATA)
/** The platform, for the agent picker and the tunnel relay. Holds the PAT; see platform.mjs. */
const platform = new Platform(DATA)

/**
 * Where an agent reaches this editor's MCP server.
 *
 * From the REQUEST's own host, not a configured one: in a cluster this service is reached by a
 * name only the cluster knows, and a hard-coded `localhost` would be a URL that works on a laptop
 * and resolves to the agent's own pod everywhere else. `WORLDEDITOR_PUBLIC_URL` overrides it for
 * the case where the agent comes in by a different route than the browser does.
 */
function mcpUrl(req) {
  if (env.WORLDEDITOR_PUBLIC_URL) return `${env.WORLDEDITOR_PUBLIC_URL.replace(/\/$/, '')}/api/agent/mcp`
  const host = req.headers.host ?? `localhost:${PORT}`
  return `http://${host}/api/agent/mcp`
}
store.catalogSeed = path.join(REPO, 'apps/corridor/public/assets/catalog.json')
await store.init()
/*
 * SEEDING IS OPT-IN, AND IT DID NOT USED TO BE.
 *
 * This seeded from the repo's `tools/corridor/sites.json` whenever the volume was empty, which is
 * right for a laptop -- the sites you already have are the ones you want to open -- and wrong for
 * a deployment, where it means a fresh instance comes up carrying thirty of somebody else's
 * worlds (Rich, 2026-09-27). Set WORLDEDITOR_SEED_SITES to a path to seed from it, or to the word
 * `repo` for the checked-in list. Unset, a new volume starts empty, which is what a blank world
 * map should mean.
 */
const seedFrom = env.WORLDEDITOR_SEED_SITES
if (seedFrom) {
  const r = await store.seedWorlds(seedFrom === 'repo' ? path.join(REPO, 'tools/corridor/sites.json') : seedFrom)
  if (r.seeded) console.log(`  seeded    ${r.seeded} world definitions from ${r.from}`)
  else console.log(`  seeded    nothing (${r.reason})`)
}

// THE DEFAULT IS THE PUBLIC MIRRORS, AND OURS IS OPT-IN. It used to be the other way round, and
// that was wrong for one measured reason: our instance holds ONE REGION, and a regional instance
// answers a box it does not hold with HTTP 200 and zero ways. With it first and undeclared, a
// query about the Alps came back empty after 240 s and the emptiness was cached. The guard for
// that is a coverage box on the URL (`#south/west/north/east`) — so if you want ours in the list,
// declare what it holds, and the rotation will use it where it helps and skip it where it lies.
// When it holds the planet (docs/corridor/OVERPASS-PLANET.md) it needs no box and should be first.
const configured = (env.WORLDEDITOR_OVERPASS_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean)
for (const u of configured) {
  if (!u.includes('#') && !/overpass-api\.de|kumi\.systems|private\.coffee/.test(u)) {
    console.warn(`overpass: ${u.split('#')[0]} has no coverage box. If it is regional, add #south/west/north/east or it will answer HTTP 200 with nothing outside its extent and that answer looks exactly like "no roads here".`)
  }
}
const overpass = new Overpass(
  store,
  [...configured, ...PUBLIC_MIRRORS],
  {
    // Tunable because the right answer depends on the extract: ours on a warm database answers a
    // county in seconds, a public mirror under load took 79 s for the same query, and a laptop
    // testing the fallback wants neither.
    timeoutMs: Number(env.WORLDEDITOR_OVERPASS_TIMEOUT ?? 120000),
    deadlineMs: Number(env.WORLDEDITOR_OVERPASS_DEADLINE ?? 240000),
    downForMs: Number(env.WORLDEDITOR_OVERPASS_DOWN_FOR ?? 60000),
  },
)
const tiles = new Tiles(store, overpass)
const basemap = new Basemap(store, { enabled: env.WORLDEDITOR_BASEMAP !== 'off' })
const geocoder = new Geocoder(store, {
  url: env.WORLDEDITOR_NOMINATIM ?? 'https://nominatim.openstreetmap.org',
  minIntervalMs: Number(env.WORLDEDITOR_NOMINATIM_INTERVAL ?? 1100),
})
const k8s = new K8s(env)
// where flux, TRELLIS and qwen are TODAY: discovered through the cluster, never hard-coded
// (models.mjs). Declared HERE and not beside the other services, because it takes `k8s` and a
// const used above its own declaration throws on the first request rather than at startup.
const models = new ModelResolver(k8s, env)
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
/**
 * Returns true, always — `api()` hands that back so the router knows the route was handled. A
 * helper that returned undefined here made every API call fall through to the static handler and
 * then to the 404, writing headers twice; the symptom was ERR_HTTP_HEADERS_SENT on a route that
 * had in fact answered correctly.
 *
 * GZIPPED ABOVE 4 kB. The map's payloads are JSON and JSON compresses like nothing else: the
 * borders layer is 880 kB raw and 108 kB gzipped, and a roads tile is the same shape. The
 * threshold is there because below it the header costs more than the saving. Async, not
 * `gzipSync`: compressing 880 kB on the event loop is ten milliseconds in which this service
 * answers nothing at all, liveness probe included.
 *
 * Pretty-printed only when it is small. A 26 MB tile does not need two-space indentation, and the
 * indentation was a third of the bytes before gzip got to it.
 */
const json = (res, status, body) => {
  const text = JSON.stringify(body, null, 2)
  const buf = Buffer.byteLength(text) > 4096 ? Buffer.from(JSON.stringify(body)) : Buffer.from(text)
  const wantsGzip = /\bgzip\b/.test(String(res.req?.headers?.['accept-encoding'] ?? ''))
  if (!wantsGzip || buf.length <= 4096) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...CORS })
    res.end(buf)
    return true
  }
  gzip(buf, (err, out) => {
    if (err) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...CORS })
      return res.end(buf)
    }
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'Content-Length': out.length,
      Vary: 'Accept-Encoding',
      ...CORS,
    })
    res.end(out)
  })
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

/** How many tiles of each layer one viewport may ask for. See the note in the plan route. */
const CAPS = { places: 16, major: 6, roads: 9 }

/** Squared distance from a tile's centre to a point, for "fetch the middle of the screen first". */
function dist2(t, z, lon, lat) {
  const cols = 2 ** (z + 1)
  const rows = 2 ** z
  const cx = -180 + ((t.x + 0.5) * 360) / cols
  const cy = 90 - ((t.y + 0.5) * 180) / rows
  return (cx - lon) ** 2 + (cy - lat) ** 2
}

/*
 * THE MCP ENDPOINT'S TOKEN AND THE EDITOR BRIDGE (agentmcp lane, 2026-09-29).
 *
 * The token gates `/api/agent/mcp` and the bridge socket; see mcpauth.mjs for why it is optional
 * and why it defaults on anywhere that is not plainly localhost. The bridge is how the service
 * reaches tools that only exist in a page — the wasm shell and the TypeScript service.
 */
const mcpAuth = await new McpAuth({ dataDir: DATA, env }).load()
const mcpBridge = new McpBridge({ log: console })

/**
 * The service calling itself, so an MCP tool takes exactly the path the editor's own request does
 * — validation, warnings and all. One hop for one implementation of every rule.
 */
async function apiFetch(method, apiPath, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${apiPath}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text.slice(0, 2000) } }
  if (!r.ok) {
    const e = new Error(parsed?.error ?? `HTTP ${r.status} from ${apiPath}`)
    e.status = r.status
    throw e
  }
  return parsed
}

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
  /*
   * How big a chunk may an upload send? THE SERVER SAYS, because only the server knows what is in
   * front of it. An ingress with `proxy-body-size: 64m` turns a 64 MiB chunk into a 413 three
   * hours into a capture, and the client has no way to find that out for itself.
   */
  if (seg[0] === 'uploads' && seg[1] === 'limits' && req.method === 'GET') {
    return json(res, 200, { chunkBytes: Number(env.WORLDEDITOR_UPLOAD_CHUNK_MIB ?? 32) * 2 ** 20, why: 'the ingress in front of this service limits a single body; stay under it' })
  }
  /* which inference is reachable from this pod, and how it was found. `?live=1` asks each one. */
  if (seg[0] === 'models' && req.method === 'GET') {
    return json(res, 200, { models: await models.describe({ live: q.get('live') === '1' }) })
  }
  if (seg[0] === 'ready') {
    // Readiness reports; it does NOT gate. If Overpass is down this can still serve baked sites,
    // save authored files and watch a run, and taking the pod out of the Service for that would
    // break the editor for a fault it can work around and report. The kubelet probes /api/health.
    const [ours, kube] = await Promise.all([overpass.available(), k8s.permitted()])
    // If ours is down, say whether anything else is — "overpass: DOWN" on a page that is working
    // perfectly off a public mirror is a true statement that misleads.
    const fallbacks = ours.ok ? [] : await overpass.probe()
    const using = ours.ok ? ours.url : (fallbacks.find((p) => p.ok)?.url ?? null)
    return json(res, 200, {
      ok: true,
      overpass: { ...ours, using, fellBack: !!(using && using !== overpass.ours), upstreams: fallbacks },
      kubernetes: kube,
      runner: runs.runner,
      assetsvc: ASSETSVC || null,
    })
  }
  if (seg[0] === 'config') {
    return json(res, 200, {
      data: store.root,
      app: APP,
      overpass: overpass.describe(),
      basemap: basemap.describe(),
      geocoder: geocoder.describe(),
      layers: LAYERS.map((l) => ({ id: l.id, label: l.label, minZoom: l.minZoom, maxZoom: l.maxZoom, tile: l.tile, kind: l.kind })),
      runs: runs.describe(),
      assetsvc: ASSETSVC ? '/assetsvc' : null,
      bucket: runs.cfg.bucket ? { bucket: runs.cfg.bucket, endpoint: runs.cfg.endpoint || 'aws', prefix: runs.cfg.prefix } : null,
      authored: (await import('./store.mjs')).AUTHORED,
      limits: {
        min_radius_m: worlds.MIN_M,
        warn_radius_m: worlds.WARN_M,
        max_radius_m: worlds.MAX_M,
        // The client sizes its road requests from these rather than hard-coding a zoom level.
        max_span_lat: MAX_SPAN_LAT,
        max_span_lon: MAX_SPAN_LON,
      },
      adoptedRuns: adopted,
    })
  }

  /* ---- the games' relay: who is where in a shared Squishy Hunt, and who claimed what ---- */
  if (seg[0] === 'rooms') return rooms.handle(req, res, seg.slice(1), { json, readJson, cors: CORS })

  /* ---- the map ---- */
  if (seg[0] === 'osm' && seg[1] === 'roads' && req.method === 'GET') {
    const bbox = { south: Number(q.get('south')), west: Number(q.get('west')), north: Number(q.get('north')), east: Number(q.get('east')) }
    for (const [k, v] of Object.entries(bbox)) if (!Number.isFinite(v)) return json(res, 400, { error: `${k} is required` })
    // A box this service will actually answer. Overpass does not care how big a bbox is until it
    // has spent five minutes finding out, and a page that has zoomed out to the state does not
    // want the state.
    const spanLat = bbox.north - bbox.south
    const spanLon = bbox.east - bbox.west
    if (spanLat > MAX_SPAN_LAT || spanLon > MAX_SPAN_LON) {
      return json(res, 400, {
        error: `zoom in — the road query is capped at ${MAX_SPAN_LAT}° x ${MAX_SPAN_LON}° (about 28 x 30 km), and this asked for ${spanLat.toFixed(3)} x ${spanLon.toFixed(3)}`,
        span: { spanLat, spanLon },
        cap: { lat: MAX_SPAN_LAT, lon: MAX_SPAN_LON },
      })
    }
    return json(res, 200, await overpass.drivable(bbox, { refresh: q.get('refresh') === '1' }))
  }
  /* ---- the layer stack: what the map asks for, by zoom ---- */

  if (seg[0] === 'osm' && seg[1] === 'layers' && req.method === 'GET') {
    // What exists, and what the map should be drawing at this zoom. The client reads its own
    // behaviour from here rather than hard-coding zoom numbers that would drift from the queries.
    const zoom = Number(q.get('zoom') ?? 0)
    return json(res, 200, {
      layers: LAYERS.map((l) => ({ id: l.id, label: l.label, minZoom: l.minZoom, maxZoom: l.maxZoom, tile: l.tile, kind: l.kind })),
      at: Number.isFinite(zoom) ? layersAt(zoom).map((l) => l.id) : [],
      cache: await tiles.stats(),
    })
  }

  /** Which tiles cover a viewport, so the client asks for whole cached cells rather than boxes. */
  if (seg[0] === 'osm' && seg[1] === 'plan' && req.method === 'GET') {
    const bbox = { south: Number(q.get('south')), west: Number(q.get('west')), north: Number(q.get('north')), east: Number(q.get('east')) }
    const zoom = Number(q.get('zoom'))
    for (const [k, v] of Object.entries({ ...bbox, zoom })) if (!Number.isFinite(v)) return json(res, 400, { error: `${k} is required` })
    const plan = []
    for (const layer of layersAt(zoom)) {
      const lvl = tileLevelOf(layer, zoom)
      const want = tilesFor(lvl, bbox)
      // A cap on tiles, not on span. The world at zoom 2 is 512 `places` cells and nobody needs
      // 512 requests; the biggest ones are in the middle of the screen, so take those.
      const cx = (bbox.west + bbox.east) / 2
      const cy = (bbox.south + bbox.north) / 2
      want.sort((a, b) => dist2(a, lvl, cx, cy) - dist2(b, lvl, cx, cy))
      // Capped per layer by what a tile COSTS, not by a single number: a places tile is one cheap
      // node query, a major tile is 5 MB and fifteen seconds. Sorted by distance from the middle of
      // the screen first, so the cap keeps what you are looking at.
      // THE VARIANT TRAVELS WITH THE PLAN. A layer asks a different question at different zooms —
      // `major` is motorway+trunk below zoom 9 and adds primary above it — and the server's cache
      // file already carries that in its key. The client's did not, so a tile fetched at zoom 9
      // was kept, drawn unchanged at zoom 8, and never re-asked at the right variant: primary
      // roads appearing on a motorways-only view, and road density visibly different tile to tile
      // (Rich's Northern Italy screenshot, 2026-09-27).
      plan.push({ layer: layer.id, kind: layer.kind, variant: variantOf(layer, zoom).key, tiles: want.slice(0, CAPS[layer.id] ?? 12), total: want.length })
    }
    return json(res, 200, { zoom, plan })
  }

  if (seg[0] === 'osm' && seg[1] === 'tile' && req.method === 'GET') {
    const [, , layer, z, x, y] = seg
    const zoom = Number(q.get('zoom') ?? z)
    return json(res, 200, await tiles.tile(layer, Number(z), Number(x), Number(y), zoom, { refresh: q.get('refresh') === '1' }))
  }

  /** Country outlines, so the world view is a world. Fetched once, then local for ever. */
  if (seg[0] === 'osm' && seg[1] === 'borders' && req.method === 'GET') {
    return json(res, 200, q.get('refresh') === '1' ? await basemap.fetch('countries') : await basemap.countries())
  }
  /** World cities, ranked — the overview's place layer, where Overpass would be absurd. */
  if (seg[0] === 'osm' && seg[1] === 'cities' && req.method === 'GET') {
    return json(res, 200, q.get('refresh') === '1' ? await basemap.fetch('cities') : await basemap.cities())
  }

  /**
   * Throw away every cached-empty answer, at both levels.
   *
   * "The map thinks Italy is empty" has exactly one cure, because an empty answer caches as a
   * perfectly ordinary cache entry and a hit never asks again. This is that cure, and it is a
   * POST because it deletes.
   */
  if (seg[0] === 'osm' && seg[1] === 'cache' && seg[2] === 'purge-empty' && req.method === 'POST') {
    const responses = await overpass.purgeEmpty()
    const tilesPurged = await tiles.purgeEmpty()
    return json(res, 200, { responses, tiles: tilesPurged, note: 'only entries with nothing in them were removed; anything with data in it was right when it was written' })
  }

  if (seg[0] === 'osm' && seg[1] === 'status' && req.method === 'GET') {
    // Every upstream, in the order they are tried, with what each one just answered. This is the
    // troubleshooting endpoint: "is it using ours or a public mirror" should not need a log.
    const probes = await overpass.probe()
    return json(res, 200, { ours: overpass.ours, upstreams: probes, using: probes.find((p) => p.ok)?.host ?? null, cache: store.overpassCache })
  }
  /**
   * Global search. Nominatim, not Overpass.
   *
   * The old one asked our own Overpass for `node[place][name~...]`, which finds a town in the
   * loaded extract and nothing anywhere else — fine for a tool that assumed you already knew where
   * you were going, useless for "find places in Italy". This returns a BBOX as well as a point, so
   * the editor can frame a country or a pass rather than dropping a pin at street zoom.
   */
  if (seg[0] === 'osm' && seg[1] === 'search' && req.method === 'GET') {
    return json(res, 200, await geocoder.search(q.get('q') ?? '', { refresh: q.get('refresh') === '1' }))
  }

  /* ---- the place index: found somewhere, keep it ---- */

  if (seg[0] === 'places' && seg.length === 1) {
    if (req.method === 'GET') return json(res, 200, { places: await store.listPlaces() })
    if (req.method === 'POST') {
      const body = await readJson(req)
      if (!Number.isFinite(body.lat) || !Number.isFinite(body.lon)) return json(res, 400, { error: 'lat and lon are required' })
      const id = body.id ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      return json(res, 201, { place: await store.putPlace({ ...body, id }) })
    }
  }
  if (seg[0] === 'places' && seg.length === 2) {
    const id = seg[1]
    if (req.method === 'GET') {
      const p = await store.getPlace(id)
      return p ? json(res, 200, { place: p }) : json(res, 404, { error: `no place ${id}` })
    }
    if (req.method === 'PUT') {
      const prev = await store.getPlace(id)
      if (!prev) return json(res, 404, { error: `no place ${id}` })
      return json(res, 200, { place: await store.putPlace({ ...prev, ...(await readJson(req)), id }) })
    }
    if (req.method === 'DELETE') {
      await store.removePlace(id)
      return json(res, 200, { deleted: id })
    }
  }

  /*
   * ---- import and export -------------------------------------------------------------------
   *
   * Rich, 2026-09-27: "we should be able to import and export world definitions and upload and
   * download baked worlds in zip files as well as directly publish to a bucket."
   *
   * Two different things, deliberately kept apart. A world DEFINITION is a few hundred bytes of
   * JSON -- where, how big, which road is the spine -- and moving it between machines is how you
   * hand somebody a place to bake. A BAKED world is hundreds of megabytes of raster and is moved
   * when you want the result without the eight hours. The bucket is a third route to the same
   * place and stays exactly as it was.
   */
  if (seg[0] === 'worlds' && seg[1] === 'export' && req.method === 'GET') {
    // ?slug=a&slug=b, or everything
    const want = q.getAll('slug')
    const all = await store.listWorlds()
    const picked = want.length ? all.filter((w) => want.includes(w.slug)) : all
    /*
     * THE GAMES COME WITH THE PLACE, unless you say otherwise.
     *
     * A world is where; a level is what you do there (Rich, 2026-09-27: "the ability to import and
     * export world configs for each area and game"). Handing somebody a world without its levels
     * hands them an empty road, and they are a few hundred bytes — so `?levels=0` is the opt-out
     * rather than `?levels=1` being the opt-in. Only the levels that name one of the worlds being
     * exported come along: a level pointing at a world that is not in the bundle would import as
     * something that can never be opened.
     */
    const withLevels = q.get('levels') !== '0'
    const slugs = new Set(picked.map((w) => w.slug))
    const levels = withLevels ? (await store.listLevels()).filter((l) => slugs.has(l.world)) : []
    const body = { kind: 'corridor-worlds', version: 1, exported: new Date().toISOString(), worlds: picked, levels }
    const name = picked.length === 1 ? picked[0].slug : `worlds-${picked.length}`
    res.writeHead(200, { ...CORS, 'content-type': 'application/json', 'content-disposition': `attachment; filename="${name}.corridor.json"` })
    return res.end(JSON.stringify(body, null, 1))
  }
  if (seg[0] === 'worlds' && seg[1] === 'import' && req.method === 'POST') {
    const body = await readJson(req)
    // one world, a bare array, or the export envelope above: all three are things a person will
    // paste, and refusing two of them would be pedantry
    const list = Array.isArray(body) ? body : Array.isArray(body?.worlds) ? body.worlds : body?.slug ? [body] : null
    if (!list) return json(res, 400, { error: 'expected a world, an array of worlds, or {worlds:[...]}' })
    const replace = q.get('replace') === '1'
    const added = []
    const skipped = []
    for (const w of list) {
      if (!w?.slug || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(w.slug)) { skipped.push({ slug: w?.slug ?? null, why: 'not a usable slug' }); continue }
      // AWAITED. `getWorld` is async, and an unawaited Promise is always truthy — so without this
      // every import was refused as "already here", including on a volume with nothing on it.
      if (!replace && (await store.getWorld(w.slug))) { skipped.push({ slug: w.slug, why: 'already here — pass ?replace=1 to overwrite' }); continue }
      added.push((await store.putWorld({ ...w, source: 'import', imported: new Date().toISOString() })).slug)
    }
    /*
     * The levels come too, and they are validated rather than trusted.
     *
     * A level names a world, an entry point and a list of scenario steps, and an invalid one is
     * how the viewer ends up throwing on load rather than saying what is wrong. `validate` is the
     * same function the editor's own panel runs as you type, so an imported level cannot be in a
     * state the editor would not let you save.
     *
     * IT DOES NOT REQUIRE THE WORLD TO BE BAKED, and POST /api/levels does. That difference is
     * deliberate: creating a level means dressing a world you are looking at, so the bake has to
     * exist; importing a bundle means receiving a place AND what to do there, on a machine that
     * has neither yet. Requiring the bake would make a bundle un-importable exactly where it is
     * most useful — a fresh editor with nothing on it.
     */
    const incoming = Array.isArray(body?.levels) ? body.levels : []
    // NOT `levels`: that is the module imported at the top of this file, and shadowing it here
    // made every import fail with "levels.withDefaults is not a function" — which no unit test
    // would have caught, because the shadow only exists inside this block.
    const addedLevels = []
    // A level must name a world that will EXIST once this import is done — one that came in the
    // bundle, or one already on the volume. Without this a bundle whose world was skipped (or
    // that never carried one) imports a level pointing at nothing: it validates, it saves, it
    // appears in the Stage list, and it can never be opened. Measured, not imagined — an early
    // version accepted `world: "no-such-world"` without a murmur.
    const known = new Set([...added, ...(await store.listWorlds()).map((w) => w.slug)])
    for (const l of incoming) {
      if (!l?.id || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(l.id)) { skipped.push({ level: l?.id ?? null, why: 'not a usable level id' }); continue }
      const full = levels.withDefaults(l)
      const v = levels.validate(full)
      if (!v.ok) { skipped.push({ level: l.id, why: v.errors[0] ?? 'did not validate' }); continue }
      if (!known.has(full.world)) { skipped.push({ level: l.id, why: `names world "${full.world}", which is neither in this bundle nor on this volume` }); continue }
      if (!replace && (await store.getLevel(l.id))) { skipped.push({ level: l.id, why: 'already here — pass ?replace=1 to overwrite' }); continue }
      await store.putLevel(full)
      addedLevels.push(l.id)
    }
    return json(res, 200, { imported: added, levels: addedLevels, skipped })
  }

  /* a baked world, as one file. `?web=1` is the viewer's half only, which is most of the value
     and a fraction of the bytes; the default carries the source rasters a re-bake would need. */
  if (seg[0] === 'sites' && seg[2] === 'archive' && req.method === 'GET') {
    const slug = seg[1]
    const files = await store.siteFiles(slug, { webOnly: q.get('web') === '1' })
    if (!files) return json(res, 404, { error: `no baked site ${slug}` })
    if (!files.length) return json(res, 404, { error: `${slug} is on the volume but has no files` })
    const total = files.reduce((n, f) => n + f.bytes, 0)
    // THE WHOLE ARCHIVE IS BUILT IN MEMORY, so the limit is stated rather than discovered. A
    // 1 GiB site would be 1 GiB of Buffer in a pod with a memory limit, and the failure mode of
    // finding that out during a download is a restarted service.
    const cap = Number(env.WORLDEDITOR_ARCHIVE_MAX_MB ?? 1536) * 2 ** 20
    if (total > cap) {
      return json(res, 413, { error: `${slug} is ${(total / 2 ** 20).toFixed(0)} MiB, over the ${(cap / 2 ** 20).toFixed(0)} MiB archive limit`, hint: 'try ?web=1, or publish to the bucket instead', bytes: total, files: files.length })
    }
    const entries = []
    for (const f of files) entries.push({ name: `${slug}/${f.rel}`, data: await readFile(store.siteFile(slug, f.rel)), mtime: f.mtime })
    const zip = zipWrite(entries)
    res.writeHead(200, { ...CORS, 'content-type': 'application/zip', 'content-length': String(zip.length), 'content-disposition': `attachment; filename="${slug}${q.get('web') === '1' ? '-web' : ''}.zip"` })
    return res.end(zip)
  }
  /* and back in. The archive names its own site, so an upload needs no slug in the URL. */
  if (seg[0] === 'sites' && seg[1] === 'import' && req.method === 'POST') {
    // the default body limit is 8 MiB, which is a rounding error against a baked world
    const body = await readBody(req, Number(env.WORLDEDITOR_ARCHIVE_MAX_MB ?? 1536) * 2 ** 20)
    let entries
    try {
      entries = zipRead(body)
    } catch (e) {
      return json(res, 400, { error: `not a usable archive: ${e.message}` })
    }
    const slugs = [...new Set(entries.map((e) => e.name.split('/')[0]))]
    if (slugs.length !== 1) return json(res, 400, { error: `an archive holds one site; this one has ${slugs.length}`, slugs: slugs.slice(0, 8) })
    const slug = slugs[0]
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) return json(res, 400, { error: `"${slug}" is not a usable slug` })
    if (q.get('replace') !== '1' && (await store.siteFiles(slug))) {
      return json(res, 409, { error: `${slug} is already baked here — pass ?replace=1 to overwrite it` })
    }
    let bytes = 0
    for (const e of entries) {
      const rel = e.name.slice(slug.length + 1)
      if (!rel) continue
      const dest = store.siteFile(slug, rel)
      if (!dest) return json(res, 400, { error: `refusing ${e.name}` }) // zipRead checks too; twice is right for a path
      await mkdir(path.dirname(dest), { recursive: true })
      await writeFile(dest, e.data)
      bytes += e.data.length
    }
    return json(res, 200, { imported: slug, files: entries.length, bytes })
  }

  /*
   * ---- captures: footage in, splat world out ------------------------------------------------
   *
   * Rich, 2026-09-27: "upload one or more video chapters from one or more cameras and then have
   * that be fed to the big job that kicks off."
   *
   * The upload is resumable and streams to disk; see captures.mjs for the protocol and why it is
   * not the archive path. Nothing here holds a chapter in memory, so the body limit that guards
   * every other route deliberately does not apply.
   */
  if (seg[0] === 'captures' && seg.length === 1) {
    if (req.method === 'GET') return json(res, 200, { captures: await captures.list() })
    if (req.method === 'POST') {
      const b = await readJson(req)
      return json(res, 201, { capture: await captures.create({ id: b.id, world: b.world ?? null, note: b.note ?? '', rig: b.rig ?? null }) })
    }
  }
  if (seg[0] === 'captures' && seg.length === 2 && req.method === 'GET') {
    const c = await captures.get(seg[1])
    return c ? json(res, 200, { capture: c, manifest: await captures.manifest(seg[1]) }) : json(res, 404, { error: `no capture ${seg[1]}` })
  }
  if (seg[0] === 'captures' && seg.length === 2 && req.method === 'PATCH') {
    const c = await captures.get(seg[1])
    if (!c) return json(res, 404, { error: `no capture ${seg[1]}` })
    const b = await readJson(req)
    // the world it belongs to, the rig it was shot on, a note: the chapters are not editable here
    return json(res, 200, { capture: await captures.put({ ...c, ...(b.world !== undefined ? { world: b.world } : {}), ...(b.note !== undefined ? { note: b.note } : {}), ...(b.rig !== undefined ? { rig: b.rig } : {}) }) })
  }
  if (seg[0] === 'captures' && seg[2] === 'chapters' && req.method === 'POST') {
    return json(res, 200, await captures.beginChapter(seg[1], await readJson(req)))
  }
  if (seg[0] === 'captures' && seg[2] === 'chapters' && req.method === 'DELETE') {
    return json(res, 200, { removed: await captures.removeChapter(seg[1], q.get('camera'), q.get('name')) })
  }
  if (seg[0] === 'uploads' && seg.length === 2 && req.method === 'GET') {
    const st = await captures.uploadState(seg[1])
    return st ? json(res, 200, st) : json(res, 400, { error: 'not a usable upload id' })
  }
  if (seg[0] === 'uploads' && seg.length === 2 && req.method === 'PUT') {
    // Content-Range: bytes <start>-<end>/<total>, or ?offset= for a client that cannot set headers
    const cr = /bytes\s+(\d+)-/.exec(req.headers['content-range'] ?? '')
    const offset = cr ? Number(cr[1]) : Number(q.get('offset') ?? NaN)
    try {
      return json(res, 200, await captures.append(seg[1], offset, req))
    } catch (e) {
      // the offset travels with the refusal, so a confused client can simply continue
      return json(res, e.status ?? 500, { error: e.message, offset: e.offset })
    }
  }
  if (seg[0] === 'uploads' && seg[2] === 'done' && req.method === 'POST') {
    const b = await readJson(req)
    return json(res, 200, { chapter: await captures.finishChapter(b.capture, seg[1]) })
  }

  /*
   * ---- levels --------------------------------------------------------------------------------
   *
   * A level names a baked world and dresses it: splats over it, assets in it, simulations running
   * in it, and a scenario saying what you are meant to do. See levels.mjs for why the scenario is
   * three declarative primitives and not a scripting language.
   */
  if (seg[0] === 'levels' && seg.length === 1) {
    if (req.method === 'GET') return json(res, 200, { levels: await store.listLevels(), facts: levels.FACTS, actions: levels.ACTIONS, modes: levels.MODES })
    if (req.method === 'POST') {
      const body = levels.withDefaults(await readJson(req))
      const v = levels.validate(body)
      // the world has to be a world: levels.mjs has no filesystem on purpose, so this is here
      const baked = await store.bakedSlugs()
      if (v.ok && !baked.has(body.world)) v.errors.push(`world "${body.world}" is not baked on this volume — have ${[...baked.keys()].slice(0, 6).join(', ') || 'none'}`)
      if (v.errors.length) return json(res, 400, { error: 'this level does not validate', ...v, ok: false })
      if (await store.getLevel(body.id)) return json(res, 409, { error: `level ${body.id} already exists` })
      return json(res, 201, { level: await store.putLevel(body), warnings: v.warnings })
    }
  }
  /* validate without saving: what the in-app agent calls before it writes anything. ABOVE the
     /levels/<id> routes, so "validate" can never be read as the name of a level. */
  if (seg[0] === 'levels' && seg[1] === 'validate' && req.method === 'POST') {
    return json(res, 200, levels.validate(levels.withDefaults(await readJson(req))))
  }
  if (seg[0] === 'levels' && seg.length === 2) {
    const id = seg[1]
    if (req.method === 'GET') {
      const l = await store.getLevel(id)
      return l ? json(res, 200, { level: l, ...levels.validate(l) }) : json(res, 404, { error: `no level ${id}` })
    }
    if (req.method === 'PUT') {
      const prev = await store.getLevel(id)
      if (!prev) return json(res, 404, { error: `no level ${id}` })
      const body = levels.withDefaults({ ...prev, ...(await readJson(req)), id })
      const v = levels.validate(body)
      if (v.errors.length) return json(res, 400, { error: 'this level does not validate', ...v, ok: false })
      return json(res, 200, { level: await store.putLevel(body), warnings: v.warnings })
    }
    if (req.method === 'DELETE') {
      await store.removeLevel(id)
      return json(res, 200, { deleted: id })
    }
  }
  /*
   * ---- the agent: the platform's deployments, and a tunnel to one ------------------------------
   *
   * Rich, 2026-09-28: embed the patapsco-remote client — "the agent picker, session manager, ACP
   * client, and editor controls" — into the editor, against "the current platform client which is
   * a few rest endpoints, a tunnel token minting endpoint, and a websocket connection".
   *
   * THE PAT NEVER REACHES THE BROWSER, and here that is not only good practice: a browser's
   * WebSocket cannot send headers, and the platform's tunnel needs the PAT in `Authorization` AND
   * a single-use OTP in `?t=`. A page can do the second half only. So the token lives here, this
   * service mints the OTP and opens the upstream socket, and `/api/agent/tunnel` relays the bytes.
   */
  if (seg[0] === 'agent') {
    try {
      if (seg.length === 1 && req.method === 'GET') return json(res, 200, await platform.info())
      if (seg[1] === 'credential') {
        if (req.method === 'PUT') return json(res, 200, await platform.set(await readJson(req)))
        if (req.method === 'DELETE') return json(res, 200, await platform.clear())
      }
      /*
       * WHAT THE AGENT TAB NEEDS: the URL, the token to paste, whether it is enforced, and who is
       * attached. It is NOT gated by the token — the page asking is the page that shows you the
       * token, and requiring the secret to learn the secret is a locked door with the key inside.
       * It is same-origin and behind whatever fronts the editor, which is the boundary that counts.
       */
      if (seg[1] === 'mcp' && seg[2] === 'config' && req.method === 'GET') {
        return json(res, 200, { url: mcpUrl(req), auth: mcpAuth.describe(), bridge: mcpBridge.describe() })
      }
      if (seg[1] === 'mcp' && seg[2] === 'config' && req.method === 'POST') {
        const body = await readJson(req)
        try {
          const token = await mcpAuth.set(body?.token)
          return json(res, 200, { url: mcpUrl(req), auth: { ...mcpAuth.describe(), token } })
        } catch (e) {
          return json(res, e.status ?? 500, { error: String(e.message ?? e) })
        }
      }
      /*
       * THE MCP SERVER, and what a session should be told about it.
       *
       * `GET /api/agent/mcp` answers with the `mcpServers` entry to put in `session/new` — the
       * editor's own documents as tools, for an agent whose harness prefers tools to a filesystem
       * or which has no page attached. It is CONFIGURATION rather than a constant because the
       * command that bridges a stdio-only client to an HTTP server depends on what the agent's
       * image has; `WORLDEDITOR_MCP_COMMAND` names it, and with nothing set nothing is injected.
       */
      if (seg[1] === 'mcp' && req.method === 'GET') {
        const command = env.WORLDEDITOR_MCP_COMMAND
        if (!command) return json(res, 200, { servers: [], url: mcpUrl(req), why: 'set WORLDEDITOR_MCP_COMMAND to inject this editor as an MCP server' })
        return json(res, 200, {
          url: mcpUrl(req),
          servers: [{
            name: 'corridor-world-editor',
            command,
            args: (env.WORLDEDITOR_MCP_ARGS ?? mcpUrl(req)).split(' ').filter(Boolean),
          }],
        })
      }
      if (seg[1] === 'mcp' && req.method === 'POST') {
        const verdict = mcpAuth.check(req, new URL(req.url, 'http://localhost'))
        if (!verdict.ok) return json(res, 401, { error: verdict.why })
        const out = await mcp.handle(await readJson(req), { root: store.root, store, levels, apiFetch, bridge: mcpBridge })
        // a JSON-RPC notification has no reply, and 202 with an empty body is what says so
        if (!out) { res.writeHead(202, CORS); res.end(); return }
        return json(res, 200, out)
      }
      if (seg[1] === 'agents' && req.method === 'GET') {
        // `q`, not `url`: this is `api(req, res, seg, q)` and the URL object belongs to the
        // caller. `url` resolved to nothing and the route answered "url is not defined".
        return json(res, 200, { agents: await platform.agents({ workspace: q.get('workspace') ?? undefined }) })
      }
    } catch (e) {
      return json(res, e.status ?? 500, { error: String(e.message ?? e) })
    }
  }

  /*
   * ---- git: the volume as a repository --------------------------------------------------------
   *
   * Rich, 2026-09-28: "being able to hook the games code base and assets up to a git lfs repo
   * would be a nice touch. We'll need a way to manage git credentials to push to a remote repo."
   *
   * THE CREDENTIAL NEVER COMES BACK OUT. `PUT /api/git/credential` writes it into a 0600 file the
   * git credential helper reads, and every response says whether one is set and for which host —
   * never the token. A panel that can display a token is a panel that puts it in a screenshot.
   */
  if (seg[0] === 'git') {
    const repo = new GitRepo(store.root)
    try {
      if (seg.length === 1 && req.method === 'GET') return json(res, 200, await repo.status())
      if (seg[1] === 'scan' && req.method === 'GET') return json(res, 200, await gitScan(store.root))
      if (seg[1] === 'init' && req.method === 'POST') return json(res, 200, await repo.init(await readJson(req)))
      if (seg[1] === 'commit' && req.method === 'POST') {
        const r = await repo.commit((await readJson(req))?.message)
        return json(res, 200, r ? { ...r, committed: true } : { committed: false, why: 'nothing has changed since the last commit' })
      }
      if (seg[1] === 'push' && req.method === 'POST') return json(res, 200, await repo.push(await readJson(req)))
      if (seg[1] === 'pull' && req.method === 'POST') return json(res, 200, await repo.pull())
      if (seg[1] === 'credential') {
        if (req.method === 'PUT') return json(res, 200, await repo.setCredential(await readJson(req)))
        if (req.method === 'DELETE') return json(res, 200, await repo.clearCredential())
      }
    } catch (e) {
      return json(res, e.status ?? 500, { error: String(e.message ?? e) })
    }
  }

  /*
   * ---- programs ------------------------------------------------------------------------------
   *
   * Stage 6: the code half of a level. TypeScript source on the volume, beside the levels that
   * name it.
   *
   * THE SERVICE DOES NOT COMPILE IT, and deliberately does not try. The editor typechecks in the
   * browser against generated declarations (apps/corridor/src/generated/program-types.json) and
   * shows the errors where they are, on the line they are on. A service that refused to save code
   * with a type error would be a service you could not save work in progress to — which is most
   * of the time you are writing any.
   */
  if (seg[0] === 'programs' && seg.length === 1 && req.method === 'GET') {
    // `dirs` as well as `programs`: an empty folder is a thing somebody just made, and a tree
    // derived only from file paths would lose it between one render and the next
    return json(res, 200, await store.listPrograms())
  }
  /*
   * THE ID IS THE REST OF THE PATH, slashes and all: `programs/levels/rooftop/run` is the program
   * `levels/rooftop/run`. A route that matched one segment is what made programs a flat list.
   * The store decides what a usable path is; this only has to stop cutting it short.
   */
  if (seg[0] === 'programs' && seg.length >= 2) {
    const id = seg.slice(1).map(decodeURIComponent).join('/')
    if (req.method === 'GET') {
      const p = await store.getProgram(id)
      return p ? json(res, 200, p) : json(res, 404, { error: `no program ${id}` })
    }
    if (req.method === 'PUT') {
      const body = await readJson(req)
      try {
        // a PUT with a `move` is a rename: the same file (or folder) under another path, in one
        // operation, because read-write-delete from a browser leaves two copies when the tab is
        // closed between the write and the delete
        if (typeof body?.move === 'string') return json(res, 200, await store.moveProgram(id, body.move))
        return json(res, 200, await store.putProgram(id, body?.source))
      } catch (e) {
        return json(res, e.status ?? 500, { error: String(e.message ?? e) })
      }
    }
    // POST makes a FOLDER at this path. The path says which: a folder and a file cannot both be
    // `levels/rooftop`, so there is nothing to disambiguate with a flag.
    if (req.method === 'POST') {
      try {
        return json(res, 200, await store.makeProgramDir(id))
      } catch (e) {
        return json(res, e.status ?? 500, { error: String(e.message ?? e) })
      }
    }
    if (req.method === 'DELETE') {
      // `?dir=1` deletes a folder and everything under it. Asked for explicitly rather than
      // inferred, so a mistyped file path can never turn into a recursive delete.
      if (q.get('dir')) return json(res, 200, await store.removeProgramDir(id))
      await store.removeProgram(id)
      return json(res, 200, { deleted: id })
    }
  }

  /*
   * ---- splat training ------------------------------------------------------------------------
   *
   * Rich, 2026-09-27: the platform's TrainingDeployment as "an optional (but featured) wrapper
   * for jobset". `plan` says which this cluster can run and `manifestFor` builds it; `?as=jobset`
   * forces the plain one, which is how you show the difference rather than describe it.
   */
  if (seg[0] === 'training' && seg[1] === 'plan' && req.method === 'GET') {
    return json(res, 200, await training.plan(k8s, { namespace: env.WORLDEDITOR_NAMESPACE ?? 'default' }))
  }
  /*
   * STARTING ONE, which until now nothing could do: the panel showed a manifest and said "not yet
   * created", because there was no route behind it.
   */
  if (seg[0] === 'training' && seg[1] === 'runs' && req.method === 'POST') {
    const body = await readJson(req)
    const run = await training.createRun(body, k8s, { namespace: k8s.namespace, force: body.via ?? null, dryRun: body.dryRun === true })
    return json(res, body.dryRun ? 200 : 201, { run })
  }
  if (seg[0] === 'training' && seg[1] === 'runs' && seg.length === 2 && req.method === 'GET') {
    return json(res, 200, { runs: await training.listRuns(k8s, { namespace: k8s.namespace }) })
  }
  if (seg[0] === 'training' && seg[1] === 'runs' && seg.length === 3 && req.method === 'GET') {
    return json(res, 200, await training.runStatus(seg[2], k8s, { namespace: k8s.namespace }))
  }
  if (seg[0] === 'training' && seg[1] === 'runs' && seg.length === 3 && req.method === 'DELETE') {
    return json(res, 200, await training.deleteRun(seg[2], k8s, { namespace: k8s.namespace }))
  }
  /* How many GPUs are actually free — asked of the scheduler, never inferred from pod names. */
  if (seg[0] === 'training' && seg[1] === 'gpus' && req.method === 'GET') {
    return json(res, 200, await training.freeGpus(k8s))
  }

  if (seg[0] === 'training' && seg[1] === 'preview' && req.method === 'POST') {
    // what WOULD be created, without creating it: the editor shows this before spending a GPU
    const body = await readJson(req)
    return json(res, 200, await training.manifestFor(body, k8s, { namespace: env.WORLDEDITOR_NAMESPACE ?? 'default', force: q.get('as') }))
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
  if (seg[0] === 'catalog' && seg.length === 2 && req.method === 'DELETE') {
    return json(res, 200, await store.unlistCatalog(decodeURIComponent(seg[1])))
  }
  return undefined
}

/**
 * The agent relay, on the same server.
 *
 * Attached before `listen` because `upgrade` is an event on the server and a browser that connects
 * in the first milliseconds would otherwise be dropped with no handler and no explanation.
 */
attachAgentRelay(server, { platform })
mcpBridge.attach(server, { auth: mcpAuth })

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

/*
 * SHUT DOWN WHEN ASKED, because as PID 1 nothing else will.
 *
 * This is the container's entrypoint, so `node` is process 1 — and the kernel does not apply
 * default signal dispositions to PID 1. A signal with no handler registered is simply IGNORED
 * there, which is the opposite of what it does for every other process. So `kubectl rollout
 * restart` sent SIGTERM, nothing happened, Kubernetes waited out the full 30 s grace period and
 * then SIGKILLed it.
 *
 * MEASURED, not inferred: "Killing" at 23:28:20 and the replacement pod Scheduled at 23:28:50.
 * Exactly thirty seconds, which is a number that can only come from the grace period elapsing.
 * The deployment is `strategy: Recreate` — deliberately, because two processes would both adopt
 * the same live run at start-up and interleave their writes into one log file on the volume — so
 * the old pod has to be gone before the new one starts, and every one of those thirty seconds was
 * a 503 for whoever was using the editor (Rich, 2026-09-27: "getting a 503").
 *
 * The new pod is ready two seconds after it is scheduled, so this takes the outage from about
 * thirty-two seconds to about three.
 *
 * `closeIdleConnections` matters as much as `close` does: keep-alive sockets from a browser that
 * is doing nothing still hold the server open, and `close` alone waits for every one of them to
 * go away by itself. The timer is the backstop for a request that is genuinely mid-flight — a
 * bake log being streamed, say — and it is well inside the grace period rather than at the edge
 * of it.
 */
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return process.exit(0) // a second one means "now"
    stopping = true
    console.log(`${signal}: closing`)
    const hard = setTimeout(() => {
      console.log('  still had connections open; exiting anyway')
      process.exit(0)
    }, 5000)
    hard.unref()
    server.closeIdleConnections()
    server.close(() => {
      console.log('  closed')
      process.exit(0)
    })
  })
}
