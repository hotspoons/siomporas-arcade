// The water line: sea at 0 on a coast, invisible inland, and it floods when raised.
// node probes/corridor-flood.mjs <slug> <level> out.png
import { chromium } from 'playwright'
const [,, slug, level = '0', out] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 760, height: 480 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 120)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:5185/#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((s) => window.corridor?.site?.manifest?.slug === s, slug, { timeout: 240000 })
await page.waitForTimeout(4000)
console.log(await page.evaluate((lv) => {
  const c = window.corridor, s = c.site
  c.tune.set('WATER_LEVEL_M', Number(lv))
  const m = s.manifest, mid = s.spineAt(m.spine.length_m / 2)
  // look along the corridor from 120 m up
  c.camera.position.set(mid.pos.x - 200, mid.pos.y + 120, mid.pos.z + 200)
  c.orbit.target.set(mid.pos.x, mid.pos.y, mid.pos.z)
  let plane = null
  s.layers.water.traverse((o) => { if (o.name === 'water:level') plane = o })
  const ground = s.groundAt(mid.pos.x, mid.pos.z)
  return JSON.stringify({ level: Number(lv), planeY: plane?.position.y, span: plane?.scale.x, roadY: +mid.pos.y.toFixed(1), groundAtRoad: ground && +ground.toFixed(1), submerged: ground !== null && ground < Number(lv) })
}, level))
await page.waitForTimeout(2500)
console.log(await page.evaluate(() => { let pl = null; window.corridor.site.layers.water.traverse((o) => { if (o.name === 'water:level') pl = o }); return JSON.stringify({ afterFrames_planeY: pl?.position.y, visible: pl?.visible }) }))
await page.screenshot({ path: out, timeout: 240000 }).catch((e) => console.log('shot failed', String(e).slice(0, 50)))
console.log(await page.evaluate(() => { let pl = null; window.corridor.site.layers.water.traverse((o) => { if (o.name === 'water:level') pl = o }); return JSON.stringify({ afterShot_planeY: pl?.position.y, knob: window.corridor.tune.get('WATER_LEVEL_M') }) }))
await browser.close()
