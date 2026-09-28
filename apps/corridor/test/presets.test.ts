// Does the presets library behave like a keyframe store, and does the resolve put the layers in
// the order Rich asked for?
//
// Two things are being proved, and they fail differently.
//
// THE RESOLVE is a precedence rule — "the tuning panel needs to apply over top of the level
// settings" — and it fails silently: a level that sets the weather also resets the season, or a
// value somebody moved in the panel snaps back on the next frame. So the tests state the
// precedence key by key rather than layer by layer.
//
// THE TWEEN is an animation, and it fails visibly but only in a cutscene nobody is watching in a
// unit test: a stepped knob interpolated to "sleet and a half", a transition that arrives at
// 2.9997 and leaves WEATHER one short, a second `apply` that fights the first. So the tests step
// it by hand and read the knobs.
import { describe, expect, it } from 'vitest'
import { tune } from '@apex/engine/app/TunePanel'
import { Presets, capture, ease, knobs, lerpOf, resolve, scopeOf, worldKnobs } from '../src/presets'
import { TUNE_TABS, type TuneTab } from '../src/tuning'
import type { TuneAccess } from '../src/sitetuning'

/** A tuning store with no browser and no renderer behind it. */
function store(init: Record<string, number>): TuneAccess & { values: Record<string, number> } {
  const values = { ...init }
  return {
    values,
    get: (n) => values[n],
    set: (n, v) => { if (!(n in values)) return false; values[n] = v; return true },
    names: () => Object.keys(values),
  }
}

/** A tiny tab set with one knob of each kind, so a test does not depend on corridor's real knobs. */
function tabs(v: Record<string, number>): TuneTab[] {
  const g = (n: string) => () => v[n]
  const s = (n: string) => (x: number) => { v[n] = x }
  return [{
    name: 'test',
    sections: [
      {
        title: 'world things',
        scope: 'world',
        keys: [
          tune('FOG', g('FOG'), s('FOG'), [0, 1], 0.01),
          tune('WEATHER', g('WEATHER'), s('WEATHER'), [0, 4], 1),
          tune('RELIEF', g('RELIEF'), s('RELIEF'), [0, 4], 0.05),
        ],
      },
      {
        title: 'machine things',
        keys: [tune('SHADOW_RES', g('SHADOW_RES'), s('SHADOW_RES'), [512, 4096], 512)],
      },
      {
        title: 'mostly machine',
        keys: [tune('SPLAT_ON', g('SPLAT_ON'), s('SPLAT_ON'), [0, 1], 1, undefined, { scope: 'world' })],
      },
    ],
  }]
}

const VALUES = () => ({ FOG: 0.2, WEATHER: 0, RELIEF: 1, SHADOW_RES: 2048, SPLAT_ON: 1 })

describe('scope', () => {
  it('defaults to machine, so a new knob cannot leak into a preset by being forgotten', () => {
    const v = VALUES()
    const names = worldKnobs(tabs(v)).map((k) => k.name)
    expect(names).toContain('FOG')
    expect(names).not.toContain('SHADOW_RES')
  })

  it('lets a knob override its section', () => {
    const v = VALUES()
    expect(worldKnobs(tabs(v)).map((k) => k.name)).toContain('SPLAT_ON')
  })

  it('reads a knob first, then its section, then machine', () => {
    const k = tune('X', () => 1, () => {}, [0, 2], 0.1)
    expect(scopeOf(k)).toBe('machine')
    expect(scopeOf(k, { scope: 'world' })).toBe('world')
    expect(scopeOf({ ...k, scope: 'machine' }, { scope: 'world' })).toBe('machine')
  })
})

describe('lerpOf', () => {
  it('calls a narrow integer knob discrete, because half of sleet is not a state', () => {
    // derived from the declaration, not from a hand-kept list: WEATHER is 0..4 step 1
    expect(lerpOf(tune('WEATHER', () => 0, () => {}, [0, 4], 1))).toBe('step')
    expect(lerpOf(tune('SEASON', () => 0, () => {}, [-1, 3], 1))).toBe('step')
    expect(lerpOf(tune('ON', () => 0, () => {}, [0, 1], 1))).toBe('step')
  })

  it('calls a wide or fractional knob continuous', () => {
    expect(lerpOf(tune('FOG', () => 0.2, () => {}, [0, 1], 0.01))).toBe('linear')
    expect(lerpOf(tune('SIGNAL_GREEN', () => 60, () => {}, [5, 180], 1))).toBe('linear')
  })

  it('takes an explicit declaration over the guess', () => {
    expect(lerpOf(tune('W', () => 0, () => {}, [0, 4], 1, undefined, { lerp: 'mix' }))).toBe('mix')
  })
})

