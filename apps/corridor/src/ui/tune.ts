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

const storeKey = (tab: string) => `apex-corridor-${tab}.tune.v1`

export interface TuneUIOpts {
  /** camera / site / season, recorded beside a copied number so the report is a repro */
  context: () => Record<string, unknown>
  /** re-pick trees, re-seed grass — whatever a changed knob invalidates */
  onChange: (name: string, value: number) => void
  /** write the diff-from-default into the site's tuning.json */
  onSaveSite: () => void
}

export class TuneUI {
  dialog: Dialog
  private tabs: Tabs
  /** every key by name, so a reset or a paste can find one without walking the tabs */
  private keys = new Map<string, TuneKey>()
  /** the live range inputs, so a programmatic set redraws the control */
  private redraw = new Map<string, () => void>()

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
          // One section is one group. Sections with a handful of keys start open; the long ones
          // (car has thirty) start collapsed, so a tab opens as a readable list of headings.
          const g = group(sec.title, { collapsed: sec.keys.length > 12 })
          const body = bodyOf(g)
          for (const k of sec.keys) body.append(this.field(tab.name, k))
          host.append(g)
        }
      },
    }))
    this.tabs = new Tabs(tabs)

    this.dialog = new Dialog({ title: 'Tuning', icon: 'adjustments-horizontal', size: 'lg' })
    this.dialog.body.append(this.tabs.root)
    this.dialog.body.classList.add('tune-body')
    this.dialog.footer(
      button({ label: 'Copy JSON', icon: 'link', title: 'every knob that differs from the default, plus the stance — paste this back into tuning.ts', onClick: () => this.copy() }),
      button({ label: 'Reset tab', icon: 'arrow-path', title: 'put this tab’s knobs back to the code defaults', onClick: () => this.resetTab() }),
      button({ label: 'Save to site', icon: 'document-arrow-down', variant: 'primary', title: 'write the changed knobs into this site’s tuning.json', onClick: () => this.o.onSaveSite() }),
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
      onInput: (v) => {
        k.set(v)
        this.persist(tabName)
        this.o.onChange(k.name, v)
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

  /** Apply everything saved for every tab. Called once, before anything caches a tunable. */
  private restore() {
    for (const tab of TUNE_TABS) {
      try {
        const raw = localStorage.getItem(storeKey(tab.name))
        if (!raw) continue
        const saved = JSON.parse(raw) as Record<string, number>
        for (const s of tab.sections) for (const k of s.keys) if (typeof saved[k.name] === 'number') k.set(saved[k.name])
      } catch {
        /* a corrupt or blocked localStorage is not worth failing a page load over */
      }
    }
  }

  private persist(tabName: string) {
    const tab = TUNE_TABS.find((t) => t.name === tabName)
    if (!tab) return
    const out: Record<string, number> = {}
    for (const s of tab.sections) for (const k of s.keys) if (k.get() !== k.default) out[k.name] = k.get()
    try {
      localStorage.setItem(storeKey(tabName), JSON.stringify(out))
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
      for (const k of s.keys) {
        if (k.get() === k.default) continue
        k.set(k.default)
        this.redraw.get(k.name)?.()
        this.o.onChange(k.name, k.default)
        n++
      }
    }
    this.persist(tab.name)
    toast(n ? `${tab.name}: ${n} knobs back to default` : `${tab.name} was already at the defaults`, n ? 'ok' : 'info')
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
    }
  }

  /** The code defaults, for the diff a per-site tuning.json is. */
  get baseline(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [name, k] of this.keys) out[name] = k.default
    return out
  }

  toggle() {
    this.dialog.toggle()
  }
}
