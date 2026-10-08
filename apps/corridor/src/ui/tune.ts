// The tuning surface, in corridor's own design language.
//
// WHY NOT @apex/engine's TunePanel. That component is shared with conduit, stuntin and coast, and
// restyling it would drag three other games into this change. What it *does* that matters is kept
// here exactly: the same localStorage keys (`apex-corridor-<tab>.tune.v1`), so knobs saved from the
// old panel are still there after this change; Copy JSON with the stance as context, which is how
// a number gets from Rich's drive back into tuning.ts's defaults; and Reset.
//
// The engine component stays where it is, untouched, for the games that use it.
import { TUNE_TABS } from '../tuning'
import type { TuneKey } from '@apex/engine/app/TunePanel'
import { Dialog, Tabs, button, toast, type Tab } from './shell'
import { bodyOf, group, slider } from './controls'
import { buildPresetPanel, type PresetPanelOpts } from './presetpanel'

const storeKey = (tab: string) => `apex-corridor-${tab}.tune.v1`

export interface TuneUIOpts {
  /** camera / site / season, recorded beside a copied number so the report is a repro */
  context: () => Record<string, unknown>
  /** re-pick trees, re-seed grass — whatever a changed knob invalidates */
  onChange: (name: string, value: number) => void
  /** write the diff-from-default into the site's tuning.json */
  onSaveSite: () => void
  /** empty that file and put the knobs it set back */
  onClearSite: () => void
  /**
   * Controls a section wants that are not knobs, keyed by section title.
   *
   * The time of day needs a date and a clock, which are not sliders. Rather than teach the shared
   * `TuneSection` type about DOM — it is a data description of knobs and should stay one — a
   * section may name an extra, and the app supplies it. The panel puts it above that section's
   * knobs.
   */
  extras?: Record<string, () => HTMLElement>
  /**
   * The presets manager, as one more tab.
   *
   * A preset IS this panel's state, filtered to the world-scope knobs (src/presets.ts), so it
   * belongs here rather than in a surface of its own that shows the same numbers and leaves a
   * person guessing which is in force.
   */
  presets?: PresetPanelOpts
}

export class TuneUI {
  dialog: Dialog
  private tabs: Tabs
  /** every key by name, so a reset or a paste can find one without walking the tabs */
  private keys = new Map<string, TuneKey>()
  /** the live range inputs, so a programmatic set redraws the control */
  private redraw = new Map<string, () => void>()
  /** move a control to an exact value without re-entering its own input handler; see `setExact` */
  private sync = new Map<string, (v: number) => void>()
  /** each rendered section, so the changed dot can be kept in step with its knobs */
  private groups: { el: HTMLElement; keys: TuneKey[] }[] = []
  /** every knob this browser has moved or explicitly reset — a site file does not override these */
  private touched = new Set<string>()

  private o: TuneUIOpts

  constructor(o: TuneUIOpts) {
    this.o = o
    for (const t of TUNE_TABS) for (const s of t.sections) for (const k of s.keys) this.keys.set(k.name, k)
    this.restore()

    const tabs: Tab[] = TUNE_TABS.map((tab) => ({
      id: tab.name,
      label: tab.name,
      build: (host) => {
        for (const sec of tab.sections) {
          // A section that does not apply right now is not built at all — the car tab is the
          // hand-written car OR the physics actor, never both.
          if (sec.when && !sec.when()) continue
          // One section is one group. Sections with a handful of keys start open; the long ones
          // (car has thirty) start collapsed, so a tab opens as a readable list of headings.
          // Each group carries its own reset, and marks itself when anything inside it has moved
          // — on a panel this size, "where have I actually changed something" is the question.
          const reset = button({
            icon: 'arrow-uturn-left',
            variant: 'ghost',
            title: `put ${sec.title} back to the code defaults`,
            onClick: () => this.resetSection(tab.name, sec),
          })
          // A section says whether it starts shut; where it does not, length decides. The length
          // rule alone put `weather` and `intersections` away purely because they are long, which
          // is not a reason (Rich, 2026-09-27) — it is the sections nobody touches that should be
          // shut, and only the section itself knows which those are.
          const g = group(sec.title, { collapsed: sec.collapsed ?? sec.keys.length > 12, actions: [reset] })
          const body = bodyOf(g)
          const extra = this.o.extras?.[sec.title]
          if (extra) body.append(extra())
          for (const k of sec.keys) body.append(this.field(tab.name, k))
          this.groups.push({ el: g, keys: sec.keys })
          host.append(g)
        }
        // a tab builds the first time it is opened; knobs restored from this browser are already
        // off their defaults, so the dots have to be right before anything is touched
        this.markGroups()
      },
    }))
    if (this.o.presets) {
      const opts = this.o.presets
      tabs.push({
        id: 'presets',
        label: 'presets',
        build: (host) => {
          host.textContent = ''
          buildPresetPanel(host, { ...opts, refresh: () => this.tabs.invalidate('presets') })
        },
      })
    }
    this.tabs = new Tabs(tabs)

    // movable: tuning is a loop of change-something / look-at-it, so this one docks to a side and
    // drops the scrim rather than dimming the world you are trying to judge
    this.dialog = new Dialog({ title: 'Tuning', icon: 'adjustments-horizontal', size: 'lg', movable: true })
    this.dialog.body.append(this.tabs.root)
    this.dialog.body.classList.add('tune-body')
    this.dialog.footer(
      button({ label: 'Copy JSON', icon: 'link', title: 'every knob that differs from the default, plus the stance — paste this back into tuning.ts', onClick: () => this.copy() }),
      button({ label: 'Reset tab', icon: 'arrow-path', title: 'put this tab’s knobs back to the code defaults', onClick: () => this.resetTab() }),
      button({ label: 'Clear site file', icon: 'trash', title: 'empty this site’s tuning.json and put its knobs back', onClick: () => this.o.onClearSite() }),
      button({ label: 'Save to site', icon: 'document-arrow-down', variant: 'primary', title: 'write the changed knobs into tools/corridor/data/sites/<slug>/tuning.json', onClick: () => this.o.onSaveSite() }),
    )
  }

