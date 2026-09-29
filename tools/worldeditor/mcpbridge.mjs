// The UI as a tool provider: a websocket the editor page dials in on, so MCP can call things that
// only exist inside a browser.
//
// WHY THIS EXISTS AT ALL, given most tools do not need it. Nearly everything an agent wants here
// is already an `/api` handler — worlds, levels, programs, the catalog, the runs — and those are
// implemented server-side (mcptools.mjs) precisely so they work with no page open. Three things
// cannot be:
//
//   the shell        a wasm build of coreutils/python/js in a Worker, with the projected
//                    documents as its filesystem. It is not a process this service can spawn.
//   the language     Monaco's TypeScript service. The AST, the diagnostics and the completions
//                    come from a worker that is already running in the page with the program's
//                    real lib set loaded.
//   what is on screen  the selection, the camera, what is placed where in the baked map.
//
// Reimplementing any of those service-side means a second answer to the same question, and the two
// would drift. So the page registers them and the service forwards.
//
// THE DIRECTION IS THE POINT. The browser dials out; the service never connects to a browser. That
// is what makes this work behind an ingress, through a corporate proxy, and from a laptop with no
// public address — the same reason every other agent tunnel is shaped this way.
//
// WHAT IT IS NOT. It is not a general RPC into the page. A page advertises a fixed manifest at
// connect time and may answer only those names; an MCP call for a tool no attached page claims is
// refused by the router before any socket sees it.
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'

/** A page that has gone quiet for this long is not coming back; its tools stop being advertised. */
const HEARTBEAT_MS = 30_000
/** How long a forwarded call may take. The shell can be slow; a python import is seconds. */
const CALL_TIMEOUT_MS = 120_000

export class McpBridge {
  constructor({ log = console } = {}) {
    this.log = log
    /** @type {Set<{ws: WebSocket, id: string, tools: Map<string, object>, label: string, alive: boolean}>} */
    this.pages = new Set()
    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map()
  }

  /**
   * Mount on the existing HTTP server.
   *
   * `auth` is the same McpAuth the MCP endpoint uses: a page that may register tools can make the
   * service execute code on its behalf, so it is exactly as privileged as an MCP client and is
   * gated the same way. A browser cannot set an Authorization header on a WebSocket, so the token
   * rides in the query here — which is the case the query fallback in mcpauth exists for, and the
   * reason the editor's own page fetches it from `/api/agent/mcp/config` first.
   */
  attach(server, { path: route = '/api/agent/bridge', auth = null } = {}) {
    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      let url
      try {
        url = new URL(req.url, 'http://localhost')
      } catch {
        return socket.destroy()
      }
      if (url.pathname !== route) return // another upgrade handler may want it

      if (auth?.required) {
        const verdict = auth.check(req, url)
        if (!verdict.ok) {
          // A 401 on the upgrade, not a silent destroy: a page that is refused must be able to say
          // why in its own status line rather than showing "disconnected" forever.
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          return socket.destroy()
        }
      }

      wss.handleUpgrade(req, socket, head, (ws) => this.#register(ws, url))
    })

    this.timer = setInterval(() => this.#sweep(), HEARTBEAT_MS)
    this.timer.unref?.()
    return this
  }

  #register(ws, url) {
    const page = { ws, id: randomUUID().slice(0, 8), tools: new Map(), label: url.searchParams.get('label') ?? 'editor', alive: true }
    this.pages.add(page)

    ws.on('pong', () => { page.alive = true })
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return // a page that cannot produce JSON is not one we can talk to
      }
      this.#onMessage(page, msg)
    })
    ws.on('close', () => {
      this.pages.delete(page)
      // Fail anything still waiting on this page rather than letting it time out slowly: the
      // caller can be told "the editor disconnected", which is actionable, instead of "timed out".
      for (const [id, p] of this.pending) {
        if (p.page === page) {
          clearTimeout(p.timer)
          p.reject(new Error('the editor page disconnected while the tool was running'))
          this.pending.delete(id)
        }
      }
      this.log.log?.(`[bridge] ${page.label} (${page.id}) gone; ${this.pages.size} attached`)
    })
    ws.on('error', () => {})
  }

  #onMessage(page, msg) {
    if (msg.type === 'register') {
      page.tools.clear()
      for (const t of msg.tools ?? []) {
        if (!t?.name) continue
        page.tools.set(t.name, t)
      }
      page.label = msg.label ?? page.label
      this.log.log?.(`[bridge] ${page.label} (${page.id}) offers ${page.tools.size} tools`)
      return
    }
    if (msg.type === 'result' || msg.type === 'error') {
      const waiting = this.pending.get(msg.id)
      if (!waiting) return // a late answer to something that already timed out
      clearTimeout(waiting.timer)
      this.pending.delete(msg.id)
      if (msg.type === 'error') waiting.reject(new Error(msg.error ?? 'the editor refused the call'))
      else waiting.resolve(msg.result)
    }
  }

  #sweep() {
    for (const page of this.pages) {
      if (!page.alive) {
        page.ws.terminate()
        this.pages.delete(page)
        continue
      }
      page.alive = false
      try {
        page.ws.ping()
      } catch {
        this.pages.delete(page)
      }
    }
  }

  /**
   * Every tool any attached page offers.
   *
   * Two pages offering the same name is normal — the editor open in two tabs — and the first wins
   * rather than being an error, because the tools are the same tools. The call then goes to
   * whichever page still claims it at call time.
   */
  tools() {
    const out = new Map()
    for (const page of this.pages) {
      for (const [name, def] of page.tools) if (!out.has(name)) out.set(name, def)
    }
    return [...out.values()]
  }

  has(name) {
    for (const page of this.pages) if (page.tools.has(name)) return true
    return false
  }

  get attached() {
    return this.pages.size
  }

  /** What the Agent tab shows: who is attached, and what they brought. */
  describe() {
    return {
      attached: this.pages.size,
      pages: [...this.pages].map((p) => ({ id: p.id, label: p.label, tools: p.tools.size })),
      tools: this.tools().map((t) => t.name),
    }
  }

  /**
   * Forward one call to a page that claims the tool.
   *
   * The error when nothing is attached names the fix, because it is the single most likely thing
   * to go wrong with this whole design: the agent is working, the tool exists in the manifest it
   * was given, and the page it needs is simply not open.
   */
  async call(name, args, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const page = [...this.pages].find((p) => p.tools.has(name))
    if (!page) {
      if (this.pages.size === 0) {
        throw new Error(`"${name}" runs inside the editor page and no editor is attached. Open the world editor in a browser — the Agent tab shows the connection — and call it again.`)
      }
      throw new Error(`"${name}" is not offered by any attached editor page (${this.pages.size} attached, offering: ${this.tools().map((t) => t.name).join(', ') || 'nothing'})`)
    }

    const id = randomUUID()
    const sent = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`"${name}" did not answer within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, page })
    })
    page.ws.send(JSON.stringify({ type: 'call', id, name, args: args ?? {} }))
    return sent
  }

  close() {
    clearInterval(this.timer)
    for (const p of this.pages) p.ws.close()
    this.pages.clear()
  }
}
