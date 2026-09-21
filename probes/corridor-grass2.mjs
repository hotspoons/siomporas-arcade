import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
await page.goto('http://127.0.0.1:5185/#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('Tab'); await page.waitForTimeout(2500)
const info = await page.evaluate(() => {
  const s = window.corridor.site
  const g = s.layers.trees.getObjectByName('grass')
  const cam = window.corridor.camera.position
  const arr = g.instanceMatrix.array
  let near = 0, hist = [0,0,0,0,0,0,0]
  for (let i = 0; i < g.count; i++) { const x = arr[i*16+12], z = arr[i*16+14]; const d = Math.hypot(x - cam.x, z - cam.z); hist[Math.min(6, Math.floor(d / 10))]++; if (d < 12) near++ }
  // sample: canopy and road distance at a few points beside the eye
  return { count: g.count, near12m: near, histBy10m: hist }
})
console.log(JSON.stringify(info))
await browser.close()
