// Writing a level's program, with the types and the toolkit that make that bearable.
//
// Rich, 2026-09-28: "any chance we can pull in a Monaco editor or something like that to improve
// the ux for humans typing? Would be great to have a tool kit to test types and verify everything
// builds and all that too."
//
// FOUR THINGS, and they answer four different questions:
//
//   the editor    what am I writing        Monaco, with the real generated declarations
//   Check         does it typecheck        the same TS service the squiggles come from
//   Build         does it compile          the emit — the JavaScript the viewer will run
//   Dry run       does it actually work    the module loaded and stepped against a stub host
//
// THE LAST ONE IS THE POINT. "It compiles" is a weak claim about a program: `api.hide('minimap')`
// and `api.hide('mnimap')` both compile in JavaScript, and a `setup` that throws on its first line
// compiles perfectly. The dry run loads the emitted module, starts a GameRun against a host with
// no renderer behind it, steps it for a few simulated seconds, and reports what happened — the
// zones declared, the goal set, the messages said, the outcome, and the throw if there was one.
// That is the difference between "the compiler is happy" and "this is a level".
import { CodeEditor, type Diagnostic } from './codeeditor'
import * as programApi from '../program'
import * as actorsApi from '../actors'
import * as actorworldApi from '../actorworld'
import * as ecsconfigApi from '../ecsconfig'
import * as trafficApi from '../traffic'
import { GameRun, type GameDef, type ProgramHost, type Transport } from '../program'
import { ActorWorld } from '../actorworld'
import { bodyOf, group, readout } from './controls'
import { FileTree } from './filetree'
import { ask, button, confirm, el, toast } from './shell'

/** What a new program starts as: the shortest thing that is a real level. */
export const TEMPLATE = `import { defineGame } from '@apex/program'

export default defineGame({
  setup(api) {
    api.goal('Reach the water tower')
    api.hide('street-names')
    api.zone('tower', { kind: 'circle', x: 0, y: 0, r: 20 })
    api.on('enters', 'tower', () => {
      api.award(100)
      api.win('Found it')
    })
    api.after(120, () => api.lose('Out of time'))
  },
})
`

