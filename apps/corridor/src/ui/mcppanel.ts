// The MCP section of the Agent tab: the URL, the token, and what an outside agent can reach.
//
// Rich, 2026-09-29: "expose the agent tools through MCP with an optional auth header… autogen an
// access token and let people override it."
//
// WHAT THIS PANE IS FOR, and it is one job: producing the block of JSON that somebody pastes into
// an agent's config. Everything here serves that — the URL is the one the service believes it is
// reachable at, the token is copyable in one click, and the snippet is the finished article rather
// than three fields to assemble by hand. A configuration screen that makes you build the config is
// only half a configuration screen.
//
// THE TOKEN IS SHOWN. That is a deliberate departure from the platform credential above it, which
// is write-only on purpose. This one is different in kind: it is minted here, it authorises only
// this editor, and its entire purpose is to be copied into a file. A token you cannot read is a
// token you must regenerate every time you add a client, and regenerating breaks the clients that
// already have it.
import { api } from '../worldedit/api'
import type { AgentBridge, BridgeStatus } from '../agent/bridge'
import { bodyOf, group, readout } from './controls'
import { button, el, toast } from './shell'

export interface McpConfig {
  url: string
  auth: { required: boolean; source: 'env' | 'file' | 'minted' | 'none'; token: string | null }
  bridge: { attached: number; pages: { id: string; label: string; tools: number }[]; tools: string[] }
}

/** Where the token came from, said in a way that tells you whether you may change it. */
const SOURCE_NOTE: Record<string, string> = {
  env: 'set by WORLDEDITOR_MCP_TOKEN on the service — change it there, not here',
  file: 'kept on the editor’s volume',
  minted: 'generated the first time the service started',
  none: 'no token',
}

export class McpPanel {
  private cfg: McpConfig | null = null
  private status: BridgeStatus | null = null

  private readonly host: HTMLElement
  private readonly bridge: () => AgentBridge | null

  constructor(host: HTMLElement, bridge: () => AgentBridge | null) {
    this.host = host
    this.bridge = bridge
  }

  async load(): Promise<void> {
    this.cfg = await api.mcpConfig().catch(() => null)
    this.draw()
  }

  /** Ask the service to move the MCP connection to this window. */
  private claim(): boolean {
    return this.bridge()?.claim() ?? false
  }

  /** The bridge pushes its state here so the pane can say "attached" without polling. */
  onBridge(s: BridgeStatus): void {
    const was = this.status?.own?.mine
    this.status = s
    // OWNERSHIP CHANGING REDRAWS, because the Take button has to appear and disappear with it.
    // The live line updates in place for everything else; this is the one change that alters which
    // controls exist.
    if (was !== undefined && was !== s.own?.mine) {
      if (!s.own?.mine) toast(`${s.own?.owner?.name ?? 'another window'} took the MCP connection`, 'warn', 6000)
      /*
       * ONLY ONCE THERE IS A CONFIG TO DRAW. `draw()` replaces the host and returns early when
       * `cfg` is null — "The service did not answer about MCP" — and nothing draws again after
       * that. The bridge reports ownership as soon as the socket opens, which can beat
       * `load()`'s fetch, so redrawing unconditionally replaced a perfectly good panel with that
       * message and left it there. `load()` draws when it lands, with the ownership already in
       * `this.status`.
       */
      if (this.cfg) this.draw()
      return
    }
    // Only the one line changes; redrawing the whole pane would eat a click on the token field.
    const dot = this.host.querySelector('.mcp-live')
    if (dot) dot.replaceChildren(...this.liveBits())
  }

  private liveBits(): HTMLElement[] {
    const s = this.status
    const state = s?.state ?? 'off'
    const own = s?.own
    const label =
      // WHICH WINDOW THIS IS, once the service has named it. Two editors open used to be
      // indistinguishable from one, and the browser tools went to whichever attached first.
      state === 'attached' && own?.me
        ? own.mine
          ? `${own.me.name} — this window has the MCP connection · ${s?.tools ?? 0} tools, ${s?.calls ?? 0} calls`
          : `${own.me.name} — attached, but ${own.owner?.name ?? 'another window'} has the MCP connection`
      : state === 'attached' ? `this page is attached — ${s?.tools ?? 0} tools, ${s?.calls ?? 0} calls`
      : state === 'connecting' ? 'connecting…'
      : state === 'retrying' ? (s?.detail ?? 'retrying')
      : state === 'refused' ? (s?.detail ?? 'refused')
      : 'not attached'
    // amber, not green, when this window is attached but somebody else answers the tools: it is
    // working and it is not the one an agent is talking to, and those are different things
    const tone = state === 'refused' ? 'bad'
      : state !== 'attached' ? 'off'
      : own && !own.mine ? 'warn'
      : 'ok'
    return [el('span', `dot ${tone}`), el('span', '', label)]
  }

