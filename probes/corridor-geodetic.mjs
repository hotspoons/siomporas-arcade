// Does the world actually sit on the ellipsoid, and does the road still sit on the ground?
//
//   PORT=5185 SLUG=bacon-ridge-rd node probes/corridor-geodetic.mjs
//
// Two things can go wrong with the frame change and neither shows up as an error:
//   * the terrain draws FLAT — the lattice was ignored and we are still on a plane
//   * the terrain curves but the ROADS do not, because the vector layers and the raster layers
//     ended up in different frames. That is the failure the 1.06 deg convergence causes, and at
//     3 km it puts the asphalt 55 m off the ground it is supposed to be lying on.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const SLUG = process.env.SLUG ?? 'bacon-ridge-rd'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror:', e.message))
page.on('response', (r) => { if (r.status() === 404) console.log('404:', r.url().replace(`http://localhost:${PORT}`, '')) })
await page.goto(`http://localhost:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__apex?.site, null, { timeout: 180000 })

const out = await page.evaluate(() => {
  const s = window.__apex.site
  const terrain = s.layers.imagery
  const pos = terrain.geometry.attributes.position
  // CURVATURE: the rendered Y is the DEM height MINUS the drop below the tangent plane, so
  // comparing the two isolates the curvature from the terrain's own relief (which is far bigger).
  const drops = []
  let far = { r: 0, y: 0 }
  for (let i = 0; i < pos.count; i += 37) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const r = Math.hypot(x, z)
    if (r > far.r) far = { r, y }
    const dem = s.heightAt(x, -z)
    if (Number.isFinite(dem)) drops.push({ r, d: dem - y })
  }
  drops.sort((a, b) => a.r - b.r)
  const bucket = (lo, hi) => {
    const v = drops.filter((p) => p.r >= lo && p.r < hi).map((p) => p.d)
    if (!v.length) return null
    v.sort((a, b) => a - b)
    return { r: Math.round((lo + hi) / 2), n: v.length, measured: +v[v.length >> 1].toFixed(3), expected: +(((lo + hi) / 2) ** 2 / (2 * 6386615)).toFixed(3) }
  }
  // the roads: does groundAt agree with the strip the asphalt was built on?
  const gaps = []
  const spine = s.manifest?.spine?.coords ?? []
  for (let i = 0; i < spine.length; i += Math.max(1, Math.floor(spine.length / 40))) {
    const [e, n, z] = spine[i]
    const g = s.groundAt(e, -n)
    if (g !== null) gaps.push(Math.abs(g - z))
  }
  gaps.sort((a, b) => a - b)
  return {
    slug: s.manifest?.slug,
    anchor: s.manifest?.frame?.anchor ?? null,
    kind: s.manifest?.frame?.kind ?? null,
    demHasLattice: !!s.manifest?.layers?.dem?.geo,
    verts: pos.count,
    farRange: Math.round(far.r),
    curvature: [bucket(0, 200), bucket(400, 600), bucket(900, 1100), bucket(1200, 1500)].filter(Boolean),
    roadSamples: gaps.length,
    roadGapMedian: gaps.length ? +gaps[gaps.length >> 1].toFixed(3) : null,
    roadGapWorst: gaps.length ? +gaps[gaps.length - 1].toFixed(3) : null,
  }
})
console.log(JSON.stringify(out, null, 1))
const bad = out.curvature.filter((b) => Math.abs(b.measured - b.expected) > 0.02 + b.expected * 0.15)
console.log(bad.length ? `CURVATURE BAD at ${bad.map((b) => b.r + ' m').join(', ')}` : 'CURVATURE OK — the surface falls away from the tangent plane by what the ellipsoid says')
console.log(out.roadGapWorst !== null && out.roadGapWorst < 2
  ? `ROAD OK  — worst gap between the spine and the ground under it: ${out.roadGapWorst} m`
  : `ROAD BAD — worst gap ${out.roadGapWorst} m (the frames disagree)`)
await browser.close()
