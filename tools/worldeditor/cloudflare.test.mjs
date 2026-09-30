// The Cloudflare client, against a stand-in that records exactly what it was sent.
//
// This proves the CLIENT: paths, methods, headers, the multipart shapes, the manifest hashes, and
// that a `success: false` is an exception. It does not prove Cloudflare's side of the contract;
// the first real deploy does that, and its log is written to be read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { Cloudflare, CloudflareError, TokenStore, assetHash } from './cloudflare.mjs'

/** a Cloudflare that answers like Cloudflare and keeps every request */
function fake() {
  const reqs = []
  const store = new Map()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const r = { method: req.method, url: req.url, headers: req.headers, body }
    reqs.push(r)
    const ok = (result, extra = {}) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, errors: [], messages: [], result, ...extra })) }
    const u = new URL(req.url, 'http://x')
    const p = u.pathname
    if (p === '/user/tokens/verify') return ok({ id: 't', status: 'active' })
    if (p === '/accounts') return ok([{ id: 'acc1', name: 'Rich' }])
    if (p === '/zones') return ok([{ id: 'z1', name: 'siomporas.com', status: 'active' }])
    if (p === '/accounts/acc1/workers/subdomain') return ok({ subdomain: 'rich' })
    if (p === '/accounts/acc1/r2/buckets' && req.method === 'GET') return ok({ buckets: [{ name: 'games', creation_date: '2026-01-01' }] })
    if (p === '/accounts/acc1/r2/buckets' && req.method === 'POST') return ok({ name: JSON.parse(body).name })
    const obj = p.match(/^\/accounts\/acc1\/r2\/buckets\/([^/]+)\/objects\/(.+)$/)
    if (obj) {
      const key = obj[2].split('/').map(decodeURIComponent).join('/')
      if (req.method === 'PUT') { store.set(key, { body, type: req.headers['content-type'] }); return ok({ key }) }
      if (req.method === 'GET') { const o = store.get(key); if (!o) { res.writeHead(404); return res.end('{"success":false,"errors":[{"code":10007,"message":"no such object"}]}') } res.writeHead(200, { 'content-type': o.type }); return res.end(o.body) }
      if (req.method === 'DELETE') { const had = store.delete(key); res.writeHead(had ? 200 : 404); return res.end('{}') }
    }
    if (p === '/accounts/acc1/r2/buckets/games/objects' && req.method === 'GET') return ok([...store.keys()].filter((k) => k.startsWith(u.searchParams.get('prefix') ?? '')).map((k) => ({ key: k, size: store.get(k).body.length })), { result_info: { cursor: '' } })
    if (p === '/accounts/acc1/workers/scripts/w1/assets-upload-session') {
      const manifest = JSON.parse(body).manifest
      const hashes = Object.values(manifest).map((m) => m.hash)
      // pretend the first one is already there
      return ok({ jwt: 'session-jwt', buckets: hashes.length > 1 ? [hashes.slice(1)] : [] })
    }
    if (p === '/accounts/acc1/workers/assets/upload') return ok({ jwt: 'completion-jwt' })
    if (p === '/accounts/acc1/workers/scripts/w1' && req.method === 'PUT') return ok({ id: 'w1' })
    if (p === '/accounts/acc1/workers/scripts/w1/subdomain') return ok({ enabled: true })
    if (p === '/accounts/acc1/workers/domains') return ok({ hostname: JSON.parse(body).hostname })
    if (p === '/boom') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null })) }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: false, errors: [{ code: 7003, message: `no route ${p}` }] }))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, reqs, store, close: () => server.close() })))
}

test('the token store holds a token in memory and describes it without showing it', () => {
  const none = new TokenStore({})
  assert.deepEqual(none.describe(), { present: false, source: null })
  assert.throws(() => none.use(), /no Cloudflare token/)
  const env = new TokenStore({ CLOUDFLARE_API_TOKEN: 'from-env' })
  assert.deepEqual(env.describe(), { present: true, source: 'env' })
  assert.equal(env.use(), 'from-env')
  assert.deepEqual(env.set('typed'), { present: true, source: 'entered' })
  assert.equal(env.use(), 'typed')
  assert.throws(() => env.set('   '), /empty/)
  assert.equal(JSON.stringify(env).includes('typed'), false, 'a dump of the store shows no token')
  assert.deepEqual(env.clear(), { present: false, source: null })
})

test('queries: accounts, zones, subdomain, buckets — with the bearer header and without the token anywhere else', async () => {
  const f = await fake()
  try {
    const cf = new Cloudflare(() => 'secret-token', { base: f.base })
    assert.deepEqual(await cf.accounts(), [{ id: 'acc1', name: 'Rich' }])
    assert.deepEqual(await cf.zones('acc1'), [{ id: 'z1', name: 'siomporas.com', status: 'active' }])
    assert.equal(await cf.workersSubdomain('acc1'), 'rich')
    assert.deepEqual(await cf.buckets('acc1'), [{ name: 'games', created: '2026-01-01', location: null }])
    await cf.createBucket('acc1', 'new-games')
    assert.ok(f.reqs.every((r) => r.headers.authorization === 'Bearer secret-token'))
    assert.equal(f.reqs.find((r) => r.url.startsWith('/zones')).url, '/zones?per_page=50&account.id=acc1')
    assert.deepEqual(JSON.parse(f.reqs.at(-1).body), { name: 'new-games' })
    assert.equal(JSON.stringify(cf).includes('secret'), false, 'a dump of the client shows no token')
  } finally {
    f.close()
  }
})

