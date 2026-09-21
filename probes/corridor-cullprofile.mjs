// How much of the scene survives frustum culling from where you actually drive?
//
//   PORT=5185 SLUG=crofton-triangle node probes/corridor-cullprofile.mjs
//
// A merged mesh spanning the site has a site-sized bounding sphere and can never be culled, so it
// is submitted in full from anywhere. This walks the scene, tests every mesh's world bounding
// sphere against the camera frustum from a driver's eye, and reports what survives — by group, so
// the one that is costing the frame is named rather than guessed at.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const SLUG = process.env.SLUG ?? 'crofton-triangle'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 600000 })

console.log(JSON.stringify(await page.evaluate(() => {
  const c = window.corridor, site = c.site, T3 = c.THREE
  const st = site.spineAt(site.manifest.spine.length_m * 0.5)
  const gy = site.groundAt(st.pos.x, st.pos.z) ?? st.pos.y
  c.camera.position.set(st.pos.x, gy + 2, st.pos.z)
  c.camera.lookAt(st.pos.x + st.dir.x * 200, gy + 2, st.pos.z + st.dir.z * 200)
  c.camera.updateMatrixWorld()
  c.camera.updateProjectionMatrix()
  const f = new T3.Frustum().setFromProjectionMatrix(new T3.Matrix4().multiplyMatrices(c.camera.projectionMatrix, c.camera.matrixWorldInverse))
  const tri = (o) => {
    const idx = o.geometry?.index
    const n = idx ? idx.count : (o.geometry?.getAttribute('position')?.count ?? 0)
    return (n / 3) * (o.isInstancedMesh ? o.count : 1)
  }
  const out = { site: site.manifest.slug, groups: {}, total: { meshes: 0, tris: 0, visMeshes: 0, visTris: 0, unculled: 0 } }
  for (const [name, g] of Object.entries(site.layers)) {
    if (!g || !g.traverse) continue
    const r = { meshes: 0, tris: 0, visMeshes: 0, visTris: 0, unculled: 0 }
    if (!g.visible) { out.hidden = (out.hidden ?? []).concat(name); continue }
    g.traverse((o) => {
      if (!o.isMesh && !o.isLine && !o.isLineSegments) return
      // a hidden layer still holds its geometry but is never submitted; counting it blames the
      // frame on something the renderer is not drawing
      let vis = o.visible
      for (let q = o.parent; q && vis; q = q.parent) vis = q.visible
      if (!vis) return
      o.geometry?.computeBoundingSphere?.()
      const t = tri(o)
      r.meshes++
      r.tris += t
      if (o.frustumCulled === false) { r.unculled++; r.visMeshes++; r.visTris += t; return }
      const s = o.geometry?.boundingSphere
      if (!s) { r.visMeshes++; r.visTris += t; return }
      const ws = s.clone().applyMatrix4(o.matrixWorld)
      if (f.intersectsSphere(ws)) { r.visMeshes++; r.visTris += t }
    })
    if (!r.meshes) continue
    r.tris = Math.round(r.tris); r.visTris = Math.round(r.visTris)
    r.pctTris = r.tris ? +((100 * r.visTris) / r.tris).toFixed(1) : 0
    out.groups[name] = r
    for (const k of ['meshes', 'tris', 'visMeshes', 'visTris', 'unculled']) out.total[k] += r[k]
  }
  out.total.pctTris = +((100 * out.total.visTris) / out.total.tris).toFixed(1)
  return out
})))
await browser.close()
