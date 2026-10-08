// Cloudflare, by hand: the handful of REST calls a deploy needs, and the token they need.
//
// Rich, 2026-09-30: "We'll need to take a cloudflare token, then be able to query which domains
// we can hang it on, give the worker a subdomain, then query buckets, create a bucket if none
// exists … The CF token available as an env var but can also be entered into the app and stored
// in memory, never to be divulged in the running process."
//
// WHY NOT WRANGLER. Wrangler is in the dev dependencies and does all of this — from a config
// file, in a shell, with its own login state. A deploy from a pod has none of those: the token is
// in memory here, the assets are produced here, and the questions the form asks ("which zones can
// I use?", "which buckets exist?") are single GETs. The Workers Static Assets upload flow is
// three calls (`deployWorker` below) and R2 object writes are one PUT each, all documented and all
// the same calls Wrangler makes; there is nothing a subprocess would add except a second copy of
// the token in an environment block.
//
// THE TOKEN NEVER LEAVES THIS MODULE. `TokenStore` holds it; `Cloudflare` reads it through a
// closure; `describe()` says whether one is present and where it came from, and that is all any
// route or log ever sees. Nothing here writes it to disk, and no error message includes it.

import { createHash, createHmac } from 'node:crypto'

const API = 'https://api.cloudflare.com/client/v4'

/**
 * WHERE THE REST API STOPS. `PUT …/r2/buckets/{b}/objects/{key}` goes through api.cloudflare.com,
 * whose front refuses a large body with an HTML 413 before R2 sees it — the dc-metro deploy died on
 * a 371 MiB osm.geojson (2026-10-08). Anything over this goes to R2's S3 endpoint as a multipart
 * upload instead, PART_BYTES at a time, so no single request is large however big the world gets.
 * R2 wants every part but the last the same size, at least 5 MiB.
 */
export const MULTIPART_OVER = 32 * 2 ** 20
export const PART_BYTES = 32 * 2 ** 20

const sha256hex = (b) => createHash('sha256').update(b).digest('hex')
const hmac = (k, s) => createHmac('sha256', k).update(s).digest()
/** RFC 3986, as SigV4 wants it: encodeURIComponent also leaves !'()* alone */
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/**
 * AWS Signature V4 for one request, by hand — the R2 S3 endpoint's auth, and nothing else uses it.
 * `headers` must hold every header that is sent and signed (lower-case names), `x-amz-date` and
 * `x-amz-content-sha256` among them; `host` is taken from the URL. Returns the Authorization value.
 */
export function sigv4({ method, url, headers, accessKey, secret, region = 'auto', service = 's3' }) {
  const u = new URL(url)
  const amzDate = headers['x-amz-date']
  const day = amzDate.slice(0, 8)
  const h = { ...headers, host: u.host }
  const names = Object.keys(h).map((k) => k.toLowerCase()).sort()
  const canonHeaders = names.map((k) => `${k}:${String(h[k]).trim().replace(/\s+/g, ' ')}\n`).join('')
  const signed = names.join(';')
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  // the path as sent: already percent-encoded per segment by whoever built the URL
  const canonical = [method, u.pathname, query, canonHeaders, signed, h['x-amz-content-sha256']].join('\n')
  const scope = `${day}/${region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request')
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`
}

/** a transient failure worth another go: the network, a 429, a 5xx */
const transient = (e) => !e?.status || e.status === 429 || e.status >= 500

/** `fn`, again on a transient failure: four tries over ~7 s. A 9,000-object deploy meets a blip. */
async function retrying(fn, { tries = 4, wait = (n) => 500 * 2 ** n } = {}) {
  for (let n = 0; ; n++) {
    try {
      return await fn()
    } catch (e) {
      if (n + 1 >= tries || !transient(e)) throw e
      await new Promise((r) => setTimeout(r, wait(n)))
    }
  }
}

export class CloudflareError extends Error {
  constructor(message, status, errors = []) {
    super(message)
    this.status = status
    this.errors = errors
  }
}