test('objects: put with the content type, get back the same bytes, delete, and a key with slashes and spaces survives the path', async () => {
  const f = await fake()
  try {
    const cf = new Cloudflare('t', { base: f.base })
    const key = 'corridor/alpha-1/assetsvc/catalog/my car/file/mesh.finished.glb'
    const n = await cf.putObject('acc1', 'games', key, Buffer.from('glb-bytes'), 'model/gltf-binary')
    assert.equal(n, 9)
    const put = f.reqs.at(-1)
    assert.equal(put.url, '/accounts/acc1/r2/buckets/games/objects/corridor/alpha-1/assetsvc/catalog/my%20car/file/mesh.finished.glb')
    assert.equal(put.headers['content-type'], 'model/gltf-binary')
    assert.equal(put.headers['content-length'], '9')
    assert.equal((await cf.getObject('acc1', 'games', key)).toString(), 'glb-bytes')
    assert.equal(await cf.getObject('acc1', 'games', 'nope'), null)
    await cf.putObject('acc1', 'games', 'corridor/deployments.json', JSON.stringify({ a: 1 }), 'application/json')
    assert.deepEqual(await cf.getJson('acc1', 'games', 'corridor/deployments.json'), { a: 1 })
    assert.deepEqual((await cf.listObjects('acc1', 'games', 'corridor/alpha-1/')).map((o) => o.key), [key])
    assert.equal(await cf.deleteObject('acc1', 'games', key), true)
    assert.equal(await cf.deleteObject('acc1', 'games', key), false)
  } finally {
    f.close()
  }
})

test('a worker deploy: the manifest hashes, the upload of only what is missing, the script with its bindings, the subdomain and the domain', async () => {
  const f = await fake()
  try {
    const cf = new Cloudflare('t', { base: f.base })
    const assets = [
      { path: '/index.html', body: Buffer.from('<html>'), contentType: 'text/html' },
      { path: '/assets/app.js', body: Buffer.from('js'), contentType: 'application/javascript' },
    ]
    const lines = []
    await cf.deployWorker('acc1', 'w1', { script: 'export default {}', assets, bindings: [{ type: 'r2_bucket', name: 'DATA', bucket_name: 'games' }], log: (l) => lines.push(l) })
    const session = f.reqs.find((r) => r.url.endsWith('/assets-upload-session'))
    const manifest = JSON.parse(session.body).manifest
    assert.deepEqual(Object.keys(manifest).sort(), ['/assets/app.js', '/index.html'])
    assert.equal(manifest['/index.html'].hash, createHash('sha256').update('<html>').digest('hex').slice(0, 32))
    assert.equal(manifest['/index.html'].size, 6)
    assert.equal(assetHash(Buffer.from('js')), manifest['/assets/app.js'].hash)
    // only the second file was asked for, base64, under the session token
    const upload = f.reqs.find((r) => r.url.startsWith('/accounts/acc1/workers/assets/upload'))
    assert.equal(upload.headers.authorization, 'Bearer session-jwt')
    assert.match(upload.url, /base64=true/)
    assert.match(upload.headers['content-type'], /^multipart\/form-data/)
    const text = upload.body.toString()
    assert.ok(text.includes(`name="${manifest['/assets/app.js'].hash}"`))
    assert.ok(text.includes(Buffer.from('js').toString('base64')))
    assert.ok(!text.includes(manifest['/index.html'].hash), 'what Cloudflare already had was not sent again')
    // the script: metadata with the completion token and the bindings, and the module
    const put = f.reqs.find((r) => r.url === '/accounts/acc1/workers/scripts/w1' && r.method === 'PUT')
    const body = put.body.toString()
    const meta = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1).split('\r\n--')[0])
    assert.equal(meta.main_module, 'worker.mjs')
    assert.equal(meta.assets.jwt, 'completion-jwt')
    assert.equal(meta.assets.config.not_found_handling, 'single-page-application')
    assert.deepEqual(meta.bindings, [{ type: 'assets', name: 'ASSETS' }, { type: 'r2_bucket', name: 'DATA', bucket_name: 'games' }])
    assert.ok(body.includes('name="worker.mjs"') && body.includes('export default {}'))
    assert.ok(lines.some((l) => /2 files, 1 to upload/.test(l)))
    await cf.enableSubdomain('acc1', 'w1')
    assert.deepEqual(JSON.parse(f.reqs.at(-1).body), { enabled: true, previews_enabled: false })
    await cf.attachDomain('acc1', { zoneId: 'z1', hostname: 'play.siomporas.com', service: 'w1' })
    assert.deepEqual(JSON.parse(f.reqs.at(-1).body), { zone_id: 'z1', hostname: 'play.siomporas.com', service: 'w1', environment: 'production' })
  } finally {
    f.close()
  }
})

test('a worker deploy with nothing to upload uses the session token as the completion token', async () => {
  const f = await fake()
  try {
    const cf = new Cloudflare('t', { base: f.base })
    await cf.deployWorker('acc1', 'w1', { script: 'x', assets: [{ path: '/index.html', body: Buffer.from('a') }] })
    assert.ok(!f.reqs.some((r) => r.url.startsWith('/accounts/acc1/workers/assets/upload')))
    const put = f.reqs.find((r) => r.url === '/accounts/acc1/workers/scripts/w1' && r.method === 'PUT')
    assert.ok(put.body.toString().includes('"jwt":"session-jwt"'))
  } finally {
    f.close()
  }
})

test('a failure is an exception that names the error, never a result to inspect', async () => {
  const f = await fake()
  try {
    const cf = new Cloudflare('t', { base: f.base })
    await assert.rejects(cf.api('/boom'), (e) => e instanceof CloudflareError && e.status === 400 && /10000: Authentication error/.test(e.message))
    await assert.rejects(cf.api('/nowhere'), /7003: no route/)
  } finally {
    f.close()
  }
})
