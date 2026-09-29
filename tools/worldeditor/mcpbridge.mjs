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
/*
 * Names for windows. Two syllables, easy to say out loud, and nothing that reads as a status —
 * a window called "Primary" or "Main" would be mistaken for the one that matters.
 */
const WINDOW_NAMES = [
  'Harbour', 'Meridian', 'Kestrel', 'Lantern', 'Compass', 'Thicket',
  'Beacon', 'Quarry', 'Fathom', 'Willow', 'Marlow', 'Pike',
]

const HEARTBEAT_MS = 30_000
/** How long a forwarded call may take. The shell can be slow; a python import is seconds. */
const CALL_TIMEOUT_MS = 120_000

export class McpBridge {
  constructor({ log = console } = {}) {
    this.log = log
    /** @type {Set<{ws: WebSocket, id: string, tools: Map<string, object>, label: string, alive: boolean}>} */
    this.pages = new Set()
    /*
     * ONE WINDOW OWNS THE CONNECTION.
     *
     * Rich, 2026-09-29: "we need to detect this and allow only a single window to own the mcp
     * access — and on other tabs or windows connected to the same back end we offer the option to
     * take the MCP connection and disconnect from the other one."
     *
     * Before this, `call()` served the FIRST page that offered the tool, which with two editors
     * open meant an agent's `shell_exec` ran in somebody else's tab against somebody else's
     * projection, and `editor_state` reported their camera. Nothing errored; the agent simply got
     * plausible answers to questions it had not asked.
     *
     * Ownership is explicit and visible instead: one page holds it, the others are told they do
     * not, and taking it is a deliberate act with the previous owner informed.
     */
    this.owner = null
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

  /**
   * A name for a window, unique among the ones attached right now.
   *
   * ASSIGNED BY THE SERVER, because only the server can see the others. A page naming itself
   * cannot avoid a collision, and "world editor" three times over is exactly what an agent cannot
   * act on — Rich, 2026-09-29: "we should probably uniquely title each window too so the agent can
   * say which one is which".
   *
   * Words rather than numbers. `editor-2` and `editor-3` are a reading test in a log; "Harbour"
   * and "Meridian" are not, and the name has to survive being read out in a sentence like "the
   * shell has not started in Harbour".
   */
  #nameFor() {
    const taken = new Set([...this.pages].map((p) => p.name))
    for (const w of WINDOW_NAMES) if (!taken.has(w)) return w
    for (let i = 2; ; i++) {
      for (const w of WINDOW_NAMES) {
        const n = `${w} ${i}`
        if (!taken.has(n)) return n
      }
    }
  }

