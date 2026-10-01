// A deploy takes what a world uses and nothing else, keys it the way the viewer asks for it,
// and can be pruned whole afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './store.mjs'
import { plan, run, defaultPrefix, workerName, stringsOf, literalsOf, LEDGER_KEY } from './deploy.mjs'
import { keyFor } from './deploy/worker.mjs'

const transpile = (src, name) => (src.includes('BROKEN') ? { js: '', errors: [{ message: 'broken on purpose' }] } : { js: `// ${name}\n${src.replace(': number', '')}`, errors: [] })

/** a volume with two baked worlds, a level on one, and a program */
async function volume() {
  const root = await mkdtemp(path.join(tmpdir(), 'deploy-'))
  const store = new Store(root)
  await store.init()
  for (const slug of ['alpha', 'beta']) {
    const dir = path.join(store.sites, slug)
    await mkdir(path.join(dir, 'web', 'tiles', '0'), { recursive: true })
    await mkdir(path.join(dir, 'lidar'), { recursive: true })
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ slug, ident: { name: slug }, length_m: 100, layers: ['dem'] }))
    await writeFile(path.join(dir, 'web', 'tiles', '0', '0_0.pack'), Buffer.alloc(64, 1))
    await writeFile(path.join(dir, 'web', 'manifest.json'), '{}')
    await writeFile(path.join(dir, 'dem_1m.tif'), Buffer.alloc(1000, 2)) // a source, never served
    await writeFile(path.join(dir, 'lidar', 'x.laz'), Buffer.alloc(10))
    await writeFile(path.join(dir, 'osm.geojson'), '{"type":"FeatureCollection","features":[]}')
    await writeFile(path.join(dir, 'fixtures.json'), JSON.stringify({ version: 1, choices: slug === 'alpha' ? { 'race-gate:0': 'gate-arch' } : {} }))
    await writeFile(path.join(dir, 'web', 'tiles', '0', 'half.part'), Buffer.alloc(5)) // an unfinished write
  }
  await writeFile(path.join(store.sites, 'index.json'), JSON.stringify({ sites: [{ slug: 'alpha', ident: { name: 'Alpha' }, length_m: 100, structures: 0, formations: [], layers: ['dem'], photos: [] }, { slug: 'beta', ident: null, length_m: 100, structures: 0, formations: [], layers: [], photos: [] }, { slug: 'gamma', ident: null, length_m: 1, structures: 0, formations: [], layers: [], photos: [] }] }))
  await writeFile(path.join(store.levels, 'alpha-jam.json'), JSON.stringify({ id: 'alpha-jam', world: 'alpha', player: { vehicle: 'hero-1' }, simulations: [{ kind: 'traffic', set: 'jam' }], program: 'alpha/jam.ts' }))
  await writeFile(path.join(store.levels, 'gamma-run.json'), JSON.stringify({ id: 'gamma-run', world: 'gamma', player: { vehicle: 'unused-build' } }))
  await mkdir(path.join(store.programs, 'alpha'), { recursive: true })
  await writeFile(path.join(store.programs, 'alpha', 'jam.ts'), 'export const n: number = 1\n')
  await mkdir(store.assets, { recursive: true })
  await writeFile(path.join(store.assets, 'catalog.json'), JSON.stringify({ assets: [{ id: 'gate-arch', kind: 'race-gate' }, { id: 'never-placed', kind: 'prop' }] }))
  return { root, store }
}

/** an asset service with four models, two builds and a traffic set */
function assetService() {
  const items = [
    { id: 'saloon', kind: 'car', finished: 1, mesh: 1, glass: 1 },
    { id: 'pickup', kind: 'car', finished: null, mesh: 1 },
    { id: 'gate-arch', kind: 'race-gate', finished: 1 },
    { id: 'lonely', kind: 'prop', finished: 1 },
  ]
  const builds = {
    vehicles: [{ id: 'hero-1', asset: 'saloon', doc: { spec: {} } }, { id: 'traffic-pickup', asset: 'pickup', doc: {} }, { id: 'unused-build', asset: 'lonely', doc: {} }],
    traffic: [{ id: 'jam', doc: { mix: [{ vehicle: 'traffic-pickup', weight: 1 }] } }, { id: 'other', doc: { mix: [{ vehicle: 'unused-build', weight: 1 }] } }],
    actors: [],
    weapons: [],
    presets: [],
  }
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    const send = (body, type = 'application/json') => { res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(body) }); res.end(req.method === 'HEAD' ? undefined : body) }
    const m = req.url.match(/^\/catalog\/([^/]+)\/file\/(.+)$/)
    if (m) return send(Buffer.from(`glb:${m[1]}:${m[2]}`), 'model/gltf-binary')
    if (req.url === '/catalog') return send(JSON.stringify({ items }))
    if (req.url === '/materials') return send(JSON.stringify({ materials: [] }))
    const kind = req.url.slice(1)
    if (builds[kind]) return send(JSON.stringify({ [kind]: builds[kind] }))
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"no"}')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close(), hits })))
}

