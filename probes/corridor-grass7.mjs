import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 1500)) })
await page.goto('http://127.0.0.1:5185/#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('d'); await page.waitForTimeout(2000)
const r = await page.evaluate(() => {
  const g = window.corridor.site.layers.trees.getObjectByName('grass')
  const road = window.corridor.site.layers.road.children[0].children[0]
  const pos = Array.from(g.geometry.attributes.position.array).map((v) => +v.toFixed(2))
  const idx = Array.from(g.geometry.index.array)
  const arr = g.instanceMatrix.array
  for (let i = 0; i < g.count; i++) { arr[i*16] = 3; arr[i*16+5] = 3; arr[i*16+10] = 3 }
  g.instanceMatrix.needsUpdate = true
  g.material = road.material
  return { pos, idx, hasNormal: !!g.geometry.attributes.normal, uvCount: g.geometry.attributes.uv?.count, groups: g.geometry.groups.length }
})
console.log(JSON.stringify(r))
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-apex-conduit/397fba92-5e84-41c5-9605-5d43678842ec/scratchpad/grass_debug4.png', timeout: 120000 })
await browser.close()
