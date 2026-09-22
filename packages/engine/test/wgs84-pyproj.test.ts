import { describe, expect, it } from 'vitest'
import { Anchor, ecefToGeodetic, geodeticToEcef } from '../src/geo/wgs84'
import { CROFTON_UTM_ANCHOR, PYPROJ_ECEF, PYPROJ_UTM } from './fixtures/pyproj'

/**
 * The geodesy in `wgs84.ts` is hand-written, so it is checked against pyproj/PROJ rather than
 * against itself. A transform that is only self-consistent is a transform that is consistently
 * wrong, and everything the bake produces already goes through PROJ — if the two disagree, the
 * world will not line up with its own source data.
 */
describe('agreement with pyproj (PROJ)', () => {
  it('matches EPSG:4978 to under a micrometre', () => {
    let worst = 0
    for (const p of PYPROJ_ECEF) {
      const [x, y, z] = geodeticToEcef(p.lon, p.lat, p.h) as number[]
      const d = Math.hypot(x - p.ecef[0], y - p.ecef[1], z - p.ecef[2])
      worst = Math.max(worst, d)
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('inverts pyproj ECEF back to the degree it came from', () => {
    for (const p of PYPROJ_ECEF) {
      const g = ecefToGeodetic(p.ecef[0], p.ecef[1], p.ecef[2])
      expect(g.lat).toBeCloseTo(p.lat, 9)
      expect(g.lon).toBeCloseTo(p.lon, 9)
      expect(Math.abs(g.h - p.h)).toBeLessThan(1e-5)
    }
  })
})

/**
 * What the flat UTM frame was costing.
 *
 * The bake stores site metres as UTM easting/northing minus `frame.origin`. UTM is a conformal
 * projection onto a PLANE: it has a scale factor (0.9996 on the central meridian, rising toward
 * the zone edges) and it has no curvature at all. These are the two errors the geodetic frame
 * removes, measured at crofton-triangle's own anchor against its own bake origin.
 */
describe('what UTM site-metres were getting wrong', () => {
  const a = new Anchor(-76.683, 39.004, 0)

  it('has the bake origin we think it has', () => {
    expect(CROFTON_UTM_ANCHOR[0]).toBeCloseTo(354269.8814291, 5)
    expect(CROFTON_UTM_ANCHOR[1]).toBeCloseTo(4318567.7528503, 5)
  })

  it('is a ROTATED frame: UTM north is not true north', () => {
    // Grid convergence. Crofton is 1.683 deg off zone 18's central meridian, so UTM north is
    // yawed from true north by about 1.06 deg. Inside one site that is invisible — everything is
    // consistently rotated — but it is why a UTM site cannot be laid next to a neighbour, why the
    // sun comes up in slightly the wrong place, and why gaussworks (which aligns to ENU) and the
    // bake disagree about which way is north.
    let sxx = 0, sxy = 0, snn = 0
    const P = PYPROJ_UTM.map((s) => {
      const l = a.toLocal(s.lon, s.lat, 0) as number[]
      return { de: s.de, dn: s.dn, e: l[0], n: l[1], u: l[2] }
    })
    for (const p of P) {
      sxx += p.de * p.e + p.dn * p.n
      sxy += p.de * p.n - p.dn * p.e
      snn += p.de * p.de + p.dn * p.dn
    }
    const theta = (Math.atan2(sxy, sxx) * 180) / Math.PI
    const scale = Math.hypot(sxx, sxy) / snn
    expect(theta).toBeCloseTo(1.0606, 3)
    // and a scale factor: UTM's 0.9996 on the central meridian, partly cancelled out here by
    // being 1.7 deg away from it. 166 ppm is 1.4 m over crofton-triangle's 8.5 km span.
    expect((scale - 1) * 1e6).toBeCloseTo(166.0, 0)
  })

  it('is horizontally GOOD once the rotation and scale are taken out — under half a metre at 25 km', () => {
    // This is the honest reckoning: UTM was never the horizontal problem. What it cannot do at all
    // is the vertical, because a plane has no curvature.
    let worstH = 0
    const drops: { r: number; drop: number }[] = []
    const theta = (1.06055 * Math.PI) / 180
    const scale = 1.000166039
    const ct = Math.cos(theta), st = Math.sin(theta)
    for (const s of PYPROJ_UTM) {
      const l = a.toLocal(s.lon, s.lat, 0) as number[]
      const e = scale * (ct * s.de - st * s.dn)
      const n = scale * (st * s.de + ct * s.dn)
      worstH = Math.max(worstH, Math.hypot(e - l[0], n - l[1]))
      drops.push({ r: Math.hypot(s.de, s.dn), drop: -l[2] })
    }
    expect(worstH).toBeLessThan(0.5)
    // the vertical, which no amount of rotating or scaling a plane can fix
    const at25k = drops.find((d) => d.r > 24_000)!
    expect(at25k.drop).toBeGreaterThan(48)
    expect(drops.find((d) => Math.round(d.r) === 10_000)!.drop).toBeCloseTo(7.84, 1)
  })

  it('is exactly invertible, so existing bakes convert without a re-bake', () => {
    // every site already records frame.epsg and frame.origin, so its metres have a known geodetic
    // position. Going geodetic is a re-interpretation of data we already have, not a re-fetch.
    for (const s of PYPROJ_UTM) {
      const l = a.toLocal(s.lon, s.lat, 0) as number[]
      const back = a.toGeodetic(l[0], l[1], l[2])
      expect(back.lon).toBeCloseTo(s.lon, 9)
      expect(back.lat).toBeCloseTo(s.lat, 9)
    }
  })
})
