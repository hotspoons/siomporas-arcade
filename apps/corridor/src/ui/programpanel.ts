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
import type { WorldThing, WorldThingKind } from '../worldthings'
import { CodeEditor, forget, knowAbout, languageForPath, type Diagnostic } from './codeeditor'
import { GameRun, type GameDef, type ProgramHost, type Transport } from '../program'
import { rewriteImports } from '../programload'
import { ActorWorld } from '../actorworld'
import { bodyOf, group, readout } from './controls'
import { FileTree } from './filetree'
import { ask, button, confirm, el, toast } from './shell'

/**
 * WHAT A NEW PROGRAM STARTS AS.
 *
 * Rich, 2026-09-28: "we should have access to the full game API and have a well sorted example
 * where we essentially port the current driving and flying game with no real goal or points
 * system as an example project to get you started. Can you set a much richer default that
 * includes the full ECS scaffolding?"
 *
 * It used to be nine lines that won the game when you drove into a circle — which is a fine
 * smallest-possible level and a terrible starting point, because it shows one corner of the API
 * and nothing about the simulation underneath. This one is the game as it currently plays, with
 * no goal and no score, and every part labelled: drive, get out and walk, fly, spawn actors,
 * query them, move something the editor placed, and react to where the player is.
 *
 * IT IS MEANT TO BE DELETED FROM, not read. Each block stands alone, so the way to use it is to
 * throw away the parts you do not want.
 */
