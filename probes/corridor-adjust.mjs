import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 300)) })
await page.goto('http://127.0.0.1:5185/?lite#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
const r = await page.evaluate(() => {
  const s = window.corridor.site
  const a = s.adjustments.at(0, 0)
  return { areas: s.adjustments.count, active: s.adjustments.active, atOrigin: a, placements: s.layers.placements.children.length, trees: s.treeCount }
})
console.log(JSON.stringify(r))
await browser.close()
