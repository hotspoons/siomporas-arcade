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
  /**
   * Documents changed under this page — a server-side MCP write, or another tab.
   *
   * Without this the page holds a copy nobody refreshes: the shell keeps serving what it seeded at
   * open, the next `sed -i` writes that stale text back, and an agent's edit is destroyed with
   * exit 0. The UI not repainting was the same silence with smaller teeth.
   */
  onInvalidate?: (paths: string[], origin: string) => void
  /** where the service is; default same origin */
  base?: string
  /** the MCP token, when the endpoint is gated — a WebSocket cannot send a header */
  token?: () => string | null
  /** shown in the Agent tab, so two open tabs are tellable apart */
  label?: string
  onStatus?: (s: BridgeStatus) => void
}

export type BridgeState = 'off' | 'connecting' | 'attached' | 'retrying' | 'refused'

export interface BridgeStatus {
  state: BridgeState
  detail?: string
  tools: number
  calls: number
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

/** Where the projection is mounted in the shell. The same constant agent/projection.ts exports. */
const SHELL_ROOT = '/workspace'

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
          'Run a command in the editor’s shell over the projected documents. Present: bash sh ls cat cp mv rm mkdir touch head tail wc sort uniq cut tr grep sed awk find diff xargs stat du tee jq rg python3 — with heredocs, pipes and redirection. NO node, NO git, NO patch, NO network. '
          + 'The filesystem is /workspace: programs/, worlds/, levels/, sites/, out/ and README.md. '
          + 'Writing under programs/, worlds/ or levels/ is a LIVE edit to that document and SAVING IS IMMEDIATE — no commit step, no undo. Use out/ for scratch; nothing there is a document. '
          + 'Runs inside a browser tab, so it needs an editor open.',
        inputSchema: {
          type: 'object',
          properties: { command: str('e.g. `grep -rn "api.physics" programs/`'), cwd: str('absolute, or relative to /workspace. Defaults to /workspace EVERY call') },
          required: ['command'],
          additionalProperties: false,
        },
        run: async (a) => {
          /*
           * ALWAYS AN EXPLICIT cwd, and that is the fix for a real bug rather than tidiness.
           *
           * Shell.exec remembers the directory a command left it in, which is right for the
           * interactive Shell tab — it is a terminal. It is wrong here: a `cd` inside one tool call
           * silently became the working directory of every later call, so `ls programs/` came back
           * empty six calls later and the agent concluded the document tree was corrupt. It was
           * not. Hidden state that makes an unrelated tool look broken produces confident wrong
           * diagnoses, which is the most expensive kind of failure for an agent.
           *
           * Passing cwd explicitly also stops Shell.exec persisting it, because it only remembers
           * when the caller did not say.
           */
          const cwd = a.cwd ? (String(a.cwd).startsWith('/') ? String(a.cwd) : `${SHELL_ROOT}/${String(a.cwd)}`) : SHELL_ROOT
          const r = await needShell().exec(String(a.command), { cwd })
          // The effective cwd goes back in every answer: if it is ever not what the caller asked
          // for, that is visible rather than inferred from a later mystery.
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, cwd }
        },
      },
      {
        name: 'shell_list',
        description: 'Every file the shell can see, with its size. The shell’s filesystem IS the editor’s documents. Needs an editor open, like shell_exec. NOTE: `mtime` is when this page projected the file, not when the document was last changed — use program_list for that.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => {
          /*
           * `mtime` OUT OF THE MACHINE IS THE SEED TIME, not the document's. Every file came back
           * with the instant the tab attached, which is worse than useless: an agent reaches for a
           * modified time precisely to detect the drift in finding 01, and this one always says
           * "all changed at once, three hours ago". Renamed to what it actually is, with a pointer
           * to the tool that knows.
           */
          const files = await needShell().list()
          return {
            files: files.map(({ mtime, ...f }) => ({ ...f, projectedAt: new Date(mtime).toISOString() })),
            note: 'projectedAt is when this page seeded the file, NOT when the document changed. program_list carries the real modified time.',
          }
        },
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
          'The declarations in a program — classes, functions, methods, top-level consts — nested, each with the lines it occupies, in FILE ORDER. Use it to edit one function without reading the whole file. Imports and in-function locals are left out unless you ask for them, because they buried everything else.',
        inputSchema: {
          type: 'object',
          properties: { path: str(''), source: str('check this text instead of what is on disk'), imports: { type: 'boolean', description: 'include import bindings' }, locals: { type: 'boolean', description: 'include variables declared inside functions' } },
          required: ['path'],
          additionalProperties: false,
        },
        run: async (a) => {
          await compiled()
          return {
            outline: await lsp.outline(String(a.path), a.source === undefined ? undefined : String(a.source), {
              imports: a.imports === true,
              locals: a.locals === true,
            }),
          }
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
    let msg: { type?: string; id?: string; name?: string; args?: Record<string, unknown>; paths?: unknown[]; origin?: string }
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (msg.type === 'invalidate') {
      // The page decides what to do with it — refresh the shell, repaint, reload a model. The
      // bridge only carries the news.
      this.o.onInvalidate?.(Array.isArray(msg.paths) ? msg.paths.map(String) : [], String(msg.origin ?? 'unknown'))
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
