// S3-compatible save and load, with no SDK.
//
// WHY BY HAND. `@aws-sdk/client-s3` is ~20 MB of dependency to PUT and GET objects, and this repo
// keeps a short dependency list it can actually account for in CREDITS. SigV4 is about eighty
// lines of HMAC and a canonical string, it is a stable published spec, and it works unchanged
// against AWS, Cloudflare R2, MinIO and Ceph RGW — which is the whole point of "S3-compatible".
// `tools/corridor/corridor/publish.py` uses boto3 because it is Python and boto3 is already there;
// this is the Node side of the same idea.
//
// Configuration is environment only, so the same code runs in the Helm chart and on a laptop:
//
//   ASSETSVC_S3_BUCKET      required for any sync
//   ASSETSVC_S3_ENDPOINT    R2: https://<account>.r2.cloudflarestorage.com   (unset for AWS)
//   ASSETSVC_S3_REGION      "auto" for R2 (default)
//   ASSETSVC_S3_PREFIX      key prefix, default "assets"
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
//
// Idempotent in both directions: an object whose size already matches is skipped, so a re-sync of
// a catalog that has not moved costs one LIST and nothing else.

import { createHmac, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import path from 'node:path'

const sha256hex = (b) => createHash('sha256').update(b).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

export class S3 {
  constructor(env = process.env) {
    this.bucket = env.ASSETSVC_S3_BUCKET ?? ''
    this.endpoint = (env.ASSETSVC_S3_ENDPOINT ?? '').replace(/\/$/, '')
    this.region = env.ASSETSVC_S3_REGION ?? 'auto'
    this.prefix = (env.ASSETSVC_S3_PREFIX ?? 'assets').replace(/^\/|\/$/g, '')
    this.key = env.AWS_ACCESS_KEY_ID ?? ''
    this.secret = env.AWS_SECRET_ACCESS_KEY ?? ''
  }

  get configured() {
    return !!(this.bucket && this.key && this.secret)
  }

  describe() {
    return { configured: this.configured, bucket: this.bucket || null, endpoint: this.endpoint || 'aws', region: this.region, prefix: this.prefix }
  }

  /** Virtual-host style for AWS, path style for everything else — R2 and MinIO both want path. */
  #url(key) {
    if (this.endpoint) return `${this.endpoint}/${this.bucket}/${key}`
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`
  }

  #sign({ method, key, query = '', body = Buffer.alloc(0), contentType }) {
    const url = new URL(this.#url(key) + (query ? `?${query}` : ''))
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = sha256hex(body)

    const headers = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(contentType ? { 'content-type': contentType } : {}),
    }
    const signedHeaders = Object.keys(headers).sort().join(';')
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]}\n`)
      .join('')
    // The path must be encoded segment by segment; the query is already canonical where we use it.
    const canonicalUri = url.pathname.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/')
    const canonicalRequest = [method, canonicalUri, url.searchParams.toString(), canonicalHeaders, signedHeaders, payloadHash].join('\n')

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonicalRequest))].join('\n')
    let k = hmac(`AWS4${this.secret}`, dateStamp)
    k = hmac(k, this.region)
    k = hmac(k, 's3')
    k = hmac(k, 'aws4_request')
    const signature = createHmac('sha256', k).update(toSign).digest('hex')

    return {
      url: url.toString(),
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    }
  }

  async put(key, body, contentType = 'application/octet-stream') {
    const full = `${this.prefix}/${key}`.replace(/^\//, '')
    const { url, headers } = this.#sign({ method: 'PUT', key: full, body, contentType })
    const r = await fetch(url, { method: 'PUT', headers, body })
    if (!r.ok) throw new Error(`S3 PUT ${full}: ${r.status} ${(await r.text()).slice(0, 200)}`)
    return { key: full, bytes: body.length }
  }

  async get(key) {
    const full = `${this.prefix}/${key}`.replace(/^\//, '')
    const { url, headers } = this.#sign({ method: 'GET', key: full })
    const r = await fetch(url, { headers })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`S3 GET ${full}: ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }

  /** Every key under the prefix, with sizes, following continuation tokens. */
  async list(sub = '') {
    const out = []
    let token
    for (;;) {
      const params = new URLSearchParams({ 'list-type': '2', prefix: `${this.prefix}/${sub}`.replace(/^\//, '') })
      if (token) params.set('continuation-token', token)
      const { url, headers } = this.#sign({ method: 'GET', key: '', query: params.toString() })
      const r = await fetch(url, { headers })
      if (!r.ok) throw new Error(`S3 LIST: ${r.status} ${(await r.text()).slice(0, 200)}`)
      const xml = await r.text()
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]+)<\/Key>/.exec(m[1])?.[1]
        const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0)
        if (key) out.push({ key, size })
      }
      token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
      if (!token) break
    }
    return out
  }

  /** Push a local directory tree. Objects whose size already matches are skipped. */
  async pushDir(dir, sub = '') {
    if (!this.configured) throw new Error('S3 is not configured')
    const remote = new Map((await this.list(sub)).map((o) => [o.key, o.size]))
    const pushed = []
    const skipped = []
    const walk = async (rel) => {
      const entries = await readdir(path.join(dir, rel), { withFileTypes: true })
      for (const e of entries) {
        const r = path.join(rel, e.name)
        if (e.isDirectory()) {
          await walk(r)
          continue
        }
        const local = path.join(dir, r)
        const size = (await stat(local)).size
        const key = `${this.prefix}/${sub}${r}`.replace(/\/+/g, '/')
        if (remote.get(key) === size) {
          skipped.push(r)
          continue
        }
        await this.put(`${sub}${r}`.replace(/^\//, ''), await readFile(local), typeFor(r))
        pushed.push(r)
      }
    }
    await walk('')
    return { pushed, skipped, bucket: this.bucket, prefix: this.prefix }
  }

  /** Pull everything under the prefix into a local directory. */
  async pullDir(dir, sub = '') {
    if (!this.configured) throw new Error('S3 is not configured')
    const objects = await this.list(sub)
    const pulled = []
    const skipped = []
    for (const o of objects) {
      const rel = o.key.slice(`${this.prefix}/`.length)
      const local = path.join(dir, rel)
      const have = await stat(local).then((s) => s.size).catch(() => -1)
      if (have === o.size) {
        skipped.push(rel)
        continue
      }
      const buf = await this.get(rel)
      if (!buf) continue
      await mkdir(path.dirname(local), { recursive: true })
      await writeFile(local, buf)
      pulled.push(rel)
    }
    return { pulled, skipped, bucket: this.bucket, prefix: this.prefix }
  }
}

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.json': 'application/json', '.webp': 'image/webp' }
const typeFor = (f) => TYPES[path.extname(f).toLowerCase()] ?? 'application/octet-stream'
