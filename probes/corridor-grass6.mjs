import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 1200)) })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.goto('http://127.0.0.1:5185/#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('d'); await page.waitForTimeout(2000)
const r = await page.evaluate(() => {
  const g = window.corridor.site.layers.trees.getObjectByName('grass')
  const road = window.corridor.site.layers.road.children[0].children[0] // a road mesh: has a BufferGeometry + MeshStandardMaterial
  // experiment A: give the grass mesh the road's material (known to render) and a plain box geometry
  const box = road.geometry.constructor === Object ? null : null
  // use the terrain geometry's constructor to build a tiny quad geometry from scratch
  const Geo = g.geometry.constructor
  const Attr = g.geometry.attributes.position.constructor
  const quad = new Geo()
  quad.setAttribute('position', new Attr(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 3, 0, 1, 3, 0]), 3))
  quad.setIndex([0, 1, 2, 1, 3, 2])
  quad.setAttribute('aSeed', g.geometry.attributes.aSeed)
  g.geometry = quad
  g.material = road.material
  return { roadMat: road.material.type, matSide: road.material.side, count: g.count }
})
console.log(JSON.stringify(r))
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-apex-conduit/397fba92-5e84-41c5-9605-5d43678842ec/scratchpad/grass_debug3.png', timeout: 120000 })
await browser.close()
