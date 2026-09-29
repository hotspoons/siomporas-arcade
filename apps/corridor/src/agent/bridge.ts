// The editor page as a tool provider: dial the service, say what this page can do, answer calls.
//
// THE PAGE DIALS OUT. The service never connects to a browser — it cannot, behind an ingress or on
// a laptop — so the direction here is the only one that works, and it is the same shape as every
// other agent tunnel in this repo.
//
// WHAT THIS PAGE BRINGS, and it is deliberately only the things that cannot live on the service.
// Worlds, levels, programs, the catalog, the runs and the splats are all `/api` handlers and are
// implemented in `tools/worldeditor/mcptools.mjs`, so they work with no browser open. Three things
// are not:
//
//   the shell     a wasm build of coreutils, python and js in a Worker, whose filesystem is the
//                 projected documents. There is no process for the service to spawn.
//   the language  Monaco's TypeScript service, with the program API's declarations already loaded.
//                 A tsc on the service would not know what `api.physics` is.
//   the view      what is selected, where the camera is, which world is open.
//
// NOTHING REACHES INTO A PANEL. Every capability arrives as a function in `BridgeOpts`, because
// `src/ui/**` belongs to the world-editor lane and a bridge that groped into its internals would
// break every time they moved a field. If a tool needs something new, the panel exports it.
import type { Shell } from './shell'
import * as lsp from './lsp'

export interface BridgeOpts {
  /** the wasm shell, once started — null while it is booting or if it failed */
  shell: () => Shell | null
  /** every program on the volume, for the compilation the language tools answer from */
  programs: () => Promise<{ path: string; text: string }[]>
  /** what the person is looking at: world, level, selection, camera */
  state: () => Record<string, unknown>
  /** where the service is; default same origin */
  base?: string
  /** the MCP token, when the endpoint is gated — a WebSocket cannot send a header */
  token?: () => string | null
  /** shown in the Agent tab, so two open tabs are tellable apart */
  label?: string
  onStatus?: (s: BridgeStatus) => void
}

export type BridgeState = 'off' | 'connecting' | 'attached' | 'retrying' | 'refused'

/** This window, and which one the service will actually send tool calls to. */
export interface Ownership {
  /** this window's name, assigned by the service so it is unique among those attached */
  me: { id: string; name: string } | null
  owner: { id: string; name: string } | null
  /** does this window own the connection? when false, browser tools run somewhere else */
  mine: boolean
  others: { id: string; name: string }[]
}

export interface BridgeStatus {
  state: BridgeState
  detail?: string
  tools: number
  calls: number
  /**
   * ONE WINDOW OWNS THE BROWSER TOOLS, and every window should be able to see whether it is that
   * window. Before this, two editors open meant the service served whichever attached first, so an
   * agent's shell commands ran in the other tab with nothing anywhere saying so.
   */
  own?: Ownership
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'number', description })

export class AgentBridge {
  private ws: WebSocket | null = null
  private tools = new Map<string, ToolDef>()
  private retry = 0
  private stopped = false
  private calls = 0
  private status: BridgeStatus = { state: 'off', tools: 0, calls: 0 }

  private readonly o: BridgeOpts

  constructor(o: BridgeOpts) {
    this.o = o
    for (const t of this.build()) this.tools.set(t.name, t)
    this.status.tools = this.tools.size
  }

  /* ---- the tools this page brings ------------------------------------------------------------ */

  private build(): ToolDef[] {
    const needShell = (): Shell => {
      const s = this.o.shell()
      if (!s) throw new Error('the editor’s shell has not started in this page — open the Shell tab once, then try again')
      return s
    }
    /** Put every program in the compilation before a language question. Cheap after the first. */
    const compiled = async () => lsp.loadWorkspace(await this.o.programs())

    return [
      {
        name: 'shell_exec',
        description:
          'Run a command in the editor’s shell: coreutils, python and js over the projected documents (worlds/, levels/, programs/). NO NETWORK. Writing a projected file is a LIVE edit to that document. This runs inside a browser tab, so it needs an editor open.',
        inputSchema: { type: 'object', properties: { command: str('e.g. `grep -rn "api.physics" programs/`'), cwd: str('default /work') }, required: ['command'], additionalProperties: false },
        run: async (a) => {
          const r = await needShell().exec(String(a.command), { cwd: a.cwd ? String(a.cwd) : undefined })
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
        },
      },
      {
        name: 'shell_list',
        description: 'Every file the shell can see, with size and modified time. The shell’s filesystem IS the editor’s documents.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => ({ files: await needShell().list() }),
      },
      {
        name: 'code_check',
        description:
          'Typecheck a program against the real compilation — the program API’s declarations and every other program on the volume. Returns syntactic AND semantic problems with lines. This is how you find out whether an edit compiles; writing does not check.',
        inputSchema: { type: 'object', properties: { path: str('program path, e.g. levels/rooftop/run'), source: str('check this text instead of what is on disk') }, required: ['path'], additionalProperties: false },
        run: async (a) => {
          await compiled()
          return { diagnostics: await lsp.check(String(a.path), a.source === undefined ? undefined : String(a.source)) }
        },
      },
      {
        name: 'code_outline',
        description:
          'The declarations in a program — classes, functions, methods, consts — nested, each with the lines it occupies. Use it to edit a specific function without reading or rewriting the whole file.',
        inputSchema: { type: 'object', properties: { path: str(''), source: str('') }, required: ['path'], additionalProperties: false },
        run: async (a) => {
          await compiled()
          return { outline: await lsp.outline(String(a.path), a.source === undefined ? undefined : String(a.source)) }
        },
      },
      {
        name: 'code_hover',
        description: 'What the symbol at a position is: its resolved type and its doc comment. The fastest way to find out what an API call actually takes.',
        inputSchema: { type: 'object', properties: { path: str(''), line: num('1-based'), column: num('1-based') }, required: ['path', 'line', 'column'], additionalProperties: false },
        run: async (a) => {
          await compiled()
          return (await lsp.hover(String(a.path), Number(a.line), Number(a.column))) ?? { signature: null }
        },
      },
      {
        name: 'code_definition',
        description: 'Where the symbol at a position is declared — which file and line.',
        inputSchema: { type: 'object', properties: { path: str(''), line: num('1-based'), column: num('1-based') }, required: ['path', 'line', 'column'], additionalProperties: false },
        run: async (a) => {
          await compiled()
          return { definitions: await lsp.definition(String(a.path), Number(a.line), Number(a.column)) }
        },
      },
      {
        name: 'editor_state',
        description: 'What this editor page is showing right now: the open world and level, the selection, the camera. Read-only, and it is about the page rather than the volume.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => this.o.state(),
      },
    ]
  }