  #register(ws, url) {
    const page = {
      ws,
      id: randomUUID().slice(0, 8),
      name: this.#nameFor(),
      tools: new Map(),
      label: url.searchParams.get('label') ?? 'editor',
      alive: true,
    }
    this.pages.add(page)
    // THE FIRST WINDOW IN OWNS IT. Somebody opening one editor should not have to claim anything;
    // the question only arises when there are two.
    if (!this.owner) this.#setOwner(page, 'it was the first window attached')
    else this.#tell(page)

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
      this.log.log?.(`[bridge] ${page.name} gone; ${this.pages.size} attached`)
      // HAND IT ON. A window closing must not leave the connection owned by nobody while another
      // editor sits there able to serve it — that would turn "close the tab you were not using"
      // into "the agent stops working".
      if (this.owner === page) this.#setOwner([...this.pages][0] ?? null, 'the owner went away')
    })
    ws.on('error', () => {})
  }

  /** Tell one page where it stands: whether it owns the connection, and who does if not. */
  #tell(page) {
    const owner = this.owner
    try {
      page.ws.send(JSON.stringify({
        type: 'ownership',
        you: { id: page.id, name: page.name },
        owner: owner ? { id: owner.id, name: owner.name } : null,
        mine: owner === page,
        others: [...this.pages].filter((p) => p !== page).map((p) => ({ id: p.id, name: p.name })),
      }))
    } catch {
      /* a socket on its way out; the sweep will drop it */
    }
  }

  /** Tell everybody, because ownership changing is news to the window that lost it too. */
  #tellAll() {
    for (const page of this.pages) this.#tell(page)
  }

  #setOwner(page, why) {
    const before = this.owner
    this.owner = page ?? null
    if (before !== this.owner) {
      this.log.log?.(`[bridge] ${this.owner ? this.owner.name : 'nobody'} now owns the MCP connection (${why})`)
    }
    this.#tellAll()
  }

  /**
   * Take the connection, by page id.
   *
   * A TAKE IS ALWAYS ALLOWED, and that is the decision rather than an oversight. The alternative
   * is asking the current owner, which needs somebody sitting at it to answer — and the case this
   * exists for is a window nobody is watching holding the connection. Losing it is visible in the
   * window that lost it, which is enough.
   */
  claim(pageId) {
    const page = [...this.pages].find((p) => p.id === pageId || p.name === pageId)
    if (!page) {
      throw Object.assign(new Error(`no attached window called "${pageId}" (attached: ${[...this.pages].map((p) => p.name).join(', ') || 'none'})`), { status: 404 })
    }
    const previous = this.owner
    this.#setOwner(page, 'it was claimed')
    return { owner: { id: page.id, name: page.name }, took_from: previous && previous !== page ? { id: previous.id, name: previous.name } : null }
  }

  #onMessage(page, msg) {
    if (msg.type === 'register') {
      page.tools.clear()
      for (const t of msg.tools ?? []) {
        if (!t?.name) continue
        page.tools.set(t.name, t)
      }
      page.label = msg.label ?? page.label
      this.log.log?.(`[bridge] ${page.name} offers ${page.tools.size} tools`)
      // a window that registers when nothing owns the connection takes it: this is the reconnect
      // case, where the owner went away and came back
      if (!this.owner) this.#setOwner(page, 'nothing owned it')
      else this.#tell(page)
      return
    }
    if (msg.type === 'claim') {
      this.#setOwner(page, 'the window asked for it')
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
    const before = this.owner
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
    // the sweep is the OTHER way a page leaves — a browser that crashed never sends a close — so
    // the same hand-over has to happen here or a dead window keeps the connection for ever
    if (before && !this.pages.has(before)) this.#setOwner([...this.pages][0] ?? null, 'the owner stopped answering')
  }

  /**
   * The tools that can actually run: the OWNER's.
   *
   * It was the union over every attached page, which advertised a tool that the window serving
   * calls might not offer — a manifest that lies in the one direction an agent cannot recover
   * from. Two editors offer the same seven tools in practice, so this changes nothing in the
   * normal case and stops the manifest overpromising in the odd one.
   */
  tools() {
    return this.owner ? [...this.owner.tools.values()] : []
  }

  has(name) {
    return !!this.owner?.tools.has(name)
  }

  get attached() {
    return this.pages.size
  }

  /** What the Agent tab shows: who is attached, and what they brought. */
  describe() {
    return {
      attached: this.pages.size,
      owner: this.owner ? { id: this.owner.id, name: this.owner.name } : null,
      pages: [...this.pages].map((p) => ({
        id: p.id, name: p.name, label: p.label, tools: p.tools.size, owner: p === this.owner,
      })),
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
    /*
     * THE OWNER SERVES IT, and only the owner.
     *
     * This used to be `[...this.pages].find(p => p.tools.has(name))` — the first page to attach,
     * for as long as it stayed. With two editors open an agent's `shell_exec` ran in the other
     * window's shell and `editor_state` reported the other window's camera, silently and
     * plausibly. Now there is exactly one window that answers, it has a name, and the answer says
     * which one it was.
     */
    const page = this.owner
    if (!page) {
      throw new Error(`"${name}" runs inside the editor page and no editor is attached. Open the world editor in a browser — the Agent tab shows the connection — and call it again.`)
    }
    if (!page.tools.has(name)) {
      const elsewhere = [...this.pages].filter((p) => p !== page && p.tools.has(name)).map((p) => p.name)
      throw new Error(elsewhere.length
        ? `"${name}" is not offered by ${page.name}, which owns the connection, but ${elsewhere.join(' and ')} offer${elsewhere.length === 1 ? 's' : ''} it. Use editor_claim to move the connection.`
        : `"${name}" is not offered by ${page.name} (offering: ${[...page.tools.keys()].join(', ') || 'nothing'})`)
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
