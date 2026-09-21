// What the furniture costs the frame: the same view with the four layers on and off.
//
//   PORT=5205 SLUG=crofton-crownsville node probes/corridor-furnitureperf.mjs
//
// This box has no GPU, so the absolute number is swiftshader's. The DIFFERENCE between the same
// frames with the layers on and off is still the right ordered signal, and it is what "within 3 ms
// of today's" means in practice. The grass and the near trees are hidden for both halves — they
// are what stops a frame arriving at all here, and they are identical in each.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5205'
const SLUG = process.env.SLUG ?? 'crofton-crownsville'
const N = Number(process.env.N ?? 12)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 300000 })

console.log(JSON.stringify(await page.evaluate(async ({ n }) => {
  const c = window.corridor, site = c.site, L = site.layers
  if (L.trees) L.trees.visible = false
  if (site.grass) site.grass.mesh.visible = false
  // stand at the busiest junction, where all four groups are in frame at once
  const g = L.furniture
  const m4 = new c.THREE.Matrix4(), p = new c.THREE.Vector3(), q = new c.THREE.Quaternion(), s = new c.THREE.Vector3()
  const at = []
  for (const mesh of g.children) {
    if (!mesh.name.startsWith('furniture:signal')) continue
    for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m4); m4.decompose(p, q, s); at.push({ x: p.x, y: p.y, z: p.z }) }
  }
  let best = at[0], bestN = -1
  for (const a of at) {
    const k = at.filter((b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 60 * 60).length
    if (k > bestN) { bestN = k; best = a }
  }
  c.camera.position.set(best.x + 40, best.y + 22, best.z + 40)
  c.orbit.target.set(best.x, best.y, best.z)
  c.orbit.update()

  const frames = (k) => new Promise((resolve) => {
    const out = []
    let last = performance.now(), i = 0
    const tick = () => {
      const t = performance.now()
      out.push(t - last)
      last = t
      if (++i >= k + 2) return resolve(out.slice(2))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const med = (a) => { const x = [...a].sort((u, v) => u - v); return Math.round(x[x.length >> 1] * 10) / 10 }
  const LAYERS = ['furniture', 'parking', 'barriers', 'sidewalks']
  const set = (v) => { for (const k of LAYERS) if (L[k]) L[k].visible = v }

  set(false)
  const off = med(await frames(n))
  set(true)
  const on = med(await frames(n))
  let tris = 0
  for (const k of LAYERS) L[k]?.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count / 3 : 0) * (o.isInstancedMesh ? o.count : 1) })
  let calls = 0
  for (const k of LAYERS) L[k]?.traverse((o) => { if (o.isMesh) calls++ })
  return {
    site: site.manifest.slug, junctionMasts: bestN,
    frame_ms_without: off, frame_ms_with: on, cost_ms: Math.round((on - off) * 10) / 10,
    furniture_triangles: tris, furniture_draw_calls: calls,
  }
}, { n: N })))
await browser.close()
