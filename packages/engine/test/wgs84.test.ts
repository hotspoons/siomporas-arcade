import { describe, expect, it } from 'vitest'
import {
  Anchor,
  WGS84_A,
  WGS84_B,
  curvatureDrop,
  ecefToGeodetic,
  enuBasis,
  geodeticToEcef,
  tileBounds,
  tileOf,
} from '../src/geo/wgs84'

// crofton-triangle's anchor, and a few places with awkward geometry
const CROFTON = { lon: -76.683, lat: 39.004 }
const SITES: [string, number, number][] = [
  ['crofton MD', -76.683, 39.004],
  ['bixby CA', -121.9017, 36.3714],
  ['ecola OR', -123.9707, 45.9282],
  ['equator/prime', 0, 0],
  ['dateline', 179.9, -41.2],
  ['high north', 12.0, 78.2],
]

describe('ellipsoid constants', () => {
  it('matches the trailworks polar radius', () => {
    // trailworks/viewer/src/render/geoMath.ts hardcodes 6356752.314245; we derive B from the
    // defining flattening. They must agree or the two projects address different planets.
    expect(WGS84_B).toBeCloseTo(6356752.314245, 5)
    expect(WGS84_A).toBe(6378137.0)
  })
})

describe('geodetic <-> ECEF', () => {
  it('round-trips to well under a micrometre', () => {
    for (const [name, lon, lat] of SITES) {
      for (const h of [-100, 0, 137.5, 8848]) {
        const [x, y, z] = geodeticToEcef(lon, lat, h) as number[]
        const g = ecefToGeodetic(x, y, z)
        expect(g.lat, `${name} lat`).toBeCloseTo(lat, 9)
        // Bowring is closed-form, not exact: the height error grows with height, and at the top
        // of Everest it is 0.53 micrometres. Anything we will ever render is far below that.
        expect(Math.abs(g.h - h), `${name} h@${h}`).toBeLessThan(1e-5)
        if (Math.abs(lat) < 89.9) expect(g.lon, `${name} lon`).toBeCloseTo(lon, 9)
      }
    }
  })

  it('puts the known reference points where they belong', () => {
    // (0,0,0) sits on the equator at the prime meridian, at exactly the equatorial radius
    expect(geodeticToEcef(0, 0, 0)).toEqual([WGS84_A, 0, 0])
    // the north pole is on +Z at exactly the polar radius
    const [px, py, pz] = geodeticToEcef(0, 90, 0) as number[]
    expect(Math.hypot(px, py)).toBeLessThan(1e-6)
    expect(pz).toBeCloseTo(WGS84_B, 6)
  })
})

describe('ENU basis', () => {
  it('is orthonormal and right-handed everywhere', () => {
    for (const [name, lon, lat] of SITES) {
      const { east, north, up } = enuBasis(lon, lat)
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      for (const [n, v] of [['east', east], ['north', north], ['up', up]] as const) {
        expect(dot(v, v), `${name} ${n} unit`).toBeCloseTo(1, 12)
      }
      expect(dot(east, north), `${name} e.n`).toBeCloseTo(0, 12)
      expect(dot(north, up), `${name} n.u`).toBeCloseTo(0, 12)
      expect(dot(up, east), `${name} u.e`).toBeCloseTo(0, 12)
      // east x north = up  (right-handed)
      const cross = [east[1] * north[2] - east[2] * north[1], east[2] * north[0] - east[0] * north[2], east[0] * north[1] - east[1] * north[0]]
      expect(dot(cross, up), `${name} handedness`).toBeCloseTo(1, 12)
    }
  })

  it('points along the ellipsoid normal, not at the centre of the Earth', () => {
    // On a sphere "up" and "away from the centre" are the same direction. On the ellipsoid they
    // differ by the angle of the vertical, which peaks near 45 deg at about 11.5 arcmin. If this
    // is zero we have silently built a sphere.
    const a = new Anchor(0, 45, 0)
    const { up } = enuBasis(0, 45)
    const r = Math.hypot(a.ecef[0], a.ecef[1], a.ecef[2])
    const radial = [a.ecef[0] / r, a.ecef[1] / r, a.ecef[2] / r]
    const cos = up[0] * radial[0] + up[1] * radial[1] + up[2] * radial[2]
    const arcmin = (Math.acos(Math.min(1, cos)) * 180 * 60) / Math.PI
    expect(arcmin).toBeGreaterThan(11.0)
    expect(arcmin).toBeLessThan(11.7)
    // and at the equator and the pole the two coincide exactly
    for (const lat of [0, 90]) {
      const b = new Anchor(0, lat, 0)
      const u = enuBasis(0, lat).up
      const rb = Math.hypot(b.ecef[0], b.ecef[1], b.ecef[2])
      const dot = (u[0] * b.ecef[0] + u[1] * b.ecef[1] + u[2] * b.ecef[2]) / rb
      expect(dot).toBeCloseTo(1, 12)
    }
  })
})

