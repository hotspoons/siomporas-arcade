// What is the hard-edged dark quadrilateral in the foreground of the signal shot?
// Raycast a grid through the SAME stance the shot used and name what is hit.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5210', SLUG = process.env.SLUG ?? 'crofton-triangle'
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 640, height: 420 } })
p.on('pageerror', e => console.log('PAGEERROR', e.message))
await p.route('**/@vite/client', r => r.abort())
await p.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(s => window.corridor?.site?.manifest?.slug === s, SLUG, { timeout: 600000 })
console.log(JSON.stringify(await p.evaluate(() => {
  const c = window.corridor, site = c.site, THREE = c.THREE
  for (const k of ['trees','grass','crops','buildings','parking','barriers','sidewalks','power','rocks','water','horizon','structures','placements','markers','spine']) if (site.layers[k]) site.layers[k].visible = false
  if (site.grass) site.grass.mesh.visible = false
  // the exact stance of lite-signal.png
  const X = site.manifest.intersections.list.filter(q => q.control === 'signals').sort((a,b) => b.arms - a.arms)[0]
  const gy = site.groundAt(X.x, -X.y) ?? 0
  c.camera.position.set(X.x + 15, gy + 7, -X.y + 15)
  c.camera.lookAt(X.x, gy + 5, -X.y)
  c.camera.updateMatrixWorld(true)

  const rc = new THREE.Raycaster()
  const v = new THREE.Vector2()
  const rows = []
  // sweep the lower half of the frame, where the quad is
  for (let sy = 0.05; sy <= 0.95; sy += 0.15) {
    const row = []
    for (let sx = -0.9; sx <= 0.9; sx += 0.3) {
      v.set(sx, -sy)
      rc.setFromCamera(v, c.camera)
      const hits = rc.intersectObject(site.group, true).filter(h => h.object.visible && h.object.isMesh)
      const h = hits[0]
      if (!h) { row.push(null); continue }
      // ALL the surfaces this ray crosses, so "terrain in front of asphalt" can be proved rather
      // than inferred from neighbouring rays hitting different things.
      const stack = hits.slice(0, 4).map((q) => ({ n: (q.object.name || '(unnamed)').replace('road:', ''), d: +q.distance.toFixed(2) }))
      const ter = hits.find((q) => (q.object.name || '') === 'terrain')
      const asp = hits.find((q) => (q.object.name || '').startsWith('road:asphalt') || (q.object.name || '') === 'strip')
      row.push({
        sx: +sx.toFixed(2), name: h.object.name || '(unnamed)', d: +h.distance.toFixed(1),
        stack,
        // negative = terrain is IN FRONT of the carriageway on this exact ray
        terrainOverRoad: ter && asp ? +(ter.distance - asp.distance).toFixed(3) : null,
        wx: +h.point.x.toFixed(1), wz: +h.point.z.toFixed(1),
      })
    }
    rows.push({ sy: +sy.toFixed(2), row })
  }
  // and what distinct objects cover the ground here at all
  const names = new Set()
  let both = 0, terFront = 0, worst = 0
  for (const r of rows) for (const q of r.row) if (q) {
    names.add(q.name)
    if (q.terrainOverRoad != null) { both++; if (q.terrainOverRoad < 0) { terFront++; worst = Math.min(worst, q.terrainOverRoad) } }
  }
  return { junction: X.id, camera: [+c.camera.position.x.toFixed(1), +c.camera.position.y.toFixed(1), +c.camera.position.z.toFixed(1)],
           objects: [...names], verdict: { raysHittingBoth: both, terrainInFront: terFront, worstMetres: worst }, rows }
})))
await b.close()
