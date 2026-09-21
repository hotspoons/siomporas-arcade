// A look at a signalised junction, with the furniture on and off.
//
//   PORT=5205 SLUG=crofton-crownsville node probes/corridor-furnitureshot.mjs out-
//
// Parks the camera at the busiest signalised junction the site has — the one with the most masts
// within fifty metres — and shoots it twice, with the furniture layer on and off, so the pair is
// the same frame and the difference is only the thing I added.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5205'
const SLUG = process.env.SLUG ?? 'crofton-crownsville'
const OUT = process.argv[2] ?? '/tmp/furn-'
const EYE = Number(process.env.EYE ?? 34)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 300000 })
await page.keyboard.press('m')

console.log(await page.evaluate(({ eye }) => {
  const c = window.corridor, site = c.site, L = site.layers, mod = c.THREE
  // this box has no GPU; the grass and the near trees are what stop a screenshot returning
  if (L.trees) L.trees.visible = false
  if (site.grass) site.grass.mesh.visible = false
  // the busiest junction: the placed mast with the most neighbours within 50 m
  const g = L.furniture
  const m4 = new mod.Matrix4(), p = new mod.Vector3(), q = new mod.Quaternion(), s = new mod.Vector3()
  const at = []
  for (const mesh of g.children) {
    if (!mesh.name.startsWith('furniture:signal')) continue
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m4)
      m4.decompose(p, q, s)
      at.push({ x: p.x, y: p.y, z: p.z, yaw: mesh.userData.src[i].yaw_deg })
    }
  }
  if (!at.length) return 'no masts placed'
  // the busiest junction that is ALSO on road we draw properly: score by neighbours, but require
  // the mast to be beside real asphalt. Crofton's interchanges are drawn as disconnected slabs,
  // and a mast standing among those is a true picture of the road mesh and a useless one of the
  // signal.
  let best = null, bestN = -1
  for (const a of at) {
    if (Math.abs(site.edgeDistance(a.x, a.z)) > 6) continue
    const n = at.filter((b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 60 * 60).length
    if (n > bestN) { bestN = n; best = a }
  }
  if (!best) { best = at[0]; bestN = 1 }
  // a driver's view: eye height, back up the approach the mast faces, looking at the junction
  const yaw = (best.yaw * Math.PI) / 180
  const backX = Math.sin(yaw), backZ = -Math.cos(yaw) // the heads' direction is back up the road
  c.camera.position.set(best.x + backX * eye, (site.groundAt(best.x + backX * eye, best.z + backZ * eye) ?? best.y) + 2.0, best.z + backZ * eye)
  c.orbit.target.set(best.x, best.y + 4.2, best.z)
  c.orbit.update()
  return JSON.stringify({ junctionMasts: bestN, at: [Math.round(best.x), Math.round(best.z)], edge: +site.edgeDistance(best.x, best.z).toFixed(1), counts: site.furnitureCounts })
}, { eye: EYE }))

for (const on of [false, true]) {
  await page.evaluate((v) => { window.corridor.site.layers.furniture.visible = v }, on)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}${on ? 'after' : 'before'}.png`, timeout: 300000 })
}
await browser.close()
