// Where are the stop bars at one junction, and are they drawn? Reads the live geometry: no screenshot.
//   PORT=5185 node probes/corridor-barcheck.mjs [junction id]
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const JID = process.argv[2] ?? 'x1646027193'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#crofton-triangle`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 300000 })
console.log(await page.evaluate((jid) => {
  const site = window.corridor.site
  const L = site.layers.stopbars
  const X = site.manifest.intersections.list.find((q) => q.id === jid)
  const bars = (site.manifest.signals?.bars ?? []).filter((b) => b.x_id === jid)
  const out = { layerVisible: L?.visible, layerParentVisible: L?.parent?.visible, children: (L?.children ?? []).map((c) => ({ name: c.name, visible: c.visible, verts: c.geometry?.getAttribute('position')?.count, kids: c.children?.length })), junction: { x: X.x, y: X.y, control: X.control, stops: X.approaches.map((a) => [a.stop_x, a.stop_y, a.width_m, a.stop]) }, bakeBars: bars }
  // vertices of stopbars:paint within 25 m of the junction, with the ground and the road surface under them
  const paint = L?.getObjectByName('stopbars:paint')
  if (paint) {
    const p = paint.geometry.getAttribute('position'); const near = []
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); if (Math.hypot(x - X.x, z + X.y) < 25) near.push({ x: +x.toFixed(1), y: +p.getY(i).toFixed(3), z: +z.toFixed(1), ground: +(site.groundAt(x, z) ?? NaN).toFixed(3), edge: +site.edgeDistance(x, z).toFixed(2) }) }
    out.nearVerts = near.slice(0, 8); out.nearCount = near.length
    paint.geometry.computeBoundingBox(); out.paintBox = paint.geometry.boundingBox
    out.paintMat = { type: paint.material.type, color: paint.material.color?.getHexString(), depthTest: paint.material.depthTest, transparent: paint.material.transparent }
  }
  // the road surface height at the first stop point: the asphalt mesh vertices nearest it
  const road = site.layers.road
  let best = null
  road.traverse((o) => { if (!o.isMesh || !/^road:asphalt|^road:concrete|^road:chipseal/.test(o.name)) return; const p = o.geometry.getAttribute('position'); const [sx, sy] = X.approaches[0] ? [X.approaches[0].stop_x, -X.approaches[0].stop_y] : [X.x, -X.y]; for (let i = 0; i < p.count; i++) { const d = Math.hypot(p.getX(i) - sx, p.getZ(i) - sy); if (!best || d < best.d) best = { d: +d.toFixed(2), y: +p.getY(i).toFixed(3), mesh: o.name } } })
  out.asphaltNearStop0 = best
  return JSON.stringify(out, null, 1)
}, JID))
await browser.close()
