// Does turf grow on car parks?
//
//   PORT=5185 SLUG=crofton-crownsville node probes/corridor-grass-parking.mjs
//
// The verge planter only knows distance from the PAVEMENT EDGE, and a lot sits beyond that edge,
// so grass grew straight across the asphalt. This asserts the mechanism rather than the look: it
// takes every live grass blade's world position and counts how many fall inside a parking ring.
// A pass must be ZERO, and the probe fails loudly if it found no blades or no lots to test with.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const SLUG = process.env.SLUG ?? 'crofton-crownsville'
// a pass on a handful of blades proves nothing; this is the floor below which the run is void
const MIN = Number(process.env.MIN ?? 2000)
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1000, height: 700 } })
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await p.goto(`http://localhost:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.__apex?.site, null, { timeout: 420000 })
// park somewhere with lots in view and let the grass ring fill
await p.evaluate(() => {
  const { camera, orbit, site } = window.__apex
  const a = site.spineAt(450), d = a.dir ?? { x: 1, z: 0 }
  camera.position.set(a.pos.x - d.x * 45, a.pos.y + 22, a.pos.z - d.z * 45)
  orbit.target.set(a.pos.x + d.x * 120, a.pos.y, a.pos.z + d.z * 120)
  orbit.update()
})
await p.waitForTimeout(12000)
const r = await p.evaluate(() => {
  const s = window.__apex.site
  const lots = (s.manifest.parking ?? []).filter((l) => (l.ring?.length ?? 0) >= 3)
    .map((l) => l.ring.map(([x, y]) => [x, -y]))
  const inside = (poly, x, z) => {
    let hit = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j]
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit
    }
    return hit
  }
  // Grass is NOT matrix-instanced: blade roots live in an `aRoot` InstancedBufferAttribute and the
  // far sprites in `aCard`. Reading getMatrixAt() found zero instances and the probe said so
  // rather than reporting a clean pass, which is the only reason this is right.
  let blades = 0, onLot = 0
  // The live count is geometry.instanceCount, NOT mesh.count — these are plain Meshes over an
  // InstancedBufferGeometry, so mesh.count reads 1 and scanning by it sampled a single blade out
  // of 400 000 and called it a pass. Third wrong version of this probe; the sample floor below is
  // what caught each one.
  const scan = (geo, attr) => {
    const a = geo?.getAttribute(attr)
    if (!a) return
    const live = geo.instanceCount
    const n = Math.min(Number.isFinite(live) && live > 0 ? live : a.count, a.count)
    for (let i = 0; i < n; i += 7) {
      const x = a.getX(i), z = a.getZ(i)
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue
      blades++
      if (lots.some((L) => inside(L, x, z))) onLot++
    }
  }
  const seen = new Set()
  s.layers.grass?.traverse((o) => {
    if (!o.geometry || seen.has(o.geometry)) return
    seen.add(o.geometry)
    scan(o.geometry, 'aRoot')
    scan(o.geometry, 'aCard')
  })
  const attrs = []
  const seen2 = new Set()
  s.layers.grass?.traverse((o) => {
    if (!o.geometry || seen2.has(o.geometry)) return
    seen2.add(o.geometry)
    for (const k of ['aRoot', 'aCard']) {
      const a = o.geometry.getAttribute(k)
      if (a) attrs.push({ name: o.name || '(unnamed)', attr: k, capacity: a.count, live: o.geometry.instanceCount ?? null })
    }
  })
  return { lots: lots.length, bladesSampled: blades, onParking: onLot, attrs }
})
console.log(JSON.stringify(r, null, 1))
if (!r.lots) { console.log('FAIL: no parking lots on this site — the check tested nothing'); process.exitCode = 2 }
else if (!r.bladesSampled) { console.log('FAIL: no grass instances found — the check tested nothing'); process.exitCode = 2 }
else if (r.bladesSampled < MIN) { console.log(`FAIL: only ${r.bladesSampled} blades sampled (need >= ${MIN}) — a pass on this few proves nothing`); process.exitCode = 2 }
else if (r.onParking) { console.log(`FAIL: ${r.onParking} of ${r.bladesSampled} sampled blades are on asphalt`); process.exitCode = 1 }
else console.log(`OK: 0 of ${r.bladesSampled} sampled blades fall inside any of ${r.lots} lots`)
await b.close()