/** Cloudflare, as a bucket in memory and a record of what was asked of it */
function fakeCloudflare() {
  const objects = new Map()
  const calls = []
  return {
    objects,
    calls,
    async buckets() { calls.push('buckets'); return [{ name: 'existing' }] },
    async createBucket(_a, name) { calls.push(`createBucket ${name}`) },
    async putObject(_a, _b, key, body, type) { objects.set(key, { body: Buffer.from(body), type }); return body.byteLength },
    async getObject(_a, _b, key) { return objects.get(key)?.body ?? null },
    async getJson(_a, _b, key) { const o = objects.get(key); return o ? JSON.parse(o.body.toString()) : null },
    async deleteObject(_a, _b, key) { calls.push(`delete ${key}`); return objects.delete(key) },
    async listObjects(_a, _b, prefix) { return [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: 1 })) },
    async deployWorker(_a, name, o) { calls.push(`deployWorker ${name}`); this.worker = { name, ...o } },
    async enableSubdomain(_a, name) { calls.push(`subdomain ${name}`) },
    async workersSubdomain() { return 'rich' },
    async attachDomain(_a, o) { calls.push(`domain ${o.hostname}`) },
  }
}

test('the plan takes one world, its level, its program and only the assets they use', async () => {
  const { store } = await volume()
  const svc = await assetService()
  try {
    const p = await plan({ store, worlds: ['alpha'], assetsvc: svc.url, transpile })
    assert.deepEqual(p.problems, [])
    assert.deepEqual(p.worlds, ['alpha'])
    assert.deepEqual(p.levels, ['alpha-jam'])
    const keys = p.objects.map((o) => o.key)
    // the bake and the docs, not the sources
    assert.ok(keys.includes('sites/alpha/web/tiles/0/0_0.pack'))
    assert.ok(keys.includes('sites/alpha/manifest.json'))
    assert.ok(keys.includes('sites/alpha/osm.geojson'))
    assert.ok(!keys.some((k) => k.endsWith('.tif') || k.includes('/lidar/') || k.endsWith('.part')), `no sources: ${keys.join(' ')}`)
    assert.ok(!keys.some((k) => k.startsWith('sites/beta/')), 'beta was not asked for')
    // the index lists the chosen world only
    const index = JSON.parse(p.objects.find((o) => o.key === 'sites/index.json').body)
    assert.deepEqual(index.sites.map((s) => s.slug), ['alpha'])
    // the level, its program built, and the list the stage picker reads
    assert.ok(keys.includes('levels/alpha-jam.json'))
    const prog = JSON.parse(p.objects.find((o) => o.key === 'api/programs/alpha/jam.ts').body)
    assert.match(prog.js, /export const n = 1/)
    assert.deepEqual(JSON.parse(p.objects.find((o) => o.key === 'api/levels').body).levels.map((l) => l.id), ['alpha-jam'])
    // THE CLOSURE: hero build → saloon; traffic set jam → pickup build → pickup; the fixture → gate-arch. Not lonely.
    assert.deepEqual([...p.assets.items].sort(), ['gate-arch', 'pickup', 'saloon'])
    assert.deepEqual(p.assets.builds.vehicles.sort(), ['hero-1', 'traffic-pickup'])
    assert.deepEqual(p.assets.builds.traffic, ['jam'])
    // finished where there is one, raw only where there is not, glass when it exists
    assert.ok(keys.includes('assetsvc/catalog/saloon/file/mesh.finished.glb'))
    assert.ok(keys.includes('assetsvc/catalog/saloon/file/mesh.glass.glb'))
    assert.ok(!keys.includes('assetsvc/catalog/saloon/file/mesh.glb'), 'the 26 MB raw mesh stays home when a finished one exists')
    assert.ok(keys.includes('assetsvc/catalog/pickup/file/mesh.glb'))
    assert.ok(!keys.some((k) => k.includes('/lonely')), 'lonely is not used')
    // the build lists are filtered to what is used
    assert.deepEqual(JSON.parse(p.objects.find((o) => o.key === 'assetsvc/vehicles').body).vehicles.map((b) => b.id).sort(), ['hero-1', 'traffic-pickup'])
    // the placement catalog too
    assert.deepEqual(JSON.parse(p.objects.find((o) => o.key === 'assets/catalog.json').body).assets.map((a) => a.id), ['gate-arch'])
    // the library list the viewer merges at runtime — the same items, under the path assetsvc.list() asks for
    assert.deepEqual(JSON.parse(p.objects.find((o) => o.key === 'assetsvc/catalog').body).items.map((a) => a.id).sort(), ['gate-arch', 'pickup', 'saloon'])
    // sizes came from HEAD
    assert.equal(p.objects.find((o) => o.key === 'assetsvc/catalog/pickup/file/mesh.glb').bytes, Buffer.byteLength('glb:pickup:mesh.glb'))
    assert.ok(p.bytes > 0)
    assert.equal(p.byGroup.bake.objects, 2)
  } finally {
    svc.close()
  }
})