export const TEMPLATE = `import { defineGame } from '@apex/program'
import { addComponent, addEntity, query, removeComponent } from 'bitecs'
import { Animal, Autonomous, Health, Hostile, Player, SETS, Transform, Vehicle, Velocity, Visual } from '@apex/actors'
import { face, integrate, mortality, spawnPedestrian, spawnVehicle, walk } from '@apex/actorworld'

/*
 * A world with nothing to do in it — which is the point of a starting project.
 *
 * Everything below is a block you can delete. Nothing here wins, loses or scores; add that when
 * you know what the level is about.
 */
export default defineGame({
  setup(api) {
    // ---- 1 · how the player gets about -----------------------------------------------------
    //
    // Each of these is a controller, not a setting. 'drive' is the car; 'walk' and 'walk-third'
    // are on foot; the rest fly, with real masses and thrusts (see @apex/program TRANSPORT).
    api.transport('drive')
    api.goal('Drive. Press F to fly, G to get out and walk.')

    // ---- 2 · the world's own furniture -----------------------------------------------------
    //
    // Anything placed in the editor is an entity here, by its id. \`api.placements()\` is the list;
    // the editor shows the same ids beside this code.
    for (const thing of api.placements()) {
      console.log('placed:', thing.id, thing.asset, thing.tags.join(' '))
    }

    // Move one, and the world moves: this is the ECS, so anything that writes a Transform works.
    const spinner = api.placedWith('utility')[0] ?? null
    if (spinner !== null) {
      api.each((dt) => {
        Transform.yaw[spinner] += dt * 0.3
      })
    }

    // ---- 3 · the simulation --------------------------------------------------------------
    //
    // The systems run in the order they are added, at a fixed 20 ms step, however long a frame
    // takes. \`integrate\` moves anything with a Velocity; \`walk\` steers pedestrians to where they
    // are going; \`face\` points things the way they are travelling; \`mortality\` removes the dead
    // once, at the end of a step.
    api.actors
      .add('walk', walk)
      .add('integrate', integrate)
      .add('face', face)
      .add('mortality', mortality)

    // ---- 4 · some traffic and some people --------------------------------------------------
    //
    // Spawned relative to the player, so this works in any world. A real level would use the
    // level's ECS config (@apex/ecsconfig) to populate along the roads instead.
    const at = api.facts()
    void at
    for (let i = 0; i < 12; i++) {
      const lane = i % 2 === 0 ? 4 : -4
      spawnVehicle(api.actors, { x: lane, y: 60 + i * 25 }, { asset: 0, maxSpeed: 14 })
    }
    for (let i = 0; i < 8; i++) {
      spawnPedestrian(api.actors, { x: 9, y: 20 + i * 12 }, { x: 9, y: 200 }, { speed: 1.3 })
    }

    // ---- 5 · one query, many shapes --------------------------------------------------------
    //
    // An enemy can take any form: this finds the hostile car, the hostile dog and the hostile
    // person without naming any of them. That is why this is an ECS and not a class hierarchy.
    api.every(5, () => {
      const threats = query(api.world, SETS.threats)
      if (threats.length) api.say(\`\${threats.length} hostile\`, 'warn')
    })

    // Make something hostile by GIVING it a component — the same entity, still where it was.
    api.after(20, () => {
      const cars = query(api.world, [Vehicle, Autonomous])
      const it = cars[0]
      if (it === undefined) return
      addComponent(api.world, it, Hostile)
      Hostile.faction[it] = 1
      Hostile.aggression[it] = 0.8
      api.say('one of them has taken an interest', 'warn')
    })

    // ---- 6 · a zone, and reacting to it ----------------------------------------------------
    //
    // Circles and boxes are the only spatial primitive. Naming one lets \`on('enters')\`,
    // \`on('leaves')\` and \`in()\` talk about it.
    api.zone('start', { kind: 'circle', x: 0, y: 0, r: 80 })
    api.on('leaves', 'start', () => api.say('off we go'))
    api.on('enters', 'start', () => api.say('back at the start'))

    // ---- 7 · the look of the place ---------------------------------------------------------
    //
    // Presets are the tuning library, by name; \`over\` tweens instead of cutting.
    api.time('17:30')
    api.preset('golden-hour', { over: 4 })
    api.hide('minimap')

    // ---- 8 · facts, which are how conditions are written ------------------------------------
    api.when((f) => f.speed > 30, () => api.say('quick'))

    // ---- 9 · physics, if this world has any ------------------------------------------------
    //
    // \`available()\` rather than a guess: a dry run has no physics world, and everything below is
    // a no-op there, so a level that uses physics is still a level you can check headlessly.
    //
    // A PROFILE IS THE WHOLE HANDLING MODEL by name — stunts, taxi, street, rush, sim — and the
    // second argument overrides individual numbers without carrying a copy of the other forty
    // that then stops tracking the base.
    if (api.physics.available()) {
      api.physics.profile('street', { gripRear: 1.05 })

      // ONE ENTITY'S OWN HANDLING. The car chasing you does not have to drive like the one you
      // are in — this is how a pursuit feels different from a commute.
      const hostiles = query(api.world, SETS.threats)
      for (const e of hostiles) api.physics.entityProfile(e, 'rush')

      // the car gets looser as it takes damage: read the state, blend toward the loose profile
      api.each(() => {
        const car = api.physics.car()
        if (car && car.damage > 0.3) api.physics.blend('stunts', car.damage, { over: 1 })
      })

      // something was hit hard enough to matter
      api.physics.onImpact((e) => {
        if (e.impulse > 8000) api.say('that was a big one', 'warn')
      })
    }
  },

  /*
   * Every frame, with the real delta. \`api.each\` is the same thing; this reads better for the
   * one loop that is about the whole level rather than one feature of it.
   */
  update(dt, api) {
    void dt
    void api
  },

  teardown(api) {
    // the world is torn down for you; this is for anything you attached to it
    api.actors.clear()
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
  /** every file on the volume, and every folder — including the empty ones */
  list: () => Promise<{ programs: { id: string; bytes: number; modified: string | null }[]; dirs: string[] }>
  load: (id: string) => Promise<string | null>
  save: (id: string, source: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** rename or move one — a file or a folder; the tree offers it only when a caller can do it */
  move?: (id: string, to: string) => Promise<void>
  makeDir?: (id: string) => Promise<void>
  removeDir?: (id: string) => Promise<void>
  /** redraw, after the list changed */
  refresh: () => void
  /**
   * What the editor has placed in the world that is open, if any.
   *
   * So the ids a program refers to are ON SCREEN beside the code (Rich, 2026-09-28: "with
   * instances listed in the editor we can reference from code by an id or something"). Without
   * this you would have to open placements.json to find out what `api.placed('…')` may be given.
   */
  instances?: () => Promise<{ world: string | null; items: WorldThing[] }>
}

const KIND_LABEL: Record<WorldThingKind, string> = {
  placement: 'Placed',
  traffic: 'Traffic zones',
  stunt: 'Stunt fixtures',
  race: 'Races',
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
// the module shims live in ../programload, shared with the viewer's own program runner

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

/** What may live here. Matches PROGRAM_EXT in tools/worldeditor/store.mjs, which is the authority. */
const EXT = ['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.txt', '.glsl', '.frag', '.vert', '.css', '.yaml', '.yml']

/** The ones the TypeScript service should know about: what a program can actually import. */
const CODE = ['.ts', '.tsx', '.js', '.mjs', '.json']

/** The last segment's extension, or '' when the name has no dot in it at all. */
export const extOf = (p: string): string => {
  const name = p.slice(p.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

/**
 * The extension a typed path ends up with.
 *
 * THREE CASES, AND THEY ARE NOT THE SAME (Rich, 2026-09-28: "Its okay to auto-name things with a
 * .ts extension but don't always add it on files especially on renames/moves. We might want json
 * too"):
 *
 *   A NAME WITH NO DOT gets one. On a new file that is `.ts`, because most of these are
 *   TypeScript and asking every time is a tax on the common case. On a rename it is the
 *   extension the file already had — renaming `chase.json` to `pursuit` means `pursuit.json`,
 *   and turning it into TypeScript behind somebody's back would be an odd thing to do.
 *
 *   A NAME WITH A DOT IS TAKEN AS TYPED, whatever it says. That is how an extension gets CHANGED,
 *   which is a thing this editor is supposed to be able to do; if the extension is not one this
 *   store keeps, `badPath` says so. It used to append `.ts` to anything it did not recognise, so
 *   renaming a file to `test.xyz` silently produced `test.xyz.ts`.
 */
export const withExt = (v: string, from?: string): string => {
  const t = v.trim().replace(/\.$/, '')
  if (extOf(t)) return t
  return `${t}${(from && extOf(from)) || '.ts'}`
}

/**
 * Which language Monaco should use, from the extension.
 *
 * It was `typescript` for everything because everything was `.ts`. A JSON file in a TypeScript
 * model is a syntax error on line 1, and worse, it is a syntax error that the type service will
 * then report about a file that is perfectly good JSON.
 */
const languageOf = (path: string): 'typescript' | 'javascript' | 'json' | 'plaintext' => {
  const ext = path.slice(path.lastIndexOf('.'))
  if (ext === '.json') return 'json'
  if (ext === '.js' || ext === '.mjs') return 'javascript'
  if (ext === '.ts' || ext === '.tsx') return 'typescript'
  return 'plaintext'
}

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
  private dirs: string[] = []
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

    await this.reload()
    void this.reloadInstances()
    if (!this.restored) {
      this.restored = true
      await this.reopenLast()
    }
    this.drawTabs()
    this.drawReport()
    // before anything is open, too: a handle that only appears once a file is showing cannot be
    // used to open one, which is the first thing a probe or a console wants to do
    this.exposeForProbes()
  }

  /** What is on the volume. One call, because folders and files come back together. */
  private async reload(): Promise<void> {
    const r = await this.o.list().catch(() => null)
    if (!r) return
    // defaulted, because a service that predates folders answers without `dirs` — and an
    // undefined here is a TypeError inside path validation, which reads as "rename is broken"
    const before = this.files
    this.files = r.programs ?? []
    this.dirs = r.dirs ?? []
    // a file that is gone must stop resolving; otherwise `import './old'` keeps typechecking
    for (const f of before) if (!this.files.some((n) => n.id === f.id)) void forget(`programs/${f.id}`)
    void this.teachService()
  }

  /**
   * Put every file on the volume into the compilation, whether or not it is open.
   *
   * WHAT THIS BUYS: `import { chase } from '../lib/chase'` resolves, its exports complete, and a
   * typo in the path is an error rather than silence. Monaco only knows the models that exist, so
   * without this a multi-file game behaves as if every file were alone.
   *
   * Fetched ONCE per file and never refetched here: the open ones are authoritative in their own
   * buffers (`knowAbout` will not touch a model that exists), and re-reading a file on every
   * listing would fight with what somebody is typing into it. A file changed on the volume by
   * something else is picked up when it is opened.
   */
  private taught = new Set<string>()
  private async teachService(): Promise<void> {
    const want = this.files.filter((f) => !this.taught.has(f.id) && CODE.includes(f.id.slice(f.id.lastIndexOf('.'))))
    if (!want.length) return
    for (const f of want) this.taught.add(f.id)
    const texts: { path: string; text: string; language: string }[] = []
    for (const f of want) {
      // a runaway file is not worth putting in the compilation; the service slows down for every
      // model it holds and a 500 kB generated blob helps nobody's completions
      if (f.bytes > 256 * 1024) continue
      const text = await this.o.load(f.id).catch(() => null)
      if (text === null) continue
      texts.push({ path: `programs/${f.id}`, text, language: languageForPath(f.id) })
    }
    if (texts.length) await knowAbout(texts)
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
      path: `programs/${path}`,
      language: languageOf(path),
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
        button({ icon: 'document-plus', title: 'new file', variant: 'ghost', onClick: () => void this.create('') }),
        button({ icon: 'folder-plus', title: 'new folder', variant: 'ghost', onClick: () => void this.makeDir('') }),
      ],
    })
    /*
     * THE PATH IS THE ID, extension and all — so a rename, a move between folders and a change of
     * extension are one operation with one dialog, which is what they are on any filesystem
     * (Rich, 2026-09-28: "move and rename files and change extensions").
     */
    this.tree ??= new FileTree({
      storageKey: 'programs',
      empty: 'No files yet.',
      files: () => this.files.map((f) => ({
        path: f.id,
        note: `${(f.bytes / 1024).toFixed(1)} kB`,
        mark: this.isDirtyPath(f.id) ? '•' : undefined,
      })),
      dirs: () => this.dirs,
      selected: () => this.active,
      onOpen: (p) => void this.openFile(p),
      folderActions: (dir) => [
        { icon: 'document-plus', title: `new file in ${dir}`, onClick: () => void this.create(`${dir}/`) },
        { icon: 'folder-plus', title: `new folder in ${dir}`, onClick: () => void this.makeDir(`${dir}/`) },
        { icon: 'pencil-square', title: `rename or move ${dir}`, onClick: () => void this.renameDir(dir) },
        { icon: 'trash', title: `delete ${dir} and everything in it`, danger: true, onClick: () => void this.delDir(dir) },
      ],
      actions: (p) => [
        { icon: 'pencil-square', title: 'rename, move or change the extension', onClick: () => void this.rename(p) },
        { icon: 'trash', title: 'delete', danger: true, onClick: () => void this.del(p) },
      ],
    })
    this.tree.render()
    bodyOf(g).append(this.tree.root)
    r.append(g)

    this.drawInstances(r)

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

  /**
   * The things in this world, by the id a program says.
   *
   * Clicking one puts `api.placed('p-07')` at the caret, because the useful thing to do with an
   * id you just found is use it, and retyping it from a list is where the typo comes from.
   */
  private instances: WorldThing[] = []
  private instanceWorld: string | null = null
  private drawInstances(into: HTMLElement): void {
    if (!this.o.instances) return
    const g = group(`In this world (${this.instances.length})`, { collapsed: !this.instances.length, note: this.instanceWorld ?? undefined })
    const b = bodyOf(g)
    if (!this.instances.length) {
      b.append(el('p', 'note', this.instanceWorld
        ? 'Nothing in this world yet. Place things, paint traffic, stand up a stunt or lay out a race and they appear here.'
        : 'No world open.'))
    }
    /*
     * GROUPED BY LAYER, and each group is there only when the world has one. A heading that says
     * "Traffic zones (0)" teaches you nothing; a world with three zones and no races should read as
     * a world with three zones.
     */
    const kinds: WorldThingKind[] = ['placement', 'traffic', 'stunt', 'race']
    for (const kind of kinds) {
      const items = this.instances.filter((i) => i.kind === kind)
      if (!items.length) continue
      b.append(el('p', 'note dim', `${KIND_LABEL[kind]} (${items.length})`))
      for (const it of items.slice(0, 200)) {
        const row = el('button', 'row')
        row.append(el('span', 'row-name', it.id), el('span', 'row-note', `${it.what}${it.tags.length ? ` · ${it.tags.join(' ')}` : ''}`))
        row.title = `insert ${it.insert}`
        row.onclick = () => this.editor()?.insert(it.insert)
        b.append(row)
      }
    }
    into.append(g)
  }

  /** Read them again — after a world changes, or after something is placed. */
  async reloadInstances(): Promise<void> {
    if (!this.o.instances) return
    try {
      const r = await this.o.instances()
      this.instances = r.items
      this.instanceWorld = r.world
    } catch {
      this.instances = []
    }
    this.drawReport()
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
      await this.reload()
      this.drawTabs()
      this.drawReport()
    } catch (e) {
      toast(`save failed: ${(e as Error).message}`, 'danger')
    }
  }

  /* ---- the file system ------------------------------------------------------------------------ */

  /**
   * A new file, at a path.
   *
   * "New program" was the wrong name for this: what it makes is a file, and since the extension
   * is part of the path it need not be TypeScript at all (Rich, 2026-09-28: "'new program'
   * probably isn't the best name for this interface"). A file with no extension typed gets `.ts`,
   * because that is what most of them are and asking for it every time is a tax on the common case.
   */
  private async create(prefix: string): Promise<void> {
    const name = await ask({
      title: 'New file',
      label: 'path',
      value: prefix,
      placeholder: 'levels/rooftop-run.ts, or lib/data.json',
      icon: 'document-plus',
      ok: 'Create',
      validate: (v) => this.badPath(withExt(v), 'file'),
    })
    if (name === null) return
    const id = withExt(name)
    await this.o.save(id, id.endsWith('.ts') ? TEMPLATE : '')
    await this.reload()
    await this.openFile(id)
    this.o.refresh()
  }

  /** The one rule, asked once: is this a path this store will take, and is it free? */
  private badPath(v: string, what: 'file' | 'folder'): string | null {
    const t = v.trim()
    if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(t)) return 'lower case letters, digits, dots, hyphens — and slashes for folders'
    if (t.split('/').some((p) => p.startsWith('.'))) return 'no segment may start with a dot'
    if (what === 'file' && !EXT.includes(extOf(t))) return `${extOf(t) || 'no extension'} — it must be one of ${EXT.join(' ')}`
    if (this.files.some((f) => f.id === t) || this.dirs.includes(t)) return `${t} already exists`
    return null
  }

  private async rename(id: string): Promise<void> {
    if (!this.o.move) return
    const to = await ask({
      title: `Move ${id}`,
      label: 'new path',
      value: id,
      icon: 'pencil-square',
      ok: 'Move',
      validate: (v) => (v.trim() === id ? null : this.badPath(withExt(v, id), 'file')),
    })
    if (to === null) return
    const id2 = withExt(to, id)
    if (id2 === id) return
    try {
      // save first: a move renames what is ON THE VOLUME, and an unsaved buffer would be left
      // pointing at a path that no longer exists
      const o = this.open.get(id)
      if (o && this.isDirty(o)) await this.o.save(id, o.editor.value())
      await this.o.move(id, id2)
      if (o) { this.closeTab(id); try { localStorage.removeItem(DRAFT(id)) } catch { /* ignore */ } }
      await this.reload()
      await this.openFile(id2)
      this.o.refresh()
      toast(`moved to ${id2}`, 'ok')
    } catch (e) {
      toast(`move failed: ${(e as Error).message}`, 'danger')
    }
  }

  private async makeDir(prefix: string): Promise<void> {
    if (!this.o.makeDir) return
    const name = await ask({
      title: 'New folder',
      label: 'path',
      value: prefix,
      placeholder: 'levels/chapter-two',
      icon: 'folder-plus',
      ok: 'Create',
      validate: (v) => this.badPath(v, 'folder'),
    })
    if (name === null) return
    try {
      await this.o.makeDir(name.trim())
      await this.reload()
      this.drawReport()
    } catch (e) {
      toast(`could not make the folder: ${(e as Error).message}`, 'danger')
    }
  }

  /**
   * Rename or move a folder, and everything in it comes along.
   *
   * The open tabs are re-pointed rather than closed: this is one `rename(2)` on the volume, and a
   * person who renamed a folder has not asked for their editor to be emptied. Drafts move with
   * their file, because an unsaved buffer is keyed by path.
   */
  private async renameDir(dir: string): Promise<void> {
    if (!this.o.move) return
    const to = await ask({
      title: `Move ${dir}`,
      label: 'new path',
      value: dir,
      icon: 'pencil-square',
      ok: 'Move',
      validate: (v) => (v.trim() === dir ? null : this.badPath(v, 'folder')),
    })
    if (to === null || to.trim() === dir) return
    const to2 = to.trim()
    try {
      // unsaved buffers under it are written first: after the move their old path is gone, and a
      // draft keyed to a path that no longer exists is work nobody will find again
      for (const [p, o] of this.open) {
        if (p === dir || p.startsWith(`${dir}/`)) { if (this.isDirty(o)) await this.o.save(p, o.editor.value()) }
      }
      await this.o.move(dir, to2)
      for (const p of [...this.open.keys()]) {
        if (p !== dir && !p.startsWith(`${dir}/`)) continue
        this.closeTab(p)
        try { localStorage.removeItem(DRAFT(p)) } catch { /* ignore */ }
        await this.openFile(`${to2}${p.slice(dir.length)}`, false)
      }
      await this.reload()
      this.drawTabs()
      this.drawReport()
      this.o.refresh()
      toast(`moved to ${to2}`, 'ok')
    } catch (e) {
      toast(`move failed: ${(e as Error).message}`, 'danger')
    }
  }

  private async delDir(dir: string): Promise<void> {
    if (!this.o.removeDir) return
    const inside = this.files.filter((f) => f.id.startsWith(`${dir}/`)).length
    if (!(await confirm({
      title: `Delete ${dir}?`,
      // the count is the whole message: "delete this folder" reads as a tidy-up until you know
      // it is taking eleven files with it
      message: inside ? `${inside} file${inside === 1 ? '' : 's'} in it will be deleted too. This cannot be undone.` : 'It is empty.',
      ok: 'Delete',
      danger: true,
    }))) return
    try {
      await this.o.removeDir(dir)
      for (const p of [...this.open.keys()]) {
        if (p.startsWith(`${dir}/`)) { this.closeTab(p); try { localStorage.removeItem(DRAFT(p)) } catch { /* ignore */ } }
      }
      await this.reload()
      this.drawReport()
      this.o.refresh()
    } catch (e) {
      toast(`delete failed: ${(e as Error).message}`, 'danger')
    }
  }

  private async del(id: string): Promise<void> {
    if (!(await confirm({ title: `Delete ${id}?`, message: 'Any level that names it will stop finding it.', ok: 'Delete', danger: true }))) return
    await this.o.remove(id)
    try { localStorage.removeItem(DRAFT(id)) } catch { /* private window */ }
    if (this.open.has(id)) this.closeTab(id)
    await this.reload()
    this.drawReport()
    this.o.refresh()
  }
}
