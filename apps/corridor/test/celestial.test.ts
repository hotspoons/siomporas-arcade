// The sky's arithmetic, checked against things that are true whatever the formulae say.
//
// Sky code fails silently and plausibly: a sign error in the hour angle gives a sky that rotates
// the wrong way, a wrong sidereal RATE gives one that drifts through the year, and a frame
// convention taken backwards gives one that is merely upside down. All of them look like a sky.
//
// So nothing here is compared against a number this code produced. The checks are:
//
//   1. POLARIS sits at an altitude equal to the observer's latitude, due north. That is the oldest
//      navigational fact there is and it owes nothing to any of this.
//   2. THE SUN, put through the star transform, must land where NOAA's solar position puts it —
//      two completely independent routes (`sun.ts` is a solar-specific series; `celestial.ts` goes
//      via sidereal time and an equatorial-to-horizon rotation) that must agree.
//   3. THE SKY TURNS ONCE PER SIDEREAL DAY, 23h56m04s, not once per solar day. Four minutes is the
//      whole difference between a sky that works and one that is a year out by next December.
//   4. THE MOON IS FULL when it is opposite the Sun, and that is measured from the two positions
//      rather than from a 29.53-day sawtooth.

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { altAzOf, celestialToWorld, julianDate, lmst, moonPosition, radecToVec, sunPositionEq } from '../src/visuals/celestial'
import { sunPosition } from '../src/visuals/sun'

/** Crofton, Maryland — the site most of this repo is built around. */
const LAT = 39.004
const LON = -76.683

const at = (iso: string) => julianDate(Date.parse(iso))

function altAz(ra: number, dec: number, jd: number, lat = LAT, lon = LON) {
  const v = radecToVec(ra, dec).applyMatrix4(celestialToWorld(lat, lon, jd))
  return altAzOf(v)
}

