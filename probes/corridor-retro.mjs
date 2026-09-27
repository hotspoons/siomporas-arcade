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
const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
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

/** render once and read the frame back in the SAME turn — the renderer has no preserveDrawingBuffer */
const frame = async (knobs, timeOfDay) =>
  page.evaluate(
    ({ knobs, timeOfDay }) =>
      new Promise((resolve) => {
        const c = window.corridor
        if (timeOfDay) c.time.setLocal('2026-09-26', timeOfDay)
        for (const [k, v] of Object.entries(knobs)) c.tune.set(k, v)
        // let the app run a few frames so the knob reaches the uniforms and the lamps settle
        let n = 0
        const tick = () => {
          if (++n < 8) return requestAnimationFrame(tick)
          const r = c.renderer
          r.render(c.scene, c.camera)
          const gl = r.getContext()
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
          const buf = new Uint8Array(w * h * 4)
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
          resolve({ w, h, px: Array.from(buf), sunEl: +c.time.sun().el.toFixed(1), lampOn: c.retro().lampOn, night: c.retro().night })
        }
        requestAnimationFrame(tick)
      }),
    { knobs, timeOfDay },
  )

const lum = (f, i) => 0.2126 * f.px[i] + 0.7152 * f.px[i + 1] + 0.0722 * f.px[i + 2]
// the road ahead of the car: the lower-middle third of the frame, where the paint is
const region = (f) => {
  const out = []
  for (let y = 0; y < Math.floor(f.h * 0.42); y++) for (let x = Math.floor(f.w * 0.18); x < Math.floor(f.w * 0.82); x++) out.push((y * f.w + x) * 4)
  return out
}
const mean = (f, idx) => idx.reduce((a, i) => a + lum(f, i), 0) / idx.length

const NIGHT = '22:00', DAY = '12:30'
const nightNoLampNoRetro = await frame({ HEADLIGHT: 0, RETRO_MARKINGS: 0 }, NIGHT)
const nightNoLampRetro = await frame({ HEADLIGHT: 0, RETRO_MARKINGS: 3 }, NIGHT)
const nightLampNoRetro = await frame({ HEADLIGHT: 1, RETRO_MARKINGS: 0 }, NIGHT)
const nightLampRetro = await frame({ HEADLIGHT: 1, RETRO_MARKINGS: 3 }, NIGHT)
const dayFrame = await frame({ HEADLIGHT: 0, RETRO_MARKINGS: 3 }, DAY)
await browser.close()

const idx = region(nightNoLampNoRetro)
// THE PAINT PIXELS, found rather than assumed: the ones the retro term lit up when the lamps
// were already on. Nothing else in the frame changed between those two renders.
const paint = idx.filter((i) => lum(nightLampRetro, i) - lum(nightLampNoRetro, i) > 25)
const res = {
  at: setup.at,
  // the conditions each frame was actually taken under, so "day" and "night" are not assertions
  // about a string that was passed to a clock
  conditions: {
    nightNoLamps: { sunEl: nightNoLampNoRetro.sunEl, lampOn: nightNoLampNoRetro.lampOn, ambient: nightNoLampNoRetro.night },
    nightLamps: { sunEl: nightLampRetro.sunEl, lampOn: nightLampRetro.lampOn, ambient: nightLampRetro.night },
    day: { sunEl: dayFrame.sunEl, lampOn: dayFrame.lampOn, ambient: dayFrame.night },
  },
  regionPx: idx.length,
  paintPx: paint.length,
  meanRegion: {
    nightDark: +mean(nightNoLampNoRetro, idx).toFixed(1),
    nightLamps: +mean(nightLampNoRetro, idx).toFixed(1),
    nightLampsRetro: +mean(nightLampRetro, idx).toFixed(1),
    day: +mean(dayFrame, idx).toFixed(1),
  },
  meanOnPaint: paint.length
    ? {
        nightNoLamps: +mean(nightNoLampNoRetro, paint).toFixed(1),
        nightNoLampsRetroOn: +mean(nightNoLampRetro, paint).toFixed(1),
        nightLamps: +mean(nightLampNoRetro, paint).toFixed(1),
        nightLampsRetro: +mean(nightLampRetro, paint).toFixed(1),
        day: +mean(dayFrame, paint).toFixed(1),
      }
    : null,
}
console.log(JSON.stringify(res, null, 1))

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
const p = res.meanOnPaint
if (setup.error) fail(setup.error)
// liveness on the conditions first: a "night" frame taken in daylight proves nothing
else if (!(res.conditions.nightLamps.sunEl < -6)) fail(`the night frames were taken with the sun at ${res.conditions.nightLamps.sunEl} degrees — that is not night`)
else if (!(res.conditions.day.sunEl > 10)) fail(`the day frame was taken with the sun at ${res.conditions.day.sunEl} degrees — that is not day`)
else if (!(res.conditions.nightLamps.lampOn > 0)) fail('the headlights were off in the lamps-on frame')
else if (paint.length < 40) fail(`only ${paint.length} pixels brightened when the retro term came on — the headlights are not reaching the paint, or the shader is not running`)
// 1. retro does NOTHING without headlights. If this fails the term is a constant, i.e. a new glow.
else if (Math.abs(p.nightNoLampsRetroOn - p.nightNoLamps) > 4) fail(`with the lamps off, turning retro up changed the paint from ${p.nightNoLamps} to ${p.nightNoLampsRetroOn} — retroreflection must return YOUR light, not make its own`)
// 2. the paint is genuinely dark at night. This is the glow-in-the-dark complaint.
else if (!(p.nightNoLamps < p.day * 0.35)) fail(`at night with no lamps the paint reads ${p.nightNoLamps} against ${p.day} by day — it is still glowing`)
// 3. and the headlights bring it back, clearly.
else if (!(p.nightLampsRetro > p.nightLamps * 1.4)) fail(`headlights + retro reads ${p.nightLampsRetro} against ${p.nightLamps} for headlights alone — the retro term is not doing enough to be worth having`)
else console.log(`PASS: paint ${p.day} by day, ${p.nightNoLamps} at night unlit, ${p.nightLamps} in the beam, ${p.nightLampsRetro} in the beam with retroreflection`)
