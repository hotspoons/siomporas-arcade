// The platform, from the service: which agents exist, and a tunnel to one of them.
//
// Rich, 2026-09-28: "embed the patapsco remote client (specifically the agent picker, session
// manager, ACP client, and editor controls) into the world and asset editor itself... just target
// the current platform client which is a few rest endpoints, a tunnel token minting endpoint, and
// a websocket connection."
//
// WHY THIS IS IN THE SERVICE AND NOT THE PAGE. A browser WebSocket cannot send headers, and the
// platform's tunnel contract needs two things at once: the PAT in `Authorization` (it
// authenticates the principal) and a single-use OTP in `?t=` (it authorises the tunnel). A page
// can do the second and not the first. Verified in patapsco-remote's own notes: OTP-as-bearer is
// a 401 "insufficient permissions", PAT-bearer with no `?t=` is a 401 "missing otp".
//
// Which is the right answer anyway, for the same reason the git credential is: a personal access
// token that reaches the browser is a token in a screenshot, in a bug report and in the devtools
// of whoever is pairing. It is written once into a 0600 file on the volume, and every response
// this module produces is searched for it by the probe.
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** The platform's tunnel auth contract, in one pure function. Ported verbatim in effect. */
export function authorizeTunnel(baseUrl, otp, pat) {
  const sep = baseUrl.includes('?') ? '&' : '?'
  return {
    url: `${baseUrl}${sep}t=${encodeURIComponent(otp)}`,
    headers: {
      Authorization: `Bearer ${pat}`,
      // oauth2-proxy strips `Authorization` on skip-auth routes and replaces it with its own JWT
      // under OIDC, so the platform reads this mirror as well
      'X-PatapscoAI-Token': pat,
    },
  }
}

const HTTPS = /^https:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/

export function validBase(url) {
  if (typeof url !== 'string' || !url.trim()) return 'give it the platform URL'
  if (!HTTPS.test(url.trim().replace(/\/$/, ''))) return 'the platform URL has to be an https:// origin'
  return null
}

function bad(msg, status = 400) {
  return Object.assign(new Error(msg), { status })
}

/**
 * The platform, as this service talks to it.
 *
 * Nothing here caches an OTP: they are single-use, the mint is one request, and a cached one is
 * the failure patapsco-remote's own retry loop exists to paper over.
 */
export class Platform {
  constructor(root, { fetchImpl = fetch } = {}) {
    this.root = path.resolve(root)
    this.file = path.join(this.root, '.platform-credential')
    this.fetch = fetchImpl
  }

  /** What is configured, and never the token. */
  async info() {
    if (!existsSync(this.file)) return { set: false, base: null, user: null }
    const doc = await this.read()
    return { set: !!doc?.token, base: doc?.base ?? null, user: doc?.user ?? null }
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      return null
    }
  }

  /** 0600 BEFORE a byte goes in — the same rule the git credential follows, for the same reason. */
  async set({ base, token, user }) {
    const why = validBase(base)
    if (why) throw bad(why)
    if (!token || /[\n\r]/.test(token)) throw bad('paste the personal access token')
    await writeFile(this.file, '', { mode: 0o600 })
    await chmod(this.file, 0o600)
    await writeFile(this.file, JSON.stringify({ base: base.trim().replace(/\/$/, ''), token, user: user ?? null }), { mode: 0o600 })
    return this.info()
  }

  async clear() {
    await rm(this.file, { force: true })
    return { set: false }
  }

  async headers() {
    const doc = await this.read()
    if (!doc?.token) throw bad('no platform credential is stored on this service', 401)
    return {
      base: doc.base,
      headers: { Authorization: `Bearer ${doc.token}`, 'X-PatapscoAI-Token': doc.token, 'Content-Type': 'application/json' },
      token: doc.token,
    }
  }

  /** Every agent deployment the platform will show us. */
  async agents({ workspace } = {}) {
    const { base, headers } = await this.headers()
    let url = `${base}/api/v1/remote-dev/agents/deployments`
    if (workspace) url += `?workspace=${encodeURIComponent(workspace)}`
    const r = await this.fetch(url, { headers })
    if (!r.ok) throw bad(`the platform answered ${r.status} for the agent list`, r.status === 401 ? 401 : 502)
    const j = await r.json().catch(() => ({}))
    return j.deployments ?? []
  }

  /**
   * A single-use tunnel token.
   *
   * `kind`/`name`/`namespace` name what to tunnel to and `class` says what kind of tunnel; the
   * platform's own client mints a fresh one per attempt and so does this.
   */
  async otp({ kind, namespace, name, tunnelClass }) {
    const { base, headers } = await this.headers()
    const r = await this.fetch(`${base}/api/v1/remote-dev/tunnels/otp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind, namespace, name, class: tunnelClass }),
    })
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      throw bad(j.error ?? `the platform refused to mint a tunnel token (${r.status})`, r.status === 401 || r.status === 403 ? 401 : 502)
    }
    const j = await r.json()
    if (!j?.token) throw bad('the platform minted a token with no token in it', 502)
    return j.token
  }

  /** The authorized upstream WebSocket for one tunnel: the URL and the headers a page cannot send. */
  async tunnel({ kind, namespace, name, tunnelClass, port }) {
    const { base, token } = await this.headers()
    const otp = await this.otp({ kind, namespace, name, tunnelClass })
    let ws = `${base.replace(/^http/, 'ws')}/api/v1/remote-dev/tunnels/connect`
    if (port) ws += `?port=${encodeURIComponent(port)}`
    return authorizeTunnel(ws, otp, token)
  }
}
