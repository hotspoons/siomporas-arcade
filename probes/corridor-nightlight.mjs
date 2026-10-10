// Night: is there any light on the road, do the headlights work, and are the stars points?
//   PORT=5185 node probes/corridor-nightlight.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 800, height: 500 } })
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/#${slug}?lite=1&fresh`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(3000)
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
const lights = () => p.evaluate(() => {
  const c = window.corridor
  const sun = c.scene.children.find((o) => o.isDirectionalLight)
  const amb = c.scene.children.find((o) => o.isHemisphereLight)
  const beams = []
  c.scene.traverse((o) => { if (o.isSpotLight) beams.push({ i: +o.intensity.toFixed(1), on: o.visible, dist: o.distance }) })
  return { sunI: +sun.intensity.toFixed(3), ambI: +amb.intensity.toFixed(3), beams }
})
await p.keyboard.press('Tab')          // into the seat, so the headlights exist
await p.waitForTimeout(1200)
await p.evaluate(() => window.corridor.time.setLocal('2026-06-21', '13:00', 'America/New_York'))
await p.waitForTimeout(900)
const day = await lights()
await p.evaluate(() => window.corridor.time.setLocal('2026-06-21', '23:30', 'America/New_York'))
await p.waitForTimeout(1200)
const night = await lights()
ok('there is ambient light at night', night.ambI > day.ambI * 0.15, `${night.ambI} vs ${day.ambI} by day`)
ok('but it is still much darker than day', night.ambI < day.ambI * 0.7, `${night.ambI} vs ${day.ambI}`)
ok('the car has headlights', night.beams.length === 2, JSON.stringify(night.beams))
ok('they are off in daylight', day.beams.every((x) => !x.on || x.i < 1), JSON.stringify(day.beams))
ok('and on at night', night.beams.every((x) => x.on && x.i > 10), JSON.stringify(night.beams))
// the road under the car should not be pure black: sample the rendered frame
const px = await p.evaluate(async () => {
  const c = window.corridor
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const cv = document.querySelector('canvas')
  const g = document.createElement('canvas')
  g.width = cv.width; g.height = cv.height
  g.getContext('2d').drawImage(cv, 0, 0)
  // where the BEAMS land: straight ahead, a little below the horizon. The very bottom of a chase
  // view is the ground under the car, which no forward-facing headlight reaches.
  // the brightest point in the lower half of the frame: the beams land somewhere down the road,
  // and exactly where depends on which way it bends
  const ctx = g.getContext('2d')
  const half = ctx.getImageData(0, Math.floor(cv.height * 0.45), cv.width, Math.floor(cv.height * 0.45)).data
  let best = [0, 0, 0]
  for (let i = 0; i < half.length; i += 4) {
    if (half[i] + half[i + 1] + half[i + 2] > best[0] + best[1] + best[2]) best = [half[i], half[i + 1], half[i + 2]]
  }
  return best
})
ok('the road ahead is lit, not pitch black', Math.max(...px) > 12, `rgb(${px.join(',')}) at the bottom of the frame`)
// stars: LOOK UP first. In the seat the top of the frame is trees and cloud, so counting there
// measures the tree line, not the sky.
await p.keyboard.press('Tab')
await p.waitForTimeout(800)
await p.keyboard.press('KeyM')   // chrome off: the minimap is satellite imagery and would read as a very bright "star"
await p.waitForTimeout(400)
await p.evaluate(() => {
  const { camera, orbit, site } = window.corridor
  const c = site.manifest.spine.coords, a = c[Math.floor(c.length / 2)]
  const g = site.groundAt(a[0], -a[1]) ?? 0
  // the orbit controls stop at the horizon by default so you cannot fly under the ground; let
  // this one look up for the measurement
  orbit.maxPolarAngle = Math.PI
  orbit.minPolarAngle = 0
  camera.position.set(a[0], g + 2, -a[1])
  orbit.target.set(a[0] + 0.5, g + 120, -a[1])   // nearly straight up
  camera.lookAt(orbit.target)
  orbit.update()
})
await p.waitForTimeout(2500)
const stars = await p.evaluate(async () => {
  // READ INSIDE A FRAME. Without preserveDrawingBuffer the WebGL canvas is cleared once it has
  // been composited, so a drawImage a moment later reads pure black — which looks exactly like a
  // sky with no stars in it. Waiting for two animation frames puts the read right after a render.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const cv = document.querySelector('canvas')
  const g = document.createElement('canvas')
  g.width = cv.width; g.height = cv.height
  g.getContext('2d').drawImage(cv, 0, 0)
  const h = Math.floor(cv.height * 0.6)
  const d = g.getContext('2d').getImageData(0, 0, cv.width, h).data
  // Run lengths of bright pixels along each row. A star is one or two pixels; the MOON is a disc
  // with a halo and will happily be fifty, so the max says nothing — the median is the star size.
  const lens = []
  let lit = 0
  for (let y = 0; y < h; y++) {
    let run = 0
    for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4
      const bright = (d[i] + d[i + 1] + d[i + 2]) / 3 > 55
      if (bright) { lit++; run++ } else { if (run) lens.push(run); run = 0 }
    }
    if (run) lens.push(run)
  }
  lens.sort((a, b) => a - b)
  return { lit, runs: lens.length, median: lens.length ? lens[lens.length >> 1] : 0, p90: lens.length ? lens[Math.floor(lens.length * 0.9)] : 0, longest: lens[lens.length - 1] ?? 0, of: cv.width * h }
})
ok('there are stars', stars.runs > 20, JSON.stringify(stars))
ok('and they are points, not blobs', stars.median <= 3 && stars.p90 <= 6, `median bright run ${stars.median} px, p90 ${stars.p90} px (the longest, ${stars.longest} px, is the moon)`)
// NOTHING GLOWS IN THE DARK. Grass and the tree impostors are drawn by their own shaders and know
// nothing about the scene's lights, so at night they used to stay lit for noon (Rich, 2026-09-26).
// Measured as the brightest green pixel in the verge at midday against the same one at midnight.
const verge = async (time) => {
  await p.evaluate((t) => window.corridor.time.setLocal('2026-06-21', t, 'America/New_York'), time)
  await p.waitForTimeout(2500)
  return p.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const cv = document.querySelector('canvas')
    const g = document.createElement('canvas'); g.width = cv.width; g.height = cv.height
    const ctx = g.getContext('2d'); ctx.drawImage(cv, 0, 0)
    const d = ctx.getImageData(0, Math.floor(cv.height * 0.55), cv.width, Math.floor(cv.height * 0.35)).data
    // the median of the brightest fifty, not the single brightest: one pixel of verge caught in a
    // headlight beam is a fact about the headlights, not about whether the grass glows
    const greens = []
    for (let i = 0; i < d.length; i += 4) { const green = d[i + 1] - (d[i] + d[i + 2]) / 2; if (green > 8) greens.push(d[i + 1]) }
    greens.sort((a, b) => b - a)
    const top = greens.slice(0, 50)
    return top.length ? top[top.length >> 1] : 0
  })
}
// the minimap is satellite imagery — green, and the same green at midnight — so the chrome goes
// away before any pixel is counted (it is already off from the star test, but not in isolation)
if (!(await p.evaluate(() => document.body.classList.contains('chrome-off')))) { await p.keyboard.press('KeyM'); await p.waitForTimeout(400) }
await p.evaluate(() => { const c = window.corridor; const s = c.site.manifest.spine.coords, a = s[Math.floor(s.length / 2)]
  const gy = c.site.groundAt(a[0], -a[1]) ?? 0
  c.camera.position.set(a[0] + 12, gy + 2.2, -a[1] + 12); c.orbit.target.set(a[0], gy + 1, -a[1]); c.orbit.update() })
const dayGreen = await verge('13:00')
const nightGreen = await verge('23:30')
ok('the verge does not glow in the dark', nightGreen < dayGreen * 0.7, `lit green ${dayGreen} by day, ${nightGreen} at night`)
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
