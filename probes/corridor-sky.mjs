// Is the night sky the real one, and does it turn the way the sky turns?
//
// Rich, 2026-09-27: "make the night sky based on reality wrt stars, and make the moon and the
// stars move across the sky as they would in reality."
//
// `apps/corridor/test/celestial.test.ts` proves the arithmetic against Polaris, the sidereal rate
// and NOAA's Sun. This proves the RENDERER: that the catalogue reached the GPU, that the object
// the viewer turns is the one the maths says, and that what you can see changes over a night and
// over a year the way it does outside.
//
// The check is a constellation. Orion's belt is three stars in a row, 1.6 degrees apart, and
// nothing else in the sky looks like that — so finding it at the right altitude and azimuth, from
// the data the GPU was actually given, is a statement about the whole chain that no single star
// could make.
//
//   PORT=5185 node probes/corridor-sky.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 560, height: 380 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
page.on('console', (m) => { if (/^sky:/.test(m.text())) console.log('  page:', m.text()) })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 900000 })
await page.waitForTimeout(4000)

const out = await page.evaluate(async () => {
  const c = window.corridor
  const THREE = c.THREE
  const pts = c.scene.getObjectByName('stars')
  if (!pts) return { error: 'no star object in the scene — the catalogue did not load' }
  const pos = pts.geometry.getAttribute('position')
  const mag = pts.geometry.getAttribute('aMag')
  const anchor = c.site.manifest.frame?.anchor ?? { lat: 39, lon: -76.7 }

  /** where a catalogue star is on the sky right now, from the object's OWN matrix */
  const altAzOf = (i, m) => {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m)
    const alt = (Math.asin(Math.max(-1, Math.min(1, v.y))) * 180) / Math.PI
    let az = (Math.atan2(v.x, -v.z) * 180) / Math.PI
    if (az < 0) az += 360
    return { alt, az }
  }
  /** the brightest star within `tol` degrees of a given right ascension / declination */
  const find = (raH, decD, tol = 0.4) => {
    const ra = (raH * 15 * Math.PI) / 180
    const dec = (decD * Math.PI) / 180
    const t = new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec))
    let best = null
    for (let i = 0; i < pos.count; i++) {
      const d = Math.acos(Math.max(-1, Math.min(1, t.x * pos.getX(i) + t.y * pos.getY(i) + t.z * pos.getZ(i)))) * (180 / Math.PI)
      if (d < tol && (!best || mag.getX(i) < best.mag)) best = { i, d, mag: mag.getX(i) }
    }
    return best
  }

  // Orion's belt, J2000: Mintaka, Alnilam, Alnitak
  const belt = [find(5.5334, -0.2991), find(5.6036, -1.2019), find(5.6793, -1.9426)]
  if (belt.some((b) => !b)) return { error: 'Orion’s belt is not in the loaded catalogue' }
  // set a date and time when Orion is well up over Maryland: a January evening
  const setTo = async (iso) => {
    c.time.setLocal('2026-01-15', iso, 'UTC')
    await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => requestAnimationFrame(r))
    return pts.matrix.clone()
  }
  const m1 = await setTo('02:00')
  const b1 = belt.map((b) => altAzOf(b.i, m1))
  // the belt's own geometry: three in a row, about 1.35 degrees apart end to middle
  const sep = (p, q) => {
    const v = (a) => [Math.cos((a.alt * Math.PI) / 180) * Math.cos((a.az * Math.PI) / 180), Math.cos((a.alt * Math.PI) / 180) * Math.sin((a.az * Math.PI) / 180), Math.sin((a.alt * Math.PI) / 180)]
    const [a, b] = [v(p), v(q)]
    return (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI
  }
  // four hours later the sky has turned; and one sidereal day later it is back
  const m2 = await setTo('06:00')
  const b2 = belt.map((b) => altAzOf(b.i, m2))
  const sidereal = await page_evalSidereal(c, pts, belt, altAzOf)
  return {
    anchor,
    stars: pos.count,
    beltMags: belt.map((b) => +b.mag.toFixed(2)),
    at02: b1.map((a) => ({ alt: +a.alt.toFixed(2), az: +a.az.toFixed(2) })),
    at06: b2.map((a) => ({ alt: +a.alt.toFixed(2), az: +a.az.toFixed(2) })),
    sepAB: +sep(b1[0], b1[1]).toFixed(3),
    sepBC: +sep(b1[1], b1[2]).toFixed(3),
    turnedDeg: +Math.abs(((b2[1].az - b1[1].az + 540) % 360) - 180).toFixed(2),
    sidereal,
  }
  async function page_evalSidereal(cc, p, bl, aa) {
    cc.time.setLocal('2026-01-15', '02:00', 'UTC')
    await new Promise((r) => requestAnimationFrame(r))
    const a0 = aa(bl[1].i, p.matrix.clone())
    // one sidereal day later: 23h56m04s
    cc.time.setLocal('2026-01-16', '01:56', 'UTC')
    await new Promise((r) => requestAnimationFrame(r))
    const a1 = aa(bl[1].i, p.matrix.clone())
    return { dAlt: +(a1.alt - a0.alt).toFixed(2), dAz: +Math.abs(((a1.az - a0.az + 540) % 360) - 180).toFixed(2) }
  }
})
console.log(JSON.stringify(out, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (out.error) fail(out.error)
else if (!(out.stars > 8000)) fail(`only ${out.stars} stars reached the GPU`)
// the belt is three stars of magnitude ~1.7-2.4; if these are not them the catalogue is wrong
else if (out.beltMags.some((m) => m < 1.5 || m > 2.6)) fail(`the stars found at Orion's belt have magnitudes ${out.beltMags} — those are not the belt`)
// its own geometry, which no transform can change: three in a row, ~1.35 deg apart
else if (!(out.sepAB > 1.1 && out.sepAB < 1.6 && out.sepBC > 1.1 && out.sepBC < 1.6)) fail(`the belt's spacing came out ${out.sepAB} and ${out.sepBC} degrees — it is 1.35`)
// and it is ABOVE THE HORIZON over Maryland at 2am in January, which is when Orion is up
else if (!(out.at02[1].alt > 20)) fail(`Orion's belt is at altitude ${out.at02[1].alt} over ${out.anchor.lat}N at 02:00 in January — it should be well up`)
/*
 * FOUR HOURS OF SKY IS NOT SIXTY DEGREES OF AZIMUTH.
 *
 * The HOUR ANGLE advances 15.04 degrees an hour; azimuth does not, and near the meridian it moves
 * much faster — Orion went from 156 to 236 degrees in four hours because it was crossing due
 * south, which is exactly where azimuth changes quickest. The first version of this check asserted
 * 60 and failed a correct sky.
 *
 * So what is asserted is what is actually true: it moved WEST (azimuth increased, it is past the
 * meridian) and it came DOWN. The rate is checked properly by the sidereal return below, which is
 * the assertion that a wrong rate cannot survive.
 */
else if (!(out.turnedDeg > 30)) fail(`four hours barely moved the sky (${out.turnedDeg} degrees of azimuth) — it is not turning`)
else if (!(out.at06[1].alt < out.at02[1].alt)) fail(`the belt rose from ${out.at02[1].alt} to ${out.at06[1].alt} degrees between 02:00 and 06:00 — after crossing the meridian it must set`)
// and one sidereal day later it is back where it started
else if (!(out.sidereal.dAz < 0.3 && Math.abs(out.sidereal.dAlt) < 0.3)) fail(`one sidereal day later the belt moved ${out.sidereal.dAz} deg in azimuth and ${out.sidereal.dAlt} in altitude — the sky is not turning at the sidereal rate`)
else console.log(`PASS: ${out.stars} stars on the GPU. Orion's belt (mags ${out.beltMags}) is ${out.sepAB}/${out.sepBC} degrees apart, ${out.at02[1].alt} degrees up at 02:00 over ${out.anchor.lat}N in January, moves ${out.turnedDeg} degrees of azimuth and sets from ${out.at02[1].alt} to ${out.at06[1].alt} degrees over four hours, and returns to within ${out.sidereal.dAz} degrees after one sidereal day.`)
