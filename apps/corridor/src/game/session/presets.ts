// The presets library: named snapshots of how a world looks, and the transitions between them.
//
// Rich, 2026-09-28:
//
//   "We need a presets manager that lets us use all of the realtime adjustable rendering options
//    and set them as the default for a world... end users with the tuning panel can override
//    these, but the tuning panel needs to apply over top of the level settings."
//
//   "We need to be able to apply these scripted from game interactions. In a long running story it
//    might all of a sudden become night and there might be a cut scene with rigged characters
//    acting. We need to be able to tween between environment states smoothly."
//
// Those two sentences set the whole design, and the second one is the one that matters: a preset
// is not a settings file, it is a KEYFRAME. So this is not a loader — it is a library of snapshots
// plus an animator that moves the live knobs between them.
//
// THREE LAYERS, ONE RESOLVE (docs/corridor/PLAN-GAME-PIPELINE.md):
//
//     world defaults   worlds/<slug>.json#look     "this place looks like this"
//          ↓ overridden by
//     level preset     levels/<id>.json#preset     "this game is set at dusk in the rain"
//          ↓ overridden by
//     live tuning      the F6 panel                "I am looking at something right now"
//
// The panel is not a fourth store, it is the TOP LAYER of the same one, which is what makes
// Rich's rule — "the tuning panel needs to apply over top" — a property of the resolve rather
// than a special case somewhere in the loader.
//
// THE GROUND STATE is world ← level with no session overrides, captured once at load. A program
// that tweens away from it always has somewhere to come home to, and a level that is reloaded
// mid-transition comes back to a defined state rather than to wherever the tween had reached.
//
// No THREE, no DOM: the whole thing runs against the `TuneAccess` seam that `sitetuning.ts`
// already defines, so a transition can be stepped and measured headlessly (presets.test.ts).
import type { TuneKey, TuneLerp, TuneScope } from '@apex/engine/app/TunePanel'
import type { TuneTab } from '../../tuning'
import type { TuneAccess } from '../../world/sitetuning'

export type { TuneLerp, TuneScope }

/** What a preset knows about one knob, resolved from the knob's own declaration. */
export interface KnobMeta {
  name: string
  scope: TuneScope
  lerp: TuneLerp
  min: number
  max: number
  step: number
  default: number
  hint?: string
  /** the tab and section it was declared in, for grouping in the editor */
  tab: string
  section: string
}

/** One snapshot. `values` holds only world-scope knobs; see `scopeOf`. */
export interface Preset {
  id: string
  name?: string
  note?: string
  values: Record<string, number>
}

/** The import/export envelope, in the same shape as the world bundles the service already writes. */
export interface PresetDoc {
  kind: 'corridor-presets'
  version: 1
  exported?: string
  /** the world these were authored against, so importing into the wrong one can be noticed */
  slug?: string
  presets: Preset[]
}

/**
 * A knob's tween behaviour, from its own declaration.
 *
 * DERIVED, not listed. A knob whose step is 1 over a range of a dozen or less is a switch or an
 * enumeration — WEATHER 0..4, SEASON -1..3, GRASS_TYPE -1..6 — and half of one of those is not a
 * state the renderer has. Interpolating it gives a frame of "sleet and a half". The alternative is
 * a hand-maintained list of discrete knobs, and four hand-typed tables in this codebase are the
 * reason things kept ending up in the road.
 */
export function lerpOf(k: TuneKey): TuneLerp {
  if (k.lerp) return k.lerp
  return k.step === 1 && k.max - k.min <= 12 ? 'step' : 'linear'
}

/** A knob's scope: its own, else its section's, else `machine` — see TuneScope. */
export function scopeOf(k: TuneKey, section?: { scope?: TuneScope }): TuneScope {
  return k.scope ?? section?.scope ?? 'machine'
}

/** Every knob the tabs declare, flattened, with scope and tween behaviour resolved. */
export function knobs(tabs: TuneTab[]): KnobMeta[] {
  const out: KnobMeta[] = []
  for (const tab of tabs) {
    for (const sec of tab.sections) {
      for (const k of sec.keys) {
        out.push({
          name: k.name,
          scope: scopeOf(k, sec),
          lerp: k.lerp ?? sec.lerp ?? lerpOf(k),
          min: k.min,
          max: k.max,
          step: k.step,
          default: k.default,
          hint: k.hint,
          tab: tab.name,
          section: sec.title,
        })
      }
    }
  }
  return out
}

/** The knobs a preset may carry: the world's decisions, never the machine's. */
export function worldKnobs(tabs: TuneTab[]): KnobMeta[] {
  return knobs(tabs).filter((k) => k.scope === 'world')
}

