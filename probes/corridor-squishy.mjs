// Does Squishy Hunt boot on a site: hauls placed at real stores, a hint written, a squishy in
// frame. Loads ?game=squishy, reads the HUD and the group, then stands by the first haul.
//   PORT=5185 node probes/corridor-squishy.mjs out.png
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const OUT = process.argv[2] ?? '/tmp/squishy.png'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?game=squishy&style=fantasy#crofton-triangle`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site && !!document.querySelector('#squishy'), null, { timeout: 300000 })
await page.waitForTimeout(1200)
console.log(await page.evaluate(() => {
  const c = window.corridor, site = c.site
  c.tune.set('GRASS_RADIUS', 30); c.tune.set('GRASS_SPRITE_RADIUS', 80); c.tune.set('GRASS_MOWN_PER_M2', 20); c.tune.set('GRASS_ROUGH_PER_M2', 10)
  const g = site.group.getObjectByName('game:squishy')
  const hud = document.querySelector('#squishy')
  const first = g?.children[0]
  if (first) {
    // stand 6 m from the first squishy at eye height, looking at it
    const p = first.position
    c.camera.position.set(p.x + 4.5, (site.groundAt(p.x + 4.5, p.z + 4) ?? p.y) + 1.7, p.z + 4)
    c.orbit.target.copy(p)
    c.orbit.update()
  }
  return JSON.stringify({ hauls: g?.children.length, score: hud?.querySelector('.squishy-score')?.textContent, hint: hud?.querySelector('.squishy-hint')?.textContent, first: first ? { name: first.name, at: first.position.toArray().map((v) => +v.toFixed(1)) } : null })
}))
await page.waitForTimeout(1500)
// the hint updates against the new eye
console.log(await page.evaluate(() => document.querySelector('#squishy .squishy-hint')?.textContent))
await page.keyboard.press('m')
await page.waitForTimeout(800)
await page.screenshot({ path: OUT, timeout: 300000 })
await browser.close()