test('several worlds share one index, and an unbaked one is a problem rather than a silence', async () => {
  const { store } = await volume()
  const svc = await assetService()
  try {
    const p = await plan({ store, worlds: ['alpha', 'beta', 'gamma'], assetsvc: svc.url, transpile })
    assert.deepEqual(p.worlds, ['alpha', 'beta'])
    assert.equal(p.problems.length, 1)
    assert.match(p.problems[0], /gamma is not baked/)
    const index = JSON.parse(p.objects.find((o) => o.key === 'sites/index.json').body)
    assert.deepEqual(index.sites.map((s) => s.slug), ['alpha', 'beta'])
    assert.ok(p.objects.some((o) => o.key === 'sites/beta/web/tiles/0/0_0.pack'))
  } finally {
    svc.close()
  }
})

test('a program that spawns a prop by name takes that prop, and nothing it merely mentions', async () => {
  const { store } = await volume()
  const svc = await assetService()
  await writeFile(path.join(store.programs, 'alpha', 'jam.ts'), [
    "api.models.spawn('lonely', { x: 1, y: 2 })",
    "api.say('not-an-asset', 'ok')",
    "const note = `hello ${name}`",
    '',
  ].join('\n'))
  try {
    const p = await plan({ store, worlds: ['alpha'], assetsvc: svc.url, transpile })
    assert.deepEqual(p.problems, [])
    assert.ok(p.assets.items.includes('lonely'), `program spawn was not closed over: ${[...p.assets.items]}`)
    assert.ok(p.objects.some((o) => o.key === 'assetsvc/catalog/lonely/file/mesh.finished.glb'))
    assert.ok(!p.assets.items.includes('not-an-asset'))
    const listed = JSON.parse(p.objects.find((o) => o.key === 'assetsvc/catalog').body).items.map((a) => a.id)
    assert.ok(listed.includes('lonely'))
  } finally {
    svc.close()
  }
})

test('literalsOf keeps ids and drops sentences and interpolations', () => {
  const s = new Set()
  literalsOf("spawn('pizza-stack') say(\"cartoon-cash\") `wad ${n}` 'a whole sentence here'", s)
  assert.deepEqual([...s].sort(), ['cartoon-cash', 'pizza-stack'])
})

test('a program that does not build is a problem, and a missing asset service a warning', async () => {
  const { store } = await volume()
  await writeFile(path.join(store.programs, 'alpha', 'jam.ts'), 'BROKEN\n')
  const p = await plan({ store, worlds: ['alpha'], assetsvc: '', transpile })
  assert.ok(p.problems.some((x) => /does not build/.test(x)))
  assert.ok(p.warnings.some((x) => /no asset service/.test(x)))
})

