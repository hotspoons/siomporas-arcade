import { describe, expect, it } from 'vitest'
import { Anchor } from '../src/geo/wgs84'
import { BAKE_ENU } from './fixtures/bake-enu'

/**
 * Cross-language agreement with the bake.
 *
 * The bake converts the VECTOR geometry to ENU (it has PROJ); the viewer converts the RASTERS,
 * from the geodetic control lattice. Those are two independent implementations of the same
 * tangent frame, in two languages, and if they drift the roads stop sitting on the ground. This
 * pins them together: `corridor.geo.Anchor` generated the fixture, `wgs84.ts` has to reproduce it.
 */
describe('the viewer reproduces the bake ENU frame', () => {
  it('agrees to under a micrometre across four UTM zones', () => {
    let worst = 0
    for (const site of BAKE_ENU) {
      const a = new Anchor(site.anchor.lon, site.anchor.lat, 0)
      for (const p of site.pts) {
        const l = a.toLocal(p.lon, p.lat, 0) as number[]
        const d = Math.hypot(l[0] - p.e, l[1] - p.n, l[2] - p.u)
        expect(d, `${site.site} @ ${p.lon},${p.lat}`).toBeLessThan(1e-6)
        worst = Math.max(worst, d)
      }
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('covers every zone the baked sites actually span', () => {
    // sites span four UTM zones; a frame bug that only showed up off the home zone would be the
    // kind that reaches production
    expect(new Set(BAKE_ENU.map((s) => s.epsg)).size).toBe(4)
  })
})
