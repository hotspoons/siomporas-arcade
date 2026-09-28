// The agent, in the editor: which one, what it is doing, and what it wants to change.
//
// Rich, 2026-09-28: "embed the patapsco remote client (specifically the agent picker, session
// manager, ACP client, and editor controls) into the world and asset editor itself, providing the
// files over the editor tools."
//
// Four things, and each is a separate failure if it is missing:
//
//   the picker    which agent deployment to talk to — without it there is a hard-coded name
//   the session   connect, prompt, cancel, close — the thing that has a transcript
//   the tools     the shell IS the editor tools: an agent's read of worlds/x.json is the
//                 projection's read and its write is a live edit
//   permission    a dialog, because the thing on the other end is about to change a world
//
// THE TOKEN IS NOT HERE. The platform credential lives on the service, which mints the tunnel's
// one-time token and opens the upstream socket — a browser's WebSocket cannot send the header the
// platform's contract needs. See tools/worldeditor/agentws.mjs.
import { api } from '../worldedit/api'
import { Session, type Entry } from '../agent/session'
import type { Shell } from '../agent/shell'
import { bodyOf, empty, group, readout, setFieldError, textField } from './controls'
import { ask, button, el, toast } from './shell'

export interface AgentDeployment {
  name: string
  namespace?: string
  phase?: string
  agent?: string
  workspace?: string
}

export interface AgentPanelOpts {
  host: HTMLElement
  /** the transcript's pane; the picker and the controls go in the sidebar */
  transcriptHost: HTMLElement
  /** the shell that answers the agent's fs/* and terminal/* — the editor tools */
  shell: () => Shell | null
}

export class AgentPanel {
  private readonly o: AgentPanelOpts
  private platform: { set: boolean; base: string | null; user: string | null } | null = null
  private agents: AgentDeployment[] = []
  private chosen: AgentDeployment | null = null
  private session: Session | null = null
  private state: string = 'closed'
  private detail = ''
  private entries: Entry[] = []
  private out: HTMLElement | null = null
  private mcp: { servers: { name: string }[]; url: string; why?: string } | null = null

  constructor(o: AgentPanelOpts) {
    this.o = o
  }

  async render(): Promise<void> {
    this.platform = await api.agentPlatform().catch(() => null)
    if (this.platform?.set && !this.agents.length) {
      this.agents = await api.agentDeployments().then((r) => r.agents).catch(() => [])
    }
    this.mcp ??= await api.agentMcp().catch(() => null)
    this.draw()
  }

  private draw(): void {
    const host = this.o.host
    host.replaceChildren()

    const bar = el('div', 'panel-bar')
    bar.append(el('span', 'panel-title', `Agent${this.chosen ? ` · ${this.chosen.name}` : ''}`))
    const acts = el('div', 'panel-bar-actions')
    if (this.session && this.state !== 'closed') {
      acts.append(
        button({ label: 'Interrupt', icon: 'stop', title: 'ask it to stop what it is doing', onClick: () => this.session?.cancel() }),
        button({ label: 'Disconnect', icon: 'x-mark', variant: 'ghost', onClick: () => { this.session?.close(); this.session = null; this.draw() } }),
      )
    }
    bar.append(acts)
    host.append(bar)

    const term = el('div', 'term')
    this.out = el('pre', 'term-out')
    for (const e of this.entries) this.out.append(this.line(e))
    const line = el('div', 'term-line')
    line.append(el('span', 'term-prompt', this.state === 'thinking' ? '…' : '>'))
    const input = el('input', 'term-input')
    input.placeholder = this.session ? 'what should it do?' : 'connect to an agent first'
    input.disabled = !this.session || this.state === 'thinking'
    input.onkeydown = (e) => {
      e.stopPropagation()
      if (e.key !== 'Enter' || !input.value.trim()) return
      const what = input.value
      input.value = ''
      void this.session?.prompt(what).catch((err) => toast((err as Error).message, 'warn', 5000))
    }
    line.append(input)
    term.append(this.out, line)
    host.append(term)
    this.out.scrollTop = this.out.scrollHeight

    this.drawSidebar()
    if (!input.disabled) input.focus()
  }

  private line(e: Entry): HTMLElement {
    const cls = { you: 'term-echo', agent: '', thought: 'term-dim', tool: 'term-dim', plan: 'term-dim', note: 'term-dim' }[e.kind] ?? ''
    const prefix = { you: '> ', agent: '', thought: '  ', tool: '  · ', plan: '', note: '  ' }[e.kind] ?? ''
    const suffix = e.kind === 'tool' && e.status ? ` [${e.status}]` : ''
    return el('span', cls, `${prefix}${e.text}${suffix}\n`)
  }