/**
 * Snapshot the live world-scope knobs.
 *
 * Only those that DIFFER from `baseline` where one is given, because a preset of two hundred
 * values is unreadable and turns every future default change into a merge conflict — the same
 * argument `saveSiteTuning` makes about the site file.
 */
export function capture(tabs: TuneTab[], access: TuneAccess, baseline?: Record<string, number>): Record<string, number> {
  const values: Record<string, number> = {}
  for (const k of worldKnobs(tabs)) {
    const v = access.get(k.name)
    if (v === undefined || !Number.isFinite(v)) continue
    if (baseline && baseline[k.name] !== undefined && Math.abs(baseline[k.name] - v) <= 1e-9) continue
    values[k.name] = v
  }
  return values
}

/**
 * The one resolve. Later layers win, key by key.
 *
 * Key by key and not layer by layer: a level that sets the weather must not also reset the season
 * the world chose, and a session that has touched the time of day must not drag the level's rain
 * back to the world default.
 */
export function resolve(...layers: (Record<string, number> | null | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const [k, v] of Object.entries(layer)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
  }
  return out
}

export type Ease = 'linear' | 'in' | 'out' | 'inOut'

export function ease(t: number, kind: Ease = 'inOut'): number {
  const x = Math.min(1, Math.max(0, t))
  switch (kind) {
    case 'in': return x * x
    case 'out': return 1 - (1 - x) * (1 - x)
    case 'inOut': return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x)
    default: return x
  }
}

export interface ApplyOpts {
  /** seconds; 0 or absent applies at once */
  over?: number
  ease?: Ease
  /** called once the transition has landed, or immediately for an instant apply */
  done?: () => void
}

/** A transition in flight. */
export interface Transition {
  readonly target: Record<string, number>
  readonly over: number
  /** 0..1 */
  readonly t: number
  cancel(): void
}

interface Leg {
  name: string
  from: number
  to: number
  lerp: TuneLerp
}

/**
 * The library, and the animator that moves between its entries.
 *
 * ONE transition at a time, and a second `apply` RE-BASES from wherever the first had reached
 * rather than queueing or blending. Two tweens writing the same knob is a knob that flickers, and
 * a queue means a cutscene that is still arriving at dusk while the story has moved on to dawn.
 */
export class Presets {
  private readonly meta = new Map<string, KnobMeta>()
  private library = new Map<string, Preset>()
  private legs: Leg[] = []
  private elapsed = 0
  private duration = 0
  private easing: Ease = 'inOut'
  private onDone: (() => void) | null = null
  private targetValues: Record<string, number> = {}

  /**
   * The state a reinitialisation returns to: world ← level, with no session overrides.
   *
   * Captured by the caller at load and handed in, NOT snapshotted from the live knobs here —
   * by the time anything asks, the panel may have been touched, and a ground state that includes
   * somebody's scratch values is not a ground state.
   */
  readonly ground: Record<string, number>

  private readonly access: TuneAccess
  /**
   * How a knob is written.
   *
   * `setExact` where the host has one: a tween must not be quantised to a slider's step, recorded
   * as the person's own opinion, or re-derive the world once per knob. Measured on the real page —
   * through `set`, a tween of WEATHER_RATE moved 0.5 → 0.6 → 0.65 in visible jumps because the
   * slider's step is 0.05.
   */
  private readonly write: (name: string, v: number) => boolean

  constructor(tabs: TuneTab[], access: TuneAccess, ground: Record<string, number> = {}) {
    this.access = access
    this.write = access.setExact ? (n, v) => access.setExact!(n, v) : (n, v) => access.set(n, v)
    for (const k of worldKnobs(tabs)) this.meta.set(k.name, k)
    this.ground = { ...ground }
  }

  /** The knobs a preset may carry, for the editor's list. */
  get knobs(): KnobMeta[] {
    return [...this.meta.values()]
  }

  list(): Preset[] {
    return [...this.library.values()]
  }

  get(id: string): Preset | null {
    return this.library.get(id) ?? null
  }

  /** Add or replace. Values outside the world scope are DROPPED, not carried and ignored. */
  put(p: Preset): Preset {
    const values: Record<string, number> = {}
    for (const [k, v] of Object.entries(p.values ?? {})) {
      const m = this.meta.get(k)
      if (!m || typeof v !== 'number' || !Number.isFinite(v)) continue
      values[k] = Math.min(m.max, Math.max(m.min, v))
    }
    const clean: Preset = { id: p.id, name: p.name, note: p.note, values }
    this.library.set(clean.id, clean)
    return clean
  }

  remove(id: string): boolean {
    return this.library.delete(id)
  }

