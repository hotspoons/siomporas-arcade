// How long does a site take to load headlessly, and what is it doing meanwhile? Prints the
// status toast every 20 s and every console error, with a long timeout.
//   PORT=5185 node probes/corridor-loadtime.mjs '<url>'
import { chromium } from 'playwright'
const [, , url] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)))
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 300)) })
page.on('crash', () => console.log('PAGE CRASHED'))
const t0 = Date.now()
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
const tick = setInterval(async () => {
  try { console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`, await page.evaluate(() => (document.querySelector('.toast')?.textContent ?? '').slice(0, 120) + (window.corridor?.site ? ' [site ready]' : ''))) } catch (e) { console.log('tick failed', e.message.slice(0, 80)) }
}, 20000)
try {
  await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 900000 })
  console.log(`site ready after ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  console.log(await page.evaluate(() => JSON.stringify({ tiles: window.corridor.site.tiles?.(), hud: [...document.querySelectorAll('#parkour,#squishy')].map((e) => e.id) })))
} catch (e) { console.log('gave up:', e.message.slice(0, 120)) }
clearInterval(tick)
await browser.close()