describe('resolve', () => {
  it('lets a later layer win key by key, not layer by layer', () => {
    const world = { FOG: 0.2, SEASON: 2, WEATHER: 0 }
    const level = { WEATHER: 1 }
    const session = { FOG: 0.9 }
    // the level set the weather and must not have reset the season the world chose; the session
    // touched the fog and must not have dragged the level's rain back to clear
    expect(resolve(world, level, session)).toEqual({ FOG: 0.9, SEASON: 2, WEATHER: 1 })
  })

  it('ignores a missing layer and a junk value', () => {
    expect(resolve(null, { A: 1 }, undefined, { B: Number.NaN, C: 2 })).toEqual({ A: 1, C: 2 })
  })
})

describe('capture', () => {
  it('takes the world knobs and leaves the machine ones', () => {
    const v = VALUES()
    const got = capture(tabs(v), store(v))
    expect(Object.keys(got).sort()).toEqual(['FOG', 'RELIEF', 'SPLAT_ON', 'WEATHER'])
  })

  it('records only what differs from a baseline', () => {
    const v = VALUES()
    const a = store(v)
    a.set('FOG', 0.7)
    expect(capture(tabs(a.values), a, { FOG: 0.2, WEATHER: 0, RELIEF: 1, SPLAT_ON: 1 })).toEqual({ FOG: 0.7 })
  })
})

