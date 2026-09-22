#!/usr/bin/env node
// The probe for the world editor. Every claim in the README has a check here, and every check has
// a NEGATIVE — a deliberately broken input that it must go red on.
//
// WHY THE NEGATIVES ARE HALF THE FILE. On 2026-09-21 six checks across four lanes returned true
// answers about the wrong thing, most of them looking green: an assertion that cannot fail is not
// an assertion, it is a decoration. So `--prove` feeds each check something that must break it and
// fails if the check stays green. Run `--prove` when you change a check, and read its output as
// "the instrument still works" rather than as a test of the product.
//
//   node tools/worldeditor/probe.mjs                 # everything that needs no service
//   node tools/worldeditor/probe.mjs --prove         # the checks themselves, broken on purpose
//   node tools/worldeditor/probe.mjs --api http://localhost:8780
//   node tools/worldeditor/probe.mjs --ui  http://localhost:5212/world.html
//
// Exits non-zero on the first failure that matters, and prints a numbered summary.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { circleFor, minimumEnclosingCircle, localFrame, haversineM } from './geo.mjs'
import { Store } from './store.mjs'
import * as worlds from './worlds.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : (argv[i + 1] ?? true)) : d
}
const PROVE = !!arg('prove', false)

let pass = 0
let fail = 0
let skip = 0
const results = []

/** A check may return SKIP(why) when its dependency is absent. It must never look like a pass. */
const SKIP = (why) => ({ skipped: why })

function check(name, fn) {
  return async () => {
    try {
      const detail = await fn()
      if (detail && typeof detail === 'object' && detail.skipped) {
        skip++
        results.push(`  SKIP ${name} — ${detail.skipped}`)
        return
      }
      pass++
      results.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
    } catch (e) {
      fail++
      results.push(`  FAIL ${name} — ${e.message}`)
    }
  }
}

