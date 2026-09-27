// Where the sun actually is, and a clock to move it.
//
// Rich, 2026-09-26: "simulate time of day (so sun going across the sky) and be able to adjust the
// arc the sun takes … a calendar and clock that autohomes to today at the current time and it
// updates in realtime, but you can adjust offsets and time elapsing rate".
//
// THE ARC IS NOT A KNOB, IT IS A DATE AND A LATITUDE. A sun that slides along a fixed hoop reads
// as fake from the first minute, because the thing everyone knows about the sun — that it is high
// and long in June and low and short in December, and that the difference is bigger the further
// north you are — is exactly what a hoop cannot do. So this is the real solar position: NOAA's
// solar-position algorithm (the one in their spreadsheet, accurate to well under a minute of arc
// for our purposes) from the site's own latitude and longitude. Changing the date changes the arc,
// which is what "adjust the arc" wants; `tiltDeg` then exaggerates it for a world that is not
// pretending to be Maryland.
//
// Everything here is pure: no three, no DOM, so probes/corridor-sun.mjs can check it against
// published sunrise and transit times.

const RAD = Math.PI / 180

/** Julian day from a UTC timestamp (ms). */
export function julianDay(ms: number): number {
  return ms / 86400000 + 2440587.5
}

export interface SunPos {
  /** degrees above the horizon; negative is below */
  elevation: number
  /** degrees clockwise from true north */
  azimuth: number
  /** the equation of time in minutes, and the declination in degrees — for anyone checking the work */
  eqTimeMin: number
  declination: number
}

/**
 * NOAA solar position for a UTC instant at a place.
 *
 * The chain is: Julian century → geometric mean longitude and anomaly → equation of centre → true
 * longitude → apparent longitude → obliquity → declination, plus the equation of time; then the
 * hour angle from local solar time, and finally elevation and azimuth. Refraction near the horizon
 * is included because it is what makes sunrise happen a couple of minutes before geometry says it
 * should, and the light changes fastest exactly there.
 */
export function sunPosition(ms: number, latDeg: number, lonDeg: number): SunPos {
  const jd = julianDay(ms)
  const t = (jd - 2451545) / 36525 // Julian centuries since J2000.0
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const C =
    Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * M * RAD) * 0.000289
  const trueLong = L0 + C
  const omega = 125.04 - 1934.136 * t
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD)
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))
  const e0 = 23 + (26 + seconds / 60) / 60
  const oblCorr = e0 + 0.00256 * Math.cos(omega * RAD)
  const declination = Math.asin(Math.sin(oblCorr * RAD) * Math.sin(appLong * RAD)) / RAD
  // equation of time, minutes
  const y = Math.tan((oblCorr / 2) * RAD) ** 2
  const eqTime =
    4 *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD)) /
    RAD
  // true solar time in minutes of the day, then the hour angle
  const utcMinutes = ((ms / 60000) % 1440 + 1440) % 1440
  const trueSolar = (utcMinutes + eqTime + 4 * lonDeg + 1440) % 1440
  const hourAngle = trueSolar / 4 < 0 ? trueSolar / 4 + 180 : trueSolar / 4 - 180
  const lat = latDeg * RAD
  const dec = declination * RAD
  const ha = hourAngle * RAD
  const cosZenith = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha)
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith))) / RAD
  const elevationGeom = 90 - zenith
  // atmospheric refraction, NOAA's piecewise fit: about 34' at the horizon, nothing overhead
  let refr = 0
  if (elevationGeom <= 85) {
    const te = Math.tan(elevationGeom * RAD)
    if (elevationGeom > 5) refr = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5
    else if (elevationGeom > -0.575) refr = 1735 + elevationGeom * (-518.2 + elevationGeom * (103.4 + elevationGeom * (-12.79 + elevationGeom * 0.711)))
    else refr = -20.772 / te
    refr /= 3600
  }
  const elevation = elevationGeom + refr
  // azimuth, degrees clockwise from north
  // NOAA's own branch, which is easy to get mirrored: BEFORE solar noon (hour angle negative) the
  // sun is in the east and the arccos is measured the other way round. Getting it backwards still
  // puts the sun due south at noon and still gives the right elevations all day — it only shows up
  // as sunrise in the west, which is why probes/corridor-sun.mjs checks the equinox horizons.
  let azimuth: number
  const denom = Math.cos(lat) * Math.sin(zenith * RAD)
  if (Math.abs(denom) > 1e-9) {
    const cosAz = Math.min(1, Math.max(-1, (Math.sin(lat) * Math.cos(zenith * RAD) - Math.sin(dec)) / denom))
    const a = Math.acos(cosAz) / RAD
    azimuth = hourAngle > 0 ? (a + 180) % 360 : (540 - a) % 360
  } else {
    azimuth = latDeg > 0 ? 180 : 0
  }
  return { elevation, azimuth, eqTimeMin: eqTime, declination }
}

