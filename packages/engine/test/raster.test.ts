import { describe, expect, it } from 'vitest'
import { Anchor } from '../src/geo/wgs84'
import { RasterFrame } from '../src/geo/raster'
import { CROFTON_RASTER as R } from './fixtures/raster'

const anchor = new Anchor(R.anchor.lon, R.anchor.lat, R.anchor.h)
const dem = new RasterFrame({ size: R.dem.size as [number, number], geo: R.dem.geo as never }, anchor)

describe('RasterFrame on a real baked lattice', () => {
  it('round-trips grid -> ENU -> grid to sub-millimetre in grid terms', () => {
    let worstU = 0
    for (let u = 0; u <= 1.0001; u += 0.1) {
      for (let v = 0; v <= 1.0001; v += 0.1) {
        const p = dem.toEnu(Math.min(u, 1), Math.min(v, 1), 0) as number[]
        const g = dem.toGrid(p[0], p[1])
        worstU = Math.max(worstU, Math.abs(g[0] - Math.min(u, 1)), Math.abs(g[1] - Math.min(v, 1)))
      }
    }
    // a whole grid cell is 1/1070; this is well inside one
    expect(worstU).toBeLessThan(1e-4)
  })

  it('the inverse closes to millimetres, against an affine seed that is metres out', () => {
    // The inverse iterates against the lattice's BILINEAR PATCH, not the exact forward map. That
    // is a deliberate trade: the exact version cost about nine geodetic transforms a call and hung
    // the build at "grading 1/427 streets", because every height and canopy lookup goes through
    // here. The patch costs four lerps and an analytic Jacobian, and the price is a few
    // millimetres against a DEM cell of 2-8 m.
    let worstM = 0
    for (let u = 0; u <= 1.0001; u += 0.25) {
      for (let v = 0; v <= 1.0001; v += 0.25) {
        const uu = Math.min(u, 1), vv = Math.min(v, 1)
        const p = dem.toEnu(uu, vv, 0) as number[]
        const g = dem.toGrid(p[0], p[1])
        const q = dem.toEnu(g[0], g[1], 0) as number[]
        worstM = Math.max(worstM, Math.hypot(q[0] - p[0], q[1] - p[1]))
      }
    }
    expect(worstM).toBeLessThan(0.01) // measured 4.0 mm over an 8.56 km raster
  })

  it('puts the raster where the bake says, and curves it', () => {
    // the four corners should land inside the ENU bbox the bake computed
    const [x0, z0, x1, z1] = R.dem.bbox as unknown as number[]
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const p = dem.toEnu(u, v, 0) as number[]
      expect(p[0]).toBeGreaterThanOrEqual(x0 - 1)
      expect(p[0]).toBeLessThanOrEqual(x1 + 1)
      expect(p[1]).toBeGreaterThanOrEqual(z0 - 1)
      expect(p[1]).toBeLessThanOrEqual(z1 + 1)
    }
    // and the far corners sit BELOW the tangent plane — the whole point
    const far = dem.toEnu(1, 1, 0) as number[]
    const r = Math.hypot(far[0], far[1])
    expect(far[2]).toBeLessThan(0)
    expect(-far[2]).toBeCloseTo((r * r) / (2 * 6386615), 0)
  })

  it('a 1 km tile lattice is accurate enough at 3x3', () => {
    const t = new RasterFrame({ size: [500, 500], geo: R.tile.geo as never }, anchor)
    let worst = 0
    for (let u = 0; u <= 1.0001; u += 0.125) {
      for (let v = 0; v <= 1.0001; v += 0.125) {
        const p = t.toEnu(Math.min(u, 1), Math.min(v, 1), 0) as number[]
        const g = t.toGrid(p[0], p[1])
        const q = t.toEnu(g[0], g[1], 0) as number[]
        worst = Math.max(worst, Math.hypot(q[0] - p[0], q[1] - p[1]))
      }
    }
    expect(worst).toBeLessThan(0.01)
  })
})