  private field(tabName: string, k: TuneKey): HTMLElement {
    const node = slider({
      label: k.name,
      value: k.get(),
      min: k.min,
      max: k.max,
      step: k.step,
      neutral: k.default,
      note: k.hint,
      resettable: true,
      onSync: (set) => this.sync.set(k.name, set),
      onInput: (v) => {
        k.set(v)
        this.touched.add(k.name)
        this.persist(tabName)
        this.o.onChange(k.name, v)
        this.markGroups()
      },
    })
    // Redrawing goes through the range's own input event, so the readout, the off-neutral dot and
    // the value all update by the one path a drag uses — there is no second place to keep in step.
    const range = node.querySelector<HTMLInputElement>('input.range')!
    this.redraw.set(k.name, () => {
      range.value = String(k.get())
      range.dispatchEvent(new Event('input'))
    })
    return node
  }

  /** Put one section's knobs back to the code defaults. */
  private resetSection(tabName: string, sec: { title: string; keys: TuneKey[] }) {
    let n = 0
    for (const k of sec.keys) {
      if (k.get() === k.default) continue
      k.set(k.default)
      this.touched.add(k.name)
      this.redraw.get(k.name)?.()
      n++
    }
    this.persist(tabName)
    this.markGroups()
    toast(n ? `${sec.title}: ${n} back to default` : `${sec.title} was already at the defaults`, n ? 'ok' : 'info', 2000)
  }

  /** A dot on every section holding a knob that has been moved. */
  private markGroups() {
    for (const g of this.groups) g.el.classList.toggle('changed', g.keys.some((k) => k.get() !== k.default))
  }

  /**
   * Apply everything saved for every tab. Called once, before anything caches a tunable.
   *
   * A knob is stored under the tab that held it. Sections move (lighting left environment for
   * visuals), so the value is applied by name from every saved tab, and a later tab wins when
   * both still have it.
   */
  private restore() {
    const savedAll: Record<string, number> = {}
    for (const tab of TUNE_TABS) {
      try {
        const raw = localStorage.getItem(storeKey(tab.name))
        if (!raw) continue
        const doc = JSON.parse(raw) as Record<string, number> | { v: 2; values: Record<string, number>; touched?: string[] }
        // v2 keeps the touched names beside the values; a v1 file is a bare map, and every key in
        // it was something somebody moved, so they are all touched
        const saved = (doc as { v?: number }).v === 2 ? (doc as { values: Record<string, number> }).values : (doc as Record<string, number>)
        for (const n of (doc as { touched?: string[] }).touched ?? Object.keys(saved)) this.touched.add(n)
        for (const [n, v] of Object.entries(saved)) if (typeof v === 'number') savedAll[n] = v
      } catch {
        /* a corrupt or blocked localStorage is not worth failing a page load over */
      }
    }
    for (const tab of TUNE_TABS) for (const s of tab.sections) for (const k of s.keys) if (typeof savedAll[k.name] === 'number') k.set(savedAll[k.name])
  }

  /**
   * WHAT YOU TOUCHED IS AN OPINION, EVEN WHEN IT IS THE DEFAULT.
   *
   * Only knobs that differ from the default were stored, which is right for the values — but it
   * meant a RESET erased the browser's opinion entirely, and the site's own tuning.json (applied
   * after the panel restores, by design) put its value straight back on the next load. Rich reset
   * the weather, reloaded, and it was raining again. So the touched names are stored beside the
   * values, and `applySiteTuning` leaves those knobs alone.
   */
  private persist(tabName: string) {
    const tab = TUNE_TABS.find((t) => t.name === tabName)
    if (!tab) return
    const out: Record<string, number> = {}
    for (const s of tab.sections) for (const k of s.keys) if (k.get() !== k.default) out[k.name] = k.get()
    try {
      localStorage.setItem(storeKey(tabName), JSON.stringify({ v: 2, values: out, touched: [...this.touched] }))
    } catch {
      /* private window, or storage full — the knob still moved, it just will not survive a reload */
    }
  }

