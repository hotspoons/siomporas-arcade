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
import { Shell, type ExecResult, type ShellFile } from '../../agent/shell'
import { ROOT, type DocSources } from '../../agent/projection'
import { bodyOf, group, readout } from '../../ui/controls'
import { FileTree } from '../program/filetree'
import { button, el } from '../../ui/shell'

export interface ShellPanelOpts {
  host: HTMLElement
  /** the files pane and the saved log go here, beside the terminal */
  sidebarHost: HTMLElement
  /** what exists, for the projection */
  docs: () => Promise<DocSources>
  /** read one projected document's text */
  read: (path: string) => Promise<string | null>
}

const PROMPT = '$ '

export class ShellPanel {
  private readonly o: ShellPanelOpts
  private shell: Shell | null = null
  private out: HTMLElement | null = null
  private input: HTMLInputElement | null = null
  private history: string[] = []
  private at = 0
  private saved: { path: string; what: string; ok: boolean; error?: string }[] = []
  private files: ShellFile[] = []
  private tree: FileTree | null = null
  private booting = false

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

  private async boot(): Promise<void> {
    if (this.booting) return
    this.booting = true
    this.write('starting the shell…\n', 'term-dim')
    this.shell = new Shell({
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
      await this.shell.start(docs, (p) => this.o.read(p))
    } catch (e) {
      this.write(`the shell did not start: ${(e as Error).message}\n`, 'term-bad')
      this.shell = null
    } finally {
      this.booting = false
    }
  }

  private async reboot(): Promise<void> {
    this.shell?.stop()
    this.shell = null
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