  private drawSidebar(): void {
    const host = this.o.transcriptHost
    host.replaceChildren()

    /* ---- the platform credential ---- */
    if (!this.platform?.set) {
      const g = group('Connect to the platform', { collapsed: false })
      const b = bodyOf(g)
      b.append(el('p', 'note', 'A personal access token, stored on the service and never sent back here. The service mints the tunnel’s one-time token and opens the socket, because a browser cannot send the header the platform wants.'))
      let base = ''
      let token = ''
      const baseField = textField({ label: 'platform', value: '', placeholder: 'https://platform.example.com', onChange: (v) => { base = v.trim(); setFieldError(baseField, null) } })
      const tokField = textField({ label: 'token', value: '', placeholder: 'pat_…', onChange: (v) => { token = v; setFieldError(tokField, null) } })
      const i = tokField.querySelector<HTMLInputElement>('input')
      if (i) { i.type = 'password'; i.autocomplete = 'off' }
      b.append(baseField, tokField, button({
        label: 'Store it',
        icon: 'lock-closed',
        variant: 'primary',
        onClick: () => {
          if (!base) return setFieldError(baseField, 'where is the platform')
          if (!token) return setFieldError(tokField, 'paste the token')
          void api.setAgentCredential({ base, token })
            .then(() => this.render())
            .catch((e) => toast((e as Error).message, 'danger'))
        },
      }))
      host.append(g)
      return
    }

    /* ---- the picker ---- */
    {
      const g = group(`Agents (${this.agents.length})`, {
        collapsed: false,
        actions: [button({ label: 'Refresh', icon: 'arrow-path', onClick: () => void this.reload() })],
      })
      const b = bodyOf(g)
      b.append(readout('platform', this.platform.base ?? '—'))
      if (!this.agents.length) b.append(empty('The platform shows no agent deployments.'))
      for (const a of this.agents) {
        const row = el('button', `row${this.chosen?.name === a.name ? ' on' : ''}`)
        row.append(el('span', 'row-name', a.name), el('span', 'row-note', `${a.phase ?? '?'}${a.namespace ? ` · ${a.namespace}` : ''}`))
        row.onclick = () => void this.connect(a)
        b.append(row)
      }
      host.append(g)
    }

    /* ---- the session ---- */
    {
      const g = group('Session', { collapsed: false })
      const b = bodyOf(g)
      b.append(readout('state', this.detail ? `${this.state} — ${this.detail}` : this.state))
      if (this.session?.sessionId) b.append(readout('id', this.session.sessionId, true))
      b.append(readout('tools', this.o.shell() ? 'the editor’s documents, through the shell' : 'open the Shell tab first'))
      if (!this.o.shell()) {
        // the agent's fs/* and terminal/* go to the shell; without one they fail one at a time and
        // the agent's only symptom is that everything it tries does not work
        b.append(el('p', 'note warn', 'Without the shell running, the agent has no files and no terminal.'))
      }
      host.append(g)
    }

    /* ---- what it can reach ---- */
    {
      const g = group('What it can do', { collapsed: true })
      bodyOf(g).append(el(
        'p',
        'note',
        'Read and write the editor’s documents, and run commands in the browser shell over them. '
        + 'A write is a live edit with no undo, so it asks first — except for a read, which cannot damage anything.',
      ))
      host.append(g)
    }
  }

  private async reload(): Promise<void> {
    this.agents = await api.agentDeployments().then((r) => r.agents).catch((e) => { toast((e as Error).message, 'warn', 5000); return [] })
    this.draw()
  }

  private async connect(a: AgentDeployment): Promise<void> {
    const shell = this.o.shell()
    if (!shell) {
      toast('open the Shell tab first — that is where the agent’s files come from', 'warn', 6000)
      return
    }
    this.session?.close()
    this.chosen = a
    this.entries = []
    this.session = new Session({
      shell,
      onEntry: (e) => {
        // a tool update replaces its own line rather than adding another
        if (e.kind === 'tool' && e.id) {
          const at = this.entries.findIndex((x) => x.kind === 'tool' && x.id === e.id)
          if (at >= 0) {
            this.entries[at] = { ...this.entries[at], ...e, text: e.text || this.entries[at].text }
            this.draw()
            return
          }
        }
        this.entries.push(e)
        this.draw()
      },
      onState: (s, d) => { this.state = s; this.detail = d ?? ''; this.draw() },
      ask: (q) => this.permission(q),
      mcpServers: () => api.agentMcp().then((r) => r.servers).catch(() => []),
    })
    try {
      await this.session.connect({ kind: 'agent', namespace: a.namespace ?? '', name: a.name })
    } catch (e) {
      toast(`could not connect: ${(e as Error).message}`, 'danger', 8000)
    }
  }

  /**
   * The permission dialog.
   *
   * It names the tool and shows what it was given, because "the agent wants to edit a file" is not
   * a question anybody can answer — WHICH file is the whole of it.
   */
  private async permission(q: { title: string; detail: string; options: { id: string; name: string; kind: string }[] }): Promise<string | null> {
    const answer = await ask({
      title: q.title,
      label: q.options.map((o, i) => `${i + 1}. ${o.name}`).join('   '),
      value: '1',
      icon: 'exclamation-triangle',
      placeholder: q.detail.slice(0, 100),
      validate: (v) => (q.options[Number(v) - 1] ? null : `1 to ${q.options.length}`),
    })
    if (answer === null) return null
    return q.options[Number(answer) - 1]?.id ?? null
  }

  stop(): void {
    this.session?.close()
    this.session = null
  }
}