  draw(): void {
    this.host.replaceChildren()
    const cfg = this.cfg
    if (!cfg) {
      this.host.append(el('p', 'note', 'The service did not answer about MCP. It may be an older build.'))
      return
    }

    const g = group('MCP — this editor as tools', { collapsed: false })
    const b = bodyOf(g)

    b.append(
      el(
        'p',
        'note',
        'An outside agent — Claude Code, or anything that speaks MCP — can drive this editor through one URL: '
        + 'the worlds, the levels, the programs, the asset catalog, the bakes and the splat runs. '
        + 'The shell and the TypeScript service need a page attached, because they run in one.',
      ),
    )

    b.append(readout('URL', cfg.url, true))
    b.append(readout('Auth', cfg.auth.required ? 'required' : 'off — anyone who can reach the URL can drive the editor', false))

    /* ---- the token ---- */
    const tokenRow = el('div', 'mcp-token')
    const input = el('input', 'input wide')
    input.type = 'text'
    input.value = cfg.auth.token ?? ''
    input.spellcheck = false
    input.readOnly = cfg.auth.source === 'env'
    tokenRow.append(input)
    tokenRow.append(
      button({
        icon: 'link',
        title: 'copy the token',
        onClick: () => {
          void navigator.clipboard?.writeText(input.value).then(
            () => toast('token copied', 'ok'),
            () => toast('the clipboard is blocked — select it and copy', 'warn'),
          )
        },
      }),
    )
    b.append(el('label', 'field-label', 'Token'), tokenRow, el('p', 'note', SOURCE_NOTE[cfg.auth.source] ?? ''))

    if (cfg.auth.source !== 'env') {
      const row = el('div', 'asset-row-actions')
      row.append(
        button({
          label: 'Save this token',
          icon: 'check',
          title: 'use the value in the box — paste your own to override the generated one',
          onClick: () => void this.save(input.value),
        }),
        button({
          label: 'Regenerate',
          icon: 'arrow-path',
          variant: 'danger',
          // The consequence is the whole point of the confirm: this is not undoable and it is not
          // local — every config that already has the old token stops working at once.
          title: 'mint a new token; every agent configured with the old one stops working',
          onClick: () => void this.regenerate(),
        }),
      )
      b.append(row)
    }

    /* ---- the block somebody pastes ---- */
    const snippet = JSON.stringify(
      {
        mcpServers: {
          'corridor-world-editor': {
            type: 'http',
            url: cfg.url,
            ...(cfg.auth.required ? { headers: { Authorization: `Bearer ${input.value}` } } : {}),
          },
        },
      },
      null,
      2,
    )
    const pre = el('pre', 'mcp-snippet')
    pre.textContent = snippet
    b.append(el('label', 'field-label', 'Client configuration'), pre)
    b.append(
      button({
        label: 'Copy configuration',
        icon: 'document-arrow-down',
        onClick: () => {
          void navigator.clipboard?.writeText(snippet).then(
            () => toast('configuration copied — paste it into the agent’s mcp config', 'ok'),
            () => toast('the clipboard is blocked — select the block and copy', 'warn'),
          )
        },
      }),
    )

    /* ---- what is attached ---- */
    const live = el('div', 'mcp-live')
    live.append(...this.liveBits())
    b.append(el('label', 'field-label', 'This page'), live)
    /*
     * TAKING IT. Rich, 2026-09-29: "on other tabs or windows connected to the same back end we
     * offer the option to take the MCP connection and disconnect from the other one."
     *
     * No asking the current owner: the case this exists for is a window nobody is watching holding
     * the connection, and a prompt there would never be answered. The window that loses it says so
     * immediately, which is the honest half of that trade.
     */
    const own = this.status?.own
    if (own && !own.mine && own.owner) {
      b.append(button({
        label: `Take the connection from ${own.owner.name}`,
        icon: 'arrow-top-right-on-square',
        variant: 'primary',
        onClick: () => {
          if (this.claim()) toast(`${own.me?.name ?? 'this window'} now has the MCP connection`, 'ok')
          else toast('this window is not attached yet', 'warn')
        },
      }))
    }
    if (own && own.others.length) {
      b.append(el('p', 'note', `Also attached: ${own.others.map((o) => o.name).join(', ')}. Browser tools — the shell and the TypeScript service — run only in the window that has the connection.`))
    }

    this.host.append(g)
  }

  private async save(token: string): Promise<void> {
    try {
      const r = await api.setMcpToken(token.trim())
      this.cfg = { ...(this.cfg as McpConfig), url: r.url, auth: r.auth }
      this.draw()
      toast('token saved — reconnecting this page', 'ok')
      this.bridge()?.stop()
      this.bridge()?.start()
    } catch (e) {
      toast((e as Error).message, 'warn', 6000)
    }
  }

  private async regenerate(): Promise<void> {
    // Empty string means "mint a fresh one" to the service, which is the same path as the override.
    await this.save('')
  }
}
