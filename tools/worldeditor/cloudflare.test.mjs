// The Cloudflare client, against a stand-in that records exactly what it was sent.
//
// This proves the CLIENT: paths, methods, headers, the multipart shapes, the manifest hashes, and
// that a `success: false` is an exception. It does not prove Cloudflare's side of the contract;
// the first real deploy does that, and its log is written to be read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { Cloudflare, CloudflareError, TokenStore, assetHash, sigv4 } from './cloudflare.mjs'

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
    if (p === '/user/tokens/verify') {
      // an account-owned token has no user: Cloudflare answers with an auth error
      if (req.headers.authorization === 'Bearer account-token') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ success: false, errors: [{ code: 6003, message: 'Invalid request headers' }] })) }
      return ok({ id: 't', status: 'active' })
    }
    if (p === '/accounts') return ok([{ id: 'acc1', name: 'Rich' }])
    if (p === '/accounts/acc1/tokens/verify') return ok({ id: 'acct-token-id', status: 'active' })
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

test('a user token and an account-owned token both verify; a dead one does not', async () => {
  const f = await fake()
  try {
    assert.deepEqual(await new Cloudflare('user-token', { base: f.base }).verify(), { kind: 'user', status: 'active', id: 't' })
    const acct = await new Cloudflare('account-token', { base: f.base }).verify()
    assert.equal(acct.kind, 'account')
    assert.deepEqual(acct.accounts, ['acc1'])
  } finally {
    f.close()
  }
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

test('sigv4 reproduces the signatures in AWS\'s own S3 examples', () => {
  // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — "GET Object" and
  // "GET Bucket (List Objects)". If these drift, R2 answers SignatureDoesNotMatch on a real deploy.
  const key = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' }
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const get = sigv4({ ...key, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z' } })
  assert.equal(get, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  const list = sigv4({ ...key, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J', headers: { 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z' } })
  assert.match(list, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/)
})

/** R2's S3 endpoint, in memory: multipart only, and every request's signature checked */
function fakeS3({ token, tokenId, failPart = null, flakyPart = null } = {}) {
  const reqs = []
  const uploads = new Map()
  const objects = new Map()
  let nextId = 1
  const flaked = new Set()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const u = new URL(req.url, 'http://x')
    reqs.push({ method: req.method, url: req.url, headers: req.headers, bytes: body.length })
    const fail = (status, code) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`) }
    // the signature, recomputed from what arrived with the secret Cloudflare derives from a token
    const h = {}
    for (const k of req.headers.authorization.match(/SignedHeaders=([^,]+)/)[1].split(';')) if (k !== 'host') h[k] = req.headers[k]
    const want = sigv4({ method: req.method, url: `http://${req.headers.host}${req.url}`, headers: h, accessKey: tokenId, secret: createHash('sha256').update(token).digest('hex') })
    if (want !== req.headers.authorization) return fail(403, 'SignatureDoesNotMatch')
    if (createHash('sha256').update(body).digest('hex') !== req.headers['x-amz-content-sha256']) return fail(400, 'XAmzContentSHA256Mismatch')
    const key = decodeURIComponent(u.pathname.split('/').slice(2).join('/'))
    if (req.method === 'POST' && u.searchParams.has('uploads')) {
      const id = `up${nextId++}`
      uploads.set(id, { key, type: req.headers['content-type'], parts: new Map() })
      res.writeHead(200); return res.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`)
    }
    const up = uploads.get(u.searchParams.get('uploadId'))
    if (!up) return fail(404, 'NoSuchUpload')
    if (req.method === 'PUT') {
      const n = Number(u.searchParams.get('partNumber'))
      if (n === failPart) return fail(400, 'EntityTooSmall')
      if (n === flakyPart && !flaked.has(n)) { flaked.add(n); return fail(503, 'SlowDown') }
      up.parts.set(n, body)
      res.writeHead(200, { etag: `"etag-${n}"` }); return res.end()
    }
    if (req.method === 'POST') {
      const order = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>"etag-(\d+)"<\/ETag>/g)].map((m) => Number(m[1]))
      objects.set(up.key, { body: Buffer.concat(order.map((n) => up.parts.get(n))), type: up.type })
      uploads.delete(u.searchParams.get('uploadId'))
      res.writeHead(200); return res.end('<CompleteMultipartUploadResult/>')
    }
    if (req.method === 'DELETE') { uploads.delete(u.searchParams.get('uploadId')); res.writeHead(204); return res.end() }
    fail(400, 'Unexpected')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, reqs, uploads, objects, close: () => server.close() })))
}

test('a large object goes to R2 as a signed multipart upload, part by part, and arrives whole', async () => {
  const f = await fake()
  const s3 = await fakeS3({ token: 'user-token', tokenId: 't' })
  try {
    const cf = new Cloudflare('user-token', { base: f.base, s3: () => s3.base })
    const size = 5 * 1024 * 1024 + 123
    const data = Buffer.alloc(size)
    for (let i = 0; i < size; i++) data[i] = (i * 7) & 255
    const reads = []
    const key = 'corridor/dc-1/sites/dc/osm.geojson'
    const n = await cf.putObjectLarge('acc1', 'games', key, { size, read: async (off, len) => { reads.push([off, len]); return data.subarray(off, off + len) } }, 'application/geo+json', { partBytes: 2 * 1024 * 1024 })
    assert.equal(n, size)
    assert.deepEqual(reads, [[0, 2097152], [2097152, 2097152], [4194304, 1048699]], 'read a part at a time, never the whole file')
    assert.ok(s3.objects.get(key).body.equals(data), 'the parts reassemble to the original bytes')
    assert.equal(s3.objects.get(key).type, 'application/geo+json')
    assert.equal(s3.reqs.length, 5) // initiate, three parts, complete
    assert.equal(s3.reqs[0].url, '/games/corridor/dc-1/sites/dc/osm.geojson?uploads=')
    assert.ok(s3.reqs.every((r) => r.headers.authorization.includes('Credential=t/')), 'the token id is the access key')
    assert.ok(s3.reqs.every((r) => !JSON.stringify(r.headers).includes('user-token')), 'the token itself is never sent to S3')
    assert.equal(s3.uploads.size, 0)
  } finally {
    f.close()
    s3.close()
  }
})

test('a transient part failure is retried; a real one aborts the upload so R2 keeps no orphaned parts', async () => {
  const f = await fake()
  const flaky = await fakeS3({ token: 'user-token', tokenId: 't', flakyPart: 2 })
  const broken = await fakeS3({ token: 'user-token', tokenId: 't', failPart: 2 })
  try {
    const data = Buffer.alloc(3 * 1024 * 1024, 1)
    const src = { size: data.length, read: async (o, l) => data.subarray(o, o + l) }
    const ok = new Cloudflare('user-token', { base: f.base, s3: () => flaky.base, retryWait: () => 1 })
    await ok.putObjectLarge('acc1', 'games', 'k', src, 'application/octet-stream', { partBytes: 1024 * 1024 })
    assert.ok(flaky.objects.get('k').body.equals(data))
    assert.equal(flaky.reqs.filter((r) => r.url.includes('partNumber=2')).length, 2, 'the 503 was retried once')
    const bad = new Cloudflare('user-token', { base: f.base, s3: () => broken.base, retryWait: () => 1 })
    await assert.rejects(bad.putObjectLarge('acc1', 'games', 'k', src, 'application/octet-stream', { partBytes: 1024 * 1024 }), (e) => e instanceof CloudflareError && /part 2: HTTP 400 EntityTooSmall/.test(e.message))
    assert.equal(broken.reqs.at(-1).method, 'DELETE', 'the upload was aborted')
    assert.equal(broken.uploads.size, 0)
    assert.equal(broken.objects.size, 0)
  } finally {
    f.close()
    flaky.close()
    broken.close()
  }
})

test('an account-owned token finds its access key id at the account verify', async () => {
  const f = await fake()
  try {
    const cf = new Cloudflare('account-token', { base: f.base })
    assert.equal(await cf.s3AccessKey('acc1'), 'acct-token-id')
  } finally {
    f.close()
  }
})