describe('Presets', () => {
  it('writes a tween through setExact, so it is not quantised to a slider step', () => {
    // MEASURED ON THE REAL PAGE. Through the panel's own `set`, a tween of WEATHER_RATE moved
    // 0.5 → 0.6 → 0.65: the redraw dispatches an `input` on the range, the browser snaps that to
    // the slider's 0.05 step, and the handler writes the snapped value back. Twenty visible jumps
    // in what is supposed to be a smooth transition.
    const values: Record<string, number> = { FOG: 0, WEATHER: 0, RELIEF: 1, SHADOW_RES: 2048, SPLAT_ON: 1 }
    const exact: number[] = []
    const snapped: number[] = []
    const access: TuneAccess = {
      get: (n) => values[n],
      set: (n, v) => { snapped.push(v); values[n] = Math.round(v * 20) / 20; return true },
      setExact: (n, v) => { exact.push(v); values[n] = v; return true },
      names: () => Object.keys(values),
    }
    const p = new Presets(tabs(values), access)
    p.put({ id: 'a', values: { FOG: 1 } })
    p.apply('a', { over: 4, ease: 'linear' })
    p.tick(1)
    expect(exact).toEqual([0.25])
    expect(snapped).toEqual([])
    expect(values.FOG).toBe(0.25)
  })

  it('falls back to set when the host has no exact setter', () => {
    const values: Record<string, number> = { FOG: 0, WEATHER: 0, RELIEF: 1, SHADOW_RES: 2048, SPLAT_ON: 1 }
    const seen: number[] = []
    const access: TuneAccess = {
      get: (n) => values[n],
      set: (n, v) => { seen.push(v); values[n] = v; return true },
      names: () => Object.keys(values),
    }
    const p = new Presets(tabs(values), access)
    p.put({ id: 'a', values: { FOG: 1 } })
    p.apply('a', { over: 4, ease: 'linear' })
    p.tick(1)
    expect(seen).toEqual([0.25])
  })

  const make = (init = VALUES()) => {
    const a = store(init)
    return { a, p: new Presets(tabs(a.values), a, { FOG: 0.2, WEATHER: 0 }) }
  }

  it('drops values that are not world knobs rather than carrying them silently', () => {
    const { p } = make()
    const put = p.put({ id: 'x', values: { FOG: 0.5, SHADOW_RES: 512, NONSENSE: 3 } })
    expect(put.values).toEqual({ FOG: 0.5 })
  })

  it('clamps a value to the knob it belongs to', () => {
    const { p } = make()
    expect(p.put({ id: 'x', values: { FOG: 9, WEATHER: -5 } }).values).toEqual({ FOG: 1, WEATHER: 0 })
  })

  it('applies at once when no duration is given', () => {
    const { a, p } = make()
    p.put({ id: 'dusk', values: { FOG: 0.8, WEATHER: 1 } })
    p.apply('dusk')
    expect(a.values.FOG).toBe(0.8)
    expect(a.values.WEATHER).toBe(1)
    expect(p.active).toBeNull()
  })

  it('moves a continuous knob smoothly', () => {
    const { a, p } = make()
    p.put({ id: 'fog', values: { FOG: 1 } })
    p.apply('fog', { over: 4, ease: 'linear' })
    p.tick(1)
    expect(a.values.FOG).toBeCloseTo(0.4, 6)
    p.tick(1)
    expect(a.values.FOG).toBeCloseTo(0.6, 6)
    p.tick(2)
    expect(a.values.FOG).toBe(1)
    expect(p.active).toBeNull()
  })

  it('lands EXACTLY on the target, not near enough', () => {
    // `from + (to - from) * 1` is not `to` in binary floating point — 0.03 → 0.3 arrives at
    // 0.30000000000000004. On a continuous knob nobody sees it; the same one-ulp miss on an
    // integer knob leaves the weather at 2.9999999999999996 and anything comparing it to 3 is
    // wrong forever. So the last tick assigns the target rather than interpolating to it.
    const { a, p } = make({ ...VALUES(), FOG: 0.03 })
    expect(0.03 + (0.3 - 0.03)).not.toBe(0.3) // the premise, stated so it cannot rot
    p.put({ id: 'to', values: { FOG: 0.3 } })
    p.apply('to', { over: 1, ease: 'linear' })
    p.tick(1)
    expect(a.values.FOG).toBe(0.3)
  })

  it('snaps a discrete knob at the midpoint instead of inventing a state', () => {
    const { a, p } = make()
    p.put({ id: 'rain', values: { WEATHER: 3 } })
    p.apply('rain', { over: 10, ease: 'linear' })
    p.tick(4)
    expect(a.values.WEATHER).toBe(0) // not 1.2
    p.tick(2)
    expect(a.values.WEATHER).toBe(3)
    p.tick(4)
    expect(a.values.WEATHER).toBe(3)
  })

  it('names the knobs that cannot be tweened, so an author finds out while authoring', () => {
    const { p } = make()
    p.put({ id: 'mix', values: { FOG: 0.5, WEATHER: 2, RELIEF: 3 } })
    expect(p.stepped('mix').sort()).toEqual(['WEATHER'])
  })

  it('re-bases an interrupted transition from where the knobs actually are', () => {
    const { a, p } = make()
    p.put({ id: 'a', values: { FOG: 1 } })
    p.put({ id: 'b', values: { FOG: 0 } })
    p.apply('a', { over: 4, ease: 'linear' })
    p.tick(2) // FOG is 0.6 now
    expect(a.values.FOG).toBeCloseTo(0.6, 6)
    p.apply('b', { over: 2, ease: 'linear' })
    p.tick(1)
    // halfway from 0.6 to 0, not halfway from 1 — the second tween must not fight the first
    expect(a.values.FOG).toBeCloseTo(0.3, 6)
    p.tick(1)
    expect(a.values.FOG).toBe(0)
  })

  it('reports progress and can be cancelled where it stands', () => {
    const { a, p } = make()
    p.put({ id: 'a', values: { FOG: 1 } })
    const t = p.apply('a', { over: 4, ease: 'linear' })
    expect(t?.t).toBe(0)
    p.tick(1)
    expect(p.active?.t).toBeCloseTo(0.25, 6)
    p.active?.cancel()
    expect(p.active).toBeNull()
    const held = a.values.FOG
    p.tick(10)
    expect(a.values.FOG).toBe(held) // cancelled means stopped, not rewound
  })

  it('calls done once the transition lands, and at once for an instant apply', () => {
    const { p } = make()
    p.put({ id: 'a', values: { FOG: 1 } })
    let n = 0
    p.apply('a', { over: 2, ease: 'linear', done: () => { n += 1 } })
    p.tick(1)
    expect(n).toBe(0)
    p.tick(1)
    expect(n).toBe(1)
    p.tick(1)
    expect(n).toBe(1)
    p.apply('a', { done: () => { n += 1 } })
    expect(n).toBe(2)
  })

  it('completes a transition that has nothing to move, rather than waiting forever', () => {
    // a cutscene that awaits `done` on a preset already in effect would hang on the first frame
    const { p } = make()
    p.put({ id: 'same', values: { FOG: 0.2 } })
    let done = false
    p.apply('same', { over: 5, done: () => { done = true } })
    expect(done).toBe(true)
    expect(p.active).toBeNull()
  })

  it('goes home to the ground state', () => {
    const { a, p } = make()
    p.put({ id: 'storm', values: { FOG: 1, WEATHER: 3 } })
    p.apply('storm')
    expect(a.values.FOG).toBe(1)
    p.apply(p.ground)
    expect(a.values.FOG).toBe(0.2)
    expect(a.values.WEATHER).toBe(0)
  })

  it('keeps the ground state even after the live knobs have been dragged around', () => {
    const { a, p } = make()
    a.set('FOG', 0.95)
    p.snapshot('now')
    expect(p.ground.FOG).toBe(0.2)
  })

  it('round-trips through a document', () => {
    const { p } = make()
    p.put({ id: 'dusk', name: 'Dusk', note: 'low sun', values: { FOG: 0.6, WEATHER: 1 } })
    const doc = p.toDoc('crofton-triangle')
    expect(doc.kind).toBe('corridor-presets')
    expect(doc.slug).toBe('crofton-triangle')

    const { p: q } = make()
    const r = q.load(JSON.parse(JSON.stringify(doc)))
    expect(r.loaded).toEqual(['dusk'])
    expect(q.get('dusk')).toEqual(p.get('dusk'))
  })

  it('says which knobs a document carried that this build does not have', () => {
    const { p } = make()
    const r = p.load({ kind: 'corridor-presets', version: 1, presets: [{ id: 'old', values: { FOG: 0.5, GONE_KNOB: 2 } }] })
    expect(r.loaded).toEqual(['old'])
    expect(r.dropped.join(' ')).toContain('1 knob')
  })

  it('snapshots the live knobs as a preset', () => {
    const { a, p } = make()
    a.set('FOG', 0.75)
    a.set('SHADOW_RES', 512)
    const snap = p.snapshot('now', { name: 'Now' })
    expect(snap.values.FOG).toBe(0.75)
    expect(snap.values).not.toHaveProperty('SHADOW_RES')
  })
})

