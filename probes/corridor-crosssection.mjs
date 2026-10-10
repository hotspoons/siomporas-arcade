// A cross-section of the world at a stance: at stations ahead of the car and offsets across its
// heading, what does every layer say the ground is? edgeDistance (d, who), the ground formula,
// the DEM, and raycasts down onto the road meshes, the strips and the terrain. Where terrain is
// above the road, or grass sits on pavement, the numbers say which layer is wrong.
//   PORT=5185 node probes/corridor-crosssection.mjs '<stance param>' <slug> [aheadList] [offsetList]
import { chromium } from 'playwright'
const [, , stance, slug, aheadArg = '0,10,20,35,50', offArg = '-12,-8,-5,-3,-1,0,1,3,5,8,12'] = process.argv
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1&stance=${stance}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForFunction(() => { const g = window.corridor?.site?.graded?.(); return !g || (g.pendingNear === 0 && g.built > 0) }, null, { timeout: 600000 })
await page.waitForTimeout(6000)
const rows = await page.evaluate(({ aheads, offs, stance }) => {
  const site = window.corridor.site, THREE = window.corridor.THREE ?? window.THREE
  const st = JSON.parse(atob(decodeURIComponent(stance)))
  const p = st.car?.p ?? st.cam?.p, yaw = st.car?.yaw ?? 0
  const fx = Math.cos(yaw), fz = Math.sin(yaw), rx = -fz, rz = fx
  const ray = new THREE.Raycaster()
  const down = new THREE.Vector3(0, -1, 0)
  const hitY = (obj, x, z, filter) => {
    if (!obj) return null
    ray.set(new THREE.Vector3(x, 500, z), down)
    const hits = ray.intersectObject(obj, true).filter((h) => !filter || filter(h.object))
    return hits.length ? +hits[0].point.y.toFixed(2) : null
  }
  const isStrip = (o) => !!o.geometry?.getAttribute?.('aEdge')
  const isRoad = (o) => !isStrip(o) && /road|asphalt|paint/i.test(o.name || o.parent?.name || '') || (!isStrip(o) && o.parent?.name === 'road')
  const out = []
  for (const a of aheads) for (const o of offs) {
    const x = p[0] + fx * a + rx * o, z = p[2] + fz * a + rz * o
    const e = site.edgeInfo ? site.edgeInfo(x, z) : { d: site.edgeDistance(x, z), who: '?' }
    out.push({ ahead: a, off: o, who: e.who, d: +e.d.toFixed(1), ground: +site.groundAt(x, z).toFixed(2), dem: +site.heightAt(x, -z).toFixed(2), grassD: +site.grassRoadDistance(x, z).toFixed(1), road: hitY(site.layers.road, x, z, isRoad), strip: hitY(site.layers.road, x, z, isStrip), terrain: hitY(site.layers.imagery?.parent ?? site.terrain.parent, x, z, (ob) => /terrain/.test(ob.name) || ob === site.terrain) })
  }
  return out
}, { aheads: aheadArg.split(',').map(Number), offs: offArg.split(',').map(Number), stance })
console.log('ahead  off  who |   d  grassD | ground   dem |  road  strip terrain  (a terrain above the road is a blob; grassD ≥ 0 on pavement is grass on the road)')
for (const r of rows) {
  const flag = (r.terrain != null && r.road != null && r.terrain > r.road + 0.05 ? ' TERRAIN-OVER-ROAD' : '') + (r.d < 0 && r.grassD >= 0 ? ' GRASS-ON-ROAD' : '') + (r.strip != null && r.road != null && r.strip > r.road + 0.05 ? ' STRIP-OVER-ROAD' : '')
  console.log(`${String(r.ahead).padStart(5)} ${String(r.off).padStart(4)} ${String(r.who).padStart(4)} | ${String(r.d).padStart(5)} ${String(r.grassD).padStart(6)} | ${String(r.ground).padStart(6)} ${String(r.dem).padStart(6)} | ${String(r.road ?? '-').padStart(6)} ${String(r.strip ?? '-').padStart(6)} ${String(r.terrain ?? '-').padStart(7)}${flag}`)
}
await browser.close()
