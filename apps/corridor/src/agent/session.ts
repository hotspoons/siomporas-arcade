// An ACP session, from the page: connect, initialize, prompt, and answer what the agent asks back.
//
// Rich, 2026-09-28: "embed the patapsco remote client (specifically the agent picker, session
// manager, ACP client, and editor controls) into the world and asset editor itself, providing the
// files over the editor tools."
//
// THE FILES ARE THE SHELL. `shell.ts` already answers the `fs/*` and `terminal/*` methods an ACP
// agent asks its client for, over the editor's own documents — so "providing the files over the
// editor tools" is a wiring job here rather than a second implementation: the agent's read of
// `worlds/crofton-triangle.json` is the projection's read, and its write is a live edit.
//
// THE TRANSPORT IS A RELAY. A browser's WebSocket cannot send headers and the platform's tunnel
// needs one, so the socket goes to this service's `/api/agent/tunnel` and the service holds the
// token (tools/worldeditor/agentws.mjs). Nothing about the protocol changes; it is a pipe.
//
// PERMISSION IS NOT AUTOMATIC. `session/request_permission` is answered by asking, because the
// thing on the other end is about to edit a world. The one exception is a read, which cannot
// damage anything and would otherwise put a dialog in front of every file an agent looks at.
import { PROTOCOL_VERSION, type ContentBlock, type SessionNotification, type SessionUpdate } from './acp'
import { JsonRpcPeer, type JsonRpcTransport } from './rpc'
import { EDITOR_CAPABILITIES, type Shell } from './shell'

/** A WebSocket, as the JSON-RPC peer wants it. */
export function socketTransport(url: string): { transport: JsonRpcTransport; opened: Promise<void> } {
  const ws = new WebSocket(url)
  let onMessage: (p: string) => void = () => {}
  let onClose: (e?: Error) => void = () => {}
  let open = false
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => { open = true; resolve() })
    // BEFORE open, a close is a refusal and its reason is the only thing that says why — the relay
    // closes with 1008/1011 and the platform's own message. After open it is an ordinary
    // disconnection, and the peer's pending requests are what needs to hear about it.
    ws.addEventListener('close', (e) => {
      if (!open) reject(new Error(e.reason || `the tunnel closed (${e.code}) before it opened`))
      else onClose(new Error(e.reason || `the tunnel closed (${e.code})`))
    })
    ws.addEventListener('error', () => { if (!open) reject(new Error('the tunnel could not be opened')) })
  })
  const queue: string[] = []
  ws.addEventListener('open', () => { for (const m of queue.splice(0)) ws.send(m) })
  ws.addEventListener('message', (e) => onMessage(typeof e.data === 'string' ? e.data : ''))
  return {
    opened,
    transport: {
      send: (p) => { if (ws.readyState === WebSocket.OPEN) ws.send(p); else queue.push(p) },
      onMessage: (cb) => { onMessage = cb },
      onClose: (cb) => { onClose = cb },
      close: () => ws.close(),
    },
  }
}

/** One line of the transcript, flattened to what a panel draws. */
export interface Entry {
  kind: 'you' | 'agent' | 'thought' | 'tool' | 'plan' | 'note'
  text: string
  /** for a tool call, so its status can be updated in place rather than appended again */
  id?: string
  status?: string
}

export interface AgentTarget {
  kind: string
  namespace: string
  name: string
  tunnelClass?: string
}

export interface SessionOpts {
  /** the shell that answers fs/* and terminal/* — the editor tools */
  shell: Shell
  /** where the workspace lives, as the agent will be told */
  cwd?: string
  onEntry: (e: Entry) => void
  onState: (s: 'connecting' | 'ready' | 'thinking' | 'closed' | 'failed', detail?: string) => void
  /** what an agent may do to the documents; returns which option id was chosen */
  ask: (q: { title: string; detail: string; options: { id: string; name: string; kind: string }[] }) => Promise<string | null>
}

const text = (blocks: ContentBlock[] | undefined) =>
  (blocks ?? []).map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('')

/**
 * A live session with one agent.
 *
 * ONE PROMPT AT A TIME. ACP allows a second, and every harness behind it handles that differently;
 * a panel that lets you send one while the last is still running produces two interleaved streams
 * into the same transcript and no way to tell which answered what.
 */
export class Session {
  private peer: JsonRpcPeer | null = null
  private id: string | null = null
  private readonly o: SessionOpts
  private busy = false
  /** tool calls seen, so an update to one is an update rather than another line */
  private tools = new Set<string>()

  constructor(o: SessionOpts) {
    this.o = o
  }

  get sessionId(): string | null {
    return this.id
  }

  get running(): boolean {
    return this.busy
  }

