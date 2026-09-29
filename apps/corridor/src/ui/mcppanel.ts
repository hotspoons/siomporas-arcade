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

  /** The bridge pushes its state here so the pane can say "attached" without polling. */
  onBridge(s: BridgeStatus): void {
    this.status = s
    // Only the one line changes; redrawing the whole pane would eat a click on the token field.
    const dot = this.host.querySelector('.mcp-live')
    if (dot) dot.replaceChildren(...this.liveBits())
  }

  private liveBits(): HTMLElement[] {
    const s = this.status
    const state = s?.state ?? 'off'
    const label =
      state === 'attached' ? `this page is attached — ${s?.tools ?? 0} tools, ${s?.calls ?? 0} calls`
      : state === 'connecting' ? 'connecting…'
      : state === 'retrying' ? (s?.detail ?? 'retrying')
      : state === 'refused' ? (s?.detail ?? 'refused')
      : 'not attached'
    return [el('span', `dot ${state === 'attached' ? 'ok' : state === 'refused' ? 'bad' : 'off'}`), el('span', '', label)]
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
    if (cfg.bridge.attached > 1) {
      b.append(el('p', 'note', `${cfg.bridge.attached} editor pages are attached; a shell or code tool goes to whichever answers first.`))
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
