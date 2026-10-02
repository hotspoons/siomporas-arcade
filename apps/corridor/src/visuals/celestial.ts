// Where the stars actually are, for an observer standing somewhere at some moment.
//
// Rich, 2026-09-27: "make the night sky based on reality wrt stars, and make the moon and the
// stars move across the sky as they would in reality".
//
// THE WHOLE SKY IS ONE ROTATION. A star's position on the celestial sphere does not change (the
// catalogue's J2000 coordinates are good for a human lifetime — precession is under a degree a
// century, which is far below anything else in this sky). What changes is where the observer is
// and which way the Earth is pointing. So the stars are built ONCE as unit vectors in the
// equatorial frame and the whole sphere is turned by one matrix per frame, which is both exact
// and what the sky is really doing. Nine thousand stars cost one matrix.
//
// FRAMES, because this is where sky code goes wrong:
//
//   equatorial   right-handed, x to the vernal equinox, z to the north celestial pole. A star at
//                right ascension a and declination d is (cos d cos a, cos d sin a, sin d).
//   world        this renderer's: x EAST, y UP, z SOUTH — i.e. (east, up, -north).
//
// Everything here is checked against things that are true independently of the formulae: Polaris
// sits at an altitude equal to the observer's latitude, due north; and the Sun run through this
// same transform must land where NOAA's solar position (sun.ts) puts it, by a completely
// different route.

import * as THREE from 'three'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

/** Julian Date from a JavaScript instant. */
export function julianDate(ms: number): number {
  return ms / 86400000 + 2440587.5
}

/**
 * Greenwich Mean Sidereal Time, in radians.
 *
 * IAU 1982, the standard series. Sidereal time runs about four minutes a day faster than clock
 * time, which is exactly why the same stars rise earlier each night — get this wrong by a constant
 * and the sky is merely rotated; get the RATE wrong and it drifts through the year.
 */
export function gmst(jd: number): number {
  const t = (jd - 2451545.0) / 36525
  let d = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - (t * t * t) / 38710000
  d = ((d % 360) + 360) % 360
  return d * D2R
}

/** Local Mean Sidereal Time, radians, east longitude positive. */
export function lmst(jd: number, lonDeg: number): number {
  const a = gmst(jd) + lonDeg * D2R
  return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
}

/**
 * The matrix that turns an equatorial unit vector into a WORLD direction.
 *
 * Built from the observer's own horizon basis expressed in equatorial coordinates, rather than
 * from a chain of named rotations — there is no convention to get backwards that way, and each
 * column is a thing you can point at:
 *
 *   up     the zenith: declination = latitude, right ascension = local sidereal time
 *   east   perpendicular to the meridian plane, in the direction of increasing right ascension
 *   north  completes it, and is where a compass points
 */
export function celestialToWorld(latDeg: number, lonDeg: number, jd: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const th = lmst(jd, lonDeg)
  const phi = latDeg * D2R
  const ct = Math.cos(th)
  const st = Math.sin(th)
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  // in equatorial coordinates
  const up = new THREE.Vector3(cp * ct, cp * st, sp)
  const east = new THREE.Vector3(-st, ct, 0)
  const north = new THREE.Vector3(-sp * ct, -sp * st, cp)
  // world = (east, up, -north): each ROW is the world axis expressed in equatorial coordinates,
  // so the matrix maps equatorial -> world
  return out.set(
    east.x, east.y, east.z, 0,
    up.x, up.y, up.z, 0,
    -north.x, -north.y, -north.z, 0,
    0, 0, 0, 1,
  )
}

/** A right ascension and declination (radians) as an equatorial unit vector. */
export function radecToVec(ra: number, dec: number, out = new THREE.Vector3()): THREE.Vector3 {
  const cd = Math.cos(dec)
  return out.set(cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec))
}

