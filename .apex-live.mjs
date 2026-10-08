// Boot corridor once in SwiftShader Chromium, report the boot profile and what
// is resident, then stay alive so the dev bridge has a client to drive.
import { chromium } from 'playwright'

const url = process.env.APEX_URL ?? 'http://localhost:5185/?level=crofton-jam#/crofton-triangle'
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const boot = []
page.on('console', (m) => {
  const t = m.text()
  if (t.includes('[boot]')) { boot.push(t); console.log('BOOTLOG ' + t) }
  else if (m.type() === 'error') console.log('CONSOLE-ERR ' + t.slice(0, 300))
})
page.on('pageerror', (e) => console.log('PAGEERR ' + e.message))

console.log('goto ' + url)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })

// Wait for the site to exist and the build profile to have a full set of phases.
await page.waitForFunction(
  () => globalThis.apex?.site?.buildProfile?.length >= 8,
  null,
  { timeout: 240_000 },
)

const summary = await page.evaluate(() => {
  const a = globalThis.apex
  const s = a.site
  const safe = (fn, d) => { try { return fn() } catch (e) { return 'ERR ' + e.message } }
  const bbox = (pts) => {
    if (!pts.length) return null
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z }
    return { x0: Math.round(x0), x1: Math.round(x1), z0: Math.round(z0), z1: Math.round(z1) }
  }
  const treePts = (s.treeRecords ?? []).filter((r) => Number.isFinite(r.x))
  const layerBox = (name) => {
    const g = s.layers?.[name]
    if (!g) return null
    const pts = []
    g.traverse((o) => {
      if (!o.isMesh || !o.geometry) return
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere()
      const c = o.geometry.boundingSphere?.center
      if (c) { const w = o.localToWorld(c.clone()); pts.push({ x: w.x, z: w.z }) }
    })
    return { meshes: pts.length, bbox: bbox(pts) }
  }
  return {
    slug: s.manifest?.slug,
    car: safe(() => ({ x: Math.round(a.car.mesh.position.x), z: Math.round(a.car.mesh.position.z) })),
    profile: s.buildProfile,
    treePlanting: safe(() => s.treePlanting()),
    trees: { count: treePts.length, bbox: bbox(treePts) },
    layers: {
      road: layerBox('road'),
      furniture: layerBox('furniture'),
      grass: layerBox('grass'),
      buildings: layerBox('buildings'),
      power: layerBox('power'),
      sidewalks: layerBox('sidewalks'),
      parking: layerBox('parking'),
      barriers: layerBox('barriers'),
    },
    pyramid: safe(() => s.pyramid?.()),
    graded: safe(() => s.graded?.()),
    roadAt: safe(() => s.roadAt?.(a.car.mesh.position.x, a.car.mesh.position.z)),
  }
})
console.log('SUMMARY ' + JSON.stringify(summary, null, 2))

// Stay alive so the bridge keeps this page as a client.
console.log('READY')
await new Promise(() => {})