/**
 * The sun as the renderer wants it: a unit vector in the viewer's world frame, where x is east,
 * y is up and z is SOUTH (z = −north). Azimuth is clockwise from north, so north is −z and east
 * is +x.
 *
 * `tiltDeg` exaggerates or flattens the arc about the horizon — the "adjust the arc" knob for a
 * world that is not pretending to be Maryland. 1 is the sky over the site as it really is.
 */
export function sunVector(elevationDeg: number, azimuthDeg: number, arcScale = 1): { x: number; y: number; z: number } {
  const el = Math.max(-90, Math.min(90, elevationDeg * arcScale)) * RAD
  const az = azimuthDeg * RAD
  const h = Math.cos(el)
  return { x: h * Math.sin(az), y: Math.sin(el), z: -h * Math.cos(az) }
}

/**
 * A clock the world runs on: it starts at the real now and keeps up with it, and it can be pushed
 * around without losing that relationship.
 *
 * `rate` is how many simulated seconds pass per real second — 1 is a real day, 600 puts a whole
 * day in four minutes, 0 stops the sun where it is. `offsetMs` is how far the simulated clock sits
 * from the real one, which is what a date picker and a time slider actually move; `home()` puts it
 * back to now. Keeping the offset rather than an absolute time is what lets a paused world still
 * track "today" when you come back to it tomorrow.
 */
export class WorldClock {
  /** simulated − real, in ms; a date/time control moves this */
  offsetMs = 0
  /** simulated seconds per real second */
  rate = 1
  private realMs = Date.now()

  /**
   * Advance by a real-time delta (seconds).
   *
   * What actually moves is the OFFSET, and only by the part of the advance that is not real time:
   * at rate 1 the offset does not change at all, so a tab left in the background for an hour --
   * where rAF does not fire and the delta comes back as one huge number -- still reads the correct
   * time when you look at it again, with no catching up to do.
   *
   * The accelerated part IS capped. A 43-second stall was measured on a software rasteriser in
   * September; at 3600x, applying it whole is a fortnight of sun in a single frame. Slowing down
   * (rate below 1, paused included) is never capped, or a paused world left in a background tab
   * comes back with the sun moved on.
   */
  tick(dt: number) {
    const now = Date.now()
    const k = this.rate - 1
    this.offsetMs += (k >= 0 ? Math.min(dt, 0.25) : dt) * k * 1000
    this.realMs = now
  }

  /** the simulated instant, ms since the epoch */
  get ms(): number {
    return this.realMs + this.offsetMs
  }

  set ms(v: number) {
    this.realMs = Date.now()
    this.offsetMs = v - this.realMs
  }

  /** back to the real here and now */
  home() {
    this.ms = Date.now()
    this.offsetMs = 0
  }

  /** the simulated time as local wall-clock parts, in a named IANA zone */
  parts(timeZone: string): { date: string; time: string; hours: number } {
    const d = new Date(this.ms)
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
    const hours = Number(p.hour) + Number(p.minute) / 60
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, hours }
  }

  /** set the simulated wall-clock date and/or time in a named zone, keeping the other half */
  setLocal(timeZone: string, date?: string, time?: string) {
    const cur = this.parts(timeZone)
    const d = date ?? cur.date
    // "HH:MM", always. An <input type=time> with a seconds step hands back "HH:MM:SS", and
    // `${d}T12:00:00:00Z` parses to NaN -- which becomes an Invalid Date, which Intl throws on,
    // inside whatever loop happens to be reading the clock. Refuse a bad instant here instead.
    const t = (time ?? cur.time).slice(0, 5)
    const want = Date.parse(`${d}T${t}:00Z`)
    if (!Number.isFinite(want)) return
    // find the UTC instant whose wall clock in `timeZone` is (d, t): guess, measure the error in
    // the zone itself, correct. Two passes settle it, DST included, without a zone database.
    let guess = want
    for (let i = 0; i < 2; i++) {
      const got = new WorldClock()
      got.ms = guess
      const p = got.parts(timeZone)
      const has = Date.parse(`${p.date}T${p.time}:00Z`)
      guess += want - has
    }
    this.ms = guess
  }
}
