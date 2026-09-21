// Terrain features, headless: fly to a measured cut face (or a measured stream), count what
// rocks.ts / water.ts put there, check the rules held, shoot it — with and without the layer.
//
//   node probes/corridor-terrain.mjs sideling-i68 rock out.png        # the tallest cut face
//   node probes/corridor-terrain.mjs south-mountain-i70 water out.png  # the longest waterway
//   PORT=5203 node probes/corridor-terrain.mjs bonnie-branch-rd water out.png
//
// Checks (printed as JSON): rock instances placed per type; none nearer a pavement edge than
// ROCK_PAVEMENT_CLEAR; every instance within 0.6 m of groundAt (they stand on the face, they do
// not float); water lines/areas/falls drawn; frame time over 3 s with the layer on. The camera is
// built from the manifest itself (spine + cuts/water) so the probe needs no hand-typed stance.
import { chromium } from 'playwright'
const [,, slug = 'sideling-i68', what = 'rock', out = `/tmp/corridor-terrain-${slug}-${what}.png`] = process.argv
const PORT = process.env.PORT ?? '5203'
const base = `http://127.0.0.1:${PORT}`

const manifest = await (await fetch(`${base}/sites/${slug}/web/manifest.json`)).json()
const coords = manifest.spine.coords
const at = (s) => coords[Math.max(0, Math.min(coords.length - 1, Math.round(s / 10)))]
let cam, target, note
if (what === 'rock') {
  const faces = manifest.cuts?.faces ?? []
  if (!faces.length) { console.log(JSON.stringify({ slug, error: 'no cut faces in manifest' })); process.exit(2) }
  const f = faces.reduce((a, b) => (b.height_m * Math.min(b.length_m, 300) > a.height_m * Math.min(a.length_m, 300) ? b : a))
  const s0 = Math.min(f.s_end - 60, Math.max(f.s_start, (f.s_start + f.s_end) / 2 - 30))
  const p = at(s0), q = at(s0 + 20)
  const d = [q[0] - p[0], q[1] - p[1]]; const n = Math.hypot(...d) || 1; d[0] /= n; d[1] /= n
  const left = [-d[1], d[0]]
  const sgn = f.side === 'left' ? 1 : -1
  // eye on the road centreline, 7 m up, looking 60 m ahead at the face's toe + 6 m up the face
  const t = at(s0 + 60)
  cam = [p[0], p[2] + 7, -p[1]]
  target = [t[0] + left[0] * sgn * (f.toe_m + 4), t[2] + 6, -(t[1] + left[1] * sgn * (f.toe_m + 4))]
  note = { face: f.id, side: f.side, class: f.class, s: [f.s_start, f.s_end], toe_m: f.toe_m, height_m: f.height_m, height_max_m: f.height_max_m, rock_type: f.rock_type, formation: f.formation }
} else {
  const lines = (manifest.water?.lines ?? []).filter((l) => !l.culvert && l.pts.length > 4)
  if (!lines.length) { console.log(JSON.stringify({ slug, error: 'no water lines in manifest' })); process.exit(2) }
  const withFalls = lines.filter((l) => l.falls?.length)
  const l = (withFalls.length ? withFalls : lines).reduce((a, b) => (b.length_m > a.length_m ? b : a))
  const fall = l.falls?.[0]
  const i = fall ? fall.i0 : Math.floor(l.pts.length / 2)
  const p = l.pts[i], q = l.pts[Math.min(l.pts.length - 1, i + 6)]
  // eye 18 m downstream-ish and 9 m up, looking at the water
  cam = [p[0] + (p[0] - q[0]) * 0.6 + 8, p[2] + 9, -(p[1] + (p[1] - q[1]) * 0.6) + 8]
  target = [q[0], q[2] + 0.3, -q[1]]
  note = { line: l.id, kind: l.kind, name: l.name, length_m: l.length_m, width_m: l.width_m, fall_m: l.fall_m, falls: l.falls }
}
const stance = { v: 1, site: slug, season: 'summer', mode: 'fly', cam: { p: cam, t: target }, layers: {}, lite: false }
const url = `${base}/?stance=${Buffer.from(JSON.stringify(stance)).toString('base64')}&season=summer#${slug}`
console.log(JSON.stringify({ slug, what, ...note, cam, target }))

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
// a Vite reload mid-probe empties window.corridor: no HMR client
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor?.site, null, { timeout: 300000 })
await page.waitForTimeout(2500)

const report = await page.evaluate((what) => {
  const c = window.corridor, site = c.site
  const o = { site: site.manifest.slug, rockCounts: site.rockCounts, waterStats: site.waterStats }
  const T = c.tune ?? null
  // rocks: instances, clearance from pavement, standing on the ground
  const rocks = site.layers.rocks
  if (rocks) {
    let n = 0, minEdge = Infinity, maxFloat = 0, offGround = 0, checked = 0
    rocks.traverse((im) => {
      if (!im.isInstancedMesh) return
      n += im.count
      const a = im.instanceMatrix.array
      const step = Math.max(1, Math.floor(im.count / 400))
      for (let i = 0; i < im.count; i += step) {
        // column-major 4x4: translation at 12..14, scale y = |column 1|
        const k = i * 16
        const x = a[k + 12], y = a[k + 13], z = a[k + 14]
        const sy = Math.hypot(a[k + 4], a[k + 5], a[k + 6])
        const e = site.edgeDistance(x, z)
        if (e < minEdge) minEdge = e
        const g = site.groundAt(x, z)
        if (g !== null) { const dy = Math.abs(y + sy * 0.15 - g); if (dy > maxFloat) maxFloat = dy; if (dy > 0.6) offGround++ }
        checked++
      }
    })
    o.rock = { instances: n, checked, minEdgeDistance_m: +minEdge.toFixed(2), maxGroundGap_m: +maxFloat.toFixed(2), offGround }
  }
  const water = site.layers.water
  if (water) {
    let meshes = 0, tris = 0
    water.traverse((mm) => { if (mm.isMesh) { meshes++; tris += (mm.geometry.index?.count ?? mm.geometry.attributes.position.count) / 3 } })
    o.water = { meshes, triangles: Math.round(tris) }
  }
  void what; void T
  return o
}, what)
console.log(JSON.stringify(report))

// frame time with the layer on, 12 s idle (swiftshader draws a corridor frame in seconds; the count is relative, not a fps claim)
await page.evaluate(() => { window.__ft = []; let last = performance.now(); const loop = () => { const n = performance.now(); window.__ft.push(n - last); last = n; requestAnimationFrame(loop) }; requestAnimationFrame(loop) })
await page.waitForTimeout(12000)
console.log(await page.evaluate(() => {
  const ft = window.__ft.slice(5); const sorted = [...ft].sort((a, b) => a - b)
  const pct = (p) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? -1) * 10) / 10
  return JSON.stringify({ frames: ft.length, median_ms: pct(0.5), p90_ms: pct(0.9), p99_ms: pct(0.99) })
}))
await page.screenshot({ path: out, timeout: 180000 })
// the isolate shot: the same frame with the layer hidden, so the dressing can be compared against the bare data
await page.evaluate((what) => { const l = window.corridor.site.layers[what === 'rock' ? 'rocks' : 'water']; if (l) l.visible = false }, what)
await page.waitForTimeout(400)
await page.screenshot({ path: out.replace(/\.png$/, '-off.png'), timeout: 180000 })
console.log(`shots ${out} and ${out.replace(/\.png$/, '-off.png')}`)
await browser.close()
