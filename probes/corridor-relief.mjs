// Does terrain exaggeration actually exaggerate? Loads a site twice, as measured and at
// RELIEF×, and asserts the MECHANISM: for sample points the ground height must move by
// k·(z − z0) about the spine datum, the spine's own median must stay put, and the road
// profile must move with the ground (or the strip would float / sink). Fails loudly if the
// relief did not apply (both loads equal) or if only part of the world moved.
//   PORT=5185 RELIEF=3 node probes/corridor-relief.mjs crofton-triangle
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const K = Number(process.env.RELIEF ?? 3)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
async function load(relief) {
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
  page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
  await page.route('**/@vite/client', (r) => r.abort())
  const url = `http://localhost:${PORT}/?lite=1${relief !== 1 ? `&relief=${relief}` : ''}#${slug}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
  // the tile stream keeps swapping the 8 m overview for 1 m tiles after the site is ready; sample
  // once the counts have stopped changing so both loads answer from the same rasters
  await page.evaluate(async () => {
    let last = '', since = Date.now()
    while (Date.now() - since < 4000) {
      const now = JSON.stringify(window.corridor.site.tiles?.() ?? null)
      if (now !== last) { last = now; since = Date.now() }
      await new Promise((r) => setTimeout(r, 250))
    }
  })
  const out = await page.evaluate(() => {
    const site = window.corridor.site
    const m = site.manifest
    const zs = m.spine.coords.map((c) => c[2]).slice().sort((a, b) => a - b)
    const median = zs[zs.length >> 1]
    // sample ground off the road at several spine stations, well clear of the strip
    const samples = []
    for (let i = 20; i < m.spine.coords.length - 20; i += Math.max(1, (m.spine.coords.length / 8) | 0)) {
      const [x, y] = m.spine.coords[i]
      const [x2, y2] = m.spine.coords[i + 1]
      const L = Math.hypot(x2 - x, y2 - y) || 1
      const nx = -(y2 - y) / L, ny = (x2 - x) / L
      // off the road: a point on a strip answers profile + a fixed lift, which is a thing sitting
      // on the terrain, not terrain; walk outward until clear of every carriageway
      let px = x, py = y, edge = 0
      for (const off of [90, 130, 170, 210]) {
        px = x + nx * off; py = y + ny * off; edge = site.edgeDistance(px, -py)
        if (edge > 8) break
      }
      samples.push({ x: px, y: py, g: site.groundAt(px, -py), edge, road: m.spine.coords[i][2] })
    }
    const branch = m.branches[0]
    // and ON a road: the surface is the profile plus whatever the strip adds; that addition is
    // measured here (surface − profile), never assumed, and must survive the exaggeration
    const bi = Math.min(3, branch.coords.length - 1)
    const [bx, by, bz] = branch.coords[bi]
    const onRoad = { z: bz, surface: site.groundAt(bx, -by), edge: site.edgeDistance(bx, -by) }
    return { median, samples, onRoad, branchZ: branch.profile?.road_z?.[0] ?? branch.coords[0][2], water: m.water?.areas?.[0]?.z ?? null }
  })
  await page.close()
  return out
}
const a = await load(1)
const b = await load(K)
await browser.close()
const z0 = a.median
let fails = 0
const check = (what, got, want, tol = 0.15) => {
  const ok = Number.isFinite(got) && Number.isFinite(want) && Math.abs(got - want) <= tol
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: got ${got?.toFixed?.(2)} want ${want?.toFixed?.(2)}`)
  if (!ok) fails++
}
console.log(`spine datum z0 = ${z0.toFixed(2)} m, relief ${K}×`)
check('spine median stays put', b.median, z0, 0.05)
let moved = 0
for (let i = 0; i < a.samples.length; i++) {
  const g1 = a.samples[i].g, g2 = b.samples[i].g
  if (g1 == null || g2 == null) { console.log(`FAIL sample ${i}: no ground (${g1}, ${g2})`); fails++; continue }
  check(`ground sample ${i} (as measured ${g1.toFixed(2)}, ${a.samples[i].edge.toFixed(1)} m from a road)`, g2, z0 + K * (g1 - z0), 0.3)
  if (Math.abs(g2 - g1) > 0.5) moved++
}
if (!moved) { console.log('FAIL nothing moved: relief did not apply'); fails++ }
check('first branch profile moves with the ground', b.branchZ, z0 + K * (a.branchZ - z0))
{
  const lift = a.onRoad.surface - a.onRoad.z
  console.log(`on the first branch (${a.onRoad.edge.toFixed(1)} m from its edge): the surface sits ${lift.toFixed(2)} m over the profile as measured`)
  check('road surface = exaggerated profile + the same lift', b.onRoad.surface, z0 + K * (a.onRoad.z - z0) + lift, 0.3)
}
if (a.water != null) check('first water area moves with the ground', b.water, z0 + K * (a.water - z0))
console.log(fails ? `FAIL ${fails}` : 'PASS')
process.exit(fails ? 1 : 0)
