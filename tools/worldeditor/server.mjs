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
import { createGzip, gzip } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Store } from './store.mjs'
import { Overpass, PUBLIC_MIRRORS } from './overpass.mjs'
import { Tiles } from './tiles.mjs'
import { Basemap } from './basemap.mjs'
import { Geocoder } from './geocode.mjs'
import { LAYERS, layersAt, tilesFor } from './layers.mjs'
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

const store = new Store(DATA)
store.catalogSeed = path.join(REPO, 'apps/corridor/public/assets/catalog.json')
await store.init()
await store.seedWorlds(env.WORLDEDITOR_SEED_SITES ?? path.join(REPO, 'tools/corridor/sites.json'))

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
      const want = tilesFor(layer.tile, bbox)
      // A cap on tiles, not on span. The world at zoom 2 is 512 `places` cells and nobody needs
      // 512 requests; the biggest ones are in the middle of the screen, so take those.
      const cx = (bbox.west + bbox.east) / 2
      const cy = (bbox.south + bbox.north) / 2
      want.sort((a, b) => dist2(a, layer.tile, cx, cy) - dist2(b, layer.tile, cx, cy))
      // Capped per layer by what a tile COSTS, not by a single number: a places tile is one cheap
      // node query, a major tile is 5 MB and fifteen seconds. Sorted by distance from the middle of
      // the screen first, so the cap keeps what you are looking at.
      plan.push({ layer: layer.id, kind: layer.kind, tiles: want.slice(0, CAPS[layer.id] ?? 12), total: want.length })
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