test('the run writes every object under the prefix, keeps a ledger, publishes the worker, and prunes the older deploy of the same world', async () => {
  const { store, root } = await volume()
  const svc = await assetService()
  const appDir = path.join(root, 'dist')
  await mkdir(path.join(appDir, 'assets'), { recursive: true })
  await writeFile(path.join(appDir, 'index.html'), '<!doctype html><title>corridor</title>')
  await writeFile(path.join(appDir, 'assets', 'main.js'), 'console.log(1)')
  const cf = fakeCloudflare()
  const lines = []
  const log = (l) => lines.push(l)
  try {
    const p1 = await plan({ store, worlds: ['alpha'], assetsvc: svc.url, transpile, appDir })
    const r1 = await run({ cf, accountId: 'acc', bucket: 'new-bucket', prefix: 'corridor/alpha-1', plan: p1, worker: { name: 'corridor-alpha', hostname: 'play.example.com', zoneId: 'z1' }, appDir, log })
    assert.ok(cf.calls.includes('createBucket new-bucket'), 'the bucket did not exist, so it was made')
    assert.ok(cf.objects.has('corridor/alpha-1/sites/alpha/web/tiles/0/0_0.pack'))
    assert.equal(cf.objects.get('corridor/alpha-1/assetsvc/catalog/saloon/file/mesh.finished.glb').body.toString(), 'glb:saloon:mesh.finished.glb')
    assert.equal(cf.objects.get('corridor/alpha-1/assetsvc/catalog/saloon/file/mesh.finished.glb').type, 'model/gltf-binary')
    const manifest = JSON.parse(cf.objects.get('corridor/alpha-1/deploy.json').body)
    assert.equal(manifest.keys.length, p1.objects.length)
    const ledger = JSON.parse(cf.objects.get(LEDGER_KEY).body)
    assert.equal(ledger.deployments.length, 1)
    // the worker: the app as assets, the bucket and the prefix as bindings, both addresses
    assert.equal(cf.worker.name, 'corridor-alpha')
    assert.deepEqual(cf.worker.assets.map((a) => a.path).sort(), ['/assets/main.js', '/index.html'])
    assert.deepEqual(cf.worker.bindings, [{ type: 'r2_bucket', name: 'DATA', bucket_name: 'new-bucket' }, { type: 'plain_text', name: 'PREFIX', text: 'corridor/alpha-1' }])
    assert.match(cf.worker.script, /env\.DATA\.get/)
    assert.deepEqual(r1.urls, ['https://corridor-alpha.rich.workers.dev', 'https://play.example.com'])
    assert.ok(cf.calls.includes('domain play.example.com'))

    // a second deploy of the same world, with prune: the first one's objects go, the ledger says so
    const p2 = await plan({ store, worlds: ['alpha'], assetsvc: svc.url, transpile, appDir })
    const r2 = await run({ cf, accountId: 'acc', bucket: 'new-bucket', prefix: 'corridor/alpha-2', plan: p2, worker: { name: 'corridor-alpha' }, appDir, prune: true, log })
    assert.equal(r2.pruned.deployments, 1)
    assert.ok(!cf.objects.has('corridor/alpha-1/sites/alpha/web/tiles/0/0_0.pack'), 'the old tile is gone')
    assert.ok(!cf.objects.has('corridor/alpha-1/deploy.json'))
    assert.ok(cf.objects.has('corridor/alpha-2/sites/alpha/web/tiles/0/0_0.pack'), 'the new one is not')
    const ledger2 = JSON.parse(cf.objects.get(LEDGER_KEY).body)
    assert.deepEqual(ledger2.deployments.map((d) => d.prefix), ['corridor/alpha-2'])
    assert.ok(lines.some((l) => /pruning corridor\/alpha-1/.test(l)))

    // a dry run writes nothing
    const before = cf.objects.size
    const r3 = await run({ cf, accountId: 'acc', bucket: 'new-bucket', prefix: 'corridor/alpha-3', plan: p2, worker: { name: 'corridor-alpha' }, appDir, dryRun: true, log })
    assert.equal(r3.dryRun, true)
    assert.equal(cf.objects.size, before)
  } finally {
    svc.close()
  }
})

test('a run refuses a plan with problems, and a missing app', async () => {
  const { store, root } = await volume()
  const p = await plan({ store, worlds: ['gamma'], assetsvc: '', transpile, appDir: path.join(root, 'nowhere') })
  assert.ok(p.problems.some((x) => /no built app/.test(x)))
  await assert.rejects(run({ cf: fakeCloudflare(), accountId: 'a', bucket: 'b', prefix: 'x', plan: p, worker: { name: 'w' }, appDir: root, log() {} }), /problems/)
})

test('names, prefixes, strings and the worker key map', () => {
  assert.match(defaultPrefix(['crofton-triangle'], new Date('2026-09-30T21:05:07.123Z')), /^corridor\/crofton-triangle-20260930-210507Z$/)
  assert.match(defaultPrefix(['a', 'b', 'c'], new Date('2026-09-30T21:05:07Z')), /^corridor\/a\+2-/)
  assert.equal(workerName('Corridor: Route 3!'), 'corridor-route-3')
  assert.deepEqual([...stringsOf({ a: ['x', { b: 'y' }], c: 1 })].sort(), ['a', 'b', 'c', 'x', 'y'])
  // the worker maps the viewer's paths to keys exactly as the plan wrote them
  assert.equal(keyFor('/sites/alpha/web/tiles/0/0_0.pack'), 'sites/alpha/web/tiles/0/0_0.pack')
  assert.equal(keyFor('/game.json'), 'game.json')
  assert.equal(keyFor('/api/levels'), 'api/levels')
  assert.equal(keyFor('/api/levels/alpha-jam'), 'levels/alpha-jam.json')
  assert.equal(keyFor('/api/programs/alpha/jam.ts'), 'api/programs/alpha/jam.ts')
  assert.equal(keyFor('/assetsvc/catalog/saloon/file/mesh.finished.glb'), 'assetsvc/catalog/saloon/file/mesh.finished.glb')
  assert.equal(keyFor('/assets/catalog.json'), 'assets/catalog.json')
  assert.equal(keyFor('/assets/main-abc.js'), null)
  assert.equal(keyFor('/'), null)
})
