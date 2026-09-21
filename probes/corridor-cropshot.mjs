// A look at a crop field, from the road beside it.
//   PORT=5201 SLUG=bacon-ridge-rd SEASONS=1,2 node probes/corridor-cropshot.mjs out-
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'bacon-ridge-rd'
const OUT = process.argv[2] ?? '/tmp/crop-'
const SEASONS = (process.env.SEASONS ?? '2').split(',').map(Number)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 300000 })
await page.keyboard.press('m')
console.log(await page.evaluate(() => {
  const c = window.corridor, site = c.site, L = site.layers
  // the swiftshader cliff: grass and near trees both have to come down or no frame arrives
  if (L.trees) L.trees.visible = false
  if (site.grass) { c.tune.set('GRASS_RADIUS', 26); c.tune.set('GRASS_SPRITE_RADIUS', 90); c.tune.set('GRASS_MOWN_PER_M2', 25); c.tune.set('GRASS_ROUGH_PER_M2', 16) }
  // stand on the road nearest the biggest farmland ring and look across it
  const rings = (site.manifest.landuse ?? []).filter((l) => l.class === 'farmland')
  if (!rings.length) return 'no farmland'
  let best = null, bestA = 0
  for (const r of rings) {
    let a = 0
    for (let i = 0, j = r.ring.length - 1; i < r.ring.length; j = i++) a += r.ring[j][0] * r.ring[i][1] - r.ring[i][0] * r.ring[j][1]
    if (Math.abs(a) / 2 > bestA) { bestA = Math.abs(a) / 2; best = r.ring }
  }
  let cx = 0, cy = 0
  for (const [x, y] of best) { cx += x; cy += y }
  cx /= best.length; cy /= best.length
  const target = { x: cx, z: -cy }
  // stand just outside the field's edge, at eye height, looking along it — a driver's view of the
  // field, which is the only view of it anyone gets. Standing on the road is no good when the
  // farmland ring is three hundred metres off it.
  let ex = best[0][0], ey = best[0][1], far = -1
  for (const [px, py] of best) {
    const d = (px - cx) ** 2 + (py - cy) ** 2
    if (d > far) { far = d; ex = px; ey = py }
  }
  const outX = ex + (ex - cx) * 0.06, outY = ey + (ey - cy) * 0.06
  const eye = { x: outX, z: -outY }
  const gy = site.groundAt(eye.x, eye.z) ?? 0
  c.camera.position.set(eye.x, gy + 1.7, eye.z)
  c.orbit.target.set(target.x, (site.groundAt(target.x, target.z) ?? gy) + 1.2, target.z)
  c.orbit.update()
  const bd = (eye.x - target.x) ** 2 + (eye.z - target.z) ** 2
  if (site.grass) { const f = c.camera.getWorldDirection(new c.THREE.Vector3()); let n = 0; do { site.grass.update(c.camera.position, f, 0) } while (site.grass.counts.pending > 0 && ++n < 8000) }
  return JSON.stringify({ field_area_ha: +(bestA / 1e4).toFixed(1), distance_to_field_m: +Math.sqrt(bd).toFixed(0), rows: site.cropRows })
}))
for (const s of SEASONS) {
  await page.evaluate((s) => window.corridor.tune.set('SEASON', s), s)
  await page.waitForTimeout(1500)
  const name = `${OUT}${['winter', 'spring', 'summer', 'autumn'][s]}.png`
  await page.screenshot({ path: name, timeout: 300000 })
  console.log(name)
}
await browser.close()