  /** Every changed knob across every tab, plus where the camera was. The repro. */
  private copy() {
    const changed: Record<string, number> = {}
    for (const [name, k] of this.keys) if (k.get() !== k.default) changed[name] = Number(k.get().toFixed(4))
    const payload = { game: 'corridor', ...this.o.context(), tune: changed }
    const text = JSON.stringify(payload, null, 2)
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast(`copied ${Object.keys(changed).length} changed knobs`, 'ok'))
      .catch(() => toast('clipboard blocked — the JSON is in the console', 'warn'))
    console.log(text)
  }

  private resetTab() {
    const tab = TUNE_TABS.find((t) => t.name === this.tabs.current)
    if (!tab) return
    let n = 0
    for (const s of tab.sections) {
      if (s.when && !s.when()) continue
      for (const k of s.keys) {
        if (k.get() === k.default) continue
        k.set(k.default)
        this.touched.add(k.name)
        this.redraw.get(k.name)?.()
        this.o.onChange(k.name, k.default)
        n++
      }
    }
    this.persist(tab.name)
    toast(n ? `${tab.name}: ${n} knobs back to default` : `${tab.name} was already at the defaults`, n ? 'ok' : 'info')
    this.markGroups()
  }

  /** How sitetuning.ts reaches the knobs without knowing about TUNE_TABS. */
  get access() {
    return {
      get: (name: string) => this.keys.get(name)?.get(),
      set: (name: string, v: number) => {
        const k = this.keys.get(name)
        if (!k) return false
        k.set(v)
        this.redraw.get(name)?.()
        return true
      },
      names: () => [...this.keys.keys()],
      /**
       * Write a knob with no side effects but the knob itself.
       *
       * `set` above goes through the slider's own input event, which is right for a site file —
       * it marks the knob touched, persists it and re-derives the world, exactly as a drag would.
       * It is wrong for a PRESET TWEEN, in three ways: the range snaps the value to its `step`, so
       * a smooth transition moves in twenty jumps; the knob is recorded as this browser's opinion,
       * which it is not; and the world is re-derived once per knob, so a 237-knob preset costs 237
       * retunes a frame. The tween re-derives once from the frame loop instead.
       */
      setExact: (name: string, v: number) => {
        const k = this.keys.get(name)
        if (!k) return false
        k.set(v)
        this.sync.get(name)?.(v)
        return true
      },
      /** what this browser has an opinion about; a site's tuning.json leaves these alone */
      touched: () => this.touched,
    }
  }

  /**
   * A detail level's values (game/session/detail.ts). Forced — the player picked a level — every
   * knob is written and the browser's override of it is forgotten, so the level is what you get
   * until you move the knob again; unforced — a page load — knobs this browser overrode are left
   * as they are. The tabs that held a changed knob are persisted. Returns how many knobs moved.
   */
  applyPreset(values: Record<string, number>, force: boolean): number {
    let n = 0
    const tabs = new Set<string>()
    for (const [name, v] of Object.entries(values)) {
      const k = this.keys.get(name)
      if (!k) continue
      if (!force && this.touched.has(name)) continue
      if (force) this.touched.delete(name)
      if (k.get() !== v) { k.set(v); n++ }
      this.redraw.get(name)?.()
      // only a level the player CHOSE re-derives the world: at page load (unforced) nothing is built
      // yet, and the retune it would run reaches things main.ts has not declared ("Cannot access
      // 'traffic' before initialization", the tab would not start — 2026-10-08)
      if (force) this.o.onChange(name, v)
      for (const t of TUNE_TABS) if (t.sections.some((sec) => sec.keys.some((x) => x.name === name))) tabs.add(t.name)
    }
    for (const t of tabs) this.persist(t)
    this.markGroups()
    return n
  }

  /** The code defaults, for the diff a per-site tuning.json is. */
  get baseline(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [name, k] of this.keys) out[name] = k.default
    return out
  }

  /**
   * Throw away the built presets tab, so it is rebuilt from the new world's library.
   *
   * The tabs are built once and cached, which is what makes a 200-slider panel open instantly and
   * what would otherwise leave the previous world's presets on screen after a site change.
   */
  invalidatePresets() {
    this.tabs.invalidate('presets')
  }

  /**
   * Throw away a built tab so it is rebuilt on the next open.
   *
   * The car tab is two panes in one and the car is re-created when drive mode is re-entered or the
   * level changes; without this the panel would keep showing the model that was current the first
   * time it was opened.
   */
  invalidateTab(id: string) {
    this.tabs.invalidate(id)
  }

  toggle() {
    this.dialog.toggle()
  }
}
