// Is the road paint LIT at night, and does it come back in the headlights?
//
// Rich, 2026-09-27: "pavement markings seem to not be affected by night time … it is glow in the
// dark lines which is cool and cyberpunk but not quite the default night aesthetic I'd go for …
// It would be great to have retroreflective things like street signs, stop signs and pavement
// markings super sensitive to head lights so if they caught the edge of the light cone they'd
// light up."
//
// Measured before the change, on his own session, 32 degrees below the horizon: 129 `road:markings`
// meshes on an unlit MeshBasicMaterial. Unlit means no light in the scene can reach it, so the
// paint was structurally incapable of getting dark.
//
// This asserts the two halves of the replacement, and it does it by DIFFERENCE IMAGING with one
// uniform moved at a time, so the only thing that changed between two frames is the thing under
// test. The world is frozen first — clock rate, wind and weather — because an earlier probe in
// this repo spent four rounds measuring the grass swaying and the sun moving instead of the thing
// it was pointed at.
//
//   PORT=5185 node probes/corridor-retro.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 560, height: 380 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)))
page.on('console', (m) => { if (m.type() === 'error' && /shader|GLSL|program/i.test(m.text())) console.log('SHADER', m.text().slice(0, 400)) })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForTimeout(4000)

// drive, and park on a road with a centre line: the photo station is chosen for exactly that
await page.keyboard.press('Tab')
await page.waitForTimeout(1500)
const setup = await page.evaluate(() => {
  const c = window.corridor
  if (!c.drive?.car) return { error: 'not driving' }
  const m = c.site.manifest
  const p = c.site.spineAt(m.spine.photo_s)
  const side = p.dir.clone().cross(new c.THREE.Vector3(0, 1, 0)).multiplyScalar(1.83)
  c.drive.car.place(p.pos.x + side.x, p.pos.z + side.z, Math.atan2(p.dir.z, p.dir.x))
  // FREEZE THE WORLD: everything that moves by itself would otherwise be what the difference
  // image measures.
  c.tune.set('GRASS_WIND', 0)
  c.tune.set('WEATHER', 0) // clear
  c.tune.set('TREE_REPLANT_M', 0) // no replant mid-measurement
  return { at: [Math.round(p.pos.x), Math.round(p.pos.z)] }
})
await page.waitForTimeout(3000)

/*
 * FIND NIGHT BY LOOKING AT THE SUN, not by naming a time -- ONCE, before any frame is taken.
 *
 * `setLocal(date, time)` interprets the time in the BROWSER's zone, and headless Chromium runs in
 * UTC. Asking for 22:00 put the sun 10.2 degrees ABOVE the horizon over Maryland, and a whole run
 * measured dusk while reporting "night". Sweeping the day to find it crashed the tab instead:
 * every clock change rebuilds the sky environment map, and dozens of those in a tight loop is a
 * stress test, not a measurement. So: one guess from longitude, which lands within an hour
 * anywhere, then a few steps with a frame between them.
 */
const times = await page.evaluate(async () => {
  const c = window.corridor
  const lon = c.site.manifest.frame?.anchor?.lon ?? 0
  const solarNoonUtc = (12 - lon / 15 + 24) % 24
  const fmt = (h) => `${String(((Math.round(h) % 24) + 24) % 24).padStart(2, '0')}:00`
  const at = async (h) => {
    c.time.setLocal('2026-09-26', fmt(h))
    await new Promise((r) => requestAnimationFrame(r))
    return c.time.sun().el
  }
  const seek = async (start, want) => {
    let h = start
    let el = await at(h)
    for (let k = 0; k < 3; k++) {
      const next = await at(h + 1)
      if (want < 0 ? next >= el : next <= el) break
      h += 1
      el = next
    }
    return { time: fmt(h), el: +el.toFixed(1) }
  }
  const night = await seek(solarNoonUtc + 12, -1)
  const day = await seek(solarNoonUtc, 1)
  return { night, day }
})
const NIGHT = times.night.time
const DAY = times.day.time

/**
 * Render once and read the frame back in the SAME turn — the renderer has no
 * preserveDrawingBuffer, so a readback a frame later reads a cleared buffer.
 *
 * The pixels STAY IN THE PAGE. Shipping a 640x420 frame over the debugging protocol is a million
 * numbers as JSON, and five of those took longer than the probe's own timeout. Only the verdict
 * crosses the wire.
 */
const frame = async (name, knobs, timeOfDay) =>
  page.evaluate(
    ({ name, knobs, timeOfDay }) =>
      new Promise((resolve) => {
        const c = window.corridor
        if (timeOfDay) c.time.setLocal('2026-09-26', timeOfDay)
        for (const [k, v] of Object.entries(knobs)) c.tune.set(k, v)
        let n = 0
        const tick = () => {
          if (++n < 8) return requestAnimationFrame(tick)
          const r = c.renderer
          c.drawFrame()
          const gl = r.getContext()
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
          const buf = new Uint8Array(w * h * 4)
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
          window.__frames = window.__frames || {}
          window.__frames[name] = { w, h, buf }
          resolve({ sunEl: +c.time.sun().el.toFixed(1), lampOn: c.retro().lampOn, night: c.retro().night })
        }
        requestAnimationFrame(tick)
      }),
    { name, knobs, timeOfDay },
  )

