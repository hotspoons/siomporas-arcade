// Does the canopy rule already keep grass off a forest floor?
//
//   PORT=5201 SLUG=chesterfield-rd node probes/corridor-canopycover.mjs
//
// Chesterfield Rd is closed canopy end to end except a west clearing and the church at the east
// (Rich). Under CHM > 3 m the verge must read as forest floor, not turf, and the grass generator
// already rejects those cells. This counts, station by station, how much of the verge is under
// canopy and how much grass the generator actually put there — so "it is already bare" is a
// number rather than an impression.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'chesterfield-rd'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug && !!window.corridor.site.grass, SLUG, { timeout: 300000 })

console.log(JSON.stringify(await page.evaluate(() => {
  const site = window.corridor.site, grass = site.grass, mod = window.corridor.THREE
  // walk the verge on a 2 m lattice and classify each cell the way grass.generate() does
  let verge = 0, underCanopy = 0, open = 0
  const bands = []
  const len = site.manifest.spine.length_m
  const BAND = Math.max(100, Math.round(len / 12 / 100) * 100)
  let bs = 0, bv = 0, bc = 0
  for (let s = 5; s < len - 5; s += 2) {
    const st = site.spineAt(s)
    const side = new mod.Vector3(-st.dir.z, 0, st.dir.x).normalize()
    for (let o = -30; o <= 30; o += 2) {
      const x = st.pos.x + side.x * o, z = st.pos.z + side.z * o
      const d = site.edgeDistance(x, z)
      if (d < 0.3 || d > 24) continue // the generator's own verge band
      verge++; bv++
      if (site.canopyAt(x, -z) > 3) { underCanopy++; bc++ } else open++
    }
    if (s - bs >= BAND) { bands.push({ s: Math.round(bs), canopy_pct: bv ? +(100 * bc / bv).toFixed(0) : null }); bs = s; bv = 0; bc = 0 }
  }
  // and what the generator actually produced, with the camera parked mid-site
  const p = site.spineAt(site.manifest.spine.photo_s)
  const cam = window.corridor.camera
  cam.position.set(p.pos.x, p.pos.y + 1.6, p.pos.z)
  const fwd = new mod.Vector3(p.dir.x, 0, p.dir.z).normalize()
  let g = 0
  do { grass.update(cam.position, fwd, 0) } while (grass.counts.pending > 0 && ++g < 8000)
  return {
    site: site.manifest.slug,
    grass_type: grass.grassType,
    verge_cells: verge,
    under_canopy_pct: +(100 * underCanopy / verge).toFixed(1),
    open_pct: +(100 * open / verge).toFixed(1),
    canopy_by_band: bands,
    counts_at_photo: grass.counts,
  }
})))
await browser.close()
