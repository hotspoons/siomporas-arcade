// The car, from the chase camera: is it a car, and do the wheels steer and spin?
//
//   node probes/corridor-car.mjs [site] [out.png]
import { chromium } from 'playwright'
const site = process.argv[2] ?? 'bowie-racetrack-rd'
const out = process.argv[3] ?? null
const PORT = process.env.CORRIDOR_PORT ?? '5202'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?lite#${site}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 240000 })
await page.keyboard.press('Tab')
await page.waitForTimeout(800)
// Tick the sim directly rather than waiting on frames: headless swiftshader renders at well under
// one frame a second here, so 2.5 s of wall clock can be ZERO sim ticks and every wheel angle reads
// its initial value. 1 s of sim at full left lock, driven from the probe, is deterministic.
await page.evaluate(() => {
  const car = window.corridor.drive.car
  car.speed = 14
  for (let i = 0; i < 120; i++) car.tick(1 / 120, { throttle: 0.3, brake: 0, steer: -1, handbrake: false })
})

console.log(JSON.stringify(await page.evaluate(() => {
  const car = window.corridor.drive.car
  const parts = []
  car.mesh.traverse((o) => { if (o.isMesh) parts.push({ type: o.geometry.type, tris: (o.geometry.index?.count ?? o.geometry.getAttribute('position').count) / 3 }) })
  const wheels = car.mesh.children.filter((o) => o.isMesh && o.geometry.type === 'CylinderGeometry')
  return {
    meshes: parts.length,
    triangles: Math.round(parts.reduce((a, b) => a + b.tris, 0)),
    geometryTypes: [...new Set(parts.map((p) => p.type))],
    wheels: wheels.length,
    wheelSteerY: wheels.map((w) => +w.rotation.y.toFixed(3)),
    wheelSpin: +car.wheelSpin.toFixed(2),
    speed: +car.speed.toFixed(1),
  }
}), null, 1))
if (out) {
  await page.evaluate(() => { for (const id of ['#info', '#panel', '#sidebar']) { const el = document.querySelector(id); if (el) el.style.display = 'none' } })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: out, timeout: 240000, animations: 'disabled' })
  console.log('shot', out)
}
await browser.close()
