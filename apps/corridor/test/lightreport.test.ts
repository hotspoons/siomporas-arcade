// The lighting panel's arithmetic: does it count what is really in the loop, and does the family
// report say something useful when the ablation has not run?
//
// Rich, 2026-10-05: *"a new panel ... that includes lighting reports"*. The report has to agree with
// the scene, so the loop count comes from the lights that are actually ON, not from the ones that
// merely exist — a spot hidden by a mode change must not appear in the forward-loop size.
import { describe, expect, it } from 'vitest'
import { lightDumpRows, lightLines, type LightReport } from '../src/ui/lightreport'

const report = (over: Partial<LightReport> = {}): LightReport => ({
  counts: [
    { type: 'spot', n: 3, on: 2 },
    { type: 'dir', n: 1, on: 1 },
    { type: 'hemi', n: 1, on: 1 },
  ],
  shadowCasters: 1,
  shadowMap: 2048,
  programs: 42,
  families: [
    { name: 'head', mode: 'real', lamps: 2, cost: 2.5 },
    { name: 'tail', mode: 'merged', lamps: 1, cost: 1.0 },
    { name: 'traffic', mode: 'real', lamps: 6, cost: 2.6 },
    { name: 'flood', mode: 'on', lamps: 8, cost: 0 },
  ],
  all: 17.9,
  measuredAt: null,
  note: null,
  lights: [
    { type: 'spot', family: 'hero-head', on: true, intensity: 2, distance: 70, angle: 38, shadow: false },
    { type: 'spot', family: 'hero-tail', on: false, intensity: 0, distance: 1.5, angle: 20, shadow: false },
    { type: 'dir', family: 'sun', on: true, intensity: 2, distance: 0, angle: 0, shadow: true },
  ],
  ...over,
})

describe('the lighting report', () => {
  it('lists the inventory in a fixed order, with the on-count only when it differs', () => {
    const lines = lightLines(report())
    expect(lines[0]).toBe('1 dir · 3 spot (2 on) · 1 hemi')
    expect(lines[1]).toBe('shadow 1 caster · map 2048² · 42 programs')
  })

  it('sizes the forward loop from the lights that are ON', () => {
    // three builds NUM_SPOT_LIGHTS from the visible spots: 2, not the 3 that exist
    expect(lightLines(report())[2]).toBe('loop 1 dir + 2 spot = 3 forward lights')
  })

  it('reports each family with its mode, lamps and measured cost', () => {
    const lines = lightLines(report())
    expect(lines).toContain('head    real · 2 lamps · 2.5 ms')
    expect(lines).toContain('tail    merged · 1 lamp · 1.0 ms')
    expect(lines).toContain('traffic real · 6 lamps · 2.6 ms')
  })

  it('shares the budget against the whole frame, mentioning the measurement time', () => {
    const at = Date.UTC(2026, 9, 5, 21, 3, 0)
    const line = lightLines(report({ measuredAt: at })).find((t) => t.startsWith('budget'))!
    // 2.5 + 1.0 + 2.6 + 0 = 6.1 of 17.9 ≈ 34%
    expect(line).toMatch(/17\.9 ms all · 6\.1 ms lights \(34%\)/)
  })

  it('says so plainly when the ablation has not run', () => {
    const line = lightLines(report({ all: null, note: null })).find((t) => t.startsWith('budget'))!
    expect(line).toBe('budget not measured — press measure')
  })

  it('passes on the reason the budget is missing', () => {
    const line = lightLines(report({ all: null, note: 'no gpu timer on this context' })).find((t) => t.startsWith('budget'))!
    expect(line).toBe('budget no gpu timer on this context')
  })

  it('still says something for a scene with no lights', () => {
    const lines = lightLines(report({ counts: [], families: [], lights: [], all: null }))
    expect(lines[0]).toBe('no lights in the scene')
    expect(lines[2]).toBe('loop 0 = 0 forward lights')
  })
})

describe('the per-light dump', () => {
  it('marks a light off, names its family, and keeps the cone only for a spot', () => {
    const rows = lightDumpRows(report())
    expect(rows[0]).toContain('● spot  hero-head')
    expect(rows[0]).toContain('a38°')
    expect(rows[1]).toContain('○ spot  hero-tail') // trailing space is part of the aligned row
    expect(rows[2]).toMatch(/^● dir\s+sun\s+i2\.00 shadow$/)
  })

  it('leaves the family blank rather than inventing one', () => {
    const rows = lightDumpRows(report({ lights: [{ type: 'point', family: '', on: true, intensity: 1, distance: 10, angle: 0, shadow: false }] }))
    expect(rows[0]).toContain('—')
  })
})
