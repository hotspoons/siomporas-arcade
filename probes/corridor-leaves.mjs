import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.goto('http://127.0.0.1:5185/#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('d'); await page.waitForTimeout(2500)
const info = await page.evaluate(() => {
  const g = window.corridor.site.layers.trees.getObjectByName('near-trees')
  return g.children.map((c) => ({ name: c.name, type: c.type, count: c.count, verts: c.geometry.attributes.position?.count, hasIndex: !!c.geometry.index, matType: c.material.type, transparent: c.material.transparent, alphaTest: c.material.alphaTest, side: c.material.side, map: c.material.map ? (c.material.map.image ? `${c.material.map.image.width}x${c.material.map.image.height}` : 'no image yet') : 'no map', visible: c.visible, depthWrite: c.material.depthWrite, uvs: !!c.geometry.attributes.uv }))
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
