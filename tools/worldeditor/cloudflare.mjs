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

import { createHash } from 'node:crypto'

const API = 'https://api.cloudflare.com/client/v4'

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
  constructor(token, { base = API, fetch = globalThis.fetch } = {}) {
    this.base = base.replace(/\/$/, '')
    this.fetch = fetch
    // a closure rather than a field, so `JSON.stringify(cf)` or a debugger dump shows nothing
    this.auth = () => `Bearer ${typeof token === 'function' ? token() : token}`
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

  /** One object up, whole. Fine for tiles and models; the API's own ceiling is ~300 MiB. */
  async putObject(accountId, bucket, key, body, contentType = 'application/octet-stream') {
    const bytes = body instanceof Uint8Array ? body : Buffer.from(body)
    await this.api(this.#objectPath(accountId, bucket, key), {
      method: 'PUT',
      body: bytes,
      headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) },
    })
    return bytes.byteLength
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
