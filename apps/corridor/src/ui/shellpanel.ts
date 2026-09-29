// A prompt in the editor, over the editor's own documents.
//
// Rich, 2026-09-28: "a lightweight shell that runs in the browser itself and has virtual access to
// the workspace projected into the phony busybox shell."
//
// WHY A PROMPT AND NOT MORE FORMS. There are already forms for a world, a level, a program and a
// preset, and there will be forms for everything else; what there is no form for is "which levels
// name a world that is not baked", "rename this preset everywhere", "what changed in these six
// documents". A shell answers all three with `grep`, `sed` and `diff`, and it is the same surface
// an agent drives — so the answer to "how does the agent edit things" and "how do I edit six things
// at once" is one thing rather than two.
//
// IT SAYS WHAT IT SAVED. Every write that lands on a document is reported by name, because saving
// is immediate and there is no undo: `sed -i` over worlds/ is a real edit to every world, and a
// person needs to see which ones the moment it happens rather than find out later.
import { Shell, type ExecResult, type ShellFile } from '../agent/shell'
import { ROOT, type DocSources } from '../agent/projection'
import { bodyOf, group, readout } from './controls'
import { FileTree } from './filetree'
import { button, el } from './shell'

export interface ShellPanelOpts {
  host: HTMLElement
  /** the files pane and the saved log go here, beside the terminal */
  sidebarHost: HTMLElement
  /** what exists, for the projection */
  docs: () => Promise<DocSources>
  /** read one projected document's text */
  read: (path: string) => Promise<string | null>
  /**
   * Is the Shell the pane on screen right now?
   *
   * The agent can start this machine without anybody opening the tab (`ensureMachine`), and the
   * sidebar it draws lives in the SHARED inspector — so drawing it while somebody is looking at
   * the Agent tab would wipe the panel they are using. Absent means "assume visible", which is the
   * behaviour every existing caller already had.
   */
  visible?: () => boolean
}

const PROMPT = '$ '

export class ShellPanel {
  private readonly o: ShellPanelOpts
  private shell: Shell | null = null
  /** the in-flight boot, shared by every concurrent caller */
  private booting: Promise<void> | null = null
  /** why the last boot failed, so ensureMachine can say rather than return null */
  private bootError: string | null = null
  private out: HTMLElement | null = null
  private input: HTMLInputElement | null = null
  private history: string[] = []
  private at = 0
  private saved: { path: string; what: string; ok: boolean; error?: string }[] = []
  private files: ShellFile[] = []
  private tree: FileTree | null = null

  constructor(o: ShellPanelOpts) {
    this.o = o
  }

  async render(): Promise<void> {
    const host = this.o.host
    host.replaceChildren()

    const bar = el('div', 'panel-bar')
    bar.append(el('span', 'panel-title', 'Shell'))
    const acts = el('div', 'panel-bar-actions')
    acts.append(
      button({ label: 'Reproject', icon: 'arrow-path', title: 'read the documents again and restart the shell', onClick: () => void this.reboot() }),
      button({ label: 'Clear', icon: 'x-mark', variant: 'ghost', onClick: () => { if (this.out) this.out.textContent = '' } }),
    )
    bar.append(acts)
    host.append(bar)

    const term = el('div', 'term')
    this.out = el('pre', 'term-out')
    const line = el('div', 'term-line')
    line.append(el('span', 'term-prompt', PROMPT))
    this.input = el('input', 'term-input')
    this.input.spellcheck = false
    this.input.autocapitalize = 'off'
    this.input.autocomplete = 'off'
    this.input.placeholder = 'ls worlds/'
    this.input.onkeydown = (e) => this.onKey(e)
    line.append(this.input)
    term.append(this.out, line)
    host.append(term)

    this.drawSidebar()
    if (!this.shell) await this.boot()
    this.input.focus()
  }

  private write(text: string, cls = ''): void {
    if (!this.out) return
    const span = el('span', cls, text)
    this.out.append(span)
    this.out.scrollTop = this.out.scrollHeight
  }

  /**
   * Start the machine if it is not running, and resolve when it is usable.
   *
   * WHY THIS IS PUBLIC. `shell_exec` over MCP used to refuse with "open the Shell tab once, then
   * try again" — which asks a human to click something before an agent can run a command, in a
   * surface whose whole point is that the agent works on its own. The machine is a Worker; there
   * is no reason a person has to have looked at it first.
   *
   * Idempotent and safe to call concurrently: several tool calls arriving together await one boot
   * rather than racing three Workers into existence.
   */
  async ensureMachine(): Promise<Shell> {
    // An IN-FLIGHT boot must be awaited before trusting `this.shell`. Returning early here was a
    // race the pre-warm made certain: the machine object exists from the moment boot starts, but
    // its Worker does not exist until start() resolves, so an exec against it died on
    // `postMessage` of null.
    if (this.booting) await this.booting
    if (this.shell) return this.shell
    await this.boot()
    if (!this.shell) throw new Error(this.bootError ?? 'the shell did not start')
    return this.shell
  }

  private async boot(): Promise<void> {
    // The in-flight boot, so concurrent callers wait for it rather than starting another. The old
    // `if (this.booting) return` returned IMMEDIATELY — a second caller got no shell and no error.
    if (this.booting) return this.booting
    this.booting = this.doBoot().finally(() => { this.booting = null })
    return this.booting
  }

