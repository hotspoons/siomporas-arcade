import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5210', SLUG = process.env.SLUG ?? 'crofton-triangle'
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 600, height: 400 } })
p.on('pageerror', e => console.log('PAGEERROR', e.message))
await p.route('**/@vite/client', r => r.abort())
await p.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(s => window.corridor?.site?.manifest?.slug === s, SLUG, { timeout: 600000 })
console.log(JSON.stringify(await p.evaluate(() => {
  const site = window.corridor.site, THREE = window.corridor.THREE
  const m = site.manifest
  const out = { side: { checked: 0, right: 0, left: 0 }, bars: { meshes: 0, tris: 0, nearJunction: 0 }, blades: { meshes: 0, tris: 0 }, sample: null }

  // which side of travel did each stop sign END UP on, after the kerb walk?
  const m4 = new THREE.Matrix4(), pp = new THREE.Vector3(), qq = new THREE.Quaternion(), ss = new THREE.Vector3()
  const byX = new Map()
  for (const X of m.intersections.list) byX.set(X.id, X)
  for (const mesh of site.layers.furniture.children) {
    if (!mesh.name.startsWith('furniture:sign')) continue
    const src = mesh.userData?.src
    if (!Array.isArray(src)) continue
    for (let i = 0; i < mesh.count; i++) {
      const rec = src[i]
      if (!rec?.x_id || rec.travel_deg == null) continue
      const X = byX.get(rec.x_id); if (!X) continue
      mesh.getMatrixAt(i, m4); m4.decompose(pp, qq, ss)
      const th = rec.travel_deg * Math.PI / 180
      // travel in world (x east, z = -north)
      const tx = Math.sin(th), tz = -Math.cos(th)
      // right of travel = travel rotated -90 about Y  => (-tz, tx)
      const rx = -tz, rz = tx
      // vector from the bake's nominal point to where it stands
      const dx = pp.x - rec.x, dz = pp.z - (-rec.y)
      const dot = dx * rx + dz * rz
      out.side.checked++
      if (dot >= 0) out.side.right++; else out.side.left++
      if (!out.sample) out.sample = { x_id: rec.x_id, travel: rec.travel_deg, moved: +Math.hypot(dx, dz).toFixed(2), dotRight: +dot.toFixed(2) }
    }
  }

  // is there actual stop-bar geometry, and where?
  const g = site.layers.stopbars
  g?.traverse(o => { if (o.isMesh) { out.bars.meshes++; out.bars.tris += (o.geometry.index?.count ?? 0) / 3 } })
  const gb = site.layers.blades
  gb?.traverse(o => { if (o.isMesh) { out.blades.meshes++; out.blades.tris += (o.geometry.index?.count ?? 0) / 3 } })

  // the junction I photographed: are its bars inside its own junction box?
  const X = m.intersections.list.find(q => q.id === 'x1646027193') ?? m.intersections.list.find(q => q.control === 'all_way_stop')
  if (X) {
    const bars = (m.signals.bars ?? []).filter(q => q.x_id === X.id)
    out.sample2 = {
      id: X.id, arms: X.arms,
      bars: bars.map(q => ({ dFromCentre: +Math.hypot(q.x - X.x, q.y - X.y).toFixed(1), width: q.width_m, ed: +site.edgeDistance(q.x, -q.y).toFixed(2) })),
      blades: (X.blades ?? []).map(q => q.text),
      corners: (X.corners ?? []).map(c => ({ ed: +site.edgeDistance(c.x, -c.y).toFixed(2) })),
      lanesByArm: X.approaches.map(a => a.lanes),
    }
  }
  return out
})))
await b.close()
