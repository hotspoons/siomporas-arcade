import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 200)) })
await page.goto('http://127.0.0.1:5185/?season=summer#clarksburg-i270', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
const r = await page.evaluate(() => {
  const { site, camera } = window.corridor
  const p = site.spineAt(3150), q = site.spineAt(3219)
  camera.position.set(p.pos.x, p.pos.y + 3, p.pos.z)
  camera.lookAt(q.pos.x, q.pos.y + 3, q.pos.z)
  site.updateNear(camera.position, 0)
  const g = site.layers.structures.getObjectByName('authored-bridges')
  // flatten check: spine z between 3100 and 3340 should be linear
  const z = [3100, 3160, 3219, 3280, 3340].map((s) => +site.spineAt(s).pos.y.toFixed(2))
  return { bridges: g?.children.length, spineZ: z }
})
console.log(JSON.stringify(r))
await page.waitForTimeout(2500)
await page.screenshot({ path: process.argv[2], timeout: 120000 })
await browser.close()