  /** Replace the whole library from a document. Returns what was taken and what was not. */
  load(doc: PresetDoc | null | undefined, { merge = false } = {}): { loaded: string[]; dropped: string[] } {
    if (!merge) this.library.clear()
    const loaded: string[] = []
    const dropped: string[] = []
    for (const p of doc?.presets ?? []) {
      if (!p?.id) { dropped.push(String(p?.name ?? '(no id)')); continue }
      const before = Object.keys(p.values ?? {}).length
      const after = Object.keys(this.put(p).values).length
      loaded.push(p.id)
      if (after < before) dropped.push(`${p.id}: ${before - after} knob(s) not in this build`)
    }
    return { loaded, dropped }
  }

  toDoc(slug?: string): PresetDoc {
    return { kind: 'corridor-presets', version: 1, exported: new Date().toISOString(), slug, presets: this.list() }
  }

  /** Snapshot the live knobs as a new preset. */
  snapshot(id: string, opts: { name?: string; note?: string; baseline?: Record<string, number> } = {}): Preset {
    const values: Record<string, number> = {}
    for (const m of this.meta.values()) {
      const v = this.access.get(m.name)
      if (v === undefined || !Number.isFinite(v)) continue
      if (opts.baseline && opts.baseline[m.name] !== undefined && Math.abs(opts.baseline[m.name] - v) <= 1e-9) continue
      values[m.name] = v
    }
    return this.put({ id, name: opts.name, note: opts.note, values })
  }

  /** Which knobs in `target` cannot be interpolated, for the editor to say so while authoring. */
  stepped(target: string | Record<string, number>): string[] {
    const values = typeof target === 'string' ? this.get(target)?.values ?? {} : target
    return Object.keys(values).filter((k) => this.meta.get(k)?.lerp === 'step')
  }

  get active(): Transition | null {
    if (!this.legs.length) return null
    return {
      target: { ...this.targetValues },
      over: this.duration,
      t: this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1,
      cancel: () => this.stop(),
    }
  }

  /** Abandon a transition where it stands. The knobs keep the values they have reached. */
  stop(): void {
    this.legs = []
    this.elapsed = 0
    this.duration = 0
    this.onDone = null
    this.targetValues = {}
  }

  /**
   * Move the live knobs to a preset, over `over` seconds.
   *
   * `api.preset('dusk-rain', { over: 8 })`, and `api.preset(presets.ground)` to go home.
   */
  apply(target: string | Record<string, number>, opts: ApplyOpts = {}): Transition | null {
    const values = typeof target === 'string' ? this.get(target)?.values : target
    if (!values) return null
    const over = Math.max(0, opts.over ?? 0)
    if (!over) {
      for (const [k, v] of Object.entries(values)) if (this.meta.has(k)) this.access.set(k, v)
      this.stop()
      opts.done?.()
      return null
    }
    // re-base from where the knobs ARE, which for an interrupted transition is mid-flight
    this.legs = []
    for (const [k, v] of Object.entries(values)) {
      const m = this.meta.get(k)
      if (!m) continue
      const from = this.access.get(k)
      if (from === undefined || !Number.isFinite(from)) continue
      if (Math.abs(from - v) <= 1e-9) continue
      this.legs.push({ name: k, from, to: v, lerp: m.lerp })
    }
    this.targetValues = { ...values }
    this.duration = over
    this.elapsed = 0
    this.easing = opts.ease ?? 'inOut'
    this.onDone = opts.done ?? null
    if (!this.legs.length) {
      // nothing to move — still a completed transition, or a cutscene waits forever on it
      this.stop()
      opts.done?.()
      return null
    }
    return this.active
  }

  /**
   * Advance the transition by `dt` seconds. Safe to call with nothing in flight.
   *
   * REAL SECONDS, not simulated: `TIME_RATE` is itself a knob a preset may tween, and driving the
   * animator off simulated time makes a transition that speeds up as it changes the clock.
   *
   * Returns whether it wrote anything, so the caller knows to re-derive whatever reads these
   * knobs. Without that the sliders move and the sky does not, which is a tween that only the
   * panel can see.
   */
  tick(dt: number): boolean {
    if (!this.legs.length) return false
    this.elapsed += Math.max(0, dt)
    const raw = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1
    const e = ease(raw, this.easing)
    for (const leg of this.legs) {
      // a step knob snaps at the MIDPOINT of the eased curve, so it lands with the look rather
      // than at the moment the transition was asked for
      const v = leg.lerp === 'step' ? (e < 0.5 ? leg.from : leg.to) : leg.from + (leg.to - leg.from) * e
      this.write(leg.name, v)
    }
    if (raw >= 1) {
      // land exactly on the target: `from + (to - from) * 1` is not `to` in binary floating point
      for (const leg of this.legs) this.write(leg.name, leg.to)
      const done = this.onDone
      this.stop()
      done?.()
    }
    return true
  }
}
