// Under the trees it is darker — and how much darker depends on the season and on what the trees
// are. Measured by moving the eye between open ground and closed canopy at the same instant.
//   PORT=5185 node probes/corridor-canopyshade.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 700, height: 450 } })
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/#${slug}?lite=1&fresh`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(4000)
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
// find one spot under heavy canopy and one in the open, both near the spine
const spots = await p.evaluate(() => {
  const site = window.corridor.site, m = site.manifest
  let wood = null, open = null
  for (const c of m.spine.coords) {
    for (const off of [-30, -20, 20, 30]) {
      const x = c[0] + off, y = c[1] + off
      const h = site.canopyAt(x, y)
      // the shade is sampled over a kernel, so a spot is only "wood" or "open" if its NEIGHBOURS
      // agree — a lone tree in a field and a gap in a wood both average to something in between
      const kernel = [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5]].map(([dx, dy]) => site.canopyAt(x + dx, y + dy))
      if (!wood && kernel.every((k) => k > 12)) wood = { x, z: -y, canopy: +h.toFixed(1) }
      if (!open && kernel.every((k) => k < 1)) open = { x, z: -y, canopy: +h.toFixed(1) }
    }
    if (wood && open) break
  }
  return { wood, open }
})
ok('the site has both closed canopy and open ground near the road', !!(spots.wood && spots.open), JSON.stringify(spots))
const lightAt = async (spot) => p.evaluate(async (s) => {
  const c = window.corridor
  c.camera.position.set(s.x, (c.site.groundAt(s.x, s.z) ?? 0) + 2, s.z)
  c.orbit.target.set(s.x + 5, (c.site.groundAt(s.x, s.z) ?? 0) + 2, s.z)
  c.orbit.update()
  // The shade is smoothed over the CAPPED frame delta (0.1 s), so under swiftshader's two frames a
  // second it closes about a third of the gap per frame — and the tile CHM the canopy is read from
  // is still streaming toward the new position. Both want more than a moment.
  await new Promise((r) => setTimeout(r, 4000))
  const amb = c.scene.children.find((o) => o.isHemisphereLight)
  const canopy = +c.site.canopyAt(c.camera.position.x, -c.camera.position.z).toFixed(1)
  return { amb: +amb.intensity.toFixed(3), env: +c.scene.environmentIntensity.toFixed(3), canopy, at: [+c.camera.position.x.toFixed(1), +c.camera.position.z.toFixed(1)], ...c.light() }
}, spot)
const setSeason = (s) => p.evaluate((s) => window.corridor.tune.set('SEASON', s), s)
for (const [name, idx, expect] of [['summer', 2, 'much darker'], ['winter', 0, 'barely darker']]) {
  await setSeason(idx)
  await p.waitForTimeout(1500)
  const open = await lightAt(spots.open)
  const wood = await lightAt(spots.wood)
  const ratio = +(wood.env / Math.max(1e-6, open.env)).toFixed(2)
  console.log(`     ${name}: open ${JSON.stringify(open)}`)
  console.log(`     ${name}: wood ${JSON.stringify(wood)}`)
  // how MUCH darker is CANOPY_SHADE's business (it is a knob); what this asserts is that the wood
  // is meaningfully darker in leaf and barely darker out of it, which is the behaviour
  if (name === 'summer') ok('in summer the wood is darker than the field', ratio < 0.88, `${ratio} of the open light`)
  else ok('in winter the SAME wood lets nearly all of it through', ratio > 0.9, `${ratio} of the open light`)
}
// and the gain knob multiplies everything
await setSeason(2)
await p.waitForTimeout(800)
const before = await lightAt(spots.open)
await p.evaluate(() => window.corridor.tune.set('AMBIENT_GAIN', 2))
const after = await lightAt(spots.open)
ok('AMBIENT_GAIN doubles the ambient', Math.abs(after.amb / before.amb - 2) < 0.15 && Math.abs(after.env / before.env - 2) < 0.15, `${before.amb}/${before.env} -> ${after.amb}/${after.env}`)
await p.evaluate(() => { window.corridor.tune.set('AMBIENT_GAIN', 1); window.corridor.tune.set('SEASON', -1) })
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
