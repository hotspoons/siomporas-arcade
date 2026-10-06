// The walk clip, without a renderer.
//
// Rich, 2026-09-27: "sidewalks rendering over streets, in this case 3 sidewalks extending over
// streets." The old rule decided a whole span by what its ENDPOINTS were doing, so a walk whose
// middle crossed a road but whose ends were clear was drawn straight across it. The rule is now a
// pure function of a segment: which sub-spans are clear of the carriageway. It is arithmetic, so it
// is tested here and only trusted on a screen after.
import { describe, expect, it } from 'vitest'
import { clearSpans } from '../src/world/furniture'

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