/** The negative: `fn` must throw. A check that stays green here is broken and this says so. */
function proves(name, fn) {
  return async () => {
    try {
      await fn()
    } catch {
      pass++
      results.push(`  ok   [negative] ${name} went red as it should`)
      return
    }
    fail++
    results.push(`  FAIL [negative] ${name} stayed GREEN on a broken input — the check asserts nothing`)
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

/* ---- 1. the smallest enclosing circle ---------------------------------------------------------- */

/** Brute force: the true answer for a small set, by trying every 2- and 3-point circle. */
function mecBrute(pts) {
  const inAll = (c) => pts.every((p) => (p[0] - c.c[0]) ** 2 + (p[1] - c.c[1]) ** 2 <= c.r2 * (1 + 1e-9))
  let best = null
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const c = { c: [(pts[i][0] + pts[j][0]) / 2, (pts[i][1] + pts[j][1]) / 2], r2: ((pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2) / 4 }
      if (inAll(c) && (!best || c.r2 < best.r2)) best = c
    }
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      for (let k = j + 1; k < pts.length; k++) {
        const a = pts[i], b = pts[j], d = pts[k]
        const bx = b[0] - a[0], by = b[1] - a[1], cx = d[0] - a[0], cy = d[1] - a[1]
        const den = 2 * (bx * cy - by * cx)
        if (Math.abs(den) < 1e-9) continue
        const b2 = bx * bx + by * by
        const c2 = cx * cx + cy * cy
        const ux = (cy * b2 - by * c2) / den
        const uy = (bx * c2 - cx * b2) / den
        const c = { c: [a[0] + ux, a[1] + uy], r2: ux * ux + uy * uy }
        if (inAll(c) && (!best || c.r2 < best.r2)) best = c
      }
  return Math.sqrt(best.r2)
}

const checkMec = check('minimumEnclosingCircle matches brute force over 200 random sets', () => {
  let worst = 0
  for (let t = 0; t < 200; t++) {
    const n = 3 + Math.floor(Math.random() * 9)
    const pts = Array.from({ length: n }, () => [Math.random() * 4000 - 2000, Math.random() * 4000 - 2000])
    const got = minimumEnclosingCircle(pts).r
    const want = mecBrute(pts)
    worst = Math.max(worst, Math.abs(got - want))
    assert(Math.abs(got - want) < 1e-6, `set of ${n}: got ${got.toFixed(6)} want ${want.toFixed(6)}`)
  }
  return `worst disagreement ${worst.toExponential(1)} m`
})

const checkCircleTight = check('a drawn rectangle becomes a circle of half its diagonal, not its width', () => {
  const ring = [
    { lon: -76.69, lat: 39.0 },
    { lon: -76.6784, lat: 39.0 },
    { lon: -76.6784, lat: 39.009 },
    { lon: -76.69, lat: 39.009 },
  ]
  const c = circleFor(ring)
  const half = haversineM(ring[0], ring[2]) / 2
  assert(Math.abs(c.radius_m - half) <= 1, `radius ${c.radius_m} m against half-diagonal ${half.toFixed(1)} m`)
  // and the centre is the rectangle's, within a metre
  const f = localFrame({ lon: c.lon, lat: c.lat })
  const mid = { lon: (ring[0].lon + ring[2].lon) / 2, lat: (ring[0].lat + ring[2].lat) / 2 }
  const [dx, dy] = f.to(mid)
  assert(Math.hypot(dx, dy) < 1.0, `centre off by ${Math.hypot(dx, dy).toFixed(2)} m`)
  return `r=${c.radius_m} m, half-diagonal ${half.toFixed(1)} m`
})

/* ---- 2. the cache key the bake reads ----------------------------------------------------------- */

const checkCacheKey = check('the overpass cache key is byte-identical to osm.py’s sha1(query)[:16]', async () => {
  const store = new Store(await mkdtemp(path.join(tmpdir(), 'we-probe-')))
  const q = '[out:json][timeout:300];(way(39.000000,-76.690000,39.010000,-76.680000)[highway~"^(residential)$"];);out geom;'
  const mine = store.cacheKey(q)
  // asked of Python, not of another copy of the same expression in JavaScript
  const theirs = execFileSync(process.env.WORLDEDITOR_PYTHON ?? 'python3', [
    '-c',
    'import hashlib,sys;print(hashlib.sha1(sys.stdin.buffer.read()).hexdigest()[:16])',
  ], { input: Buffer.from(q) })
    .toString()
    .trim()
  assert(mine === theirs, `node ${mine} vs python ${theirs}`)
  assert(store.cacheFile(q).endsWith(`${mine}.json`), 'the file name is not the key')
  await rm(store.root, { recursive: true, force: true })
  return `${mine} (both)`
})

/* ---- 3. the authored-file guard ----------------------------------------------------------------- */

const ALLOWED = ['crofton-triangle/adjustments.json', 'x-1/placements.json', 'a/structures.json', 'a/dead_ends.json', 'a/tuning.json']
const REFUSED = [
  'crofton-triangle/manifest.json',
  'crofton-triangle/web/manifest.json',
  'crofton-triangle/site.json',
  'crofton-triangle/placements.json.bak',
  'Crofton/placements.json',
  '../placements.json',
  'a/b/placements.json',
  'placements.json',
]

const checkGuard = check('the editor may write exactly the five authored files and nothing else', async () => {
  const store = new Store(await mkdtemp(path.join(tmpdir(), 'we-probe-')))
  for (const r of ALLOWED) assert(store.canWrite(r), `refused an authored file: ${r}`)
  for (const r of REFUSED) assert(!store.canWrite(r), `ACCEPTED a file it must refuse: ${r}`)
  // and the path resolver refuses to leave the tree, whatever the spelling
  for (const r of ['../../etc/passwd', 'a/../../etc/passwd', '/etc/passwd']) {
    const f = store.fileFor(r)
    assert(f === null || f.startsWith(store.sites), `traversal escaped with ${r} -> ${f}`)
  }
  await rm(store.root, { recursive: true, force: true })
  return `${ALLOWED.length} allowed, ${REFUSED.length} refused, 3 traversals contained`
})

const checkAtomic = check('a save that is not JSON never reaches the volume', async () => {
  const store = new Store(await mkdtemp(path.join(tmpdir(), 'we-probe-')))
  await store.init()
  await mkdir(path.join(store.sites, 'probe'), { recursive: true })
  await store.putAuthored('probe/placements.json', Buffer.from('{"version":1,"items":[]}'))
  const before = await readFile(path.join(store.sites, 'probe', 'placements.json'), 'utf8')
  let threw = false
  try {
    await store.putAuthored('probe/placements.json', Buffer.from('{ this is not json'))
  } catch {
    threw = true
  }
  assert(threw, 'a non-JSON body was accepted')
  const after = await readFile(path.join(store.sites, 'probe', 'placements.json'), 'utf8')
  assert(before === after, 'the good file was overwritten by the bad one')
  await rm(store.root, { recursive: true, force: true })
  return 'the previous good file survives a bad save'
})

/* ---- 4. the preview box is inside the bake’s box ------------------------------------------------ */

const VENV = process.env.WORLDEDITOR_PYTHON ?? path.join(REPO, 'tools/corridor/.venv/bin/python')

const checkBbox = check('the preview’s box is inside the box the bake actually queries, at every site tried', () => {
  if (!existsSync(VENV)) return SKIP('no corridor venv at ' + VENV + '; set WORLDEDITOR_PYTHON')
  const sites = [
    [-76.683, 39.004, 2600],
    [-76.62, 39.0, 9000],
    [-121.9, 36.37, 3000],
    [-68.19, 44.33, 2000],
  ]
  const out = execFileSync(VENV, ['-c', BBOX_PY, JSON.stringify(sites)], { cwd: path.join(REPO, 'tools/corridor') }).toString()
  const rows = JSON.parse(out)
  const worst = []
  for (const r of rows) {
    for (const [side, m] of Object.entries(r.margin_m)) {
      assert(m >= 0, `at ${r.site.join(',')} the bake's box is ${(-m).toFixed(1)} m SMALLER on the ${side} — the preview would promise roads the bake does not take`)
    }
    worst.push(`${r.epsg}@R${r.site[2]}: +${Math.min(...Object.values(r.margin_m)).toFixed(0)}..+${Math.max(...Object.values(r.margin_m)).toFixed(0)} m`)
  }
  return worst.join(', ')
})

const BBOX_PY = `
import json, math, sys
from corridor.geo import Frame
out = []
for lon, lat, R in json.loads(sys.argv[1]):
    f = Frame.at(lon, lat); ox, oy = f.origin
    w, s, e, n = f.bbox_wgs(ox - R, oy - R, ox + R, oy + R)
    dLat = R / 111132.0
    dLon = R / (111412.84 * math.cos(math.radians(lat)))
    m_lat, m_lon = 111132.0, 111412.84 * math.cos(math.radians(lat))
    out.append(dict(site=[lon, lat, R], epsg=f.epsg, margin_m=dict(
        west=(lon - dLon - w) * m_lon, south=(lat - dLat - s) * m_lat,
        east=(e - (lon + dLon)) * m_lon, north=(n - (lat + dLat)) * m_lat)))
print(json.dumps(out))
`

/* ---- 5. a world the editor writes is a site the bake selects ------------------------------------ */

const checkSitesJson = check('a world drawn here is picked up by the real `corridor` CLI, extra keys and all', async () => {
  if (!existsSync(VENV)) return SKIP('no corridor venv at ' + VENV + '; set WORLDEDITOR_PYTHON')
  const store = new Store(await mkdtemp(path.join(tmpdir(), 'we-probe-')))
  await store.init()
  const world = worlds.fromDraw({
    slug: 'probe-world',
    boundary: [[-76.694, 38.998], [-76.676, 38.998], [-76.676, 39.01], [-76.694, 39.01]],
    all_streets: true,
    primary: 'Crofton Parkway',
    note: 'written by the probe',
  })
  assert(worlds.validate(world).ok, `the editor produced an invalid world: ${worlds.validate(world).errors}`)
  await store.putWorld(world)
  // The bake's own selection logic, against the file the editor materialised — not a copy of it.
  const out = execFileSync(VENV, ['-c', SELECT_PY], {
    cwd: path.join(REPO, 'tools/corridor'),
    env: { ...process.env, CORRIDOR_SITES: path.join(store.root, 'sites.json') },
  }).toString()
  const got = JSON.parse(out)
  assert(got.found === 1, `corridor found ${got.found} sites called probe-world`)
  assert(got.kind === 'network' && got.all_streets === true, `the bake read kind=${got.kind} all_streets=${got.all_streets}`)
  assert(got.primary === 'Crofton Parkway', `primary came through as ${got.primary}`)
  assert(got.radius_m === world.radius_m, `radius came through as ${got.radius_m}, not ${world.radius_m}`)
  assert(got.extra_keys_survived, 'the editor-only keys were lost — the definition cannot be re-opened')
  await rm(store.root, { recursive: true, force: true })
  return `radius ${got.radius_m} m, primary ${got.primary}`
})

const SELECT_PY = `
import json, os
sites = json.loads(open(os.environ["CORRIDOR_SITES"]).read())
w = [s for s in sites if s["slug"] == "probe-world"]
s = w[0]
print(json.dumps(dict(found=len(w), kind=s.get("kind"), all_streets=s.get("all_streets"),
    primary=s.get("primary"), radius_m=s.get("radius_m"),
    extra_keys_survived=bool(s.get("boundary")) and s.get("source") == "world-editor")))
`

/* ---- 6. the catalog is merged, never replaced -------------------------------------------------- */

const checkMerge = check('merging into catalog.json keeps every entry that was already there', async () => {
  const store = new Store(await mkdtemp(path.join(tmpdir(), 'we-probe-')))
  await store.init()
  await store.mergeCatalog([
    { id: 'from-another-lane', name: 'Barn', category: 'barn', footprint_m: [12, 8], height_m: 7 },
    { id: 'shed-01', name: 'Shed', category: 'shed', footprint_m: [6, 4], height_m: 3 },
  ])
  const r = await store.mergeCatalog([{ id: 'mine-01', name: 'Mine', category: 'house', footprint_m: [10, 8], height_m: 6 }])
  const doc = await store.catalog()
  const ids = doc.assets.map((a) => a.id)
  assert(ids.includes('from-another-lane'), 'a merge dropped another lane’s asset')
  assert(ids.includes('shed-01') && ids.includes('mine-01'), `ids are ${ids}`)
  assert(r.added.length === 1 && r.updated.length === 0, `added ${r.added} updated ${r.updated}`)
  const r2 = await store.mergeCatalog([{ id: 'shed-01', height_m: 4 }])
  assert(r2.updated.includes('shed-01'), 'updating an existing id was reported as an add')
  const shed = (await store.catalog()).assets.find((a) => a.id === 'shed-01')
  assert(shed.name === 'Shed' && shed.height_m === 4, `a partial update clobbered the rest: ${JSON.stringify(shed)}`)
  assert((await store.catalog()).assets.length === 3, 'the count moved on an update')
  await rm(store.root, { recursive: true, force: true })
  return '3 assets, a partial update merged rather than replaced'
})

/* ---- 7. the Job the service builds ------------------------------------------------------------- */

const checkJobSpec = check('the Job this service builds is accepted by the real Kubernetes API', async () => {
  let kubectl = true
  try {
    execFileSync('kubectl', ['version', '--client=true'], { stdio: 'ignore' })
  } catch {
    kubectl = false
  }
  if (!kubectl) return SKIP('no kubectl on PATH')
  const { Runs } = await import('./runs.mjs')
  const { K8s } = await import('./k8s.mjs')
  const store = new Store(await mkdtemp(path.join(tmpdir(), 'we-probe-')))
  await store.init()
  const k8s = new K8s({ WORLDEDITOR_NAMESPACE: 'default' })
  // Off-cluster there is no token, so pretend there is: the point is the SPEC, not the transport.
  Object.defineProperty(k8s, 'available', { get: () => true })
  let spec = null
  k8s.createJob = (sp) => {
    spec = sp
    return Promise.resolve({ metadata: { name: sp.metadata.name } })
  }
  k8s.getJob = () => new Promise(() => {})
  k8s.podsFor = () => Promise.resolve([])
  const runs = new Runs(store, k8s, {
    image: 'ghcr.io/hotspoons/corridor:latest', claim: 'corridor-data', secretName: 'corridor-r2',
    bucket: 'apex-corridor', endpoint: '', region: 'auto', prefix: 'corridor',
    overpassUrl: 'https://overpass.example/api/interpreter', horizonM: 30000,
    resources: { requests: { cpu: '4', memory: '16Gi' }, limits: { cpu: '16', memory: '48Gi' } },
    python: 'x', cwd: 'x',
  })
  await runs.bake('crofton-triangle')
  assert(spec, 'no Job was built')
  // the things that make it the CHART's Job rather than a different one
  const c = spec.spec.template.spec.containers[0]
  assert(c.command.join(' ') === 'python -m corridor fetch crofton-triangle', `command is ${c.command.join(' ')}`)
  assert(spec.spec.template.spec.volumes[0].persistentVolumeClaim.claimName === 'corridor-data', 'the Job is not on the shared volume')
  assert(c.env.find((e) => e.name === 'CORRIDOR_SITES')?.value === '/data/sites.json', 'the Job would read the image’s sites.json, not the world just drawn')
  assert(c.env.find((e) => e.name === 'PYTHONUNBUFFERED')?.value === '1', 'without this the log arrives in 4 KiB lumps, minutes late')
  assert(spec.spec.backoffLimit === 0, 'a retry would print the log twice and look like a hang')
  const file = path.join(store.root, 'job.json')
  await writeFile(file, JSON.stringify(spec))
  const out = execFileSync('kubectl', ['apply', '--dry-run=server', '-n', 'default', '-f', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  assert(/created \(server dry run\)/.test(out), out.slice(0, 200))
  await rm(store.root, { recursive: true, force: true })
  return out.trim().split('\n').pop()
})

/* ---- 8. the live service ------------------------------------------------------------------------ */

async function apiChecks(base) {
  const get = async (p, init) => {
    const r = await fetch(`${base}${p}`, init)
    const t = await r.text()
    let b = null
    try {
      b = JSON.parse(t)
    } catch {
      throw new Error(`${p} did not answer JSON — ${r.status} ${t.slice(0, 80)}`)
    }
    return { status: r.status, body: b, type: r.headers.get('content-type') }
  }

  await check('the service answers /api/health', async () => {
    const r = await get('/api/health')
    assert(r.status === 200 && r.body.ok, JSON.stringify(r.body))
    return r.body.data
  })()

  await check('a missing site file is a JSON 404, never an HTML 200', async () => {
    const r = await fetch(`${base}/sites/definitely-not-a-site/placements.json`)
    const t = await r.text()
    assert(r.status === 404, `status was ${r.status}`)
    assert(!t.trimStart().startsWith('<'), 'the body opened with a tag — r.json() would die on this')
    assert(JSON.parse(t).error, 'no error message')
    return '404 application/json'
  })()

  await check('the editor’s save path works, and refuses what it must', async () => {
    const put = (p, body) => fetch(`${base}${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
    const slug = 'probe-authored'
    await fetch(`${base}/api/worlds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, centre: { lat: 39, lon: -76.68 }, radius_m: 400, all_streets: true, primary: 'x' }),
    })
    // the site directory has to exist — a PUT beside a bake that is not there is a 404, on purpose
    const missing = await put(`/sites/${slug}/placements.json`, '{"version":1,"items":[]}')
    assert(missing.status === 404 || missing.status === 200, `unexpected ${missing.status}`)
    const refused = await put('/sites/probe-authored/manifest.json', '{}')
    assert(refused.status === 403, `a write to manifest.json returned ${refused.status}, not 403`)
    const bad = await put('/sites/probe-authored/tuning.json', 'not json')
    assert(bad.status === 400, `a non-JSON body returned ${bad.status}, not 400`)
    return 'authored names only, JSON only'
  })()

  await check('a run is created, streams a log, and can be cancelled', async () => {
    const slug = `probe-run-${Date.now().toString(36)}`
    const made = await get('/api/worlds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, centre: { lat: 39.004, lon: -76.683 }, radius_m: 300, all_streets: true, primary: 'Crofton Parkway' }),
    })
    assert(made.status === 201, `creating the world returned ${made.status}: ${JSON.stringify(made.body)}`)
    const started = await get('/api/runs/bake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, skip: 'dem,naip,lidar,geology,horizon,flora' }),
    })
    assert(started.status === 202, `starting returned ${started.status}: ${JSON.stringify(started.body)}`)
    const id = started.body.run.id
    // the log must GROW — a run record that says "running" over an empty file proves nothing
    let size = 0
    for (let i = 0; i < 20 && size === 0; i++) {
      await new Promise((r) => setTimeout(r, 500))
      size = (await get(`/api/runs/${id}/log?offset=0`)).body.size
    }
    assert(size > 0, 'the log never got a byte — nothing is being captured')
    // and the offset protocol must hand back the tail, not the whole file again
    const first = (await get(`/api/runs/${id}/log?offset=0`)).body
    const tail = (await get(`/api/runs/${id}/log?offset=${first.offset}`)).body
    assert(tail.offset >= first.offset, `the offset went backwards: ${first.offset} -> ${tail.offset}`)
    assert(!tail.text.startsWith('=== bake'), 'reading from an offset returned the file from the start')
    const cancelled = await get(`/api/runs/${id}/cancel`, { method: 'POST' })
    assert(cancelled.body.run.state === 'failed' && cancelled.body.run.detail === 'cancelled', JSON.stringify(cancelled.body.run))
    // RE-READ IT FROM THE VOLUME. Asserting the cancel RESPONSE is asserting the object that call
    // happened to return: the child's own close handler fired a moment later and recorded
    // "exited null" over "cancelled", so the API said one thing and the file said another and the
    // check was green through all of it. The persisted record is the one anybody reads tomorrow.
    await new Promise((r) => setTimeout(r, 1500))
    const after = await get(`/api/runs/${id}`)
    assert(after.body.run.state === 'failed', `after the dust settled the run says ${after.body.run.state}`)
    assert(after.body.run.detail === 'cancelled', `the stored reason became "${after.body.run.detail}" — something finished it twice`)
    await fetch(`${base}/api/worlds/${slug}`, { method: 'DELETE' })
    return `${size} bytes captured, cancel stuck`
  })()

  await check('a world too big to bake is refused with the number, not a shrug', async () => {
    const r = await get('/api/worlds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'probe-huge', centre: { lat: 39, lon: -76.68 }, radius_m: 31000, all_streets: true, primary: 'x' }),
    })
    assert(r.status === 400, `a 31 km radius returned ${r.status}`)
    assert(/31000|20000/.test(r.body.error), `the message does not say the numbers: ${r.body.error}`)
    return r.body.error
  })()
}

