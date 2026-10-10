// Trees out of buildings, bare cells asked again when finer canopy arrives, and the reasons the
// perf panel prints. Rich, 2026-10-10, dc-metro-take-2 on Belcrest Road: trees growing through
// high-rises, and swaths of woods with no trees that were there a tile over.
import { afterEach, describe, expect, it, vi } from 'vitest'

const knobs = vi.hoisted(() => ({
  LANE_WIDTH: 3.66,
  SHOULDER_OUT: 3,
  SHOULDER_IN: 1,
  TREE_CELL_M: 10,
  TREE_PLANT_RADIUS_M: 60,
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
import { FootprintMask, inRing } from '../src/world/footprintmask'

afterEach(() => {
  knobs.TREE_MIN_H = 3
})

type Planter = ReturnType<typeof treesFromCanopy>
const drain = (t: Planter) => {
  let guard = 0
  while ((t.stats().pending > 0 || t.diagnose(0, 0, 1).redo > 0) && guard++ < 200) t.pump(8)
  return guard
}
const liveIn = (t: Planter, x0: number, x1: number) => t.records.filter((r) => Number.isFinite(r.x) && r.x >= x0 && r.x <= x1).length

describe('a canopy tile arriving', () => {
  // the coarse level answered 0 east of x = 0; the fine tile that arrives later has woods there
  function coarseThenFine() {
    let fine = false
    const canopyAt = (x: number) => (x < 0 || fine ? 8 : 0)
    const t = treesFromCanopy(new Float32Array(4), [2, 2], [-200, -200, 200, 200], 10, () => 0, 5000, 3, () => false, undefined, {
      canopyAt: (x) => canopyAt(x),
      centre: [0, 0],
      cellM: 10,
      radius: 60,
    })
    drain(t)
    return { t, arrive: () => { fine = true } }
  }

  it('leaves the bare side bare and says STALE when nothing asks again (the old behaviour)', () => {
    const { t, arrive } = coarseThenFine()
    expect(liveIn(t, 1, 100)).toBe(0)
    expect(t.diagnose(0, 0, 60).why.low).toBeGreaterThan(10)
    arrive()
    for (let k = 0; k < 20; k++) t.pump(8)
    // nothing queued: the cached answers stand, and the panel can say which ones are wrong
    expect(liveIn(t, 1, 100)).toBe(0)
    const d = t.diagnose(0, 0, 60)
    expect(d.stale).toBeGreaterThan(10)
    expect(d.why.low ?? 0).toBe(0)
  })

  it('regrows the bare cells under the tile once it is rechecked', () => {
    const { t, arrive } = coarseThenFine()
    const westBefore = liveIn(t, -100, -1)
    arrive()
    t.recheck(0, -100, 100, 100)
    drain(t)
    const d = t.diagnose(0, 0, 60)
    expect(d.stale).toBe(0)
    expect(d.redo).toBe(0)
    expect(d.staleFixed).toBeGreaterThan(10)
    expect(liveIn(t, 1, 100)).toBeGreaterThan(10)
    // the trees that were standing kept their place
    expect(liveIn(t, -100, -1)).toBe(westBefore)
    // a pump that only walked the queue did not mark anything settled that was not
    expect(t.stats().pending).toBe(0)
  })
})

describe('building footprints', () => {
  it('culls standing trees inside a footprint, reports them in the next patch, and does not regrow them', () => {
    const mask = new FootprintMask()
    let maskOn = false
    const t = treesFromCanopy(new Float32Array(4), [2, 2], [-200, -200, 200, 200], 10, () => 0, 5000, 3, (x, y) => (maskOn && mask.inside(x, y) ? 'building' : false), undefined, {
      canopyAt: () => 8,
      centre: [0, 0],
      cellM: 10,
      radius: 60,
    })
    drain(t)
    const inBox = (r: { x: number; z: number }) => Number.isFinite(r.x) && r.x > -20 && r.x < 20 && -r.z > -20 && -r.z < 20
    const before = t.records.filter(inBox).length
    expect(before).toBeGreaterThan(5)
    // the footprint tile streams in after the woods were planted
    const box = mask.add([{ ring: [[-20, -20], [20, -20], [20, 20], [-20, 20]] }])
    maskOn = true
    expect(box).toEqual([-20, -20, 20, 20])
    const n = t.cull(box![0], box![1], box![2], box![3], (x, y) => mask.inside(x, y))
    expect(n).toBe(before)
    expect(t.records.filter(inBox).length).toBe(0)
    // the frame's next plant carries the freed slots, so the collision grid drops them too
    t.plant(0, 0)
    const note = t.patch()
    expect(note.removed.length).toBe(n)
    expect(note.removedAt.length).toBe(2 * n)
    drain(t)
    t.plant(0, 0)
    drain(t)
    expect(t.records.filter(inBox).length).toBe(0)
    expect(t.diagnose(0, 0, 18).why.building).toBeGreaterThan(5)
    expect(t.stats().culled).toBe(n)
  })

  it('an exclude reason is what the diagnosis counts', () => {
    const t = treesFromCanopy(new Float32Array(4), [2, 2], [-200, -200, 200, 200], 10, () => 0, 5000, 3, (x) => (Math.abs(x) < 15 ? 'road' : false), undefined, {
      canopyAt: () => 8,
      centre: [0, 0],
      cellM: 10,
      radius: 60,
    })
    drain(t)
    const d = t.diagnose(0, 0, 40)
    expect(d.why.road).toBeGreaterThan(10)
    expect(d.planted + (d.why.road ?? 0)).toBe(d.cells - d.unmeasured)
    expect(d.canopy).toBe(d.cells)
  })
})

describe('FootprintMask', () => {
  const L: [number, number][] = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]]
  it('is inside the L, not in its notch, and the pad reaches past the wall', () => {
    const m = new FootprintMask(16)
    m.add([{ ring: L }])
    expect(m.inside(5, 25)).toBe(true)
    expect(m.inside(25, 5)).toBe(true)
    expect(m.inside(20, 20)).toBe(false)
    expect(m.inside(31, 5)).toBe(false)
    expect(m.inside(31, 5, 1.5)).toBe(true)
    expect(m.inside(-50, -50, 5)).toBe(false)
    expect(inRing(L, 20, 20)).toBe(false)
  })
  it('indexes a footprint once however often its tile arrives', () => {
    const m = new FootprintMask()
    const b = { ring: L }
    expect(m.add([b])).not.toBeNull()
    expect(m.add([b])).toBeNull()
    expect(m.count).toBe(1)
  })
})
