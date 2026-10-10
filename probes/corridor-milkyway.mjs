// Is the Milky Way in the sky, and is it over the galaxy?
//
// Rich, 2026-09-27: "If there was a public dataset for the sky it would be awesome to use it to
// draw stars and the Milky Way."
//
// `tools/sky/ingest.mjs --verify` proves the MAP: that the band lies on the galactic plane, that
// the bulge is brightest, that the galactic poles are black and that the band closes all the way
// round. It cannot prove that the map reached the GPU, or that it was put on the sky the right way
// up, or at all. A map sampled through a wrong rotation still passes every test the map has.
//
// So this probe asks the sky itself, by DIFFERENCE. The same view is rendered twice, once with
// SKY_MILKYWAY at 0 and once at 1, in directions chosen from the galaxy's own coordinates:
//
//   * toward the galactic plane, high up   -- must get much brighter
//   * toward a galactic pole, equally high -- must not change
//
// Differencing one direction against itself is what makes this a statement about the galaxy
// rather than about the sky's own gradient, which changes with altitude and azimuth whatever is
// drawn on it.
//
//   PORT=5185 node probes/corridor-milkyway.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 420, height: 300 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 900000 })
await page.waitForTimeout(3000)

/*
 * NIGHT, AND NOT BY ASKING FOR A TIME.
 *
 * Headless Chromium runs in UTC, so "22:00" is 22:00 UTC and put the sun 10 degrees UP over
 * Maryland the first time this trick was used elsewhere in these probes. The clock is pushed in
 * hours until the sun is measured below the horizon instead.
 */
const night = await page.evaluate(async () => {
  const c = window.corridor
  const THREE = c.THREE
  c.tune.set('TIME_RATE', 0)
  const D2R = Math.PI / 180
  const NGP_RA = 192.85948 * D2R, NGP_DEC = 27.12825 * D2R, LON_NODE = 122.93192 * D2R
  const dirOf = (m, lDeg, bDeg) => {
    const l = lDeg * D2R, b = bDeg * D2R
    const dec = Math.asin(Math.max(-1, Math.min(1, Math.sin(NGP_DEC) * Math.sin(b) + Math.cos(NGP_DEC) * Math.cos(b) * Math.cos(LON_NODE - l))))
    const ra = NGP_RA - Math.atan2(Math.cos(b) * Math.sin(LON_NODE - l), Math.cos(NGP_DEC) * Math.sin(b) - Math.sin(NGP_DEC) * Math.cos(b) * Math.cos(LON_NODE - l))
    return new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)).applyMatrix4(m).normalize()
  }
  /*
   * THE MOMENT IS CHOSEN, not taken.
   *
   * Two things have to be true at once: the sun below the horizon, and BOTH a piece of galactic
   * plane and a galactic pole high enough that what is measured is the sky rather than the
   * extinction near the horizon. They pull against each other -- the poles are 90 degrees from the
   * plane, so when the plane is overhead at 84.7 the pole is at 5.2, which is what the first run
   * of this measured and then failed itself on. The best either can do together is 45 each, so the
   * sweep maximises the WORSE of the two.
   *
   * A frame between steps, because moving the clock owes an environment map and asking for
   * twenty-four of them inside one tick crashed this tab.
   */
  let best = null
  for (let i = 0; i < 48; i++) {
    c.time.ms = Date.now() + i * 1800000
    await new Promise((r) => requestAnimationFrame(r))
    const sunEl = c.time.sun().el
    if (sunEl > -12) continue
    const m = c.scene.getObjectByName('milkyway')?.matrix
    if (!m) return null
    let plane = -90
    for (let l = 0; l < 360; l += 10) plane = Math.max(plane, (Math.asin(dirOf(m, l, 0).y) * 180) / Math.PI)
    const pole = Math.max((Math.asin(dirOf(m, 0, 90).y) * 180) / Math.PI, (Math.asin(dirOf(m, 0, -90).y) * 180) / Math.PI)
    const score = Math.min(plane, pole)
    if (!best || score > best.score) best = { halfHours: i, sunEl: +sunEl.toFixed(1), plane: +plane.toFixed(1), pole: +pole.toFixed(1), score: +score.toFixed(1) }
  }
  if (!best) return null
  c.time.ms = Date.now() + best.halfHours * 1800000
  await new Promise((r) => requestAnimationFrame(r))
  return best
})
if (!night) { console.error('FAIL: could not find a moment with the sun down and both the plane and a pole in the sky'); await browser.close(); process.exit(1) }
await page.waitForTimeout(1200)

