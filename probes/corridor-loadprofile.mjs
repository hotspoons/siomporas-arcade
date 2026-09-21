// Where does a big network site's load time and jank actually go?
//
//   PORT=5185 SLUG=crofton-triangle node probes/corridor-loadprofile.mjs
//
// Three separate costs get blamed on each other:
//   BUILD    buildSite() on the main thread — geometry, stations, furniture. A freeze.
//   UPLOAD   three.js uploads a mesh's buffers on FIRST DRAW, so every mesh added during build
//            hits the GPU in the same frame. Trailworks traced 0.5–1.5 s stalls from exactly this
//            and fixed it with an upload gate (ext/trailworks/viewer/src/render/uploadGate.ts).
//   STEADY   per-frame cost once everything is resident: draw calls and triangles.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const SLUG = process.env.SLUG ?? 'crofton-triangle'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.addInitScript(() => {
  window.__t0 = performance.now()
  window.__frames = []
  const raf = window.requestAnimationFrame.bind(window)
  let last = performance.now()
  window.requestAnimationFrame = (cb) => raf((t) => { const n = performance.now(); window.__frames.push(n - last); last = n; cb(t) })
})
const t0 = Date.now()
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 600000 })
const built = Date.now() - t0
await page.waitForTimeout(25000)

console.log(JSON.stringify(await page.evaluate(({ built }) => {
  const c = window.corridor, site = c.site
  const f = window.__frames
  const r1 = (v) => Math.round(v * 10) / 10
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return r1(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? -1) }
  // the first frames after the site appears are the upload burst; the tail is steady state
  const early = f.slice(0, 12)
  const late = f.slice(-40)
  let meshes = 0, tris = 0, instanced = 0
  const byGroup = {}
  for (const [name, g] of Object.entries(site.layers)) {
    if (!g || !g.traverse) continue
    let m = 0, t = 0
    g.traverse((o) => {
      if (!o.isMesh && !o.isLine && !o.isLineSegments) return
      m++
      const n = o.isInstancedMesh ? o.count : 1
      if (o.isInstancedMesh) instanced++
      const idx = o.geometry?.index
      t += ((idx ? idx.count : (o.geometry?.getAttribute('position')?.count ?? 0)) / 3) * n
    })
    if (m) byGroup[name] = { meshes: m, tris: Math.round(t) }
    meshes += m
    tris += t
  }
  return {
    site: site.manifest.slug,
    roads: (site.manifest.roads ?? []).length,
    branches: (site.manifest.branches ?? []).length,
    build_ms_wallclock: built,
    buildProfile: (site.buildProfile ?? []).filter((p) => p.ms >= 200).sort((a, b) => b.ms - a.ms),
    frames_captured: f.length,
    first_frames_ms: early.map(r1),
    steady: { median: pct(late, 0.5), p90: pct(late, 0.9), max: r1(Math.max(...late)) },
    scene: { meshes, instancedMeshes: instanced, triangles: Math.round(tris) },
    byGroup,
  }
}, { built })))
await browser.close()