  /** Connect through the relay, initialize, and open a session. */
  async connect(target: AgentTarget): Promise<void> {
    this.o.onState('connecting')
    const q = new URLSearchParams({
      kind: target.kind,
      namespace: target.namespace,
      name: target.name,
      class: target.tunnelClass ?? 'pty',
    })
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/agent/tunnel?${q}`
    const { transport, opened } = socketTransport(url)
    try {
      await opened
    } catch (e) {
      this.o.onState('failed', (e as Error).message)
      throw e
    }

    const peer = new JsonRpcPeer(transport, (m) => this.o.onEntry({ kind: 'note', text: m }))
    this.peer = peer
    this.wire(peer)

    const init = await peer.request<{ protocolVersion: number; agentCapabilities?: unknown }>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: EDITOR_CAPABILITIES,
    })
    this.o.onEntry({ kind: 'note', text: `connected — protocol v${init.protocolVersion}` })

    const s = await peer.request<{ sessionId: string }>('session/new', {
      cwd: this.o.cwd ?? '/workspace',
      mcpServers: [],
    })
    this.id = s.sessionId
    this.o.onState('ready')
  }

  /** Send a prompt and wait for the turn to end. */
  async prompt(what: string): Promise<void> {
    if (!this.peer || !this.id) throw new Error('not connected')
    if (this.busy) throw new Error('it is still working on the last one')
    this.busy = true
    this.o.onEntry({ kind: 'you', text: what })
    this.o.onState('thinking')
    try {
      const r = await this.peer.request<{ stopReason: string }>('session/prompt', {
        sessionId: this.id,
        prompt: [{ type: 'text', text: what }],
      })
      if (r.stopReason && r.stopReason !== 'end_turn') this.o.onEntry({ kind: 'note', text: `stopped: ${r.stopReason}` })
    } finally {
      this.busy = false
      this.o.onState('ready')
    }
  }

  /** Ask the agent to stop what it is doing. */
  cancel(): void {
    if (this.peer && this.id) this.peer.send('session/cancel', { sessionId: this.id })
  }

  close(): void {
    this.peer?.close()
    this.peer = null
    this.id = null
    this.o.onState('closed')
  }

  /* ---- what the agent asks US ------------------------------------------------------------ */

  private wire(peer: JsonRpcPeer): void {
    peer.notify('session/update', (params) => this.update(params as SessionNotification))

    // the editor tools: straight through to the shell, which is the projection
    for (const m of ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release']) {
      peer.handle(m, (params) => this.o.shell.handle(m, (params ?? {}) as Record<string, unknown>))
    }

    peer.handle('session/request_permission', async (params) => {
      const p = (params ?? {}) as { toolCall?: { title?: string; kind?: string; rawInput?: unknown }; options?: { optionId: string; name: string; kind: string }[] }
      const options = (p.options ?? []).map((o) => ({ id: o.optionId, name: o.name, kind: o.kind }))
      // A READ IS NOT A DECISION. Asking about every file an agent opens trains a person to press
      // the first button, which is how the one that mattered gets allowed too.
      if (p.toolCall?.kind === 'read') {
        const allow = options.find((o) => o.kind.startsWith('allow'))
        if (allow) return { outcome: { outcome: 'selected', optionId: allow.id } }
      }
      const chosen = await this.o.ask({
        title: p.toolCall?.title ?? 'The agent wants to do something',
        detail: typeof p.toolCall?.rawInput === 'string' ? p.toolCall.rawInput : JSON.stringify(p.toolCall?.rawInput ?? {}, null, 1).slice(0, 2000),
        options,
      })
      if (!chosen) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: chosen } }
    })
  }

  private update(n: SessionNotification): void {
    const u = n?.update as SessionUpdate | undefined
    if (!u) return
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        this.o.onEntry({ kind: 'agent', text: text([u.content as ContentBlock]) })
        break
      case 'agent_thought_chunk':
        this.o.onEntry({ kind: 'thought', text: text([u.content as ContentBlock]) })
        break
      case 'user_message_chunk':
        break // the panel already showed what was typed
      case 'tool_call':
      case 'tool_call_update': {
        const t = u as unknown as { toolCallId: string; title?: string; status?: string; kind?: string }
        const first = !this.tools.has(t.toolCallId)
        this.tools.add(t.toolCallId)
        this.o.onEntry({ kind: 'tool', id: t.toolCallId, status: t.status, text: t.title ?? (first ? t.kind ?? 'tool' : '') })
        break
      }
      case 'plan':
        this.o.onEntry({ kind: 'plan', text: ((u as unknown as { entries?: { content: string; status: string }[] }).entries ?? []).map((e) => `${e.status === 'completed' ? '✓' : '·'} ${e.content}`).join('\n') })
        break
      default:
        break
    }
  }
}
