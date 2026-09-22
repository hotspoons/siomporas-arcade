import { describe, expect, it } from 'vitest'
import { childrenOf, diff, parentOf, tileBoundsOf, tileKey, tileMetres, wanted, type TileId } from '../src/geo/pyramid'

/** A synthetic world: every tile exists down to `zmax`, placed on a flat ENU plane. */
const world = (zmax: number, lat = 39) => {
  const has = (t: TileId) => t.z <= zmax
  const place = (t: TileId) => {
    const { ew, ns } = tileMetres(t.z, lat)
    const b = tileBoundsOf(t.z, t.x, t.y)
    const cols = 2 ** (t.z + 1)
    const rows = 2 ** t.z
    // centre relative to the world origin, in metres
    return {
      x: ((t.x + 0.5) / cols - 0.5) * 360 * 111_320 * Math.cos((lat * Math.PI) / 180),
      z: -((0.5 - (t.y + 0.5) / rows) * 180 * 111_320),
      radius: Math.hypot(ew, ns) / 2,
      b,
    }
  }
  return { has, place }
}

describe('quadtree ids', () => {
  it('children and parent are inverses', () => {
    const t = { z: 12, x: 2350, y: 1158 }
    for (const c of childrenOf(t)) expect(parentOf(c)).toEqual(t)
  })

  it('a tile is the union of its four children', () => {
    const t = { z: 11, x: 1174, y: 578 }
    const b = tileBoundsOf(t.z, t.x, t.y)
    const kids = childrenOf(t).map((c) => tileBoundsOf(c.z, c.x, c.y))
    expect(Math.min(...kids.map((k) => k.w))).toBeCloseTo(b.w, 9)
    expect(Math.max(...kids.map((k) => k.e))).toBeCloseTo(b.e, 9)
    expect(Math.min(...kids.map((k) => k.s))).toBeCloseTo(b.s, 9)
    expect(Math.max(...kids.map((k) => k.n))).toBeCloseTo(b.n, 9)
  })

  it('matches the levels the bake chose', () => {
    // z14 is the leaf because it is ~1 km at latitude 39 — the size we already emitted
    const { ew, ns } = tileMetres(14, 39)
    expect(ew).toBeGreaterThan(900)
    expect(ew).toBeLessThan(1000)
    expect(ns).toBeGreaterThan(1200)
    expect(ns).toBeLessThan(1250)
  })
})

describe('the resident set is bounded by the VIEW, not the world', () => {
  // a pixel covers this many metres at range d: 60 deg over 1080 px
  const mpp = (d: number) => (2 * d * Math.tan((30 * Math.PI) / 180)) / 1080

  it('holds a similar number of tiles whether the world is one site or a continent', () => {
    const small = world(14)
    const huge = world(14)
    const eye = { x: 0, z: 0 }
    // "one site": roots at z10. "a continent": roots at z6 — 256x more area under the same camera
    const a = wanted([{ z: 10, x: 588, y: 289 }], { eye, metresPerPixel: mpp, has: small.has, place: small.place }, 14)
    const b = wanted(
      Array.from({ length: 4 }, (_, i) => ({ z: 6, x: 36 + (i % 2), y: 18 + ((i / 2) | 0) })),
      { eye, metresPerPixel: mpp, has: huge.has, place: huge.place },
      14,
    )
    // the continent asks for more, but by a small factor — NOT by the 256x its area grew
    expect(b.length).toBeLessThan(a.length * 6)
    expect(b.length).toBeLessThan(400)
  })

  it('never exceeds its cap', () => {
    const w = world(18)
    const got = wanted([{ z: 4, x: 9, y: 4 }], { eye: { x: 0, z: 0 }, metresPerPixel: mpp, has: w.has, place: w.place, maxTiles: 64 }, 18)
    expect(got.length).toBeLessThanOrEqual(64)
  })

  it('returns only leaves — no tile is an ancestor of another', () => {
    const w = world(14)
    const got = wanted([{ z: 10, x: 588, y: 289 }], { eye: { x: 0, z: 0 }, metresPerPixel: mpp, has: w.has, place: w.place }, 14)
    const keys = new Set(got.map(tileKey))
    for (const t of got) {
      let p = parentOf(t)
      while (p) {
        expect(keys.has(tileKey(p)), `${tileKey(t)} is covered by its ancestor ${tileKey(p)}`).toBe(false)
        p = parentOf(p)
      }
    }
  })
})

describe('strict child-replaces-parent', () => {
  it('does NOT subdivide when a quad is incomplete — the trailworks failure', () => {
    const w = world(14)
    const missing = { z: 11, x: 1177, y: 579 }
    // knock one child out of one quad
    const has = (t: TileId) => (t.z === missing.z && t.x === missing.x && t.y === missing.y ? false : w.has(t))
    const mpp = () => 0.0001 // demand maximum detail everywhere
    const got = wanted([{ z: 10, x: 588, y: 289 }], { eye: { x: 0, z: 0 }, metresPerPixel: mpp, has, place: w.place }, 14)
    const keys = new Set(got.map(tileKey))
    // the parent of the broken quad must be drawn ITSELF, and none of its children drawn
    const parent = parentOf(missing)!
    expect(keys.has(tileKey(parent))).toBe(true)
    for (const c of childrenOf(parent)) expect(keys.has(tileKey(c))).toBe(false)
  })
})

describe('load / evict', () => {
  const held = (rows: [string, number, number][]) =>
    new Map(rows.map(([k, bytes, dist]) => [k, { bytes, dist }]))

  it('loads what is wanted and drops what is not', () => {
    const want = [{ z: 14, x: 1, y: 1 }, { z: 14, x: 1, y: 2 }]
    const h = held([['14/1/1', 1e6, 10], ['14/9/9', 1e6, 900]])
    const { load, drop } = diff(want, h, 128e6)
    expect(load.map(tileKey)).toEqual(['14/1/2'])
    expect(drop).toEqual(['14/9/9'])
  })

  it('evicts farthest-first when the BYTE budget is exceeded, even if still wanted', () => {
    const want = [{ z: 14, x: 1, y: 1 }, { z: 14, x: 1, y: 2 }, { z: 14, x: 1, y: 3 }]
    const h = held([['14/1/1', 60e6, 10], ['14/1/2', 60e6, 500], ['14/1/3', 60e6, 900]])
    const { drop } = diff(want, h, 128e6)
    // 180 MB held against a 128 MB budget: the farthest goes, the nearest stays
    expect(drop).toContain('14/1/3')
    expect(drop).not.toContain('14/1/1')
  })

  it('a count-based cap would have been the wrong unit', () => {
    // the same three tiles as compressed textures fit easily; as decoded ones they do not
    const want = [{ z: 14, x: 1, y: 1 }, { z: 14, x: 1, y: 2 }, { z: 14, x: 1, y: 3 }]
    const cheap = held([['14/1/1', 0.7e6, 10], ['14/1/2', 0.7e6, 500], ['14/1/3', 0.7e6, 900]])
    expect(diff(want, cheap, 128e6).drop).toEqual([])
  })
})