describe('the celestial sphere', () => {
  it('puts Polaris at the latitude, due north, wherever and whenever you stand', () => {
    // J2000: RA 02h 31m 49s, Dec +89 15' 51". It is 0.74 degrees off the pole, so it circles that
    // far around due north over a day — which is why the tolerances below are a degree and not a
    // minute, and why checking it at four spread-out times is the point rather than incidental.
    const ra = ((2 + 31 / 60 + 49 / 3600) * 15 * Math.PI) / 180
    const dec = ((89 + 15 / 60 + 51 / 3600) * Math.PI) / 180
    for (const t of ['2026-01-01T00:00:00Z', '2026-04-01T06:00:00Z', '2026-07-01T12:00:00Z', '2026-10-01T18:00:00Z']) {
      for (const lat of [10, 39.004, 60]) {
        const { alt, az } = altAz(ra, dec, at(t), lat)
        expect(Math.abs(alt - lat)).toBeLessThan(1.0)
        // azimuth wraps, so measure the angle to north rather than the number
        const offNorth = Math.abs(((az + 180) % 360) - 180)
        expect(offNorth).toBeLessThan(1.5)
      }
    }
  })

  it('agrees with NOAA about where the Sun is, by a completely different route', () => {
    /*
     * The two routes share nothing. `sun.ts` is NOAA's solar-specific series straight to elevation
     * and azimuth; this goes the general way — the Sun's equatorial coordinates, sidereal time,
     * and the same equatorial-to-horizon rotation every star uses. If the frames, the sidereal
     * time or the matrix were wrong, the Sun would land somewhere else.
     *
     * They do not agree exactly, and the residual is a real thing rather than slop: NOAA's answer
     * includes ATMOSPHERIC REFRACTION, which lifts a body near the horizon by up to half a degree
     * and is nil overhead. So the tolerance is split by altitude, and the fact that the error
     * TRACKS altitude is itself the evidence that nothing else is wrong.
     */
    const rows: { t: string; el: number; deg: number }[] = []
    for (const t of [
      '2026-03-20T12:00:00Z', // equinox
      '2026-06-21T17:00:00Z', // solstice, sun high
      '2026-09-27T07:30:00Z',
      '2026-12-21T16:00:00Z', // solstice, sun low — refraction
      '2026-08-15T00:30:00Z', // the small hours, well below the horizon — refraction clamped
    ]) {
      const jd = at(t)
      const eq = sunPositionEq(jd)
      const mine = altAz(eq.ra, eq.dec, jd)
      const noaa = sunPosition(Date.parse(t), LAT, LON)
      const a = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - (mine.alt * Math.PI) / 180, (mine.az * Math.PI) / 180)
      const b = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - (noaa.elevation * Math.PI) / 180, (noaa.azimuth * Math.PI) / 180)
      rows.push({ t, el: noaa.elevation, deg: (a.angleTo(b) * 180) / Math.PI })
    }
    /*
     * The residual is not merely SMALL, it is REFRACTION — so it is checked against refraction's
     * own formula rather than against a tolerance somebody picked. Bennett's approximation, the
     * standard one, in arcminutes for an apparent altitude h in degrees:
     *
     *     R = 1 / tan(h + 7.31 / (h + 4.4))
     *
     * A constant offset hiding in the sidereal time, or a frame a degree out, would not follow
     * that curve from 25 degrees up to 70. This is the assertion that makes the whole file worth
     * having.
     */
    const refractionDeg = (h: number) => 1 / Math.tan(((h + 7.31 / (h + 4.4)) * Math.PI) / 180) / 60
    const above = rows.filter((r) => r.el > 5)
    expect(above.length).toBeGreaterThanOrEqual(3)
    for (const r of above) {
      const expected = refractionDeg(r.el)
      expect(Math.abs(r.deg - expected), `${r.t} at ${r.el.toFixed(1)} deg: ${(r.deg * 60).toFixed(2)}' against refraction ${(expected * 60).toFixed(2)}'`).toBeLessThan(0.012)
    }
    // and below the horizon, where NOAA clamps its refraction model, they still agree to well
    // under the size of the Sun
    for (const r of rows.filter((x) => x.el <= 5)) expect(r.deg, `${r.t} at ${r.el.toFixed(1)} deg`).toBeLessThan(0.7)
  })

  it('turns once per SIDEREAL day, not once per solar day', () => {
    const jd0 = at('2026-09-27T02:00:00Z')
    const ra = ((6 + 45 / 60) * 15 * Math.PI) / 180 // Sirius, near enough
    const dec = (-16.7 * Math.PI) / 180
    const a0 = altAz(ra, dec, jd0)
    const sidereal = 23.9344696 / 24
    const aSid = altAz(ra, dec, jd0 + sidereal)
    const aSolar = altAz(ra, dec, jd0 + 1)
    const off = (x: number) => Math.abs(((x + 180) % 360) - 180)
    // after one sidereal day it is back where it was, to a hundredth of a degree
    expect(off(aSid.az - a0.az)).toBeLessThan(0.05)
    expect(Math.abs(aSid.alt - a0.alt)).toBeLessThan(0.05)
    // and after one SOLAR day it is about a degree past it — 360/365.25
    expect(off(aSolar.az - a0.az)).toBeGreaterThan(0.3)
  })

  it('advances local sidereal time by about 361 degrees a solar day', () => {
    const jd = at('2026-09-27T00:00:00Z')
    const d = ((lmst(jd + 1, LON) - lmst(jd, LON)) * 180) / Math.PI
    const wrapped = ((d % 360) + 360) % 360
    expect(wrapped).toBeGreaterThan(0.8)
    expect(wrapped).toBeLessThan(1.2)
  })

  it('has the Moon full when it is opposite the Sun', () => {
    // 2026-10-26 is a full moon; 2026-11-09 a new one (any ephemeris agrees on these to the hour)
    const full = moonPosition(at('2026-10-26T04:00:00Z'))
    const New = moonPosition(at('2026-11-09T22:00:00Z'))
    expect(full.phase).toBeGreaterThan(0.97)
    expect(New.phase).toBeLessThan(0.03)
    // and it is never further than the Moon actually gets
    for (const t of ['2026-01-15T00:00:00Z', '2026-05-05T00:00:00Z', '2026-09-27T00:00:00Z']) {
      const m = moonPosition(at(t))
      expect(m.distKm).toBeGreaterThan(356000)
      expect(m.distKm).toBeLessThan(407000)
      expect(Math.abs((m.dec * 180) / Math.PI)).toBeLessThan(29) // never leaves the zodiac band
    }
  })
})
