// Repro for "the render hiccups every ~0.75 s while driving" + lane-width check + a stance shot.
// node probes/corridor-grassperf.mjs '<stance url>' out.png
import { chromium } from 'playwright'
const [,, url, out] = process.argv
const local = url.replace(/^https?:\/\/[^/]+/, 'http://127.0.0.1:5185')
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 750 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
// three agents edit this tree at once; a Vite full reload mid-probe empties window.corridor. No HMR client, no reload.
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(local, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor?.site, null, { timeout: 240000 })
await page.waitForTimeout(2500)
// lane geometry at the car: paved half width from the site's own edge distance at the centreline
console.log(await page.evaluate(() => {
  const c = window.corridor, car = c.drive?.car
  const o = { site: c.site?.manifest?.slug, drive: c.drive?.on, keys: Object.keys(c.site ?? {}) }
  try {
    const p = car?.pos ?? car?.p ?? c.camera.position
    o.carPos = [p.x, p.y, p.z].map((v) => Math.round(v * 10) / 10)
    const e = c.site.edgeDistance(p.x, p.z)
    o.edgeDistanceRaw = typeof e === 'number' ? e : e
    o.expectedTwoLaneTwoWayHalf = 2 * 3.66 / 2 + 3.0
  } catch (err) { o.err = String(err) }
  return JSON.stringify(o)
}))
// frame-time histogram while driving 6 s: the hiccup is any frame > 60 ms
await page.evaluate(() => { window.__ft = []; let last = performance.now(); const loop = () => { const n = performance.now(); window.__ft.push(n - last); last = n; requestAnimationFrame(loop) }; requestAnimationFrame(loop) })
await page.keyboard.down('w')
await page.waitForTimeout(6000)
await page.keyboard.up('w')
console.log(await page.evaluate(() => {
  const ft = window.__ft.slice(5)
  const sorted = [...ft].sort((a, b) => a - b)
  const pct = (p) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? -1) * 10) / 10
  const g = window.corridor.site.grass?.counts ?? null
  return JSON.stringify({ frames: ft.length, median_ms: pct(0.5), p90_ms: pct(0.9), p99_ms: pct(0.99), max_ms: +Math.max(...ft).toFixed(1), spikes_over_60ms: ft.filter((v) => v > 60).length, speed: Math.round((window.corridor.drive?.car?.speed ?? -1) * 10) / 10 })
}))
await page.waitForTimeout(1500)
await page.screenshot({ path: out })
await browser.close()
