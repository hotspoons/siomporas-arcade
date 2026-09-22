import { describe, expect, it } from 'vitest'
import { childrenOf, diff, holdWhileRefining, latticeFor, parentOf, tileBoundsOf, tileKey, tileMetres, wanted, type TileId } from '../src/geo/pyramid'
import { RasterFrame } from '../src/geo/raster'
import { Anchor } from '../src/geo/wgs84'

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

describe('latticeFor', () => {
  // A UTM tile needs a 9x9 lattice because a UTM square is a curved quadrilateral in lon/lat.
  // A quadtree tile IS a lon/lat rectangle, so 2x2 should not be an approximation at all. If that
  // is true the manifest carries no lattice and there is nothing to keep in step; if it is false
  // the pyramid quietly misplaces every vertex, so it is worth asserting rather than asserting.
  const z = 14, x = 9382, y = 6215
  const b = tileBoundsOf(z, x, y)
  const anchor = new Anchor((b.w + b.e) / 2, (b.s + b.n) / 2, 0)

  it('reproduces the tile rectangle exactly, not approximately', () => {
    const rf = new RasterFrame({ size: [512, 512], geo: latticeFor(z, x, y) }, anchor)
    let worst = 0
    // deliberately off-centre and non-symmetric: a lat flip or a u/v swap cancels at (0.5, 0.5)
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.3, 0.8], [0.77, 0.12], [0.5, 0.5]]) {
      const g = rf.geodeticAt(u, v)
      const lon = b.w + u * (b.e - b.w)
      const lat = b.n - v * (b.n - b.s)   // v runs NORTH to SOUTH, image order
      worst = Math.max(worst, Math.abs(g.lon - lon), Math.abs(g.lat - lat))
    }
    expect(worst).toBeLessThan(1e-12)
  })

  it('is oriented: v=0 is the NORTH edge and u=0 the WEST', () => {
    const rf = new RasterFrame({ size: [512, 512], geo: latticeFor(z, x, y) }, anchor)
    expect(rf.geodeticAt(0.5, 0).lat).toBeGreaterThan(rf.geodeticAt(0.5, 1).lat)
    expect(rf.geodeticAt(0, 0.5).lon).toBeLessThan(rf.geodeticAt(1, 0.5).lon)
  })

  it('a flipped lattice FAILS the exactness check', () => {
    // the negative: prove the first test can go red, so passing means something
    const g = latticeFor(z, x, y)
    const flipped = { n: 2, lon: g.lon, lat: [g.lat[2], g.lat[3], g.lat[0], g.lat[1]] }
    const rf = new RasterFrame({ size: [512, 512], geo: flipped }, anchor)
    const got = rf.geodeticAt(0.3, 0.8).lat
    const want = b.n - 0.8 * (b.n - b.s)
    expect(Math.abs(got - want)).toBeGreaterThan(1e-6)
  })

  it('a child tile lattice nests exactly inside its parent', () => {
    for (const c of childrenOf({ z, x, y })) {
      const cb = tileBoundsOf(c.z, c.x, c.y)
      expect(cb.w).toBeGreaterThanOrEqual(b.w - 1e-12)
      expect(cb.e).toBeLessThanOrEqual(b.e + 1e-12)
      expect(cb.s).toBeGreaterThanOrEqual(b.s - 1e-12)
      expect(cb.n).toBeLessThanOrEqual(b.n + 1e-12)
    }
  })
})

describe('holdWhileRefining', () => {
  const parent: TileId = { z: 12, x: 2345, y: 1553 }
  const kids = childrenOf(parent)
  const pk = tileKey(parent)

  it('holds a parent whose children are wanted but not yet resident', () => {
    // the leading edge: diff wants to evict the parent, the children are still in flight
    const out = holdWhileRefining([pk], kids, () => false)
    expect(out).toEqual([])
  })

  it('releases the parent once ALL four children are resident', () => {
    const resident = new Set(kids.map(tileKey))
    const out = holdWhileRefining([pk], kids, (k) => resident.has(k))
    expect(out).toEqual([pk])
  })

  it('still holds when only three of four have landed', () => {
    // three children and a parent-shaped gap is worse than a blurry parent
    const resident = new Set(kids.slice(0, 3).map(tileKey))
    expect(holdWhileRefining([pk], kids, (k) => resident.has(k))).toEqual([])
  })

  it('releases immediately when the tile simply left the view', () => {
    // nothing wanted overlaps it — no refinement is happening, so there is nothing to wait for
    const elsewhere: TileId[] = [{ z: 12, x: 900, y: 900 }]
    expect(holdWhileRefining([pk], elsewhere, () => false)).toEqual([pk])
  })

  it('does not hold a tile whose SIBLING is wanted — only its own children count', () => {
    // a sibling covers different ground; holding for it would pin the resident set open
    const sibling: TileId = { z: 12, x: 2346, y: 1553 }
    expect(holdWhileRefining([pk], childrenOf(sibling), () => false)).toEqual([pk])
  })
})
