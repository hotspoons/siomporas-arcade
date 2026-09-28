// The in-editor shell, main-thread side: one worker, the editor's documents projected into it, and
// what a command writes there saved back.
//
// PORTED FROM ZIP-TIES (zip-ties-ui/static/js/lib/computer/computer.js), where Rich built it first
// and told us to copy it rather than invent a second one. The worker protocol is his, unchanged.
// What is different here is both ends of the projection: there /workspace is a conversation's
// attachments and artifacts, here it is the editor's own worlds, levels, programs and presets, and
// a write goes back through the editor's API rather than to an attachments endpoint.
//
// THE ACP EDITOR TOOLS COME FREE. `handle()` answers the `fs/*` and `terminal/*` methods an ACP
// agent asks its client for, so an agent connected to this page sees a machine it can run commands
// on and files it can edit — which is Rich's "providing the files over the editor tools". The same
// surface a person types at.
//
// A COMMAND THAT OVERRUNS is stopped by restarting the worker from the files this side mirrors.
// What that command wrote is lost and nothing else is: there is no way to interrupt a synchronous
// wasm interpreter from outside it, so the only honest options are a restart or a hung tab.
import { ROOT, bodyFor, checkBody, endpointFor, pathsFor, readme, type DocSources } from './projection'

export interface ExecResult {
  cmd: string
  cwd0: string
  stdout: string
  stderr: string
  exitCode: number
  ms?: number
  changed?: string[]
  removed?: string[]
}

export interface ShellFile { path: string; size: number; mtime: number }

export interface ShellOpts {
  onOutput?: (r: ExecResult) => void
  onFiles?: (files: ShellFile[]) => void
  onStatus?: (text: string) => void
  onSaved?: (e: { path: string; what: string; ok: boolean; error?: string }) => void
  onReady?: (motd: string) => void
  /** where the worker and its vendored bundle are served from */
  workerUrl?: string
}

type Pending = (m: Record<string, unknown>) => void

