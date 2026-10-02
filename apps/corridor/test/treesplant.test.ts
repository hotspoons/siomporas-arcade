// Crescent replant: a tree that stays keeps its slot, and the cells that entered are measured
// across pump() calls instead of in the plant() that noticed the eye had moved.
import { afterEach, describe, expect, it, vi } from 'vitest'

const knobs = vi.hoisted(() => ({
  LANE_WIDTH: 3.66,
  SHOULDER_OUT: 3,
  SHOULDER_IN: 1,
  TREE_CELL_M: 10,
  TREE_PLANT_RADIUS_M: 40,
  TREE_SPARE_M: 0,
  TREE_PATCH: 1,
  TREE_MIN_H: 3,
  TREE_DENSITY: 1,
  TREE_HEIGHT_SCALE: 1,
  TREE_REPLANT_M: 30,
}))
vi.mock('../src/tuning', () => knobs)

import { treesFromCanopy } from '../src/props'

afterEach(() => {
  knobs.TREE_CELL_M = 10
  knobs.TREE_PLANT_RADIUS_M = 40
  knobs.TREE_SPARE_M = 0
  knobs.TREE_PATCH = 1
  knobs.TREE_MIN_H = 3
  knobs.TREE_DENSITY = 1
  knobs.TREE_HEIGHT_SCALE = 1
})

function wood(budget: number) {
  const chm = new Float32Array(4)
  return treesFromCanopy(chm, [2, 2], [-200, -200, 200, 200], 10, () => 0, budget, 3, () => false, undefined, {
    canopyAt: () => 8,
    centre: [0, 0],
    cellM: 10,
    radius: 40,
  })
}

function drain(t: ReturnType<typeof wood>) {
  let guard = 0
  while (t.stats().pending > 0 && guard++ < 80) t.pump(8)
  return guard
}

describe('crescent replant', () => {
  it('keeps a staying tree in its slot and fills the new cells across pumps', () => {
    const t = wood(5000)
    const before = t.stats()
    expect(before.pending).toBe(0)
    expect(before.count).toBeGreaterThan(10)
    const stay = t.records.findIndex((r) => r.ci === 0 && r.cj === 0)
    expect(stay).toBeGreaterThanOrEqual(0)
    const at = { x: t.records[stay].x, z: t.records[stay].z }

    const n = t.plant(30, 0)
    const mid = t.stats()
    expect(mid.pending).toBeGreaterThan(0)
    expect(t.records[stay].x).toBe(at.x)
    expect(t.records[stay].z).toBe(at.z)
    expect(t.patch().changed).toEqual([])

    const steps = drain(t)
    expect(steps).toBeGreaterThan(0)
    expect(t.stats().pending).toBe(0)
    expect(t.records[stay].x).toBe(at.x)
    const seen = new Set<string>()
    for (const r of t.records) {
      if (!Number.isFinite(r.x)) continue
      const key = `${r.ci},${r.cj}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
    expect(t.stats().count).toBeGreaterThanOrEqual(n)
    const ahead = t.records.filter((r) => Number.isFinite(r.x) && r.ci >= 6).length
    expect(ahead).toBeGreaterThan(3)
  })

  it('does not grow past the budget', () => {
    const t = wood(8)
    expect(t.stats().count).toBe(8)
    expect(t.stats().capped).toBe(true)
    t.plant(30, 0)
    drain(t)
    expect(t.stats().count).toBeLessThanOrEqual(8)
    const note = t.patch()
    expect(note.changed.filter((i) => note.removed.includes(i))).toEqual([])
  })
})
