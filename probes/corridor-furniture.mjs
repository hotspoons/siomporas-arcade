// Street furniture: how much was placed, is any of it standing in the road, and is it facing the
// traffic it governs?
//
//   PORT=5205 SLUG=crofton-crownsville node probes/corridor-furniture.mjs
//
// Three things a screenshot cannot tell you:
//   ON THE CARRIAGEWAY   `edgeDistance` at every instance's real position. A signal node is on the
//                        road centreline in OSM, so every mast has to have been walked off it; one
//                        left behind is a pole growing out of a traffic lane.
//   FACING               the heads' world direction against the bake's bearing. The repo renders a
//                        bearing as `rotation.y = -(yaw·π/180)`, under which a model's −Z is what
//                        points along it — easy to get backwards, and a signal facing away from
//                        the traffic looks fine in a still. Matched by INSTANCE INDEX, through the
//                        source record each mesh carries: the first version matched by nearest
//                        position and reported a 180° error, because two masts of one junction end
//                        up metres apart and it kept pairing each with the opposite approach.
//   ARM OVER THE ROAD    the far end of the mast arm should be above asphalt. That is the check
//                        that says the thing is doing its job; whether two approach bearings differ
//                        by 180° says very little, since a two-signal junction is as often two
//                        roads crossing as one road with a signal at each end.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5205'
const SLUG = process.env.SLUG ?? 'crofton-crownsville'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 300000 })

console.log(JSON.stringify(await page.evaluate(() => {
  const site = window.corridor.site, mod = window.corridor.THREE
  const g = site.layers.furniture
  const masts = site.manifest.signals?.masts ?? []
  const out = {
    site: site.manifest.slug,
    baked: { masts: masts.length, signs: (site.manifest.signals?.signs ?? []).length },
    placed: site.furnitureCounts,
    meshes: [],
    onCarriageway: { count: 0, worst: null, examples: [] },
    facing: { checked: 0, worstErrDeg: 0 },
    arm: { checked: 0, overAsphalt: 0, overAsphaltPct: 0, examplesMissing: [] },
    triangles: 0,
    parking: null,
  }
  if (!g) return { ...out, note: 'no furniture group' }

  const m4 = new mod.Matrix4()
  const pos = new mod.Vector3()
  const quat = new mod.Quaternion()
  const scl = new mod.Vector3()
  const fwd = new mod.Vector3()
  const bearingOf = (q) => {
    // the geometry faces −Z; where does −Z end up?
    fwd.set(0, 0, -1).applyQuaternion(q)
    // world (x east, z south) → site (x east, y north = −z); bearing 0 = north
    return ((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI + 360) % 360
  }
  const placed = []
  for (const mesh of g.children) {
    out.meshes.push({ name: mesh.name, instances: mesh.count, tris: (mesh.geometry.index.count / 3) * mesh.count })
    out.triangles += (mesh.geometry.index.count / 3) * mesh.count
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m4)
      m4.decompose(pos, quat, scl)
      const e = site.edgeDistance(pos.x, pos.z)
      const rec = { name: mesh.name, x: +pos.x.toFixed(1), z: +pos.z.toFixed(1), edge: +e.toFixed(2), bearing: +bearingOf(quat).toFixed(1) }
      placed.push(rec)
      if (e < 0) {
        out.onCarriageway.count++
        if (out.onCarriageway.examples.length < 6) out.onCarriageway.examples.push(rec)
        if (out.onCarriageway.worst === null || e < out.onCarriageway.worst) out.onCarriageway.worst = +e.toFixed(2)
      }
    }
  }

  // FACING and ARM: instance i against the bake record it was built from
  const arm = new mod.Vector3()
  for (const mesh of g.children) {
    const src = mesh.userData.src
    if (!src || !mesh.name.startsWith('furniture:signal')) continue
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m4)
      m4.decompose(pos, quat, scl)
      const want = src[i].yaw_deg
      const got = bearingOf(quat)
      // wrap the difference into [-180, 180) and take its size. The first version had a stray
      // `180 -` in front and reported a PERFECT match as a 180° error, which sent me looking for
      // an orientation bug that was not there.
      const err = Math.abs(((((got - want) % 360) + 540) % 360) - 180)
      out.facing.checked++
      if (err > out.facing.worstErrDeg) out.facing.worstErrDeg = +err.toFixed(1)
      // the arm runs out along local +X; its tip should be over asphalt
      arm.set(mesh.userData.arm * 0.9, 0, 0).applyQuaternion(quat).add(pos)
      const e = site.edgeDistance(arm.x, arm.z)
      out.arm.checked++
      if (e < 0) out.arm.overAsphalt++
      else if (out.arm.examplesMissing.length < 5) out.arm.examplesMissing.push({ x: +arm.x.toFixed(1), z: +arm.z.toFixed(1), edge: +e.toFixed(2) })
    }
  }
  out.arm.overAsphaltPct = out.arm.checked ? +((100 * out.arm.overAsphalt) / out.arm.checked).toFixed(1) : 0

  // --- parking: is any of the asphalt on a carriageway, and is the paint on the asphalt? --------
  const pk = site.layers.parking
  if (pk) {
    const p3 = new mod.Vector3()
    const res = { counts: site.parkingCounts, baked: (site.manifest.parking ?? []).length, meshes: [], surfaceOnRoad: 0, surfaceChecked: 0, paintOffAsphalt: 0, paintChecked: 0, triangles: 0 }
    const surface = pk.children.find((m) => m.name === 'parking:surface')
    const paint = pk.children.find((m) => m.name === 'parking:paint')
    for (const m of pk.children) {
      const tris = m.geometry.index.count / 3
      res.meshes.push({ name: m.name, tris })
      res.triangles += tris
    }
    // every Nth surface vertex: none of the paved area should be over a road we drew
    if (surface) {
      const a = surface.geometry.getAttribute('position')
      const step = Math.max(1, Math.floor(a.count / 4000))
      for (let i = 0; i < a.count; i += step) {
        res.surfaceChecked++
        if (site.edgeDistance(a.getX(i), a.getZ(i)) < 0) res.surfaceOnRoad++
      }
    }
    // every stall stripe's far end should be inside a lot, i.e. above the paved mesh. Cheap proxy:
    // it must be within the site and not on a carriageway, which is what the builder promised.
    if (paint) {
      const a = paint.geometry.getAttribute('position')
      const step = Math.max(1, Math.floor(a.count / 4000))
      for (let i = 0; i < a.count; i += step) {
        res.paintChecked++
        p3.set(a.getX(i), a.getY(i), a.getZ(i))
        if (site.edgeDistance(p3.x, p3.z) < 0) res.paintOffAsphalt++
      }
    }
    res.surfaceOnRoadPct = res.surfaceChecked ? +((100 * res.surfaceOnRoad) / res.surfaceChecked).toFixed(2) : 0
    out.parking = res
    out.triangles += res.triangles
  }
  return out
})))
await browser.close()
