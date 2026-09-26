// Is the sun where the sun is?
//
// Checked against facts that follow from the geometry rather than from an almanac I half remember:
// noon elevation at a solstice is 90 − |lat ∓ 23.44|, an equinox day is twelve hours everywhere,
// the sun rises due east and sets due west at an equinox, the equation of time stays inside ±17
// minutes, and everything is symmetric about solar noon. A bug in the declination, the hour angle
// or the azimuth quadrant breaks at least one of them.
//   npx tsx probes/corridor-sun.mjs
import { sunPosition, sunVector, WorldClock } from '../apps/corridor/src/sun.ts'

let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
const near = (what, got, want, tol) => ok(`${what}: ${got.toFixed(2)} (want ${want.toFixed(2)} ±${tol})`, Math.abs(got - want) <= tol)
const CROFTON = { lat: 39.004, lon: -76.683 }

/** the instant between a and b where the elevation crosses zero, to the second */
function cross(a, b, lat, lon) {
  for (let i = 0; i < 24; i++) {
    const m = (a + b) / 2
    if (Math.sign(sunPosition(a, lat, lon).elevation) === Math.sign(sunPosition(m, lat, lon).elevation)) a = m
    else b = m
  }
  return (a + b) / 2
}

/** scan a day in one-minute steps: noon, the elevation there, and the daylight length */
function day(iso, lat, lon) {
  const t0 = Date.parse(`${iso}T00:00:00Z`)
  let best = -100, bestMs = t0, up = 0, rise = null, set = null, prev = null
  for (let m = 0; m < 1440 * 2; m++) {           // two UTC days: a local day straddles the UTC one
    const ms = t0 + m * 60000
    const s = sunPosition(ms, lat, lon)
    if (s.elevation > best) { best = s.elevation; bestMs = ms }
    if (prev !== null) {
      // BISECT THE CROSSING. A one-minute scan is fine for the elevation but not for the azimuth:
      // at 60° the sun crawls along the horizon and a minute of slop is two degrees of it, which
      // looked like a model error and was the probe's own sampling.
      if (prev <= 0 && s.elevation > 0) rise = cross(ms - 60000, ms, lat, lon)
      if (prev > 0 && s.elevation <= 0) set = cross(ms - 60000, ms, lat, lon)
    }
    prev = s.elevation
  }
  for (let m = 0; m < 1440; m++) if (sunPosition(bestMs - 720 * 60000 + m * 60000, lat, lon).elevation > 0) up++
  return { noonMs: bestMs, noonEl: best, noonAz: sunPosition(bestMs, lat, lon).azimuth, daylightMin: up, rise, set }
}

// --- the solstices: the noon elevation is fixed by latitude and the earth's tilt ---------------
{
  const june = day('2026-06-21', CROFTON.lat, CROFTON.lon)
  const dec = day('2026-12-21', CROFTON.lat, CROFTON.lon)
  near('Crofton, June solstice noon elevation', june.noonEl, 90 - CROFTON.lat + 23.44, 0.6)
  near('Crofton, December solstice noon elevation', dec.noonEl, 90 - CROFTON.lat - 23.44, 0.6)
  near('June declination', sunPosition(june.noonMs, CROFTON.lat, CROFTON.lon).declination, 23.44, 0.1)
  near('December declination', sunPosition(dec.noonMs, CROFTON.lat, CROFTON.lon).declination, -23.44, 0.1)
  near('the sun is due south at noon (June)', june.noonAz, 180, 1)
  near('the sun is due south at noon (December)', dec.noonAz, 180, 1)
  ok('midsummer is the long day', june.daylightMin > dec.daylightMin + 300, `${(june.daylightMin / 60).toFixed(1)} h vs ${(dec.daylightMin / 60).toFixed(1)} h`)
}
// --- an equinox: twelve hours, rising east and setting west, everywhere -----------------------
for (const lat of [0, 39.004, 60]) {
  const eq = day('2026-03-20', lat, CROFTON.lon)
  // refraction adds minutes, and more of them where the sun crosses the horizon at a shallow angle
  near(`equinox daylight at ${lat}°`, (eq.set - eq.rise) / 3600000, 12, lat > 50 ? 0.35 : 0.25)
  const riseAz = sunPosition(eq.rise, lat, CROFTON.lon).azimuth
  const setAz = sunPosition(eq.set, lat, CROFTON.lon).azimuth
  // DUE east, but refraction lifts the sun onto the horizon about 0.57° early, and at the equinox
  // its path meets the horizon at (90 − lat), so that early point sits further round the compass
  // the further north you are: a tolerance that ignores latitude is wrong at 60° and slack at 0°.
  const tol = 0.6 + 1.6 * Math.tan((lat * Math.PI) / 180)
  near(`equinox sunrise is due east at ${lat}°`, riseAz, 90, tol)
  near(`equinox sunset is due west at ${lat}°`, setAz, 270, tol)
}
near('noon at the equator on an equinox is overhead', day('2026-03-20', 0, CROFTON.lon).noonEl, 90, 0.7)
// --- the equation of time stays in its envelope -----------------------------------------------
{
  let lo = 99, hi = -99
  for (let d = 0; d < 365; d++) {
    const e = sunPosition(Date.parse('2026-01-01T12:00:00Z') + d * 86400000, CROFTON.lat, CROFTON.lon).eqTimeMin
    lo = Math.min(lo, e); hi = Math.max(hi, e)
  }
  ok('the equation of time runs about −14 to +16 minutes', lo > -15.5 && lo < -13 && hi > 15 && hi < 17, `${lo.toFixed(1)} … ${hi.toFixed(1)} min`)
}
// --- the render vector agrees with the angles --------------------------------------------------
{
  const v = sunVector(0, 90)   // due east, on the horizon
  near('east on the horizon → +x', v.x, 1, 0.01)
  near('east on the horizon → y 0', v.y, 0, 0.01)
  const n = sunVector(0, 0)    // due north: the world's north is −z
  near('north → −z', n.z, -1, 0.01)
  const up = sunVector(90, 123)
  near('overhead → +y', up.y, 1, 0.01)
  const steep = sunVector(30, 180, 2)
  near('the arc scale steepens the elevation', Math.asin(steep.y) * 180 / Math.PI, 60, 0.01)
}
// --- the clock ---------------------------------------------------------------------------------
{
  const c = new WorldClock()
  ok('a fresh clock is now', Math.abs(c.ms - Date.now()) < 50)
  c.rate = 600
  c.tick(1)
  ok('a rate of 600 moves ten minutes in a second', Math.abs(c.ms - Date.now() - 600000) < 200, `${((c.ms - Date.now()) / 1000).toFixed(0)} s ahead`)
  c.home()
  ok('home comes back to now', Math.abs(c.ms - Date.now()) < 50)
  c.setLocal('America/New_York', '2026-06-21', '13:30')
  const p = c.parts('America/New_York')
  ok('setting a local date and time round-trips', p.date === '2026-06-21' && p.time === '13:30', `${p.date} ${p.time}`)
  const noonish = sunPosition(c.ms, CROFTON.lat, CROFTON.lon)
  ok('and half past one on the longest day is a high sun', noonish.elevation > 65, `${noonish.elevation.toFixed(1)}°`)
}
console.log(fails ? `FAIL ${fails}` : 'PASS')
process.exit(fails ? 1 : 0)