describe('ease', () => {
  it('starts at 0, ends at 1 and is monotonic', () => {
    for (const kind of ['linear', 'in', 'out', 'inOut'] as const) {
      expect(ease(0, kind)).toBe(0)
      expect(ease(1, kind)).toBe(1)
      let prev = -1
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const v = ease(t, kind)
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
        prev = v
      }
    }
  })

  it('clamps outside 0..1', () => {
    expect(ease(-3)).toBe(0)
    expect(ease(4)).toBe(1)
  })
})

describe("corridor's real knobs", () => {
  it('marks the world and leaves the machine alone', () => {
    const all = knobs(TUNE_TABS)
    const world = all.filter((k) => k.scope === 'world').map((k) => k.name)
    // the world's decisions
    for (const n of ['WEATHER', 'TIME_RATE', 'SEASON', 'GRASS_TYPE', 'LANE_WIDTH', 'SPLAT_ENABLED']) {
      expect(world, n).toContain(n)
    }
    // the machine's capabilities. A level that pins these is unplayable on a laptop.
    for (const n of ['ENGINE_SIM_HZ', 'STAR_PIXELS', 'SPLAT_BUDGET_MB', 'SPLAT_SORT_MS']) {
      expect(world, n).not.toContain(n)
    }
    expect(world.length).toBeGreaterThan(100)
    expect(all.length).toBeGreaterThan(world.length)
  })

  it('finds the discrete ones', () => {
    const stepped = knobs(TUNE_TABS).filter((k) => k.scope === 'world' && k.lerp === 'step').map((k) => k.name)
    for (const n of ['WEATHER', 'SEASON', 'GRASS_TYPE']) expect(stepped, n).toContain(n)
    // and does not call a continuous one discrete
    for (const n of ['WEATHER_RATE', 'TIME_RATE', 'LANE_WIDTH']) expect(stepped, n).not.toContain(n)
  })

  it('gives every world knob a section and a tab to sit under in the editor', () => {
    for (const k of worldKnobs(TUNE_TABS)) {
      expect(k.tab, k.name).toBeTruthy()
      expect(k.section, k.name).toBeTruthy()
    }
  })
})