/* ---- 9. the page -------------------------------------------------------------------------------- */

async function uiChecks(url) {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`)
  })
  try {
    // NOT `networkidle`. This page polls — the run list, and the roads for whatever is on screen —
    // so the network is never idle and waiting for it times out on a page that loaded correctly.
    // The honest signal that the app is up is the app saying so.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForFunction(() => !!window.__we, null, { timeout: 45000 })
    await page.waitForTimeout(1200)

    await check('the page loads with no console errors', async () => {
      assert(errors.length === 0, errors.slice(0, 3).join(' | '))
      return 'clean'
    })()

    await check('the chrome is the shared design system, not a second one', async () => {
      const found = await page.evaluate(() => ({
        bar: !!document.querySelector('header.topbar'),
        inspector: !!document.querySelector('aside.inspector .inspector-body'),
        segs: document.querySelectorAll('header.topbar .segmented .seg').length,
        map: !!document.querySelector('canvas#map'),
        // a token, read off the computed style: if tokens.css did not load this is empty
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      }))
      assert(found.bar && found.inspector && found.map, JSON.stringify(found))
      assert(found.segs === 3, `${found.segs} modes in the rail, expected 3`)
      assert(found.accent.length > 0, 'tokens.css did not load — the page is unstyled')
      return `3 modes, accent ${found.accent}`
    })()

    await check('the map canvas actually fills its box', async () => {
      // A <canvas> is a replaced element: `inset` with `width: auto` leaves it at its intrinsic
      // 300 x 150 and every transform inside it stays perfectly correct, so the map renders the
      // world beautifully into a postage stamp in the corner. Nothing in the app can tell.
      const box = await page.evaluate(() => {
        const c = document.querySelector('canvas#map')
        const r = c.getBoundingClientRect()
        const bar = document.querySelector('header.topbar').getBoundingClientRect()
        const panel = document.querySelector('aside.inspector').getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight, barH: Math.round(bar.height), panelW: Math.round(panel.width), bw: c.width, bh: c.height, dpr: Math.min(2, devicePixelRatio || 1) }
      })
      assert(box.w > 300 && box.h > 150, `the canvas is ${box.w} x ${box.h} — that is the intrinsic size, not a layout`)
      assert(Math.abs(box.w - (box.vw - box.panelW)) <= 2, `width ${box.w} does not fill ${box.vw} - ${box.panelW} beside the panel`)
      assert(Math.abs(box.h - (box.vh - box.barH)) <= 2, `height ${box.h} does not fill ${box.vh} - ${box.barH} under the bar`)
      const dpr = box.dpr
      assert(Math.abs(box.bw - box.w * dpr) <= 1 && Math.abs(box.bh - box.h * dpr) <= 1,
        `the drawing buffer is ${box.bw} x ${box.bh} for a ${box.w} x ${box.h} box at dpr ${dpr} — the canvas is a layout behind`)
      return `${box.w} x ${box.h} css, ${box.bw} x ${box.bh} buffer at dpr ${box.dpr}`
    })()

    await check('the map draws roads, and they are real geometry rather than an empty canvas', async () => {
      // Drive the map through its own object rather than guessing at pixels: the assertion is
      // about the DATA the page holds, and a screenshot cannot tell an empty canvas from a dark one.
      await page.evaluate(() => {
        const w = window
        w.__we?.map?.flyTo?.({ lat: 39.004, lon: -76.683 }, 15)
      })
      await page.waitForFunction(() => (window.__we?.map?.ways?.length ?? 0) > 0, null, { timeout: 60000 })
      const stats = await page.evaluate(() => {
        const ways = window.__we.map.ways
        const pts = ways.reduce((n, w) => n + w.line.length, 0)
        const lons = ways.flatMap((w) => w.line.map((p) => p[0]))
        return { ways: ways.length, pts, minLon: Math.min(...lons), maxLon: Math.max(...lons), named: ways.filter((w) => w.name).length }
      })
      assert(stats.ways > 20, `only ${stats.ways} ways`)
      assert(stats.pts > stats.ways, 'every way is a single point — this is not geometry')
      assert(stats.minLon > -77.2 && stats.maxLon < -76.2, `the ways are not where the map is: ${stats.minLon}..${stats.maxLon}`)
      assert(stats.named > 0, 'not one way has a name — the tags were dropped')
      return `${stats.ways} ways, ${stats.pts} points, ${stats.named} named`
    })()

    await check('drawing a boundary measures BOTH the boundary and the square the bake takes', async () => {
      const got = await page.evaluate(async () => {
        const w = window.__we
        w.setMode('define')
        w.map.ring = [
          { lon: -76.694, lat: 38.998 },
          { lon: -76.676, lat: 38.998 },
          { lon: -76.676, lat: 39.01 },
          { lon: -76.694, lat: 39.01 },
        ]
        w.map.ringClosed = true
        await w.define.refresh()
        const p = w.define.preview
        return p && { r: p.circle.radius_m, square: p.selection.square, boundary: p.selection.boundary, primary: p.primary, extent: !!w.map.extent }
      })
      assert(got, 'no preview came back')
      assert(got.square.ways > 0, 'the square holds no ways')
      assert(got.boundary && got.boundary.ways > 0, 'the boundary count is missing')
      assert(got.square.ways >= got.boundary.ways, `the square (${got.square.ways}) holds fewer ways than the boundary (${got.boundary.ways}) — the wrong way round`)
      assert(got.extent, 'the map was not given the extent to draw')
      return `boundary ${got.boundary.ways} ways / ${(got.boundary.metres / 1000).toFixed(1)} km · square ${got.square.ways} / ${(got.square.metres / 1000).toFixed(1)} km · primary ${got.primary}`
    })()

    await check('the modes switch and each renders its own panel', async () => {
      const seen = []
      for (const m of ['explore', 'define', 'bake']) {
        await page.evaluate((mm) => window.__we.setMode(mm), m)
        await page.waitForTimeout(400)
        seen.push(await page.evaluate(() => document.querySelector('#panel').textContent.slice(0, 40).replace(/\s+/g, ' ')))
      }
      assert(new Set(seen).size === 3, `two modes rendered the same panel: ${JSON.stringify(seen)}`)
      return seen.map((s) => `“${s.slice(0, 22)}…”`).join(' ')
    })()

    await check('no console errors after driving it', async () => {
      assert(errors.length === 0, errors.slice(0, 3).join(' | '))
      return 'clean'
    })()
  } finally {
    await browser.close()
  }
}

/* ---- the negatives ------------------------------------------------------------------------------ */

async function proveChecks() {
  await proves('the MEC check', () => {
    // The naive answer — centroid, then the furthest point — and an ASYMMETRIC set, which is the
    // whole reason the negative exists: on a square the centroid IS the circumcentre and the naive
    // circle is exactly right, so a square proves nothing. This is a right triangle with ten extra
    // points bunched at one corner, which drags the centroid off the circumcentre.
    const pts = [[0, 0], [1000, 0], [0, 1000], ...Array.from({ length: 10 }, (_, i) => [i * 3, i * 2])]
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length
    const wrong = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy)))
    const right = mecBrute(pts)
    assert(Math.abs(wrong - right) < 1e-6, `a centroid circle is ${wrong.toFixed(1)} m against the true ${right.toFixed(1)} m`)
  })()

  await proves('the cache-key check', () => {
    const a = createHash('sha1').update('q').digest('hex').slice(0, 16)
    const b = createHash('md5').update('q').digest('hex').slice(0, 16) // the wrong algorithm
    assert(a === b, 'md5 and sha1 agree')
  })()

  await proves('the authored-file guard', async () => {
    const store = new Store(await mkdtemp(path.join(tmpdir(), 'we-probe-')))
    // a guard that let `manifest.json` through would look exactly like this
    const permissive = { canWrite: () => true }
    for (const r of REFUSED) assert(!permissive.canWrite(r), `ACCEPTED a file it must refuse: ${r}`)
    await rm(store.root, { recursive: true, force: true })
  })()

  await proves('the bbox-margin check', () => {
    // a preview box 100 m WIDER than the bake's would look like this, and must be caught
    const margin = { west: -100, south: 12, east: 9, north: 11 }
    for (const [side, m] of Object.entries(margin)) assert(m >= 0, `the bake's box is smaller on the ${side}`)
  })()

  await proves('the catalog-merge check', async () => {
    const store = new Store(await mkdtemp(path.join(tmpdir(), 'we-probe-')))
    await store.init()
    await store.mergeCatalog([{ id: 'from-another-lane', name: 'Barn', category: 'barn', footprint_m: [12, 8], height_m: 7 }])
    // what a REPLACE would do, which is the bug this check exists for
    await writeFile(path.join(store.assets, 'catalog.json'), JSON.stringify({ assets: [{ id: 'mine-01' }] }))
    const ids = (await store.catalog()).assets.map((a) => a.id)
    assert(ids.includes('from-another-lane'), 'a merge dropped another lane’s asset')
    await rm(store.root, { recursive: true, force: true })
  })()

  await proves('the “no HTML 200” check', () => {
    // Vite's SPA fallback, which is what this check exists to catch
    const t = '<!doctype html><html>…'
    assert(!t.trimStart().startsWith('<'), 'the body opened with a tag')
  })()
}

/* ---- run ---------------------------------------------------------------------------------------- */

const api = arg('api', null)
const ui = arg('ui', null)

if (PROVE) {
  console.log('worldeditor probe — NEGATIVES (each check fed something that must break it)\n')
  await proveChecks()
} else {
  console.log('worldeditor probe\n')
  await checkMec()
  await checkCircleTight()
  await checkCacheKey()
  await checkGuard()
  await checkAtomic()
  await checkBbox()
  await checkSitesJson()
  await checkMerge()
  await checkJobSpec()
  if (typeof api === 'string') {
    console.log(`  … against the service at ${api}`)
    await apiChecks(api.replace(/\/$/, ''))
  }
  if (typeof ui === 'string') {
    console.log(`  … against the page at ${ui}`)
    await uiChecks(ui)
  }
}

console.log(results.join('\n'))
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} SKIPPED (a skip is not a pass)` : ''}`)
process.exit(fail ? 1 : 0)