  private async doBoot(): Promise<void> {
    this.bootError = null
    this.write('starting the shell…\n', 'term-dim')
    /*
     * BUILT INTO A LOCAL, published only once it has started. `this.shell` used to be assigned
     * here, which meant it was non-null for the whole of the projection read — and anything that
     * grabbed it in that window got a machine with no Worker behind it.
     */
    const shell = new Shell({
      onReady: (motd) => this.write(`${motd}\n\n`, 'term-dim'),
      onStatus: (t) => this.write(`${t}\n`, 'term-dim'),
      onFiles: (f) => { this.files = f; this.drawSidebar() },
      onSaved: (s) => {
        this.saved.unshift(s)
        this.saved = this.saved.slice(0, 40)
        // named in the terminal as well as the sidebar: the thing a person is looking at is the
        // terminal, and a save they did not intend has to interrupt them there
        this.write(`saved ${s.what}${s.ok ? '' : ` — FAILED: ${s.error}`}\n`, s.ok ? 'term-ok' : 'term-bad')
        this.drawSidebar()
      },
    })
    try {
      const docs = await this.o.docs()
      await shell.start(docs, (p) => this.o.read(p))
      this.shell = shell
    } catch (e) {
      this.bootError = `the shell did not start: ${(e as Error).message}`
      this.write(`${this.bootError}\n`, 'term-bad')
      shell.stop()
      this.shell = null
    }
  }

  private async reboot(): Promise<void> {
    this.shell?.stop()
    this.shell = null
    // a reboot wants a NEW machine with freshly read documents, not whichever boot is in flight
    this.booting = null
    this.saved = []
    if (this.out) this.out.textContent = ''
    await this.boot()
    this.input?.focus()
  }

  private onKey(e: KeyboardEvent): void {
    const input = this.input!
    if (e.key === 'Enter') {
      const cmd = input.value
      input.value = ''
      if (cmd.trim()) {
        this.history.push(cmd)
        this.at = this.history.length
      }
      void this.run(cmd)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!this.history.length) return
      this.at = Math.max(0, this.at - 1)
      input.value = this.history[this.at] ?? ''
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      this.at = Math.min(this.history.length, this.at + 1)
      input.value = this.history[this.at] ?? ''
      return
    }
    // the editor's own shortcuts must not fire while somebody is typing a command
    e.stopPropagation()
  }

  private async run(cmd: string): Promise<void> {
    const shell = this.shell
    const here = (shell?.cwd ?? ROOT).replace(ROOT, '~')
    this.write(`${here} ${PROMPT}${cmd}\n`, 'term-echo')
    if (!cmd.trim()) return
    if (!shell) { this.write('the shell is not running\n', 'term-bad'); return }
    const r: ExecResult = await shell.exec(cmd)
    if (r.stdout) this.write(r.stdout)
    if (r.stderr) this.write(r.stderr, 'term-bad')
    if (r.exitCode) this.write(`exit ${r.exitCode}\n`, 'term-dim')
  }

  private drawSidebar(): void {
    // Booting for the agent must not redraw a sidebar somebody else is using; the tree is rebuilt
    // from `this.files` when the tab is next opened anyway.
    if (this.o.visible && !this.o.visible()) return
    const host = this.o.sidebarHost
    host.replaceChildren()

    /*
     * THE PROJECTION, AS A TREE.
     *
     * It was a flat list of absolute paths cut off at sixty rows — which for a volume with a few
     * worlds on it is a file browser that silently omits most of the machine, and every row was
     * the same forty characters of `/workspace/…` prefix before the part that differs. The
     * projection is already `worlds/`, `levels/`, `programs/`, `sites/`, `out/`: it IS a tree, and
     * ui/filetree.ts is the same control the program editor uses (Rich, 2026-09-28: "make a folder
     * control we can use for both the program editor and the shell").
     */
    const g = group(`Files (${this.files.length})`, { collapsed: false })
    this.tree ??= new FileTree({
      storageKey: 'shell',
      empty: 'nothing projected yet',
      files: () => this.files.map((f) => ({ path: f.path.replace(`${ROOT}/`, ''), note: `${f.size} B` })),
      // a click writes the command rather than running it: this is a shell, and what you want to
      // do with the file you just found is usually not `cat`
      onOpen: (p) => { if (this.input) { this.input.value = `cat ${p}`; this.input.focus() } },
      actions: (p) => [
        { icon: 'eye', title: `cat ${p}`, onClick: () => void this.run(`cat ${p}`) },
        { icon: 'pencil-square', title: `put the path in the prompt`, onClick: () => { if (this.input) { this.input.value += (this.input.value ? ' ' : '') + p; this.input.focus() } } },
      ],
    })
    this.tree.render()
    bodyOf(g).append(this.tree.root)
    host.append(g)

    if (this.saved.length) {
      const s = group(`Saved (${this.saved.length})`, { collapsed: false })
      const sb = bodyOf(s)
      for (const x of this.saved) sb.append(readout(x.ok ? 'saved' : 'failed', `${x.what}${x.error ? ` — ${x.error}` : ''}`))
      host.append(s)
    }

    const help = group('What is in here', { collapsed: true })
    bodyOf(help).append(el(
      'p',
      'note',
      'coreutils, python and js over the editor’s documents. No network. Writing worlds/, levels/, programs/ '
      + 'or sites/ saves that document immediately; out/ is yours.',
    ))
    host.append(help)
  }

  /** For probes, and for the agent: the live shell. */
  get machine(): Shell | null {
    return this.shell
  }

  stop(): void {
    this.shell?.stop()
    this.shell = null
  }
}
