// The place editor's map layer: the road tiers, the bucketing, and the label layout
// (src/editor/view/maproads.data.ts, maplabels.ts).
import { describe, expect, it } from 'vitest'
import { bucketRoads, LABEL_SPACING_M, ROAD_STYLES, styleOf, type RoadLine } from '../src/editor/view/maproads.data'
import { layoutLabels, readableAngle, type LabelCand } from '../src/editor/view/maplabels'

const line = (cls: string, name: string | null, pts: [number, number][]): RoadLine => ({ cls, name, xy: Float32Array.from(pts.flat()), z: null })

describe('road classes', () => {
  it('puts motorway/trunk/primary at every zoom, the streets at z14, service roads closer still', () => {
    const tier = (c: string) => ROAD_STYLES[styleOf(c)].tier
    expect(['motorway', 'trunk', 'primary', 'motorway_link'].map(tier)).toEqual([0, 0, 0, 0])
    expect(['secondary', 'tertiary', 'residential', 'unclassified'].map(tier)).toEqual([1, 1, 1, 1])
    expect(['service', 'track'].map(tier)).toEqual([2, 2])
    expect(styleOf('footway')).toBe(-1)
    expect(styleOf(null)).toBe(-1)
  })
})

describe('bucketRoads', () => {
  it('merges every major road into one bucket and cuts the rest into cells by segment', () => {
    const out = bucketRoads([
      line('motorway', 'I 495', [[0, 0], [10_000, 0], [20_000, 0]]),
      line('primary', 'Georgia Avenue', [[-5000, -5000], [-5000, 9000]]),
      line('residential', 'Elm Street', [[100, 100], [900, 100], [4100, 100]]),
      line('footway', 'Path', [[0, 0], [10, 10]]),
    ], 4000)
    const major = out.buckets.filter((b) => b.key === 'major')
    expect(major).toHaveLength(1)
    expect(major[0].segs.length / 2).toBe(3)
    const minor = out.buckets.filter((b) => b.tier === 1 && b.segs.length)
    // Elm Street's two segments both have their midpoints in cell 0,0 (the long one's is at 2500) —
    // its label anchors past x = 4000 make a label-only bucket next door, which is not counted here
    expect(minor.map((b) => b.key).sort()).toEqual(['1:0,0'])
    expect(minor[0].segs.length / 2).toBe(2)
    // vertices are shared along a polyline inside a bucket
    expect(minor[0].xy.length / 2).toBe(3)
    expect(out.names).toContain('Elm Street')
    expect(out.names).not.toContain('Path')
  })

  it('a road crossing cells is cut at the cell boundary of its segments', () => {
    const out = bucketRoads([line('tertiary', 'Long Road', [[100, 100], [3900, 100], [4100, 100], [7900, 100]])], 4000)
    const keys = out.buckets.map((b) => b.key).sort()
    expect(keys).toEqual(['1:0,0', '1:1,0'])
    const segs = out.buckets.reduce((s, b) => s + b.segs.length / 2, 0)
    expect(segs).toBe(3)
  })

  it('leaves label anchors along a named road at the tier spacing, each with its direction', () => {
    const L = 10_000
    const out = bucketRoads([line('primary', 'Capital Beltway', [[0, 0], [0, L]])], 4000)
    const lb = out.buckets[0].labels
    expect(lb.x.length).toBe(Math.floor((L - LABEL_SPACING_M[0] / 2) / LABEL_SPACING_M[0]) + 1)
    expect(lb.ang[0]).toBeCloseTo(Math.PI / 2, 6) // running north
    // a short street gets one, at its middle; a stub gets none
    const short = bucketRoads([line('residential', 'Court', [[0, 0], [100, 0]]), line('residential', 'Stub', [[0, 0], [10, 0]])], 4000)
    const all = short.buckets.flatMap((b) => [...b.labels.x])
    expect(all).toEqual([50])
  })

  it('keeps label anchors inside their bucket bounds, so a culled cell takes its labels with it', () => {
    const out = bucketRoads([line('residential', 'Edge Road', [[3990, 10], [4010, 10], [4500, 10]])], 4000)
    for (const b of out.buckets) {
      for (let i = 0; i < b.labels.x.length; i++) {
        expect(b.labels.x[i]).toBeGreaterThanOrEqual(b.bbox[0])
        expect(b.labels.x[i]).toBeLessThanOrEqual(b.bbox[2])
      }
    }
  })
})

describe('layoutLabels', () => {
  const opts = { width: 1000, height: 600, max: 50, pad: 2, sameNamePx: () => 300 }
  const c = (sx: number, sy: number, name: number, rank = 5, w = 80): LabelCand => ({ sx, sy, ang: 0, w, h: 14, name, rank, dist: Math.hypot(sx - 500, sy - 300) })

  it('never places two overlapping labels', () => {
    const cands = [c(500, 300, 1), c(520, 305, 2), c(700, 300, 3)]
    const keep = layoutLabels(cands, opts)
    expect(keep).toEqual([0, 2])
  })

  it('the more important road wins a collision, wherever it is', () => {
    const cands = [c(500, 300, 1, 5), c(530, 300, 2, 0)]
    expect(layoutLabels(cands, opts)).toEqual([1])
  })

  it('does not repeat a name within the spacing, but does past it', () => {
    // the one nearest the centre goes first (400), so 200 is too close to it and 800 is just clear
    const cands = [c(200, 300, 7), c(400, 300, 7), c(800, 300, 7)]
    expect(layoutLabels(cands, opts).sort()).toEqual([1, 2])
  })

  it('drops a label the screen edge would cut, and stops at the cap', () => {
    expect(layoutLabels([c(10, 300, 1)], opts)).toEqual([])
    const many = Array.from({ length: 200 }, (_, i) => c(60 + (i % 10) * 95, 20 + Math.floor(i / 10) * 28, i))
    expect(layoutLabels(many, { ...opts, max: 25 }).length).toBe(25)
  })

  it('a rotated label takes its rotated room', () => {
    const tall = { ...c(500, 300, 1, 5, 200), ang: Math.PI / 2 }
    const beside = c(500, 220, 2, 5, 40) // above it: clear of a flat label, inside a vertical one
    expect(layoutLabels([tall, beside], opts)).toEqual([0])
    expect(layoutLabels([{ ...tall, ang: 0 }, beside], opts).sort()).toEqual([0, 1])
  })

  it('folds angles so text never reads upside down', () => {
    expect(readableAngle(Math.PI)).toBeCloseTo(0, 9)
    expect(readableAngle(-Math.PI * 0.75)).toBeCloseTo(Math.PI / 4, 9)
    expect(readableAngle(Math.PI / 3)).toBeCloseTo(Math.PI / 3, 9)
  })
})
