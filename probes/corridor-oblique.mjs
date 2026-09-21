import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
await page.goto(process.argv[2], { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
// high oblique down the corridor: where the impostor cards used to fan over the road
await page.evaluate(() => {
  const { site, camera } = window.corridor
  const p = site.spineAt(site.manifest.spine.photo_s), q = site.spineAt(site.manifest.spine.photo_s + 400)
  camera.position.copy(p.pos).add(new THREE_UP()).add(p.dir.clone().multiplyScalar(-120))
  function THREE_UP() { return { x: 0, y: 160, z: 0, isVector3: true, clone() { return this }, add() { return this } } }
  camera.position.set(p.pos.x - p.dir.x * 120, p.pos.y + 160, p.pos.z - p.dir.z * 120)
  camera.lookAt(q.pos.x, q.pos.y, q.pos.z)
  window.corridor.site.updateNear(camera.position, 0)
})
await page.waitForTimeout(2500)
await page.screenshot({ path: process.argv[3], timeout: 120000 })
await browser.close()
