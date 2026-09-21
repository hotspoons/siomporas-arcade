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
if (process.env.MODE) await page.evaluate((m) => { window.__mode = m }, process.env.MODE)
if (process.env.KIND) await page.evaluate((k) => { window.__kind = k }, process.env.KIND)

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
  if (window.__mode === 'sidewalks') {
    // a marked crossing that is actually beside road we draw, seen from the pavement
    const xs = (site.manifest.sidewalks ?? []).filter((r) => r.kind === 'crossing' && r.marked)
    let best = null
    for (const r of xs) {
      const m = r.coords[Math.floor(r.coords.length / 2)]
      if (Math.abs(site.edgeDistance(m[0], -m[1])) < 6) { best = r; break }
    }
    if (!best) best = xs[0]
    if (!best) return 'no marked crossing'
    const m = best.coords[Math.floor(best.coords.length / 2)]
    const mx = m[0]
    const mz = -m[1]
    const gy = site.groundAt(mx, mz) ?? 0
    c.camera.position.set(mx + eye * 0.5, gy + eye * 0.35, mz + eye * 0.5)
    c.orbit.target.set(mx, gy, mz)
    c.orbit.update()
    return JSON.stringify({ mode: 'sidewalks', at: [Math.round(mx), Math.round(mz)], counts: site.sidewalkCounts })
  }
  if (window.__mode === 'barriers') {
    // the longest run of the kind asked for, seen from beside it at eye height
    const want = window.__kind ?? 'guard_rail'
    const runs = (site.manifest.barriers ?? []).filter((r) => r.kind === want)
    if (!runs.length) return `no ${want} on this site`
    let best = runs[0]
    for (const r of runs) if (r.coords.length > best.coords.length) best = r
    const mid = best.coords[Math.floor(best.coords.length / 2)]
    const nxt = best.coords[Math.min(best.coords.length - 1, Math.floor(best.coords.length / 2) + 4)]
    const mx = mid[0]
    const mz = -mid[1]
    const dx = nxt[0] - mid[0]
    const dz = -(nxt[1] - mid[1])
    const l = Math.hypot(dx, dz) || 1
    // stand off to one side, looking along the run so its length is what fills the frame
    const px = (-dz / l) * 9
    const pz = (dx / l) * 9
    const gy = site.groundAt(mx + px, mz + pz) ?? 0
    c.camera.position.set(mx + px - (dx / l) * 18, gy + 2.2, mz + pz - (dz / l) * 18)
    c.orbit.target.set(mx + (dx / l) * 25, gy + 0.9, mz + (dz / l) * 25)
    c.orbit.update()
    return JSON.stringify({ mode: 'barriers', kind: want, runVerts: best.coords.length, at: [Math.round(mx), Math.round(mz)], counts: site.barrierCounts })
  }
  if (window.__mode === 'parking') {
    // the biggest lot that actually got stalls: centre of the paint's bounding box, seen from a
    // height that fits the whole thing in
    const paintMesh = site.layers.parking?.children.find((m) => m.name === 'parking:paint')
    const surfMesh = site.layers.parking?.children.find((m) => m.name === 'parking:surface')
    if (!paintMesh) return 'no parking paint'
    // find the densest cluster of paint: bucket every 64th vertex on a 60 m grid
    const a = paintMesh.geometry.getAttribute('position')
    const cell = new Map()
    for (let i = 0; i < a.count; i += 16) {
      const k = `${Math.round(a.getX(i) / 60)},${Math.round(a.getZ(i) / 60)}`
      const e = cell.get(k) ?? { n: 0, x: 0, y: 0, z: 0 }
      e.n++
      e.x += a.getX(i)
      e.y += a.getY(i)
      e.z += a.getZ(i)
      cell.set(k, e)
    }
    let bb = null
    for (const e of cell.values()) if (!bb || e.n > bb.n) bb = e
    const c0 = { x: bb.x / bb.n, y: bb.y / bb.n, z: bb.z / bb.n }
    c.camera.position.set(c0.x + eye * 0.9, c0.y + eye * 0.8, c0.z + eye * 0.9)
    c.orbit.target.set(c0.x, c0.y, c0.z)
    c.orbit.update()
    void surfMesh
    return JSON.stringify({ mode: 'parking', at: [Math.round(c0.x), Math.round(c0.z)], paintVerts: bb.n, counts: site.parkingCounts })
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
  await page.evaluate((v) => {
    const L = window.corridor.site.layers
    const g = window.__mode === 'parking' ? L.parking : window.__mode === 'barriers' ? L.barriers : window.__mode === 'sidewalks' ? L.sidewalks : L.furniture
    g.visible = v
  }, on)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}${on ? 'after' : 'before'}.png`, timeout: 300000 })
}
await browser.close()
