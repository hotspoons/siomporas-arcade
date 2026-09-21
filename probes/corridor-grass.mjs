import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 400)) })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.goto('http://127.0.0.1:5185/#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('d'); await page.waitForTimeout(2500)
const info = await page.evaluate(() => {
  const s = window.corridor.site
  const g = s.layers.trees.getObjectByName('grass')
  const cam = window.corridor.camera
  const arr = g.instanceMatrix.array
  const seed = g.geometry.attributes.aSeed.array
  return { count: g.count, cam: [cam.position.x, cam.position.y, cam.position.z].map((v) => +v.toFixed(1)), first: Array.from(arr.slice(12, 15)).map((v) => +v.toFixed(1)), seed0: Array.from(seed.slice(0, 4)).map((v) => +v.toFixed(2)), visible: g.visible, parentVisible: s.layers.trees.visible }
})
console.log(JSON.stringify(info))
await browser.close()
