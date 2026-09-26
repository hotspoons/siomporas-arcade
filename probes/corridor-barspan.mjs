// What does each stop bar at a junction SPAN, in lane coordinates? Reads the live geometry and
// projects each bar's vertices onto its approach's across-vector, from the centre line outward.
//   PORT=5185 node probes/corridor-barspan.mjs [junction id]
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const JID = process.argv[2] ?? 'x1646027193'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#crofton-triangle`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 300000 })
console.log(await page.evaluate((jid) => {
  const site = window.corridor.site, T = window.corridor.tune
  const X = site.manifest.intersections.list.find((q) => q.id === jid)
  const paint = site.layers.stopbars.getObjectByName('stopbars:paint')
  const p = paint.geometry.getAttribute('position')
  const out = { id: jid, control: X.control, laneWidth: T.get('LANE_WIDTH'), shoulderOut: T.get('SHOULDER_OUT'), approaches: [] }
  for (const a of X.approaches) {
    const th = (a.bearing_deg * Math.PI) / 180
    const travel = [Math.sin(th), -Math.cos(th)], right = [-travel[1], travel[0]]
    const sx = a.stop_x, sz = -a.stop_y
    // vertices within 1 m along-travel of the stop point and 12 m across
    let lo = Infinity, hi = -Infinity, n = 0
    for (let i = 0; i < p.count; i++) {
      const dx = p.getX(i) - sx, dz = p.getZ(i) - sz
      const along = dx * travel[0] + dz * travel[1], across = dx * right[0] + dz * right[1]
      if (Math.abs(along) < 1.0 && Math.abs(across) < 12) { lo = Math.min(lo, across); hi = Math.max(hi, across); n++ }
    }
    // the road's own lane edge and asphalt edge here, from the edge-distance sampler
    const edgeAt = (k) => site.edgeDistance(sx + right[0] * k, sz + right[1] * k)
    let asphaltEdge = null
    for (let k = 0; k < 12; k += 0.1) if (edgeAt(k) >= 0) { asphaltEdge = +k.toFixed(1); break }
    out.approaches.push({ name: a.name, lanes: a.lanes, width_m: a.width_m, stop: a.stop, barSpan: n ? [+lo.toFixed(2), +hi.toFixed(2)] : null, verts: n, asphaltEdgeRight: asphaltEdge })
  }
  return JSON.stringify(out, null, 1)
}, JID))
await browser.close()