  /* ---- the socket ---------------------------------------------------------------------------- */

  private url(): string {
    const base = this.o.base ?? location.origin
    const u = new URL('/api/agent/bridge', base)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.searchParams.set('label', this.o.label ?? 'editor')
    /*
     * The token goes in the query, and only here. A browser's WebSocket constructor takes a URL and
     * a subprotocol — there is no way to set an Authorization header on it — so this is the one
     * case the service's query fallback exists for. It is a same-origin request to our own service,
     * so the exposure is our own access log rather than a chain of proxies.
     */
    const t = this.o.token?.()
    if (t) u.searchParams.set('access_token', t)
    return u.toString()
  }

  start(): void {
    this.stopped = false
    this.open()
  }

  private open(): void {
    if (this.stopped) return
    this.emit({ state: 'connecting' })
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url())
    } catch (e) {
      return this.scheduleRetry(String((e as Error).message ?? e))
    }
    this.ws = ws

    ws.onopen = () => {
      this.retry = 0
      ws.send(
        JSON.stringify({
          type: 'register',
          label: this.o.label ?? 'editor',
          tools: [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }),
      )
      this.emit({ state: 'attached' })
    }

    ws.onmessage = (ev) => void this.onCall(ev)

    ws.onclose = (ev) => {
      this.ws = null
      // 1008 is the service refusing us — a wrong token. Retrying that forever is a hot loop
      // against a door that will not open, and it hides the reason behind "reconnecting".
      if (ev.code === 1008 || ev.code === 4401) return this.emit({ state: 'refused', detail: 'the service refused this page’s token — check the Agent tab' })
      this.scheduleRetry(ev.reason || `closed (${ev.code})`)
    }

    ws.onerror = () => {
      /* onclose always follows; reporting both would double every message */
    }
  }

  private async onCall(ev: MessageEvent): Promise<void> {
    let msg: {
      type?: string; id?: string; name?: string; args?: Record<string, unknown>
      you?: { id: string; name: string }; owner?: { id: string; name: string } | null
      mine?: boolean; others?: { id: string; name: string }[]
    }
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (msg.type === 'ownership') {
      this.emit({ own: { me: msg.you ?? null, owner: msg.owner ?? null, mine: !!msg.mine, others: msg.others ?? [] } })
      return
    }
    if (msg.type !== 'call' || !msg.id) return
    const tool = this.tools.get(String(msg.name))
    if (!tool) return this.ws?.send(JSON.stringify({ type: 'error', id: msg.id, error: `this page does not offer "${msg.name}"` }))
    this.calls++
    this.emit({})
    try {
      const result = await tool.run(msg.args ?? {})
      this.ws?.send(JSON.stringify({ type: 'result', id: msg.id, result }))
    } catch (e) {
      // The message is the agent's only clue, and these are mostly "you need something open" —
      // so the tool's own wording is passed through rather than replaced with a generic failure.
      this.ws?.send(JSON.stringify({ type: 'error', id: msg.id, error: String((e as Error)?.message ?? e) }))
    }
  }

  private scheduleRetry(detail: string): void {
    if (this.stopped) return
    // Backoff to 30s: the common cause is the service restarting, which takes seconds, and the
    // other common cause is a laptop asleep, where a tight loop is just battery.
    const wait = Math.min(30_000, 500 * 2 ** this.retry++)
    this.emit({ state: 'retrying', detail: `${detail} — retrying in ${Math.round(wait / 1000)}s` })
    setTimeout(() => this.open(), wait)
  }

  stop(): void {
    this.stopped = true
    this.ws?.close()
    this.ws = null
    this.emit({ state: 'off' })
  }

  /**
   * Take the MCP connection for this window.
   *
   * Over the socket rather than the HTTP route, because the socket already identifies this page —
   * the service knows which window asked, and the page does not have to know its own id to say
   * "me".
   */
  claim(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ type: 'claim' }))
    return true
  }

  private emit(patch: Partial<BridgeStatus>): void {
    this.status = { ...this.status, ...patch, tools: this.tools.size, calls: this.calls }
    this.o.onStatus?.(this.status)
  }

  get current(): BridgeStatus {
    return this.status
  }

  /** What the Agent tab lists. */
  get toolNames(): string[] {
    return [...this.tools.keys()]
  }
}
