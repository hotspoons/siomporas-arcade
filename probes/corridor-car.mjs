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
// Roll with the wheel over so the steer and the spin are both non-zero in the shot. It has to be a
// held KEY: frame() calls readDriveKeys() every frame, which overwrites drive.input.steer, so an
// injected value is gone before the next render.
await page.evaluate(() => { window.corridor.drive.car.speed = 14 })
await page.keyboard.down('a')
await page.waitForTimeout(2500)
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
await page.keyboard.up('a')
if (out) {
  await page.evaluate(() => { for (const id of ['#info', '#panel', '#sidebar']) { const el = document.querySelector(id); if (el) el.style.display = 'none' } })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: out, timeout: 240000, animations: 'disabled' })
  console.log('shot', out)
}
await browser.close()
