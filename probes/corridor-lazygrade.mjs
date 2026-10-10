// Lazy grading: does the site load without grading, and does the grading then arrive around the
// eye — and is the ground the same surface whether or not its mesh exists yet?
//   PORT=5185 node probes/corridor-lazygrade.mjs [slug] [stanceParam]
// Asserts the mechanism: (1) build profile carries no grading/building phase of any size, (2)
// graded().built is 0 at ready and grows to cover everything within STREAM_BUILD_M of the eye,
// (3) groundAt at 40 points near roads is bit-identical before and after the meshes exist,
// (4) on a branch, the surface is the profile + the strip's fixed 0.38 m, and a strip vertex
// there agrees with groundAt to a few cm. Fails loudly on each.
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const stance = process.argv[3]
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
const t0 = Date.now()
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1${stance ? `&stance=${stance}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
const ready = (Date.now() - t0) / 1000
let fails = 0
const fail = (m) => { console.log('FAIL', m); fails++ }
const first = await page.evaluate(() => {
  const site = window.corridor.site
  const prof = site.buildProfile
  const total = prof.reduce((a, p) => a + p.ms, 0)
  const grading = prof.filter((p) => p.ms >= 100).map((p) => [p.phase, p.ms])
  // sample ground near roads NOW, before any strip mesh exists
  const m = site.manifest
  const pts = []
  for (let i = 0; i < 40; i++) {
    const br = m.branches[(i * 37) % m.branches.length]
    const c = br.coords[Math.min(2, br.coords.length - 1)]
    const off = (i % 4) * 2.5 // 0, 2.5, 5, 7.5 m off the line
    pts.push([c[0] + off, -c[1]])
  }
  const g = pts.map(([x, z]) => site.groundAt(x, z))
  return { total, grading, graded: site.graded(), pts, g }
})
console.log(`ready after ${ready.toFixed(1)} s; build ${first.total} ms; phases ≥ 100 ms: ${JSON.stringify(first.grading)}`)
console.log('at ready:', JSON.stringify(first.graded))
// the pump starts with the first frame, which can precede this read by a unit or two
if (first.graded.built > 3) fail(`built ${first.graded.built} units during load — the load is supposed to grade nothing`)
// the phase named 'grade: units listed' is the units' own setup; the 'grade: lazy…' phase after it
// is the cul-de-sac bulbs and driveways, which were always there
for (const [ph, ms] of first.grading) if (/units listed/.test(ph) && ms > 300) fail(`setting up the lazy units costs ${ms} ms at load`)
// let the frames run: the scheduler builds around the eye
let last = -1, same = 0, snap
for (let i = 0; i < 240; i++) {
  await page.waitForTimeout(500)
  snap = await page.evaluate(() => window.corridor.site.graded())
  if (snap.pendingNear === 0 && snap.built > 0) break
  if (snap.built === last) { if (++same >= 20) break } else { same = 0; last = snap.built }
}
console.log(`settled after ${((Date.now() - t0) / 1000).toFixed(1)} s:`, JSON.stringify(snap))
if (snap.built === 0) fail('nothing was ever built')
if (snap.strips === 0) fail('no strips built')
if (snap.buildings === 0) fail('no buildings built')
const after = await page.evaluate((pts) => {
  const site = window.corridor.site
  const g = pts.map(([x, z]) => site.groundAt(x, z))
  // a strip mesh vertex vs the formula, on a branch that has been built
  const road = site.layers.road
  let checks = []
  road.traverse((o) => {
    if (checks.length >= 12 || !o.isMesh || !o.geometry.getAttribute('aEdge')) return
    const pos = o.geometry.getAttribute('position'), edge = o.geometry.getAttribute('aEdge')
    for (let i = 0; i < pos.count && checks.length < 12; i += Math.max(1, (pos.count / 4) | 0)) {
      if (!Number.isFinite(pos.getY(i))) continue
      const x = pos.getX(i), z = pos.getZ(i)
      const gy = site.groundAt(x, z)
      checks.push({ d: +edge.getX(i).toFixed(1), dy: +(gy - pos.getY(i)).toFixed(3) })
    }
  })
  // on the first branch, mid-way: surface vs profile
  const b = site.manifest.branches[0]
  const c = b.coords[Math.min(3, b.coords.length - 1)]
  const ed = site.edgeDistance(c[0], -c[1])
  return { g, checks, onRoad: { lift: +(site.groundAt(c[0], -c[1]) - c[2]).toFixed(3), edge: +ed.toFixed(2) } }
}, first.pts)
let diff = 0
for (let i = 0; i < first.g.length; i++) if (first.g[i] !== after.g[i]) diff++
console.log(`ground at 40 road-side points before vs after the meshes: ${diff} differ`)
if (diff) fail('the ground changed when the meshes arrived — it is supposed to be a formula')
console.log('strip vertices vs groundAt (d = m from pavement edge, dy = ground − vertex):', JSON.stringify(after.checks))
for (const c of after.checks) if (Math.abs(c.dy) > 0.05) fail(`strip vertex ${c.d} m out disagrees with groundAt by ${c.dy} m`)
console.log('first branch, on the road:', JSON.stringify(after.onRoad), '(expect lift 0.38 = 0.40 curve lift − 0.02)')
if (after.onRoad.edge < 0 && Math.abs(after.onRoad.lift - 0.38) > 0.05) fail(`on-road lift ${after.onRoad.lift}`)
console.log(fails ? `FAIL ${fails}` : 'PASS')
await browser.close()
process.exit(fails ? 1 : 0)