export interface ProgramPanelOpts {
  /** the wide pane the editor lives in */
  host: HTMLElement
  /**
   * Where the diagnostics and the dry-run report go — the docked inspector, beside the editor.
   *
   * Beside and not below: a list of problems under a code editor is a list you scroll the editor
   * away to read, and the whole value of a diagnostic is being able to see it and the line it is
   * about at the same time.
   */
  reportHost: HTMLElement
  /** every program on the volume */
  list: () => Promise<{ id: string; bytes: number; modified: string | null }[]>
  load: (id: string) => Promise<string | null>
  save: (id: string, source: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** rename or move one; the tree offers it only when a caller can do it */
  move?: (id: string, to: string) => Promise<void>
  /** redraw, after the list changed */
  refresh: () => void
}

/** What a dry run found out. Every field is something a person would otherwise have to play for. */
export interface DryRun {
  ok: boolean
  /** the throw, if the program stopped */
  error: string | null
  goal: string
  zones: string[]
  hidden: string[]
  transport: Transport | null
  presets: string[]
  messages: string[]
  score: number
  outcome: string | null
  /** simulated seconds stepped */
  played: number
}

/**
 * Load the emitted JavaScript and play it against a host with nothing behind it.
 *
 * A BLOB MODULE, so it is a real ES module with real `import` semantics rather than `eval` — a
 * program's `import { defineGame } from '@apex/program'` has to resolve, and it resolves to the
 * app's own module because that is what a level will run against. The import map is done by
 * rewriting the specifier, which is crude and is exactly right here: there is one module to
 * resolve and shipping an import-map polyfill to resolve it would be the larger mistake.
 */
export async function dryRun(js: string, { seconds = 5, step = 0.05 }: { seconds?: number; step?: number } = {}): Promise<DryRun> {
  const state = {
    hidden: new Set<string>(),
    transport: null as Transport | null,
    presets: [] as string[],
    said: [] as string[],
  }
  const actors = new ActorWorld()
  const host: ProgramHost = {
    actors,
    hide: (what, hidden) => { if (hidden) state.hidden.add(what); else state.hidden.delete(what) },
    transport: (m) => { state.transport = m },
    preset: (id) => { state.presets.push(typeof id === 'string' ? id : '(inline)') },
    say: (t) => { state.said.push(t) },
    // the stub player sits at the origin and does not move: a dry run is about whether the program
    // RUNS, and a program whose only path to a win is the player driving somewhere is correctly
    // reported as "no outcome in five seconds" rather than made to pass by a fake drive
    playerAt: () => ({ x: 0, y: 0, z: 0 }),
    playerSpeed: () => 0,
    setTime: () => {},
    setWeather: () => {},
  }

  const blob = URL.createObjectURL(new Blob([rewriteImports(js)], { type: 'text/javascript' }))
  const base: DryRun = {
    ok: false, error: null, goal: '', zones: [], hidden: [], transport: null, presets: [], messages: [],
    score: 0, outcome: null, played: 0,
  }
  try {
    const mod = (await import(/* @vite-ignore */ blob)) as { default?: GameDef }
    const def = mod.default
    if (!def || typeof def !== 'object') {
      return { ...base, error: 'the program has no default export — it should end with `export default defineGame({ ... })`' }
    }
    const run = new GameRun(host, def)
    const started = await run.start()
    let played = 0
    if (started) {
      for (let t = 0; t < seconds - 1e-9 && !run.outcome && !run.error; t += step) {
        run.tick(step)
        played = t + step
      }
    }
    return {
      ok: !run.error,
      error: run.error,
      goal: run.goalText,
      zones: run.zoneNames,
      hidden: [...state.hidden],
      transport: state.transport,
      presets: state.presets,
      messages: run.messages.map((m) => m.text),
      score: run.score,
      outcome: run.outcome,
      played: +played.toFixed(2),
    }
  } catch (e) {
    return { ...base, error: String((e as Error)?.message ?? e) }
  } finally {
    URL.revokeObjectURL(blob)
  }
}

/**
 * The modules a program may import, at runtime.
 *
 * The same five the type bundle declares (scripts/gen-program-types.mjs), so what the editor lets
 * you import and what the dry run can resolve are the same list.
 */
const MODULES: Record<string, Record<string, unknown>> = {
  '@apex/program': programApi as unknown as Record<string, unknown>,
  '@apex/actors': actorsApi as unknown as Record<string, unknown>,
  '@apex/actorworld': actorworldApi as unknown as Record<string, unknown>,
  '@apex/ecsconfig': ecsconfigApi as unknown as Record<string, unknown>,
  '@apex/traffic': trafficApi as unknown as Record<string, unknown>,
}

/** A blob module per specifier, made once and kept: creating one per run leaks a URL per run. */
const shims = new Map<string, string>()

/**
 * A URL that resolves `@apex/program` to the app's own live module.
 *
 * NOT a path like `/src/program.ts`. That works in dev, where Vite serves the sources, and is a
 * 404 in a production build where everything is bundled and hashed — which is the worst shape of
 * bug, because the feature is only ever exercised in dev until somebody uses it in the cluster.
 *
 * So the app hands the module over BY VALUE through a global, and the shim re-exports its keys.
 * The export list comes from the real module object, so it cannot drift from what the module
 * actually exports.
 */
function shimFor(name: string): string | null {
  const mod = MODULES[name]
  if (!mod) return null
  const cached = shims.get(name)
  if (cached) return cached
  const g = globalThis as unknown as { __APEX_PROGRAM_MODULES?: typeof MODULES }
  g.__APEX_PROGRAM_MODULES ??= MODULES
  const keys = Object.keys(mod).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k))
  const src = [
    `const m = globalThis.__APEX_PROGRAM_MODULES[${JSON.stringify(name)}];`,
    ...keys.map((k) => `export const ${k} = m[${JSON.stringify(k)}];`),
  ].join('\n')
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
  shims.set(name, url)
  return url
}