const out = await page.evaluate(async () => {
  const c = window.corridor
  const THREE = c.THREE
  const mw = c.scene.getObjectByName('milkyway')
  if (!mw) return { error: 'no milkyway object in the scene — the map did not load' }
  const m = mw.matrix // the celestial-to-world rotation the viewer is actually using

  // galactic to equatorial (J2000), then through the object's own matrix to a world direction
  const D2R = Math.PI / 180
  const NGP_RA = 192.85948 * D2R, NGP_DEC = 27.12825 * D2R, LON_NODE = 122.93192 * D2R
  const dirOf = (lDeg, bDeg) => {
    const l = lDeg * D2R, b = bDeg * D2R
    const sinDec = Math.sin(NGP_DEC) * Math.sin(b) + Math.cos(NGP_DEC) * Math.cos(b) * Math.cos(LON_NODE - l)
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)))
    const y = Math.cos(b) * Math.sin(LON_NODE - l)
    const x = Math.cos(NGP_DEC) * Math.sin(b) - Math.sin(NGP_DEC) * Math.cos(b) * Math.cos(LON_NODE - l)
    const ra = NGP_RA - Math.atan2(y, x)
    const v = new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec))
    return v.applyMatrix4(m).normalize()
  }
  const altOf = (v) => (Math.asin(Math.max(-1, Math.min(1, v.y))) * 180) / Math.PI

  // the highest bit of plane there is right now, and the higher of the two galactic poles
  let plane = null
  for (let l = 0; l < 360; l += 5) {
    const v = dirOf(l, 0)
    if (!plane || v.y > plane.v.y) plane = { l, v }
  }
  const poles = [dirOf(0, 90), dirOf(0, -90)]
  const pole = poles[0].y > poles[1].y ? poles[0] : poles[1]
  // and a control that is neither: 40 degrees off the plane
  let off = null
  for (let l = 0; l < 360; l += 5) for (const b of [40, -40]) {
    const v = dirOf(l, b)
    if (!off || v.y > off.v.y) off = { l, b, v }
  }

  const r = c.renderer
  const cam = new THREE.PerspectiveCamera(55, r.domElement.width / r.domElement.height, 0.1, 5000)
  cam.position.copy(c.camera.position)
  const look = (v) => { cam.lookAt(cam.position.clone().add(v.clone().multiplyScalar(100))); cam.updateMatrixWorld() }
  const gl = r.getContext()
  const grab = () => {
    const w = r.domElement.width, h = r.domElement.height
    const buf = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    // the middle sixth of the frame, where we are pointing
    let sum = 0, n = 0
    for (let y = Math.floor(h * 0.42); y < Math.floor(h * 0.58); y++)
      for (let x = Math.floor(w * 0.42); x < Math.floor(w * 0.58); x++) {
        const o = (y * w + x) * 4
        sum += buf[o] + buf[o + 1] + buf[o + 2]
        n++
      }
    return +(sum / (3 * n)).toFixed(2)
  }
  /*
   * THE KNOB REACHES THE SHADER THROUGH A FRAME, not through the tune table.
   *
   * SKY_MILKYWAY is read in frame() and written to the uniform there, so setting it and rendering
   * by hand in the same tick renders the PREVIOUS value -- twice, which is why the first run of
   * this measured a gain of exactly 0 in all three directions. Waiting two animation frames after
   * each change is what makes the difference a difference.
   */
  const frames = (n) => new Promise((res) => { const t = () => (--n <= 0 ? res() : requestAnimationFrame(t)); requestAnimationFrame(t) })
  const at = async (v) => {
    c.tune.set('SKY_MILKYWAY', 0)
    await frames(2)
    look(v)
    c.drawFrame(cam)
    const off0 = grab()
    c.tune.set('SKY_MILKYWAY', 1)
    await frames(2)
    look(v)
    c.drawFrame(cam)
    const on = grab()
    c.tune.set('SKY_MILKYWAY', 0.5)
    return { off: off0, on, gain: +(on - off0).toFixed(2) }
  }
  return {
    planeAlt: +altOf(plane.v).toFixed(1),
    planeL: plane.l,
    poleAlt: +altOf(pole).toFixed(1),
    offAlt: +altOf(off.v).toFixed(1),
    plane: await at(plane.v),
    pole: await at(pole),
    off: await at(off.v),
  }
})

console.log(JSON.stringify({ night, ...out }, null, 1))
await browser.close()
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (out.error) fail(out.error)
// the comparison is only meaningful if both directions are actually in the sky
else if (!(out.planeAlt > 15)) fail(`the galactic plane's highest point is at altitude ${out.planeAlt} — nothing to look at, so nothing was tested`)
else if (!(out.poleAlt > 15)) fail(`the higher galactic pole is at altitude ${out.poleAlt} — the control direction is below the sky`)
else if (!(out.plane.gain > 2)) fail(`turning the Milky Way on changed the view toward the galactic plane by ${out.plane.gain}/255 — it is not being drawn`)
else if (!(out.pole.gain < out.plane.gain * 0.25)) fail(`the galactic POLE brightened by ${out.pole.gain} against the plane's ${out.plane.gain} — the band is not where the galaxy is`)
else if (!(out.off.gain < out.plane.gain * 0.6)) fail(`40 degrees off the plane brightened by ${out.off.gain} against the plane's ${out.plane.gain} — the band has no shape`)
else console.log(`PASS: with the sun at ${night.sunEl} deg, looking at the galactic plane (l ${out.planeL}, altitude ${out.planeAlt}) the Milky Way adds ${out.plane.gain}/255; at the galactic pole (altitude ${out.poleAlt}) it adds ${out.pole.gain}, and 40 degrees off the plane ${out.off.gain}.`)