/** The token, from the environment or typed into the app; held in memory only. */
export class TokenStore {
  #token = null
  source = null

  constructor(env = process.env) {
    if (env.CLOUDFLARE_API_TOKEN) {
      this.#token = env.CLOUDFLARE_API_TOKEN
      this.source = 'env'
    }
  }

  /** what a route may say about it: present or not, and where from — never the value */
  describe() {
    return { present: !!this.#token, source: this.source }
  }

  set(token) {
    const t = String(token ?? '').trim()
    if (!t) throw Object.assign(new Error('an empty token is not a token'), { status: 400 })
    this.#token = t
    this.source = 'entered'
    return this.describe()
  }

  clear() {
    this.#token = null
    this.source = null
    return this.describe()
  }

  /** the token, for a client and nothing else. Throws when there is none */
  use() {
    if (!this.#token) throw Object.assign(new Error('no Cloudflare token — set CLOUDFLARE_API_TOKEN or enter one in the Deploy panel'), { status: 401 })
    return this.#token
  }
}

/** sha256, hex, the first 32 characters: the asset manifest's hash, as Wrangler computes it. */
export function assetHash(body) {
  return createHash('sha256').update(body).digest('hex').slice(0, 32)
}

/** The REST calls. `fetch` and `base` are injectable so a test can stand in for Cloudflare. */
export class Cloudflare {
  constructor(token, { base = API, fetch = globalThis.fetch, s3 = (accountId) => `https://${accountId}.r2.cloudflarestorage.com`, retryWait } = {}) {
    this.base = base.replace(/\/$/, '')
    this.fetch = fetch
    this.s3Base = s3
    this.retryWait = retryWait
    // a closure rather than a field, so `JSON.stringify(cf)` or a debugger dump shows nothing
    const raw = () => (typeof token === 'function' ? token() : token)
    this.auth = () => `Bearer ${raw()}`
    // the S3 secret Cloudflare derives from a token is its SHA-256; same closure rule
    this.s3Secret = () => sha256hex(raw())
    this.s3KeyId = new Map()
  }

  /**
   * One call. Every Cloudflare response is `{ success, errors, messages, result, result_info }`;
   * a failure is an exception naming each error, never a `success: false` handed back to a caller
   * that forgets to check it.
   */
  async api(path, { method = 'GET', body, headers = {}, query, raw = false, auth = this.auth() } = {}) {
    const url = new URL(`${this.base}${path}`)
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    const h = { authorization: auth, ...headers }
    let payload = body
    if (body !== undefined && !(body instanceof Uint8Array) && !(typeof FormData !== 'undefined' && body instanceof FormData) && typeof body !== 'string') {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const r = await this.fetch(url.toString(), { method, headers: h, body: payload })
    if (raw) return r
    const text = await r.text()
    let doc = null
    try {
      doc = text ? JSON.parse(text) : null
    } catch {
      throw new CloudflareError(`${method} ${path}: HTTP ${r.status}, not JSON: ${text.slice(0, 200)}`, r.status)
    }
    if (!r.ok || (doc && doc.success === false)) {
      const errors = doc?.errors ?? []
      const msg = errors.map((e) => `${e.code ? `${e.code}: ` : ''}${e.message}`).join('; ') || `HTTP ${r.status}`
      throw new CloudflareError(`${method} ${path}: ${msg}`, r.status, errors)
    }
    return doc?.result ?? doc
  }

  /**
   * Is the token good, and which kind is it.
   *
   * Two kinds exist and only one of them can answer `/user/tokens/verify`: a USER token (made
   * under My Profile) can; an ACCOUNT-OWNED token (made under the account's Manage Account →
   * API Tokens) gets an authentication error there, because it has no user. Rich, 2026-09-30:
   * "we need to be able to use account API tokens in addition to user API tokens". So a token
   * that fails the user check is asked the question both kinds can answer — which accounts can
   * you see — and is good if it sees any. `kind` is reported so the panel can say which it got.
   */
  async verify() {
    try {
      const r = await this.api('/user/tokens/verify')
      return { kind: 'user', status: r?.status ?? 'active', id: r?.id ?? null }
    } catch (userErr) {
      let accounts = []
      try {
        accounts = await this.accounts()
      } catch (accountErr) {
        throw new CloudflareError(`not a usable token: as a user token, ${userErr.message}; as an account token, ${accountErr.message}`, accountErr.status ?? 401)
      }
      if (!accounts.length) throw new CloudflareError('the token is accepted but can see no account — give it Account Settings: Read', 403)
      return { kind: 'account', status: 'active', id: null, accounts: accounts.map((a) => a.id) }
    }
  }

  /** Every account the token can see; nearly always one. */
  async accounts() {
    const r = await this.api('/accounts', { query: { per_page: 50 } })
    return (r ?? []).map((a) => ({ id: a.id, name: a.name }))
  }

  /** The zones (domains) a Worker could be hung on. */
  async zones(accountId) {
    const r = await this.api('/zones', { query: { per_page: 50, ...(accountId ? { 'account.id': accountId } : {}) } })
    return (r ?? []).map((z) => ({ id: z.id, name: z.name, status: z.status }))
  }

  /** The account's `*.workers.dev` subdomain, or null when it has never been set. */
  async workersSubdomain(accountId) {
    try {
      const r = await this.api(`/accounts/${accountId}/workers/subdomain`)
      return r?.subdomain ?? null
    } catch (e) {
      if (e.status === 404) return null
      throw e
    }
  }

  /* ---- R2 ---------------------------------------------------------------------------------- */

  async buckets(accountId) {
    const r = await this.api(`/accounts/${accountId}/r2/buckets`, { query: { per_page: 100 } })
    return (r?.buckets ?? []).map((b) => ({ name: b.name, created: b.creation_date ?? null, location: b.location ?? null }))
  }

  createBucket(accountId, name) {
    return this.api(`/accounts/${accountId}/r2/buckets`, { method: 'POST', body: { name } })
  }

  #objectPath(accountId, bucket, key) {
    return `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  /**
   * One object up, whole, through the REST API. Fine for tiles, docs and models — not for anything
   * over MULTIPART_OVER, which the API's front refuses (see `putObjectLarge`).
   */
  async putObject(accountId, bucket, key, body, contentType = 'application/octet-stream') {
    const bytes = body instanceof Uint8Array ? body : Buffer.from(body)
    await retrying(() => this.api(this.#objectPath(accountId, bucket, key), {
      method: 'PUT',
      body: bytes,
      headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) },
    }), { wait: this.retryWait })
    return bytes.byteLength
  }

  /**
   * The S3 access key id for this token in this account: the TOKEN'S ID, which is what Cloudflare
   * documents as the R2 access key of a token with R2 permissions (the secret is its SHA-256). A
   * user token says its id at /user/tokens/verify; an account-owned token only at the account's.
   */
  async s3AccessKey(accountId) {
    if (this.s3KeyId.has(accountId)) return this.s3KeyId.get(accountId)
    let id = null
    for (const p of ['/user/tokens/verify', `/accounts/${accountId}/tokens/verify`]) {
      try {
        id = (await this.api(p))?.id ?? null
      } catch {
        /* the other kind of token */
      }
      if (id) break
    }
    if (!id) throw new CloudflareError('cannot find this token\'s id, which a large R2 upload needs as its S3 access key', 403)
    this.s3KeyId.set(accountId, id)
    return id
  }

  /** One signed call to R2's S3 endpoint. Errors are XML there; they become CloudflareErrors. */
  async #s3(accountId, method, bucket, key, { query = {}, body, headers = {} } = {}) {
    const path = `/${rfc3986(bucket)}/${key.split('/').map(rfc3986).join('/')}`
    const url = new URL(`${this.s3Base(accountId).replace(/\/$/, '')}${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
    const payload = body ?? Buffer.alloc(0)
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    const h = { ...headers, 'x-amz-date': amzDate, 'x-amz-content-sha256': sha256hex(payload) }
    h.authorization = sigv4({ method, url: url.toString(), headers: h, accessKey: await this.s3AccessKey(accountId), secret: this.s3Secret() })
    const r = await this.fetch(url.toString(), { method, headers: h, body: method === 'GET' || method === 'HEAD' ? undefined : payload })
    const text = await r.text()
    if (!r.ok) {
      const code = text.match(/<Code>([^<]*)<\/Code>/)?.[1]
      const msg = text.match(/<Message>([^<]*)<\/Message>/)?.[1]
      throw new CloudflareError(`S3 ${method} ${key}${query.partNumber ? ` part ${query.partNumber}` : ''}: HTTP ${r.status}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`, r.status)
    }
    return { headers: r.headers, text }
  }

  /**
   * One LARGE object up: an S3 multipart upload to R2, a part at a time.
   *
   * `read(offset, length)` hands back the bytes of one part, so a 371 MiB file is never in memory
   * whole — a deploy runs four of these at once on a pod. Parts go in order, each retried on a
   * transient failure; any other failure aborts the upload so R2 does not keep the orphaned parts.
   */
  async putObjectLarge(accountId, bucket, key, { size, read }, contentType = 'application/octet-stream', { partBytes = PART_BYTES, log = () => {} } = {}) {
    const init = await retrying(() => this.#s3(accountId, 'POST', bucket, key, { query: { uploads: '' }, headers: { 'content-type': contentType } }), { wait: this.retryWait })
    const uploadId = init.text.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1]
    if (!uploadId) throw new CloudflareError(`S3 multipart ${key}: no UploadId in ${init.text.slice(0, 200)}`, 502)
    const parts = []
    try {
      const count = Math.max(1, Math.ceil(size / partBytes))
      for (let n = 1; n <= count; n++) {
        const off = (n - 1) * partBytes
        const body = await read(off, Math.min(partBytes, size - off))
        const r = await retrying(() => this.#s3(accountId, 'PUT', bucket, key, { query: { partNumber: n, uploadId }, body }), { wait: this.retryWait })
        const etag = r.headers.get('etag')
        if (!etag) throw new CloudflareError(`S3 part ${n} of ${key}: no ETag`, 502)
        parts.push(`<Part><PartNumber>${n}</PartNumber><ETag>${etag}</ETag></Part>`)
        log(`    ${key}: part ${n}/${count}`)
      }
      const done = `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`
      await retrying(() => this.#s3(accountId, 'POST', bucket, key, { query: { uploadId }, body: Buffer.from(done), headers: { 'content-type': 'application/xml' } }), { wait: this.retryWait })
    } catch (e) {
      await this.#s3(accountId, 'DELETE', bucket, key, { query: { uploadId } }).catch(() => {})
      throw e
    }
    return size
  }

  /** The object's bytes, or null when there is no such key. */
  async getObject(accountId, bucket, key) {
    const r = await this.api(this.#objectPath(accountId, bucket, key), { raw: true })
    if (r.status === 404) return null
    if (!r.ok) throw new CloudflareError(`GET ${key}: HTTP ${r.status}`, r.status)
    return Buffer.from(await r.arrayBuffer())
  }

  async getJson(accountId, bucket, key) {
    const b = await this.getObject(accountId, bucket, key)
    return b ? JSON.parse(b.toString('utf8')) : null
  }

  async deleteObject(accountId, bucket, key) {
    const r = await this.api(this.#objectPath(accountId, bucket, key), { method: 'DELETE', raw: true })
    if (r.status !== 404 && !r.ok) throw new CloudflareError(`DELETE ${key}: HTTP ${r.status}`, r.status)
    return r.status !== 404
  }

  /**
   * Keys under a prefix. Best effort: the deploy keeps its own manifest of what it wrote and
   * prunes from that, so nothing depends on this — it is the "what else is in there" readout.
   */
  async listObjects(accountId, bucket, prefix) {
    const out = []
    let cursor = ''
    for (let page = 0; page < 100; page++) {
      const r = await this.api(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects`, { query: { prefix, per_page: 1000, cursor } })
      const items = Array.isArray(r) ? r : (r?.objects ?? [])
      for (const o of items) out.push({ key: o.key, size: o.size ?? 0 })
      cursor = r?.result_info?.cursor ?? r?.cursor ?? ''
      if (!cursor || !items.length) break
    }
    return out
  }

  /* ---- Workers ----------------------------------------------------------------------------- */

  /**
   * Publish a Worker with static assets: the built viewer as its assets, one module as its code.
   *
   * THREE CALLS, the same three Wrangler makes:
   *   1. an upload session, from a manifest of `{ path: { hash, size } }` — Cloudflare answers
   *      with a JWT and WHICH hashes it does not already have, grouped into buckets;
   *   2. each bucket uploaded as multipart form-data, base64, one field per hash, under that JWT
   *      — the last answer carries the completion JWT;
   *   3. the script itself, multipart: `metadata` (bindings, the assets JWT, the entry module) and
   *      the module. Bindings: `assets` for the files, `r2_bucket` for the data, `plain_text` for
   *      the prefix the data is under.
   */
  async deployWorker(accountId, name, { script, assets, bindings = [], compatibilityDate = '2025-06-01', log = () => {} }) {
    const manifest = {}
    const byHash = new Map()
    for (const a of assets) {
      const p = a.path.startsWith('/') ? a.path : `/${a.path}`
      const hash = assetHash(a.body)
      manifest[p] = { hash, size: a.body.byteLength }
      byHash.set(hash, a)
    }
    const session = await this.api(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/assets-upload-session`, { method: 'POST', body: { manifest } })
    let jwt = session?.jwt ?? null
    const buckets = session?.buckets ?? []
    const toSend = buckets.reduce((n, b) => n + b.length, 0)
    log(`assets: ${assets.length} files, ${toSend} to upload (${assets.length - toSend} already on Cloudflare)`)
    for (const bucket of buckets) {
      const form = new FormData()
      for (const hash of bucket) {
        const a = byHash.get(hash)
        if (!a) throw new CloudflareError(`upload session asked for an unknown hash ${hash}`, 500)
        form.append(hash, new Blob([Buffer.from(a.body).toString('base64')], { type: a.contentType ?? 'application/octet-stream' }), hash)
      }
      const r = await this.api('/accounts/' + accountId + '/workers/assets/upload', { method: 'POST', body: form, query: { base64: 'true' }, auth: `Bearer ${session.jwt}` })
      if (r?.jwt) jwt = r.jwt
    }
    if (!jwt) throw new CloudflareError('the asset upload finished without a completion token', 500)

    const metadata = {
      main_module: 'worker.mjs',
      compatibility_date: compatibilityDate,
      compatibility_flags: [],
      bindings: [{ type: 'assets', name: 'ASSETS' }, ...bindings],
      assets: { jwt, config: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application' } },
    }
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json')
    form.append('worker.mjs', new Blob([script], { type: 'application/javascript+module' }), 'worker.mjs')
    const r = await this.api(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`, { method: 'PUT', body: form })
    log(`worker ${name} published${r?.id ? ` (${r.id})` : ''}`)
    return r
  }

  /** Serve it at `<name>.<account>.workers.dev`. */
  enableSubdomain(accountId, name) {
    return this.api(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/subdomain`, { method: 'POST', body: { enabled: true, previews_enabled: false } })
  }

  /** Hang it on a hostname in one of the account's zones; Cloudflare writes the DNS record. */
  attachDomain(accountId, { zoneId, hostname, service }) {
    return this.api(`/accounts/${accountId}/workers/domains`, { method: 'PUT', body: { zone_id: zoneId, hostname, service, environment: 'production' } })
  }
}