describe('Anchor local frame', () => {
  const a = new Anchor(CROFTON.lon, CROFTON.lat, 0)

  it('puts its own anchor at the origin', () => {
    const l = a.toLocal(CROFTON.lon, CROFTON.lat, 0) as number[]
    expect(Math.hypot(l[0], l[1], l[2])).toBeLessThan(1e-9)
  })

  it('round-trips geodetic -> local -> geodetic over a whole site', () => {
    // crofton-triangle spans about 8.5 x 7.9 km; walk well past that
    for (let de = -20000; de <= 20000; de += 5000) {
      for (let dn = -20000; dn <= 20000; dn += 5000) {
        const g = a.toGeodetic(de, dn, 12.5)
        const l = a.toLocal(g.lon, g.lat, g.h) as number[]
        expect(l[0]).toBeCloseTo(de, 6)
        expect(l[1]).toBeCloseTo(dn, 6)
        expect(l[2]).toBeCloseTo(12.5, 6)
      }
    }
  })

  // Going EAST, the relevant radius is the prime vertical N, not the mean radius. At Crofton
  // (lat 39) N is 6 386 615 m against a mean of 6 371 009, so the familiar d^2/2R overstates the
  // drop by about 0.25%: at 30 km it says 70.63 m where the ellipsoid says 70.46 m.
  const sl = Math.sin((CROFTON.lat * Math.PI) / 180)
  const N = WGS84_A / Math.sqrt(1 - (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A) * sl * sl)

  it('reproduces the curvature drop a flat plane was missing', () => {
    // a point at local u = 0 is ON the tangent plane, so its height above the ellipsoid IS the drop
    for (const d of [1000, 4250, 8500, 30000]) {
      const g = a.toGeodetic(d, 0, 0)
      expect(g.h).toBeGreaterThan(0)
      expect(g.h, `exact drop at ${d} m`).toBeCloseTo((d * d) / (2 * N), 1)
    }
    // the exact figures this design is justified by
    expect(a.toGeodetic(8500, 0, 0).h).toBeCloseTo(5.657, 2)
    expect(a.toGeodetic(30000, 0, 0).h).toBeCloseTo(70.460, 2)
  })

  it('places a point on the ellipsoid below the tangent plane by the same amount', () => {
    for (const d of [1000, 8500, 30000]) {
      const east = a.toGeodetic(d, 0, 0)
      const onSurface = a.toLocal(east.lon, east.lat, 0) as number[]
      expect(-onSurface[2]).toBeCloseTo((d * d) / (2 * N), 1)
    }
  })

  it('the spherical d^2/2R is a good enough rule of thumb, and we know by how much', () => {
    for (const d of [1000, 8500, 30000]) {
      const exact = a.toGeodetic(d, 0, 0).h
      expect(Math.abs(curvatureDrop(d) - exact) / exact).toBeLessThan(0.005)
    }
  })

  it('measures true distances, not projected ones', () => {
    // 1 degree of latitude is ~111 km; the local frame must agree within the ellipsoid's own
    // variation, NOT within UTM's 0.04-0.1% scale error
    const north1deg = a.toLocal(CROFTON.lon, CROFTON.lat + 1, 0) as number[]
    expect(north1deg[1]).toBeGreaterThan(110_500)
    expect(north1deg[1]).toBeLessThan(111_600)
    expect(Math.abs(north1deg[0])).toBeLessThan(1) // due north stays due north
  })
})