/** Point every `@apex/…` import at its shim. */
function rewriteImports(js: string): string {
  return js.replace(/(['"])(@apex\/[a-z]+)\1/g, (m, q, name) => {
    const url = shimFor(name)
    return url ? `${q}${url}${q}` : m
  })
}

/* ---- the panel ---------------------------------------------------------------------------- */
/*
 * ONE PANEL, MANY FILES.
 *
 * Rich, 2026-09-28: "How are you supposed to manage multiple files in the editor, there is no
 * folders and no file system and no tabs", and "it does not store state and what ever was typed
 * is wiped when you move away."
 *
 * Both of those are the same mistake. The panel rebuilt itself from the server on every render —
 * one file, no tabs, and `render()` meaning "throw away the editor and fetch the source again",
 * which is a destructive operation bound to a tab click. What is here instead:
 *
 *   A TREE, from ui/filetree.ts, over ids that are now paths (see store.mjs `#programFile`).
 *   TABS, one per open file, each with its own Monaco editor that is created once and kept.
 *   DRAFTS, written to localStorage as you type and restored on the way back.
 *
 * The draft is the part that matters. Everything else can be rebuilt from the service; the two
 * minutes of typing that have not been saved yet cannot, and they were being discarded by a
 * click on another tab, by a page refresh, and by the browser being closed. They now survive all
 * three, and the file is still not saved until somebody presses Save — an editor that writes to
 * the volume as you type is a different and much worse promise.
 */

/** Where an unsaved buffer lives between visits. One key per path, so a stale one is orphaned. */
const DRAFT = (path: string) => `apex-program-draft.${path}`
/** Which files were open, and which was on top. */
const TABS = 'apex-program-tabs.v1'

interface Open {
  path: string
  editor: CodeEditor
  host: HTMLElement
  /** the source as the service has it, so "dirty" is a comparison and not a flag that drifts */
  saved: string
}

export class ProgramPanel {
  private readonly o: ProgramPanelOpts
  private open = new Map<string, Open>()
  private active: string | null = null
  private files: { id: string; bytes: number; modified: string | null }[] = []
  private diagnostics: Diagnostic[] = []
  private last: DryRun | null = null
  private tree: FileTree | null = null
  /** built once and kept in the host; see the note above about what `render` must not destroy */
  private root: HTMLElement | null = null
  private tabsRow = el('div', 'code-tabs')
  private stack = el('div', 'code-stack')
  private restored = false

  constructor(o: ProgramPanelOpts) {
    this.o = o
  }

  /* ---- the chrome ---------------------------------------------------------------------------- */

  private build(): HTMLElement {
    if (this.root) return this.root
    const root = el('div', 'code-root')
    const bar = el('div', 'panel-bar')
    bar.append(this.tabsRow)
    const actions = el('div', 'panel-bar-actions')
    actions.append(
      button({ label: 'Check', icon: 'check', title: 'typecheck it, against the real API declarations', onClick: () => void this.check() }),
      button({ label: 'Dry run', icon: 'beaker', title: 'compile it, load it and play five seconds of it against a stub world', onClick: () => void this.dry() }),
      button({ label: 'Save', icon: 'document-arrow-down', variant: 'primary', key: '⌘S', onClick: () => void this.save() }),
    )
    bar.append(actions)
    root.append(bar, this.stack)
    this.root = root

    // Save with the keyboard, because this is a code editor and the muscle is already there.
    root.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        void this.save()
      }
    })
    return root
  }

  async render(): Promise<void> {
    const host = this.o.host
    const root = this.build()
    // appended, NOT replaced: the editors live in here and a rebuild would dispose a tab's
    // undo history and its scroll position along with its DOM
    if (root.parentElement !== host) host.append(root)

    this.files = await this.o.list().catch(() => [])
    if (!this.restored) {
      this.restored = true
      await this.reopenLast()
    }
    this.drawTabs()
    this.drawReport()
  }

  /** Put back the tabs that were open before the page was reloaded. */
  private async reopenLast(): Promise<void> {
    let want: { open?: string[]; active?: string } | null = null
    try { want = JSON.parse(localStorage.getItem(TABS) ?? 'null') } catch { /* fresh browser */ }
    const exists = new Set(this.files.map((f) => f.id))
    for (const p of want?.open ?? []) if (exists.has(p)) await this.openFile(p, false)
    if (want?.active && this.open.has(want.active)) this.show(want.active)
    else if (this.open.size) this.show([...this.open.keys()][0])
  }

  private rememberTabs(): void {
    try { localStorage.setItem(TABS, JSON.stringify({ open: [...this.open.keys()], active: this.active })) } catch { /* private window */ }
  }

  /* ---- tabs ---------------------------------------------------------------------------------- */

  private drawTabs(): void {
    this.tabsRow.replaceChildren()
    if (!this.open.size) {
      this.tabsRow.append(el('span', 'panel-title', 'Program'))
      return
    }
    for (const [path, o] of this.open) {
      const tab = el('div', `code-tab${path === this.active ? ' on' : ''}`)
      const pick = el('button', 'code-tab-name')
      pick.append(el('span', '', path.split('/').pop() ?? path))
      if (this.isDirty(o)) pick.append(el('span', 'tree-mark', '•'))
      pick.title = path
      pick.onclick = () => this.show(path)
      const shut = button({ icon: 'x-mark', variant: 'ghost', title: `close ${path}`, onClick: () => this.closeTab(path) })
      shut.classList.add('code-tab-x')
      tab.append(pick, shut)
      this.tabsRow.append(tab)
    }
  }

  private isDirty(o: Open): boolean {
    return o.editor.value() !== o.saved
  }

  /** Which editor is on screen. The others stay built, with their undo history and their scroll. */
  private show(path: string): void {
    this.active = path
    for (const [p, o] of this.open) o.host.hidden = p !== path
    this.drawTabs()
    this.rememberTabs()
    this.exposeForProbes()
    this.diagnostics = []
    this.last = null
    this.drawReport()
    void this.check()
  }

  private closeTab(path: string): void {
    const o = this.open.get(path)
    if (!o) return
    // NO CONFIRMATION, because nothing is lost: the draft is on disk and reopening the file
    // brings it back with the dot still on it. A dialog here would be asking permission to do
    // something that does not happen.
    o.editor.dispose()
    o.host.remove()
    this.open.delete(path)
    if (this.active === path) {
      const next = [...this.open.keys()].pop() ?? null
      this.active = next
      if (next) this.show(next)
      else { this.drawTabs(); this.drawReport() }
    } else this.drawTabs()
    this.rememberTabs()
  }

  /* ---- opening ------------------------------------------------------------------------------- */

  /**
   * Open a file into a tab, restoring whatever was typed into it last time.
   *
   * A DRAFT WINS OVER THE SERVER, and that is the whole point of having one: a person who typed
   * something and navigated away expects to find it, and the saved copy is one keystroke away
   * through undo. It is announced, because silently showing something other than what the volume
   * holds is how two people edit different files with the same name.
   */
  async openFile(path: string, focus = true): Promise<void> {
    const already = this.open.get(path)
    if (already) { if (focus) this.show(path); return }

    const saved = (await this.o.load(path)) ?? TEMPLATE
    let value = saved
    let draft: string | null = null
    try { draft = localStorage.getItem(DRAFT(path)) } catch { /* private window */ }
    if (draft !== null && draft !== saved) value = draft

    const host = el('div', 'code-host')
    host.dataset.path = path
    this.stack.append(host)
    const editor = new CodeEditor({
      host,
      path: `programs/${path}.ts`,
      value,
      onChange: () => this.onEdited(path),
    })
    const o: Open = { path, editor, host, saved }
    this.open.set(path, o)
    await editor.whenReady()
    if (focus) this.show(path)
    else host.hidden = true
    this.drawTabs()
    this.rememberTabs()
    if (draft !== null && draft !== saved) toast(`${path}: restored what you had typed but not saved`, 'info', 5000)
  }

  /**
   * Somebody typed. Keep the draft, and keep it cheap.
   *
   * Debounced, because this runs on every keystroke and `localStorage` is synchronous — writing a
   * 40 kB program to disk on each character is a stutter you can feel. Half a second is short
   * enough that closing the tab immediately after a keystroke still keeps it.
   */
  private drafts = new Map<string, ReturnType<typeof setTimeout>>()
  private onEdited(path: string): void {
    const o = this.open.get(path)
    if (!o) return
    clearTimeout(this.drafts.get(path))
    this.drafts.set(path, setTimeout(() => {
      try {
        if (this.isDirty(o)) localStorage.setItem(DRAFT(path), o.editor.value())
        else localStorage.removeItem(DRAFT(path))
      } catch { /* private window: the tab still works, the draft is simply not kept */ }
    }, 500))
    this.drawTabs()
    if (this.tree) this.tree.render()
  }

  /* ---- the tree, in the inspector ------------------------------------------------------------- */

  private drawReport(): void {
    const r = this.o.reportHost
    r.replaceChildren()

    const g = group(`Files (${this.files.length})`, {
      collapsed: false,
      actions: [
        button({ icon: 'document-plus', title: 'new program', variant: 'ghost', onClick: () => void this.create('') }),
      ],
    })
    this.tree ??= new FileTree({
      storageKey: 'programs',
      empty: 'No programs yet.',
      files: () => this.files.map((f) => ({
        path: `${f.id}.ts`,
        note: `${(f.bytes / 1024).toFixed(1)} kB`,
        mark: this.isDirtyPath(f.id) ? '•' : undefined,
      })),
      selected: () => (this.active ? `${this.active}.ts` : null),
      onOpen: (p) => void this.openFile(p.replace(/\.ts$/, '')),
      folderActions: (dir) => [{ icon: 'document-plus', title: `new program in ${dir}`, onClick: () => void this.create(`${dir}/`) }],
      actions: (p) => [
        { icon: 'pencil-square', title: 'rename or move', onClick: () => void this.rename(p.replace(/\.ts$/, '')) },
        { icon: 'trash', title: 'delete', danger: true, onClick: () => void this.del(p.replace(/\.ts$/, '')) },
      ],
    })
    this.tree.render()
    bodyOf(g).append(this.tree.root)
    r.append(g)

    if (!this.open.size) {
      r.append(el('p', 'note', 'Open a file, or make one.'))
      return
    }

    if (this.diagnostics.length) {
      const d = group(`${this.diagnostics.length} problem${this.diagnostics.length === 1 ? '' : 's'}`, { collapsed: false })
      const b = bodyOf(d)
      for (const x of this.diagnostics) {
        const row = el('button', `row diag ${x.severity}`)
        row.append(el('span', 'row-name', `${x.line}:${x.column}`), el('span', 'row-note', x.message))
        row.onclick = () => this.editor()?.reveal(x.line, x.column)
        b.append(row)
      }
      r.append(d)
    } else {
      r.append(el('p', 'note ok', 'No type errors.'))
    }

    if (this.last) {
      const d = this.last
      const g2 = group(d.ok ? 'Dry run' : 'Dry run failed', { collapsed: false })
      const b = bodyOf(g2)
      if (d.error) b.append(el('p', 'note warn', d.error))
      b.append(readout('played', `${d.played} s`))
      if (d.goal) b.append(readout('goal', d.goal))
      b.append(readout('outcome', d.outcome ?? 'still running'))
      b.append(readout('score', String(d.score)))
      if (d.zones.length) b.append(readout('zones', d.zones.join(', ')))
      if (d.hidden.length) b.append(readout('hidden', d.hidden.join(', ')))
      if (d.transport) b.append(readout('transport', d.transport))
      if (d.presets.length) b.append(readout('presets', d.presets.join(', ')))
      for (const m of d.messages) b.append(el('p', 'note', `said: ${m}`))
      r.append(g2)
    }
  }

  private isDirtyPath(id: string): boolean {
    const o = this.open.get(id)
    return !!o && this.isDirty(o)
  }

  private editor(): CodeEditor | null {
    return this.active ? this.open.get(this.active)?.editor ?? null : null
  }

  /* ---- the toolkit ---------------------------------------------------------------------------- */

  private exposeForProbes(): void {
    // for probes and the console, the way the viewer exposes its knobs. The toolkit is three
    // asynchronous services behind an editor, and every one of them fails by doing nothing
    // visible; this is how probes/corridor-program-editor.mjs asks them directly.
    ;(window as unknown as { __apexProgram: unknown }).__apexProgram = {
      id: this.active,
      open: () => [...this.open.keys()],
      dirty: () => [...this.open.keys()].filter((p) => this.isDirtyPath(p)),
      value: () => this.editor()?.value() ?? '',
      setValue: (v: string) => this.editor()?.setValue(v),
      openFile: (p: string) => this.openFile(p),
      save: () => this.save(),
      check: () => this.check().then(() => this.diagnostics),
      emit: () => this.editor()?.emit() ?? Promise.resolve(null),
      dryRun: async () => {
        const js = await this.editor()?.emit()
        if (!js) return null
        this.last = await dryRun(js)
        this.drawReport()
        return this.last
      },
    }
  }

  private async check(): Promise<void> {
    const ed = this.editor()
    if (!ed) return
    this.diagnostics = await ed.check()
    this.drawReport()
  }

  private async dry(): Promise<void> {
    const ed = this.editor()
    if (!ed) return
    this.diagnostics = await ed.check()
    const fatal = this.diagnostics.filter((d) => d.severity === 'error')
    const js = await ed.emit()
    if (!js) {
      this.last = { ...(this.last ?? ({} as DryRun)), ok: false, error: 'it does not compile', played: 0 } as DryRun
      this.drawReport()
      return
    }
    // a type error does NOT stop the dry run: TypeScript's emit is valid JavaScript either way,
    // and a program with one type error that plays correctly is more useful to see run than to be
    // refused. The errors are on screen at the same time.
    this.last = await dryRun(js)
    if (fatal.length && this.last.ok) toast(`it runs, but ${fatal.length} type error${fatal.length === 1 ? '' : 's'} remain`, 'warn', 5000)
    this.drawReport()
  }

  private async save(): Promise<void> {
    const path = this.active
    const o = path ? this.open.get(path) : null
    if (!path || !o) return
    try {
      const text = o.editor.value()
      await this.o.save(path, text)
      o.saved = text
      try { localStorage.removeItem(DRAFT(path)) } catch { /* private window */ }
      toast(`saved ${path}`, 'ok')
      this.files = await this.o.list().catch(() => this.files)
      this.drawTabs()
      this.drawReport()
    } catch (e) {
      toast(`save failed: ${(e as Error).message}`, 'danger')
    }
  }

  /* ---- the file system ------------------------------------------------------------------------ */

  /**
   * A new program, at a path.
   *
   * The dialog takes the WHOLE path, prefilled with the folder it was started from, because a
   * folder here exists only by being in one — there is nothing to create separately, and a "new
   * folder" button would make a thing the store cannot represent.
   */
  private async create(prefix: string): Promise<void> {
    const name = await ask({
      title: 'New program',
      label: 'path',
      value: prefix,
      placeholder: 'levels/rooftop-run',
      icon: 'document-plus',
      validate: (v) => {
        const t = v.trim().replace(/\.ts$/, '')
        if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(t)) return 'lower case letters, digits, dots, hyphens — and slashes for folders'
        if (this.files.some((f) => f.id === t)) return `${t} already exists`
        return null
      },
    })
    if (name === null) return
    const id = name.trim().replace(/\.ts$/, '')
    await this.o.save(id, TEMPLATE)
    this.files = await this.o.list().catch(() => this.files)
    await this.openFile(id)
    this.o.refresh()
  }

  private async rename(id: string): Promise<void> {
    if (!this.o.move) return
    const to = await ask({
      title: `Move ${id}`,
      label: 'new path',
      value: id,
      icon: 'pencil-square',
      ok: 'Move',
      validate: (v) => {
        const t = v.trim().replace(/\.ts$/, '')
        if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(t)) return 'lower case letters, digits, dots, hyphens — and slashes for folders'
        if (t !== id && this.files.some((f) => f.id === t)) return `${t} already exists`
        return null
      },
    })
    if (to === null) return
    const id2 = to.trim().replace(/\.ts$/, '')
    if (id2 === id) return
    try {
      // save first: a move renames what is ON THE VOLUME, and an unsaved buffer would be left
      // pointing at a path that no longer exists
      const o = this.open.get(id)
      if (o && this.isDirty(o)) await this.o.save(id, o.editor.value())
      await this.o.move(id, id2)
      if (o) { this.closeTab(id); try { localStorage.removeItem(DRAFT(id)) } catch { /* ignore */ } }
      this.files = await this.o.list().catch(() => this.files)
      await this.openFile(id2)
      this.o.refresh()
      toast(`moved to ${id2}`, 'ok')
    } catch (e) {
      toast(`move failed: ${(e as Error).message}`, 'danger')
    }
  }

  private async del(id: string): Promise<void> {
    if (!(await confirm({ title: `Delete ${id}?`, message: 'Any level that names it will stop finding it.', ok: 'Delete', danger: true }))) return
    await this.o.remove(id)
    try { localStorage.removeItem(DRAFT(id)) } catch { /* private window */ }
    if (this.open.has(id)) this.closeTab(id)
    this.files = await this.o.list().catch(() => this.files)
    this.drawReport()
    this.o.refresh()
  }
}