/** A world direction back to altitude and azimuth in degrees, azimuth from north through east. */
export function altAzOf(v: THREE.Vector3): { alt: number; az: number } {
  const n = v.clone().normalize()
  const alt = Math.asin(THREE.MathUtils.clamp(n.y, -1, 1)) * R2D
  // world z is SOUTH, so north is -z
  let az = Math.atan2(n.x, -n.z) * R2D
  if (az < 0) az += 360
  return { alt, az }
}

/**
 * The Moon's geocentric right ascension, declination and illuminated fraction.
 *
 * Meeus' abridged lunar theory — the handful of largest periodic terms rather than the full ELP.
 * It is good to a few arcminutes, which against a half-degree disc drawn on a sky dome is far
 * better than it needs to be, and it is a few dozen lines rather than a megabyte of coefficients.
 *
 * The PHASE is what makes a moon look right, and it is not a clock: it is the angle between the
 * Sun and the Moon as seen from here, so it comes out of the two positions rather than out of a
 * 29.53-day sawtooth that drifts.
 */
export function moonPosition(jd: number): { ra: number; dec: number; phase: number; distKm: number } {
  const t = (jd - 2451545.0) / 36525
  const rad = D2R
  // mean elements, degrees
  const Lp = 218.316 + 481267.8813 * t // mean longitude
  const M = 357.5291 + 35999.0503 * t // sun's mean anomaly
  const Mp = 134.963 + 477198.8676 * t // moon's mean anomaly
  const D = 297.8502 + 445267.1115 * t // mean elongation
  const F = 93.272 + 483202.0175 * t // argument of latitude
  // the six largest longitude terms, the four largest latitude terms (Meeus, ch. 47 abridged)
  const lon =
    Lp +
    6.289 * Math.sin(Mp * rad) +
    1.274 * Math.sin((2 * D - Mp) * rad) +
    0.658 * Math.sin(2 * D * rad) +
    0.214 * Math.sin(2 * Mp * rad) -
    0.186 * Math.sin(M * rad) -
    0.114 * Math.sin(2 * F * rad)
  const lat =
    5.128 * Math.sin(F * rad) +
    0.281 * Math.sin((Mp + F) * rad) -
    0.278 * Math.sin((F - Mp) * rad) -
    0.173 * Math.sin((2 * D - F) * rad)
  const distKm = 385001 - 20905 * Math.cos(Mp * rad) - 3699 * Math.cos((2 * D - Mp) * rad) - 2956 * Math.cos(2 * D * rad)
  // ecliptic -> equatorial
  const eps = (23.439 - 0.0000004 * (jd - 2451545.0)) * rad
  const l = lon * rad
  const b = lat * rad
  const ra = Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l))
  const dec = Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l))
  // elongation from the Sun gives the illuminated fraction
  const sunLon = (280.46646 + 36000.76983 * t + 0.0003032 * t * t) * rad
  const sunAnom = M * rad
  const sunTrue = sunLon + (1.914602 - 0.004817 * t) * rad * Math.sin(sunAnom) + 0.019993 * rad * Math.sin(2 * sunAnom)
  const elong = Math.acos(Math.cos(b) * Math.cos(l - sunTrue))
  return { ra: ((ra % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), dec, phase: (1 - Math.cos(elong)) / 2, distKm }
}

/** The Sun's geocentric right ascension and declination — for checking this file against sun.ts. */
export function sunPositionEq(jd: number): { ra: number; dec: number } {
  const t = (jd - 2451545.0) / 36525
  const rad = D2R
  const L = (280.46646 + 36000.76983 * t + 0.0003032 * t * t) * rad
  const g = (357.52911 + 35999.05029 * t - 0.0001537 * t * t) * rad
  const lam = L + (1.914602 - 0.004817 * t - 0.000014 * t * t) * rad * Math.sin(g) + (0.019993 - 0.000101 * t) * rad * Math.sin(2 * g) + 0.000289 * rad * Math.sin(3 * g)
  const eps = (23.439291 - 0.0130042 * t) * rad
  return { ra: Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec: Math.asin(Math.sin(eps) * Math.sin(lam)) }
}
