import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 300)) })
await page.goto('http://127.0.0.1:5185/?season=summer#frederick-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
const r = await page.evaluate(() => {
  const { site, camera } = window.corridor
  const g = site.layers.placements
  const first = g.children[0]
  if (first) {
    const p = first.position
    camera.position.set(p.x + 60, p.y + 45, p.z + 60)
    camera.lookAt(p.x, p.y + 4, p.z)
    site.updateNear(camera.position, 0)
  }
  return { count: g.children.length, names: g.children.map((c) => c.userData.entry?.name ?? c.userData.placement?.asset), glbs: g.children.map((c) => !!c.userData.entry?.glb) }
})
console.log(JSON.stringify(r))
await page.waitForTimeout(2500)
await page.screenshot({ path: process.argv[2], timeout: 120000 })
await browser.close()
