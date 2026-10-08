// Display ▸ Detail: four levels, each a set of LOD knob values, that reset the knobs when chosen and
// leave the panel's overrides alone at load (Rich, 2026-10-08).
import { describe, expect, it } from 'vitest'
import { DETAILS, DETAIL_PRESETS, applyDetail, type DetailTarget } from '../src/game/session/detail'
import { TUNE_TABS } from '../src/tuning'

const knobs = new Set(TUNE_TABS.flatMap((t) => t.sections.flatMap((s) => s.keys.map((k) => k.name))))

describe('the detail presets', () => {
  it('name only knobs the panel has, and every level sets the same ones', () => {
    const names = Object.keys(DETAIL_PRESETS.ultra).sort()
    for (const d of DETAILS) {
      expect(Object.keys(DETAIL_PRESETS[d]).sort()).toEqual(names)
      for (const n of names) expect(knobs.has(n), `${n} is not a knob`).toBe(true)
    }
  })

  it('get lighter from ultra down to low', () => {
    const { ultra, high, medium, low } = DETAIL_PRESETS
    // ultra: everything at full
    expect(ultra.LOD_PROP_RATIO).toBe(1)
    expect(ultra.LOD_HERO_RATIO).toBe(1)
    expect(ultra.LOD_TRAFFIC_FULL_N).toBeGreaterThanOrEqual(4000)
    // high: small props simplified, traffic and the hero still full
    expect(high.LOD_PROP_RATIO).toBeLessThan(1)
    expect(high.LOD_TRAFFIC_FULL_N).toBe(ultra.LOD_TRAFFIC_FULL_N)
    expect(high.LOD_HERO_RATIO).toBe(1)
    // medium: a budget of full-detail traffic
    expect(medium.LOD_TRAFFIC_FULL_N).toBeLessThan(high.LOD_TRAFFIC_FULL_N)
    expect(medium.LOD_TRAFFIC_FULL_N).toBeGreaterThan(0)
    // low: everything simplified, the hero included
    expect(low.LOD_TRAFFIC_FULL_N).toBe(0)
    expect(low.LOD_HERO_RATIO).toBeLessThan(1)
  })
})

describe('applying a level', () => {
  /** a panel in miniature: values, and the names this browser has overridden */
  function panel(touched: string[]) {
    const values: Record<string, number> = {}
    const t = new Set(touched)
    const target: DetailTarget = {
      applyPreset: (vals, force) => {
        let n = 0
        for (const [k, v] of Object.entries(vals)) {
          if (!force && t.has(k)) continue
          if (force) t.delete(k)
          if (values[k] !== v) { values[k] = v; n++ }
        }
        return n
      },
    }
    return { values, touched: t, target }
  }

  it('at load leaves an overridden knob alone; chosen, it resets it and forgets the override', () => {
    const p = panel(['LOD_PROP_RATIO'])
    p.values.LOD_PROP_RATIO = 0.5
    applyDetail(p.target, 'high', false)
    expect(p.values.LOD_PROP_RATIO).toBe(0.5) // the panel's override survives a page load
    expect(p.values.LOD_TRAFFIC_FULL_N).toBe(DETAIL_PRESETS.high.LOD_TRAFFIC_FULL_N)
    applyDetail(p.target, 'medium', true)
    expect(p.values.LOD_PROP_RATIO).toBe(DETAIL_PRESETS.medium.LOD_PROP_RATIO) // choosing a level resets it
    expect(p.touched.has('LOD_PROP_RATIO')).toBe(false)
  })
})