const conditions = {}
conditions.nightNoLampsNoRetro = await frame('nightNoLampsNoRetro', { HEADLIGHT: 0, RETRO_MARKINGS: 0 }, NIGHT)
conditions.nightNoLampsRetro = await frame('nightNoLampsRetro', { HEADLIGHT: 0, RETRO_MARKINGS: 3 }, NIGHT)
conditions.nightLampsNoRetro = await frame('nightLampsNoRetro', { HEADLIGHT: 1, RETRO_MARKINGS: 0 }, NIGHT)
conditions.nightLampsRetro = await frame('nightLampsRetro', { HEADLIGHT: 1, RETRO_MARKINGS: 3 }, NIGHT)
conditions.day = await frame('day', { HEADLIGHT: 0, RETRO_MARKINGS: 3 }, DAY)

const res = await page.evaluate(() => {
  const F = window.__frames
  const { w, h } = F.day
  const lum = (f, i) => 0.2126 * f.buf[i] + 0.7152 * f.buf[i + 1] + 0.0722 * f.buf[i + 2]
  // the road ahead of the car: the lower-middle third of the frame, where the paint is
  const idx = []
  for (let y = 0; y < Math.floor(h * 0.42); y++) for (let x = Math.floor(w * 0.18); x < Math.floor(w * 0.82); x++) idx.push((y * w + x) * 4)
  // THE PAINT PIXELS, found rather than assumed: the ones the retro term lit up when the lamps
  // were already on. Nothing else in the frame changed between those two renders.
  const paint = idx.filter((i) => lum(F.nightLampsRetro, i) - lum(F.nightLampsNoRetro, i) > 25)
  const mean = (f, ix) => (ix.length ? +(ix.reduce((a, i) => a + lum(f, i), 0) / ix.length).toFixed(1) : null)
  return {
    regionPx: idx.length,
    paintPx: paint.length,
    meanOnPaint: {
      nightNoLamps: mean(F.nightNoLampsNoRetro, paint),
      nightNoLampsRetroOn: mean(F.nightNoLampsRetro, paint),
      nightLamps: mean(F.nightLampsNoRetro, paint),
      nightLampsRetro: mean(F.nightLampsRetro, paint),
      day: mean(F.day, paint),
    },
  }
})
res.at = setup.at
res.times = times
res.conditions = conditions
console.log(JSON.stringify(res, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
const p = res.meanOnPaint
const c = res.conditions
if (setup.error) fail(setup.error)
// liveness on the conditions first: a "night" frame taken in daylight proves nothing, and one
// was — the browser clock is UTC, so 22:00 put the sun ten degrees UP over Maryland
else if (!(c.nightLampsRetro.sunEl < -6)) fail(`the night frames were taken with the sun at ${c.nightLampsRetro.sunEl} degrees — that is not night`)
else if (!(c.day.sunEl > 10)) fail(`the day frame was taken with the sun at ${c.day.sunEl} degrees — that is not day`)
else if (!(c.nightLampsRetro.lampOn > 0)) fail('the headlights were off in the lamps-on frame')
else if (!(c.nightNoLampsRetro.lampOn === 0)) fail('the headlights were on in the lamps-off frame')
else if (res.paintPx < 40) fail(`only ${res.paintPx} pixels brightened when the retro term came on — the headlights are not reaching the paint, or the shader is not running`)
// 1. retro does NOTHING without headlights. If this fails the term is a constant, i.e. a new glow.
else if (Math.abs(p.nightNoLampsRetroOn - p.nightNoLamps) > 6) fail(`with the lamps off, turning retro up moved the paint from ${p.nightNoLamps} to ${p.nightNoLampsRetroOn} — retroreflection must return YOUR light, not make its own`)
// 2. the paint is genuinely dark at night. This is the glow-in-the-dark complaint.
else if (!(p.nightNoLamps < p.day * 0.5)) fail(`at night with no lamps the paint reads ${p.nightNoLamps} against ${p.day} by day — it is still glowing`)
// 3. and the headlights bring it back, clearly.
else if (!(p.nightLampsRetro > p.nightLamps * 1.25)) fail(`headlights + retro reads ${p.nightLampsRetro} against ${p.nightLamps} for headlights alone — the retro term is not doing enough to be worth having`)
else console.log(`PASS: paint ${p.day} by day (sun ${c.day.sunEl}deg), ${p.nightNoLamps} at night unlit (sun ${c.nightLampsRetro.sunEl}deg), ${p.nightLamps} in the beam, ${p.nightLampsRetro} in the beam with retroreflection`)
