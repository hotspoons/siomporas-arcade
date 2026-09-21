import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 1200)) })
await page.goto('http://127.0.0.1:5185/#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('d'); await page.waitForTimeout(2000)
const r = await page.evaluate(() => {
  const g = window.corridor.site.layers.trees.getObjectByName('grass')
  const info = { count: g.count, geoIndex: g.geometry.index?.count, pos: g.geometry.attributes.position.count, drawRange: g.geometry.drawRange, matVisible: g.material.visible, layers: g.layers.mask, camLayers: window.corridor.camera.layers.mask, matrixWorldUpdated: g.matrixWorldNeedsUpdate, parentChain: [] }
  let o = g; while (o) { info.parentChain.push(`${o.type}:${o.name}:${o.visible}`); o = o.parent }
  return info
})
console.log(JSON.stringify(r))
await browser.close()
