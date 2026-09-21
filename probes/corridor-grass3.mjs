import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
await page.goto('http://127.0.0.1:5185/#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('d'); await page.waitForTimeout(2000)
const info = await page.evaluate(() => {
  const s = window.corridor.site
  const g = s.layers.trees.getObjectByName('grass')
  const cam = window.corridor.camera.position
  // heights: DEM vs conformed terrain, 6 m right of the eye
  const THREE_ = null
  const arr = g.instanceMatrix.array
  let sample = []
  for (let i = 0; i < g.count && sample.length < 5; i++) { const x = arr[i*16+12], y = arr[i*16+13], z = arr[i*16+14]; if (Math.hypot(x - cam.x, z - cam.z) < 12) sample.push([+x.toFixed(1), +y.toFixed(2), +z.toFixed(1)]) }
  // raycast down onto the terrain at those points
  const ray = new (window.corridor.scene.constructor.prototype.constructor === Object ? Object : Object)()
  return { cam: [cam.x, cam.y, cam.z].map((v) => +v.toFixed(2)), sample, terrainVerts: s.terrain.geometry.attributes.position.count }
})
console.log(JSON.stringify(info))
// lift + recolour, then screenshot
await page.evaluate(() => { const g = window.corridor.site.layers.trees.getObjectByName('grass'); g.position.y += 1.0; g.material.uniforms.uBase.value.setRGB(1, 0, 0); g.material.uniforms.uTip.value.setRGB(1, 0.5, 0) })
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-apex-conduit/397fba92-5e84-41c5-9605-5d43678842ec/scratchpad/grass_debug.png', timeout: 120000 })
await browser.close()
