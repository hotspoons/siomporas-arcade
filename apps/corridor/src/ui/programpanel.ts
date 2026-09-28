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
import { bodyOf, empty, group, readout } from './controls'
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

export class ProgramPanel {
  private readonly o: ProgramPanelOpts
  private editor: CodeEditor | null = null
  private id: string | null = null
  private dirty = false
  private diagnostics: Diagnostic[] = []
  private last: DryRun | null = null
  private report: HTMLElement | null = null

  constructor(o: ProgramPanelOpts) {
    this.o = o
  }

  async render(): Promise<void> {
    const host = this.o.host
    host.replaceChildren()

    this.o.reportHost.replaceChildren()
    if (!this.id) {
      const list = await this.o.list().catch(() => [])
      const g = group(`Programs (${list.length})`, {
        collapsed: false,
        actions: [button({ label: 'New', icon: 'plus', variant: 'primary', onClick: () => void this.create() })],
      })
      const b = bodyOf(g)
      if (!list.length) b.append(empty('No programs yet. A level without one uses its declarative scenario; a program is what you write when that runs out.'))
      for (const p of list) {
        const row = el('button', 'row')
        row.append(
          el('span', 'row-name', p.id),
          el('span', 'row-note', `${(p.bytes / 1024).toFixed(1)} kB${p.modified ? ` · ${p.modified.slice(0, 16).replace('T', ' ')}` : ''}`),
        )
        row.onclick = () => void this.open(p.id)
        b.append(row)
      }
      this.o.reportHost.append(g)
      return
    }

    /* the editor */
    const bar = el('div', 'panel-bar')
    bar.append(
      button({ label: 'Back', icon: 'arrow-left', variant: 'ghost', onClick: () => void this.close() }),
      el('span', 'panel-title', this.id + (this.dirty ? ' •' : '')),
    )
    const actions = el('div', 'panel-bar-actions')
    actions.append(
      button({ label: 'Check', icon: 'check', title: 'typecheck it, against the real API declarations', onClick: () => void this.check() }),
      button({ label: 'Dry run', icon: 'beaker', title: 'compile it, load it and play five seconds of it against a stub world', onClick: () => void this.dry() }),
      button({ label: 'Save', icon: 'document-arrow-down', variant: 'primary', onClick: () => void this.save() }),
      button({ label: 'Delete', icon: 'trash', variant: 'ghost', onClick: () => void this.del() }),
    )
    bar.append(actions)
    host.append(bar)

    const editorHost = el('div', 'code-host')
    host.append(editorHost)
    this.report = this.o.reportHost
    this.report.replaceChildren()

    const source = (await this.o.load(this.id)) ?? TEMPLATE
    this.editor = new CodeEditor({
      host: editorHost,
      path: `programs/${this.id}.ts`,
      value: source,
      onChange: () => {
        if (this.dirty) return
        this.dirty = true
        const title = this.o.host.querySelector('.panel-title')
        if (title) title.textContent = `${this.id} •`
      },
    })
    await this.editor.whenReady()
    // for probes and the console, the way the viewer exposes its knobs. The toolkit is three
    // asynchronous services behind an editor, and every one of them fails by doing nothing
    // visible; this is how probes/corridor-program-editor.mjs asks them directly.
    ;(window as unknown as { __apexProgram: unknown }).__apexProgram = {
      id: this.id,
      value: () => this.editor?.value() ?? '',
      setValue: (v: string) => this.editor?.setValue(v),
      check: () => this.check().then(() => this.diagnostics),
      emit: () => this.editor?.emit() ?? Promise.resolve(null),
      dryRun: async () => {
        const js = await this.editor?.emit()
        if (!js) return null
        this.last = await dryRun(js)
        this.drawReport()
        return this.last
      },
    }
    this.drawReport()
    // check once on open: opening a program that has been broken by an API change and saying
    // nothing is how somebody spends an evening on a level that was never going to run
    void this.check()
  }

  private drawReport(): void {
    const r = this.report
    if (!r) return
    r.replaceChildren()

    if (this.diagnostics.length) {
      const g = group(`${this.diagnostics.length} problem${this.diagnostics.length === 1 ? '' : 's'}`, { collapsed: false })
      const b = bodyOf(g)
      for (const d of this.diagnostics) {
        const row = el('button', `row diag ${d.severity}`)
        row.append(el('span', 'row-name', `${d.line}:${d.column}`), el('span', 'row-note', d.message))
        row.onclick = () => this.editor?.reveal(d.line, d.column)
        b.append(row)
      }
      r.append(g)
    } else if (this.editor) {
      r.append(el('p', 'note ok', 'No type errors.'))
    }

    if (this.last) {
      const d = this.last
      const g = group(d.ok ? 'Dry run' : 'Dry run failed', { collapsed: false })
      const b = bodyOf(g)
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
      r.append(g)
    }
  }

  private async check(): Promise<void> {
    if (!this.editor) return
    this.diagnostics = await this.editor.check()
    this.drawReport()
  }

  private async dry(): Promise<void> {
    if (!this.editor) return
    this.diagnostics = await this.editor.check()
    const fatal = this.diagnostics.filter((d) => d.severity === 'error')
    const js = await this.editor.emit()
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
    if (!this.editor || !this.id) return
    try {
      await this.o.save(this.id, this.editor.value())
      this.dirty = false
      toast(`saved ${this.id}`, 'ok')
      const title = this.o.host.querySelector('.panel-title')
      if (title) title.textContent = this.id
    } catch (e) {
      toast(`save failed: ${(e as Error).message}`, 'danger')
    }
  }

  private async create(): Promise<void> {
    const name = await ask({
      title: 'New program',
      label: 'id',
      placeholder: 'rooftop-run',
      icon: 'plus',
      validate: (v) => (/^[a-z0-9][a-z0-9-]{1,63}$/.test(v.trim()) ? null : 'lower case letters, digits and hyphens'),
    })
    if (name === null) return
    await this.o.save(name.trim(), TEMPLATE)
    await this.open(name.trim())
  }

  private async open(id: string): Promise<void> {
    this.id = id
    this.dirty = false
    this.diagnostics = []
    this.last = null
    await this.render()
  }

  private async close(): Promise<void> {
    if (this.dirty && !(await confirm({ title: 'Leave without saving?', message: `${this.id} has unsaved changes.`, ok: 'Discard', danger: true }))) return
    this.editor?.dispose()
    this.editor = null
    this.id = null
    this.o.refresh()
    await this.render()
  }

  private async del(): Promise<void> {
    if (!this.id) return
    if (!(await confirm({ title: `Delete ${this.id}?`, message: 'Any level that names it will stop finding it.', ok: 'Delete', danger: true }))) return
    await this.o.remove(this.id)
    this.editor?.dispose()
    this.editor = null
    this.id = null
    await this.render()
  }
}
