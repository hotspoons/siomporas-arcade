// Cockpit view (C while driving): does the viewer keep running, and is the HUD alive?
//
//   node probes/corridor-cockpit.mjs [site] [out.png]
//
// Counts animation frames for 2 s in chase view, presses C, counts again. The camera block for the
// cockpit used to `return` out of frame() before renderer.render() and requestAnimationFrame(), so
// pressing C stopped the render loop dead — the picture froze and never came back.
import { chromium } from 'playwright'
const site = process.argv[2] ?? 'bowie-racetrack-rd'
const out = process.argv[3] ?? null
const PORT = process.env.CORRIDOR_PORT ?? '5202'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 860, height: 560 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?lite#${site}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 240000 })
await page.keyboard.press('Tab') // drive

// Liveness has to be counted, not inferred from how far the car got: headless swiftshader renders
// at about one frame a second, so 2 s of driving moves the car a fraction of a metre either way.
// scene.onAfterRender fires once per renderer.render(), which is the last thing frame() does, so
// it counts exactly the thing that died.
await page.evaluate(() => {
  window.__n = 0
  window.corridor.scene.onAfterRender = () => { window.__n++ }
})
const renders = async (ms) => {
  const a = await page.evaluate(() => window.__n)
  const pa = await page.evaluate(() => [window.corridor.drive.car.pos.x, window.corridor.drive.car.pos.z])
  await page.waitForTimeout(ms)
  const b = await page.evaluate(() => window.__n)
  const pb = await page.evaluate(() => [window.corridor.drive.car.pos.x, window.corridor.drive.car.pos.z])
  return { renders: b - a, car_moved_m: +Math.hypot(pb[0] - pa[0], pb[1] - pa[1]).toFixed(2) }
}

// roll a little so the car is moving
await page.keyboard.down('w')
await page.waitForTimeout(1500)
await page.evaluate(() => { window.corridor.drive.car.speed = 22 })
const chase = await renders(4000)
const hudChase = await page.evaluate(() => document.querySelector('#pos')?.textContent ?? '')
await page.keyboard.press('KeyC')
await page.waitForTimeout(300)
await page.evaluate(() => { window.corridor.drive.car.speed = 22 })
const cockpit = await renders(4000)
const hudCockpit = await page.evaluate(() => document.querySelector('#pos')?.textContent ?? '')
const state = await page.evaluate(() => ({
  cockpit: window.corridor.drive.cockpit,
  speed: +(window.corridor.drive.car?.speed ?? -1).toFixed(1),
  camY: +window.corridor.camera.position.y.toFixed(2),
  carY: +(window.corridor.drive.car?.pos.y ?? 0).toFixed(2),
}))
await page.keyboard.up('w')
console.log(JSON.stringify({
  site, chase_4s: chase, cockpit_4s: cockpit,
  render_loop_alive_in_cockpit: cockpit.renders > 0,
  hud_chase: hudChase, hud_cockpit: hudCockpit, hud_alive_in_cockpit: hudCockpit.trim().length > 0,
  ...state,
}, null, 1))
if (out) {
  // the info panel covers the left half of the view, which is where the dash and the near pillar are
  await page.evaluate(() => { for (const id of ['#info', '#panel', '#sidebar']) { const el = document.querySelector(id); if (el) el.style.display = 'none' } })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: out, timeout: 180000, animations: 'disabled' })
  console.log('shot', out)
}
await browser.close()
