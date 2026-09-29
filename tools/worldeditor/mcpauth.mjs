// The MCP endpoint's bearer token: minted once, kept on the volume, overridable.
//
// WHY THERE IS A TOKEN AT ALL. Until now `/api/agent/mcp` was open, which was defensible while the
// only tools were four document reads on a service nobody had published. It is not defensible now:
// the same endpoint is about to expose the shell, the asset catalog, the splat runs and every
// world. An MCP URL is pasted into agent configs, which end up in dotfiles, screenshots and
// support threads, so the URL alone must not be authority.
//
// WHY IT IS OPTIONAL. The editor also runs on a laptop against localhost, where a token is pure
// friction, and it runs behind an ingress that already authenticates, where a second secret is
// two things to rotate. `required` is therefore a decision the deployment makes
// (`WORLDEDITOR_MCP_AUTH`), not one this file makes for it. The default is ON when a token exists
// and the service is reachable off-localhost, because the failure modes are not symmetric: a
// needless token costs a copy-paste, a missing one costs the cluster.
//
// WHY IT IS NOT A PASSWORD. Nobody types it. It is generated, shown once in the Agent tab beside
// a copy button, and pasted into a config file — so it is 256 bits of urlsafe base64 rather than
// something memorable, and there is no recovery flow because regenerating is cheaper than one.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'

/** `aat_` for "agent access token" — a prefix so a leaked string is identifiable in a log sweep. */
const PREFIX = 'aat_'

export function mintToken() {
  return PREFIX + randomBytes(32).toString('base64url')
}

/**
 * Compare without leaking length or position through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be the leak — so both sides are
 * hashed to a fixed width first by padding into equal buffers. An attacker who can time this
 * learns nothing they did not bring with them.
 */
export function tokenMatches(given, expected) {
  if (!given || !expected) return false
  const a = Buffer.from(String(given))
  const b = Buffer.from(String(expected))
  if (a.length !== b.length) {
    // still do the work, so a wrong-length guess is not measurably faster than a wrong-value one
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** `Authorization: Bearer <token>`, or null. Also accepts `?access_token=` — see load(). */
export function bearerOf(req, url) {
  const h = req.headers?.authorization ?? req.headers?.Authorization
  if (typeof h === 'string' && /^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, '').trim()
  /*
   * A QUERY FALLBACK, and it is deliberately not advertised in the config the Agent tab hands out.
   * Some MCP clients cannot set a header — the same limitation as a browser's WebSocket — and
   * without this they simply cannot reach the endpoint. It is accepted and it is second-class:
   * a token in a query string is in every proxy log between the two ends, so the tab shows the
   * header form and this exists for the client that has no other option.
   */
  const q = url?.searchParams?.get('access_token')
  return q ? String(q) : null
}

export class McpAuth {
  /**
   * @param {{dataDir: string, env?: NodeJS.ProcessEnv}} o
   */
  constructor({ dataDir, env = process.env }) {
    this.file = path.join(dataDir, 'agent', 'mcp-token.json')
    this.env = env
    this.token = null
    this.source = 'none'
    this.required = false
  }

  /**
   * Resolve the token and whether it is enforced.
   *
   * Precedence is env, then the file, then a fresh mint — so a chart can set
   * `WORLDEDITOR_MCP_TOKEN` from a Secret and the file is never written, which is what you want
   * when the volume is shared or backed up.
   */
  async load() {
    const fromEnv = this.env.WORLDEDITOR_MCP_TOKEN?.trim()
    if (fromEnv) {
      this.token = fromEnv
      this.source = 'env'
    } else {
      const onDisk = await readFile(this.file, 'utf8').then((t) => JSON.parse(t)?.token).catch(() => null)
      if (onDisk) {
        this.token = onDisk
        this.source = 'file'
      } else {
        this.token = mintToken()
        this.source = 'minted'
        await this.#persist()
      }
    }

    const flag = this.env.WORLDEDITOR_MCP_AUTH?.trim().toLowerCase()
    // An explicit decision wins. Otherwise: on, unless this is plainly a localhost-only dev run.
    this.required = flag === 'off' || flag === 'false' || flag === '0' ? false : flag ? true : !this.#looksLocalOnly()
    return this
  }

  #looksLocalOnly() {
    const host = (this.env.WORLDEDITOR_HOST ?? '').trim()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  }

  async #persist() {
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify({ token: this.token, minted: new Date().toISOString() }, null, 2))
    // The volume may be shared with a bake Job; nothing else needs to read this.
    await chmod(this.file, 0o600).catch(() => {})
  }

  /** Replace the token — the Agent tab's "regenerate", and the override an operator pastes in. */
  async set(token) {
    const next = (token ?? '').trim() || mintToken()
    if (this.source === 'env') {
      const e = new Error('the token comes from WORLDEDITOR_MCP_TOKEN; change it there, not here')
      e.status = 409
      throw e
    }
    this.token = next
    this.source = 'file'
    await this.#persist()
    return this.token
  }

  /**
   * Is this request allowed?
   *
   * Returns a reason rather than a boolean because the caller has to say something useful: "no
   * Authorization header" and "wrong token" are different mistakes and an agent that is told only
   * "401" will try the same config again.
   */
  check(req, url) {
    if (!this.required) return { ok: true, why: 'auth is off' }
    const given = bearerOf(req, url)
    if (!given) return { ok: false, why: 'no bearer token — add an Authorization header, or the headers block from the Agent tab' }
    if (!tokenMatches(given, this.token)) return { ok: false, why: 'that token is not this editor’s; copy it again from the Agent tab' }
    return { ok: true }
  }

  /** What the Agent tab shows. The token is included because the tab is where you copy it from. */
  describe() {
    return { required: this.required, source: this.source, token: this.token }
  }
}
