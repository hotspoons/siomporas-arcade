// frame-time trace in drive mode: how long does each frame take while moving, and where are the stalls
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
await page.goto('http://127.0.0.1:5185/?lite#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('d')
const r = await page.evaluate(async () => {
  const site = window.corridor.site
  const cam = window.corridor.camera
  const times = []
  // measure only our per-frame CPU work (updateNear = trees + grass), not swiftshader's raster time
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now()
    cam.position.x += 1.2 // ~45 mph at 60 fps
    site.updateNear(cam.position, i / 60)
    times.push(performance.now() - t0)
    await new Promise((r) => setTimeout(r, 5))
  }
  times.sort((a, b) => a - b)
  return { median: times[30].toFixed(1), p90: times[54].toFixed(1), max: times[59].toFixed(1), over16ms: times.filter((t) => t > 16).length }
})
console.log('updateNear ms per frame (lite):', JSON.stringify(r))
await browser.close()