describe('rebasing', () => {
  it('delta puts the new origin where the old frame says it is', () => {
    const a = new Anchor(CROFTON.lon, CROFTON.lat, 0)
    const b = a.toGeodetic(6000, -4000, 0)
    const nb = new Anchor(b.lon, b.lat, b.h)
    const d = a.delta(nb)
    expect(d[0]).toBeCloseTo(6000, 6)
    expect(d[1]).toBeCloseTo(-4000, 6)
    expect(d[2]).toBeCloseTo(0, 6)
  })

  it('a rebase is a translation AND a rotation, and ignoring the rotation costs metres', () => {
    const a = new Anchor(CROFTON.lon, CROFTON.lat, 0)
    const far = a.toGeodetic(30000, 0, 0)
    const b = new Anchor(far.lon, far.lat, far.h)
    // a point 30 km beyond the new origin, expressed in each frame
    const p = b.toGeodetic(30000, 0, 0)
    const inB = b.toLocal(p.lon, p.lat, p.h) as number[]
    const inA = a.toLocal(p.lon, p.lat, p.h) as number[]
    // translation alone would say inA == inB + delta; it does not, and the gap is the curvature
    const shift = a.delta(b)
    const naive = [inB[0] + shift[0], inB[1] + shift[1], inB[2] + shift[2]]
    const gap = Math.hypot(naive[0] - inA[0], naive[1] - inA[1], naive[2] - inA[2])
    expect(gap).toBeGreaterThan(100) // ~141 m over 60 km: the rotation is not optional
    // ...and the rotation is what closes it
    const R = a.deltaRotation(b)
    expect(R.length).toBe(9)
  })
})

describe('float32 is why we do not render in absolute ECEF', () => {
  const ulp = (x: number) => {
    let d = 1e-4
    while (Math.fround(x + d) === Math.fround(x)) d *= 2
    return d
  }

  it('quantises ECEF magnitudes to a quarter of a metre', () => {
    // this is the measurement the whole design rests on: a float32 vertex buffer holding absolute
    // ECEF cannot resolve a lane marking.
    expect(ulp(6.4e6)).toBeGreaterThan(0.2)
    expect(ulp(6.4e6)).toBeLessThan(0.6)
  })

  it('gives millimetres once coordinates are relative to a nearby origin', () => {
    expect(ulp(30_000)).toBeLessThanOrEqual(0.005)
    expect(ulp(1_000)).toBeLessThanOrEqual(0.001)
  })

  it('survives a whole site at float32 through the local frame', () => {
    const a = new Anchor(CROFTON.lon, CROFTON.lat, 0)
    let worst = 0
    for (let de = -15000; de <= 15000; de += 2500) {
      for (let dn = -15000; dn <= 15000; dn += 2500) {
        const g = a.toGeodetic(de, dn, 30)
        const l = a.toLocal(g.lon, g.lat, g.h) as number[]
        // what actually reaches the GPU
        worst = Math.max(worst, Math.abs(Math.fround(l[0]) - de), Math.abs(Math.fround(l[1]) - dn))
      }
    }
    expect(worst).toBeLessThan(0.002) // millimetres across a 30 km site
  })
})

describe('global tile scheme', () => {
  it('matches the trailworks quadtree', () => {
    expect(tileBounds(0, 0, 0)).toEqual({ w: -180, e: 0, n: 90, s: -90 })
    expect(tileBounds(1, 0, 0)).toEqual({ w: -180, e: -90, n: 90, s: 0 })
  })

  it('tileOf and tileBounds agree', () => {
    for (const [name, lon, lat] of SITES) {
      for (const z of [0, 4, 9, 14]) {
        const t = tileOf(z, lon, lat)
        const b = tileBounds(t.z, t.x, t.y)
        expect(lon, `${name} z${z} lon`).toBeGreaterThanOrEqual(b.w)
        expect(lon, `${name} z${z} lon`).toBeLessThanOrEqual(b.e)
        expect(lat, `${name} z${z} lat`).toBeGreaterThanOrEqual(b.s)
        expect(lat, `${name} z${z} lat`).toBeLessThanOrEqual(b.n)
      }
    }
  })
})
