// Dead ends should be pavement, not grass: count the bulbs and check edgeDistance inside one.
// node probes/corridor-culdesac.mjs <slug> [port]
import { chromium } from 'playwright'
const [,, slug, port = '5185'] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${port}/#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((s) => window.corridor?.site?.manifest?.slug === s, slug, { timeout: 240000 })
await page.waitForTimeout(1500)
console.log(await page.evaluate(() => {
  const s = window.corridor.site
  const bulbs = []
  s.layers.road.traverse((o) => { if (o.name === 'road:culdesac') bulbs.push([+o.position.x.toFixed(1), +o.position.y.toFixed(1), +o.position.z.toFixed(1), +o.geometry.parameters.radius.toFixed(1)]) })
  const probe = bulbs.slice(0, 3).map(([x, y, z, r]) => ({
    centre: +s.edgeDistance(x, z).toFixed(2),          // < 0 = pavement
    atRimInside: +s.edgeDistance(x + r * 0.8, z).toFixed(2),
    outside: +s.edgeDistance(x + r * 2.0, z).toFixed(2),
  }))
  return JSON.stringify({ bulbs: bulbs.length, first: bulbs.slice(0, 3), probe })
}))
await browser.close()
