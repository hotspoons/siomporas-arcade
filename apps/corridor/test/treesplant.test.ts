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
  TREE_ROAD_CLEAR_M: 4.5,
  TREE_REPLANT_M: 30,
}))
vi.mock('../src/tuning', () => knobs)

import { treesFromCanopy } from '../src/world/props'

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

  it('re-measures a standing tree when pavement arrives under it', () => {
    // a lazy branch streams in beneath a tree already planted: the cell was never re-asked
    const gone = new Set<string>()
    const exclude = (x: number, y: number) => gone.has(`${Math.floor(x / 10)},${Math.floor(y / 10)}`)
    const chm = new Float32Array(4)
    const t = treesFromCanopy(chm, [2, 2], [-200, -200, 200, 200], 10, () => 0, 5000, 3, exclude, undefined, {
      canopyAt: () => 8,
      centre: [0, 0],
      cellM: 10,
      radius: 40,
    })
    drain(t)
    const idx = t.records.findIndex((r) => Number.isFinite(r.x) && r.ci === 0 && r.cj === 0)
    expect(idx).toBeGreaterThanOrEqual(0)
    const rec = t.records[idx]
    const before = t.stats().count
    gone.add(`${rec.ci},${rec.cj}`)
    t.invalidateRegion(rec.x, rec.z, rec.x, rec.z)
    expect(Number.isFinite(t.records[idx].x)).toBe(false)
    t.plant(0, 0)
    drain(t)
    const stillThere = t.records.some((r) => Number.isFinite(r.x) && r.ci === rec.ci && r.cj === rec.cj)
    expect(stillThere).toBe(false)
    expect(t.stats().count).toBeLessThan(before)
  })

  it('replants by block: a block that stays is not walked, one that crosses the draw radius flips its trees together', () => {
    // 100 m blocks over a 10 m lattice, a 150 m draw radius and a 150 m spare ring: a 120 m move
    // keeps most of the disc where it was. Before the block index every record was visited on
    // every replant; now only the blocks that crossed a radius are.
    knobs.TREE_PLANT_RADIUS_M = 150
    knobs.TREE_SPARE_M = 150
    const chm = new Float32Array(4)
    const t = treesFromCanopy(chm, [2, 2], [-600, -600, 600, 600], 10, () => 0, 20000, 3, () => false, undefined, {
      canopyAt: () => 8,
      centre: [0, 0],
      cellM: 10,
      radius: 150,
    })
    drain(t)
    const s0 = t.stats()
    expect(s0.pending).toBe(0)
    expect(s0.blocks).toBeGreaterThan(4)
    expect(s0.records).toBe(t.records.length)
    // a tree 205 m east sits in the block centred (250, 50): 255 m from the eye it is spare,
    // and 139 m from an eye at (120, 0) its whole block is drawn
    const far = t.records.findIndex((r) => Number.isFinite(r.x) && r.ci === 20 && r.cj === 0)
    expect(far).toBeGreaterThanOrEqual(0)
    expect(t.records[far].spare).toBe(true)
    t.plant(120, 0)
    const s1 = t.stats()
    expect(s1.walked).toBeGreaterThan(0)
    expect(s1.walked).toBeLessThan(s0.records * 0.6)
    const note = t.patch()
    expect(note.shown).toContain(far)
    expect(t.records[far].spare).toBe(false)
    // every tree of that block changed together: none of its siblings is still spare
    for (const r of t.records) {
      if (!Number.isFinite(r.x)) continue
      if (Math.floor(r.x / 100) === 2 && Math.floor(-r.z / 100) === 0) expect(r.spare).toBe(false)
    }
    // the trees that left the context ring went out as whole blocks, with their positions for the grids
    expect(note.removed.length).toBeGreaterThan(0)
    expect(note.removed.length * 2).toBe(note.removedAt.length)
    expect(note.removed.every((i) => !Number.isFinite(t.records[i].x))).toBe(true)
    // and a block still inside the ring kept every tree, even past the old per-record rim: the
    // block centred (-150, 50) is 275 m from the new eye, inside the 300 m context ring, so its
    // tree at x = -195 stays although it is now 315 m out
    const kept = t.records.filter((r) => Number.isFinite(r.x) && Math.floor(r.x / 100) === -2 && Math.floor(-r.z / 100) === 0)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.some((r) => Math.hypot(r.x - 120, r.z) > 300)).toBe(true)
    // a replant that does not move the centre (a branch arriving asks for one) walks nothing
    t.plant(120, 0)
    expect(t.stats().walked).toBe(0)
    expect(t.patch().removed).toEqual([])
  })
})
