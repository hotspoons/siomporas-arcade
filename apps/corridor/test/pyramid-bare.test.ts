/**
 * PyramidSet.bareAt — the earth beside a GRADED dem.
 *
 * A graded bake writes the road grading into a tile's `dem` and the sampled earth into `bare`
 * beside it; an older bake, or a coarse level the bake left ungraded, has no `bare`. `bareAt` must
 * read `bare` where there is one and fall back to `dem` where there is not, so that on an
 * ungraded bake it IS `heightAt` — the deck tests and the strip blend then see exactly what they
 * saw before the graded path existed.
 */
import { describe, expect, it } from 'vitest'
import { Anchor } from '@apex/engine/geo/wgs84'
import { RasterFrame } from '@apex/engine/geo/raster'
import { latticeFor } from '@apex/engine/geo/pyramid'
import type { PyrTile, TileField } from '../src/lod/tiles'

// site.ts reads `location.search` at module scope (DATA_BASE); there is no window under vitest,
// so the stub goes in before the module does — a static import would be hoisted above it.
;(globalThis as { location?: unknown }).location ??= { search: '' }
const { PyramidSet } = await import('../src/lod/tiles')

const anchor = new Anchor(-76.670706, 39.007758, 0)

function field(z: number, x: number, y: number, value: number): TileField {
  const geo = latticeFor(z, x, y)
  const size: [number, number] = [4, 4]
  const rf = new RasterFrame({ size, geo }, anchor)
  return { layer: { file: '', res: 0, size, bbox: [0, 0, 0, 0], zmin: 0, zscale: 0.01, geo }, data: new Float32Array(16).fill(value), rf }
}

function tile(z: number, x: number, y: number, dem: number, bare: number | null): PyrTile {
  const d = field(z, x, y, dem)
  const e = [0, 0, 0]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]) {
    d.rf.toEnu(u, v, 0, e)
    x0 = Math.min(x0, e[0]); x1 = Math.max(x1, e[0]); y0 = Math.min(y0, e[1]); y1 = Math.max(y1, e[1])
  }
  return { z, x, y, dem: d, bare: bare === null ? null : field(z, x, y, bare), chm: null, bounds: [x0, y0, x1, y1], cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hasNaip: false, bytes: 0 }
}

describe('PyramidSet.bareAt', () => {
  // the leaf tile over the anchor itself
  const cols = 2 ** 15, rows = 2 ** 14
  const tx = Math.floor(((anchor.lon + 180) / 360) * cols)
  const ty = Math.floor(((90 - anchor.lat) / 180) * rows)

  it('reads bare.png where the bake wrote one, and the graded dem stays the ground', () => {
    const set = new PyramidSet(14, 14, () => -999)
    set.add(tile(14, tx, ty, 50, 42))
    const h = set.heightAt(0, 0)
    const e = set.bareAt(0, 0)
    // both go through the same curvature (the corner patch's drop, a few cm at a tile's middle),
    // so the raster values come back together and their difference is exact
    expect(h).toBeCloseTo(50, 1)
    expect(h - e).toBeCloseTo(8, 6)
  })

  it('is heightAt on a tile the bake left bare', () => {
    const set = new PyramidSet(14, 14, () => -999)
    set.add(tile(14, tx, ty, 50, null))
    expect(set.bareAt(0, 0)).toBe(set.heightAt(0, 0))
    expect(set.levelAt(0, 0)).toBe(14)
  })

  it('falls back to the overview beyond every tile', () => {
    const set = new PyramidSet(14, 14, () => -999)
    set.add(tile(14, tx, ty, 50, 42))
    expect(set.bareAt(50_000, 50_000)).toBe(-999)
  })
})