/** The default shape of a save: a PUT of the file's text, through the page's own origin. */
async function put(url: string, body: string, type = 'application/json'): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': type }, body })
    if (r.ok) return { ok: true }
    const j = (await r.json().catch(() => null)) as { error?: string } | null
    return { ok: false, error: j?.error ?? `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) }
  }
}

export class Shell {
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<number, Pending>()
  private n = 0
  private terminals = new Map<string, { output: string; exitCode: number | null; done: Promise<unknown> }>()
  /** path → bytes: what the machine holds, so a restart can put it back */
  private mirror = new Map<string, Uint8Array>()
  /** paths this side is reading back right now, so a save does not chase its own write */
  private syncing = new Set<string>()
  files: ShellFile[] = []
  cwd = ROOT
  motd = ''
  timeoutMs = 120_000
  restarts = 0
  private readonly o: ShellOpts

  constructor(o: ShellOpts = {}) {
    this.o = o
  }

  /**
   * Project the editor's documents and boot the machine.
   *
   * The documents are fetched HERE and handed to the worker as bytes, rather than the worker
   * fetching them: the worker has no network at all by design (it seals `fetch`, `WebSocket` and
   * the rest before any command runs), because Python's `js` module reaches the worker's globals
   * and a script could otherwise call the editor's API with the page's own credentials.
   */
  async start(docs: DocSources, fetchDoc: (path: string) => Promise<string | null>): Promise<void> {
    if (this.ready) return this.ready
    const seed: Record<string, Uint8Array> = {}
    const enc = new TextEncoder()
    seed[`${ROOT}/README.md`] = enc.encode(readme(docs))
    for (const path of pathsFor(docs)) {
      const text = await fetchDoc(path).catch(() => null)
      if (text !== null) seed[path] = enc.encode(text)
    }
    for (const [p, b] of Object.entries(seed)) this.mirror.set(p, b)
    this.motd = `the world editor's documents, in a shell. ${Object.keys(seed).length - 1} files projected; see README.md.`
    return this.boot()
  }

  private boot(): Promise<void> {
    const url = this.o.workerUrl ?? '/agent/worker.js'
    this.worker = new Worker(url, { type: 'module' })
    const seed: Record<string, Uint8Array> = {}
    for (const [p, b] of this.mirror) seed[p] = b
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker!.onerror = (e) => {
        this.o.onStatus?.(`the shell did not start: ${e.message}`)
        reject(new Error(e.message))
      }
      this.worker!.onmessage = (ev) => this.onMessage(ev.data as Record<string, unknown>, resolve)
      this.worker!.postMessage({ type: 'init', files: seed, motd: this.motd })
    })
    return this.ready
  }

  stop(): void {
    this.worker?.terminate()
    this.worker = null
    this.ready = null
  }

  private restart(why: string): Promise<void> {
    this.restarts += 1
    this.o.onStatus?.(`${why}; restarting the shell (${this.mirror.size} files kept)`)
    this.worker?.terminate()
    this.worker = null
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const p of waiting) p({ type: 'result', stdout: '', stderr: `shell: ${why}\n`, exitCode: 124, changed: [], removed: [] })
    return this.boot()
  }

  private onMessage(m: Record<string, unknown>, resolveReady?: () => void): void {
    if (m.type === 'ready') {
      this.motd = (m.motd as string) || this.motd
      this.o.onReady?.(this.motd)
      resolveReady?.()
      void this.list()
      return
    }
    if (m.type === 'status') { this.o.onStatus?.(m.text as string); return }
    if (m.type === 'publish') { void this.save(m.path as string, m.bytes as Uint8Array); return }
    if (m.type === 'listing') {
      this.files = m.files as ShellFile[]
      this.o.onFiles?.(this.files)
    }
    const p = this.pending.get(m.id as number)
    if (p) { this.pending.delete(m.id as number); p(m) }
    const changed = (m.changed as string[]) ?? []
    const removed = (m.removed as string[]) ?? []
    if (changed.length || removed.length) void this.changed(changed, removed)
  }

  private ask(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.n
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.worker!.postMessage({ ...msg, id })
    })
  }

  async exec(cmd: string, { cwd }: { cwd?: string } = {}): Promise<ExecResult> {
    await this.ready
    const cwd0 = cwd || this.cwd
    let timer: ReturnType<typeof setTimeout> | undefined
    const r = await Promise.race([
      this.ask({ type: 'exec', cmd, cwd }),
      new Promise<Record<string, unknown>>((resolve) => {
        timer = setTimeout(() => {
          const secs = Math.round(this.timeoutMs / 1000)
          void this.restart(`the command was still running after ${secs} s`).then(() =>
            resolve({ stdout: '', stderr: `shell: stopped after ${secs} s\n`, exitCode: 124 }))
        }, this.timeoutMs)
      }),
    ])
    clearTimeout(timer)
    if (r.cwd && !cwd) this.cwd = r.cwd as string
    const out: ExecResult = {
      cmd,
      cwd0,
      stdout: (r.stdout as string) ?? '',
      stderr: (r.stderr as string) ?? '',
      exitCode: (r.exitCode as number) ?? 0,
      ms: r.ms as number,
    }
    this.o.onOutput?.(out)
    return out
  }

  async read(path: string): Promise<{ text?: string | null; bytes?: Uint8Array; error?: string }> {
    await this.ready
    return this.ask({ type: 'read', path }) as Promise<{ text?: string | null; bytes?: Uint8Array; error?: string }>
  }

  async write(path: string, content: string): Promise<void> {
    await this.ready
    await this.ask({ type: 'write', path, content })
  }

  async list(): Promise<ShellFile[]> {
    await this.ready
    const r = await this.ask({ type: 'list' })
    this.files = r.files as ShellFile[]
    this.o.onFiles?.(this.files)
    return this.files
  }

  /**
   * What a command wrote goes back to the document it came from.
   *
   * Only the paths the projection recognises: everything else — out/, a scratch file, a README the
   * agent rewrote — stays in the machine, which is what the README says it does.
   */
  private async changed(changed: string[], removed: string[]): Promise<void> {
    void this.list()
    for (const p of removed) this.mirror.delete(p)
    for (const p of changed) {
      if (this.syncing.has(p)) continue
      this.syncing.add(p)
      try {
        const f = await this.read(p)
        if (f.error || !f.bytes) continue
        this.mirror.set(p, f.bytes)
        if (typeof f.text !== 'string') continue // a binary a command produced is not a document
        await this.save(p, f.bytes, f.text)
      } finally {
        this.syncing.delete(p)
      }
    }
  }

  /** Save one path back, if it maps to a document. Reports either way; never throws. */
  private async save(path: string, bytes: Uint8Array, text?: string): Promise<void> {
    const e = endpointFor(path)
    if (!e) return
    const body = text ?? new TextDecoder().decode(bytes)
    const why = checkBody(e, body)
    if (why) {
      this.o.onSaved?.({ path, what: e.what, ok: false, error: why })
      return
    }
    const r = await put(e.url, bodyFor(e, body))
    this.o.onSaved?.({ path, what: e.what, ok: r.ok, error: r.error })
  }

  /* ---- the ACP editor tools: what an agent asks its client for --------------------------- */

  /**
   * Answer one `fs/*` or `terminal/*` request.
   *
   * The same methods the ACP spec defines for a client that has an editor behind it, so an agent
   * sees this tab as a machine with files. Unchanged from zip-ties, because the protocol is.
   */
  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ready
    switch (method) {
      case 'fs/read_text_file': {
        const f = await this.read(String(params.path ?? ''))
        if (f.error) throw new Error(f.error)
        return { content: f.text ?? '' }
      }
      case 'fs/write_text_file': {
        await this.write(String(params.path ?? ''), String(params.content ?? ''))
        return {}
      }
      case 'terminal/create': {
        const id = `term-${++this.n}`
        const cmd = [params.command, ...((params.args as string[]) ?? [])].map(quote).join(' ')
        const t: { output: string; exitCode: number | null; done: Promise<unknown> } = { output: '', exitCode: null, done: Promise.resolve() }
        t.done = this.exec(cmd, { cwd: (params.cwd as string) || undefined }).then((r) => {
          t.output = r.stdout + r.stderr
          t.exitCode = r.exitCode
          return r
        })
        this.terminals.set(id, t)
        return { terminalId: id }
      }
      case 'terminal/output': {
        const t = this.terminals.get(String(params.terminalId))
        if (!t) throw new Error('unknown terminal')
        return { output: t.output, truncated: false, ...(t.exitCode !== null ? { exitStatus: { exitCode: t.exitCode, signal: null } } : {}) }
      }
      case 'terminal/wait_for_exit': {
        const t = this.terminals.get(String(params.terminalId))
        if (!t) throw new Error('unknown terminal')
        await t.done
        return { exitCode: t.exitCode, signal: null }
      }
      case 'terminal/kill': {
        const t = this.terminals.get(String(params.terminalId))
        if (t && t.exitCode === null) void this.restart('the agent killed a command')
        return {}
      }
      case 'terminal/release': {
        this.terminals.delete(String(params.terminalId))
        return {}
      }
      default:
        throw new Error(`unsupported client method ${method}`)
    }
  }
}

/** What the client tells an agent it can do. The ACP handshake's `clientCapabilities`. */
export const EDITOR_CAPABILITIES = { fs: { readTextFile: true, writeTextFile: true }, terminal: true }

const quote = (s: unknown) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`)
