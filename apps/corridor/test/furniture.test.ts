// The walk clip, without a renderer.
//
// Rich, 2026-09-27: "sidewalks rendering over streets, in this case 3 sidewalks extending over
// streets." The old rule decided a whole span by what its ENDPOINTS were doing, so a walk whose
// middle crossed a road but whose ends were clear was drawn straight across it. The rule is now a
// pure function of a segment: which sub-spans are clear of the carriageway. It is arithmetic, so it
// is tested here and only trusted on a screen after.
import { describe, expect, it } from 'vitest'
import { boomSignAt, clearSpans, kerbCorner, kerbJoinRings, type BoomJunction, type KerbEnd } from '../src/world/furniture'

// exactly the road, as a fraction of the segment, is on the carriageway
const roadBetween = (a: number, b: number) => (t: number) => t < a || t >= b

describe('clipping a walk span against a road', () => {
  it('keeps a segment that is clear all the way', () => {
    const { spans, onRoad } = clearSpans(10, () => true)
    expect(spans).toEqual([[0, 1]])
    expect(onRoad).toBe(0)
  })

  it('drops a segment that is on the road all the way', () => {
    const { spans, onRoad } = clearSpans(10, () => false)
    expect(spans).toEqual([])
    expect(onRoad).toBe(11)
  })

  it('splits one segment that crosses a road and comes back', () => {
    const { spans, onRoad } = clearSpans(10, roadBetween(0.4, 0.6))
    expect(spans).toEqual([[0, 0.4], [0.6, 1]])
    expect(onRoad).toBe(2)
  })

  it('trims a segment that runs onto the road and stops there', () => {
    const { spans, onRoad } = clearSpans(10, (t) => t < 0.7)
    expect(spans).toEqual([[0, 0.7]])
    expect(onRoad).toBe(4)
  })

  it('emits nothing for a degenerate one-sample segment that is on the road', () => {
    const { spans, onRoad } = clearSpans(1, () => false)
    expect(spans).toEqual([])
    expect(onRoad).toBe(2)
  })
})

describe('the kerb at a corner', () => {
  // the kerb sits 3 m to the left of a way running north (site +z), and the joint turns east
  const off = 3

  it('miter to a right angle when bevels are off', () => {
    const v = kerbCorner(0, 0, 0, 1, 1, 0, off, 180)
    expect(v).toEqual([[-3, 3]])
  })

  it('bevel a right angle into two vertices', () => {
    const v = kerbCorner(0, 0, 0, 1, 1, 0, off, 30)
    expect(v).toEqual([[-3, 0], [0, 3]])
    // neither vertex is further from the node than the offset, by Pythagoras
    for (const [x, z] of v) expect(Math.hypot(x, z)).toBeCloseTo(off, 6)
  })

  it('miters a straight run back to the one offset point', () => {
    expect(kerbCorner(0, 0, 0, 1, 0, 1, off, 30)).toEqual([[-3, 0]])
  })

  it('keeps a gentle bend a miter', () => {
    const c = Math.cos((10 * Math.PI) / 180)
    const s = Math.sin((10 * Math.PI) / 180)
    const v = kerbCorner(0, 0, 0, 1, s, c, off, 30)
    expect(v).toHaveLength(1)
    expect(Math.abs(v[0][0] + off)).toBeLessThan(0.05)
  })
})

describe('joining two walk ends into one corner', () => {
  // a 2 m band, kerb 15 cm, standing on ground at y = 10; only the colours of `ring` are read
  const end = (fwdX: number, fwdZ: number, side: 1 | -1): KerbEnd => ({
    x: 0, z: 0, y: 10, fwdX, fwdZ, side, w: 2, kerb: 0.15, kerbed: true, clear: true,
    ring: [
      [0, 10, 0, 0, 1, 0.6, 0.6, 0.6],
      [0, 10.17, 0, 0, 1, 0.6, 0.6, 0.6],
      [0, 10, 0, 0, 1, 0.7, 0.7, 0.7],
    ],
  })

  it('bevels a right angle into two bands, one per vertex', () => {
    const r = kerbJoinRings(end(1, 0, 1), end(0, 1, 1), 30)
    expect(r).not.toBeNull()
    expect(r!).toHaveLength(2)
    // the kerb foot runs (0,1) → (-1,0), and the top sits one kerb + lift above the ground
    expect(r![0][0].slice(0, 3)).toEqual([0, 10, 1])
    expect(r![1][0].slice(0, 3)).toEqual([-1, 10, 0])
    expect(r![0][1][1]).toBeCloseTo(10 + 0.15 + 0.02, 6)
  })

  it('mitres a gentle bend into one vertex', () => {
    const c = Math.cos((10 * Math.PI) / 180)
    const s = Math.sin((10 * Math.PI) / 180)
    const r = kerbJoinRings(end(0, 1, 1), end(s, c, 1), 30)
    expect(r!).toHaveLength(1)
  })

  it('refuses kerbs on opposite sides', () => {
    expect(kerbJoinRings(end(1, 0, 1), end(0, 1, -1), 30)).toBeNull()
  })

  it('refuses a straight-through split, already joined inside each run', () => {
    expect(kerbJoinRings(end(1, 0, 1), end(1, 0, 1), 30)).toBeNull()
  })
})

describe('which junctions earn a boom sign', () => {
  const jx = (over: Partial<BoomJunction> = {}): BoomJunction => ({ x: 0, y: 0, control: 'signals', arms: 4, rank: 7, ...over })
  // the viewer's defaults: primary-or-better (7), four arms, matched within 45 m
  const at = (mx: number, my: number, list: BoomJunction[]) => boomSignAt(mx, my, list, 45, 7, 4)

  it('signs a 4-way signalised junction on a primary', () => {
    expect(at(10, 10, [jx()])).toBe(true)
  })

  it('does not sign a side-street stop', () => {
    expect(at(0, 0, [jx({ control: 'two_way_stop' })])).toBe(false)
  })

  it('does not sign a signalised junction whose superior road is residential', () => {
    expect(at(0, 0, [jx({ rank: 3 })])).toBe(false)
  })

  it('does not sign a T', () => {
    expect(at(0, 0, [jx({ arms: 3 })])).toBe(false)
  })

  it('does not sign a mast far from the junction', () => {
    expect(at(100, 0, [jx()])).toBe(false)
  })
})
