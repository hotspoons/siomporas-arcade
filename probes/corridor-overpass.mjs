// A grade-separated crossing must not put a wall across the road underneath.
//
//   node probes/corridor-overpass.mjs [site]
//
// Regression for Paul, 2026-10-06. On dc-metro the Beltway (I 95/I 495) at s≈25124 passes under a
// `motorway_link` ramp (deck ≈ 42 m, Beltway ≈ 34.5 m). `edgeDistance` chose the laterally NEAREST
// carriageway with no idea of height, so on the Beltway beside the crossing the ground snapped up to
// the ramp: a 7.65 m step the car hit as an invisible wall. Driving the ramp it snapped down to the
// Beltway and fell. The fix makes the physics ground follow the LOWEST carriageway covering the
// point (`site.physGroundAt`) and carries the upper one as a trimesh deck collider (`site.decksNear`).
//
// WHY THIS PROBE OPENS A TILE FAR FROM THE CROSSING FIRST. A branch is tiled by its FIRST point
// (`_TILE_KEY`), and this ramp's first point is at (13211, 3830) — 560 m from where its deck crosses
// the Beltway, in tile 13_3. The viewer streams branches per tile when the eye reaches the tile, so
// the ramp is absent from the station grid unless 13_3 has been pumped. `updateNear` on the tile's
// centre is that pump. This is also, on its own, a real bug worth its own fix: a long road is only
// loaded near wherever it starts.
import { chromium } from 'playwright'

const site = process.argv[2] ?? 'dc-metro-take-2'
const PORT = process.env.CORRIDOR_PORT ?? '5186'

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.goto(`http://127.0.0.1:${PORT}/#${site}?lite&phys=1`, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.corridor?.site && !!window.corridor.physics, null, { timeout: 300000 })

const result = await page.evaluate(async () => {
  const s = window.corridor.site
  const ph = window.corridor.physics
  // pump the tile the ramp is keyed to
  const p = s.spineAt(0).pos.clone()
  p.set(13500, 0, -3500)
  for (let i = 0; i < 60; i++) {
    s.updateNear(p, performance.now() / 1000 + i)
    await new Promise((r) => setTimeout(r, 120))
  }
  const C = { x: 12654.3, z: -3955.0 }

  // find the worst wall in a 60 m box: where the nearest road is far above the lowest covering one
  let worst = null
  for (let dx = -30; dx <= 30; dx += 0.5) {
    for (let dz = -30; dz <= 30; dz += 0.5) {
      const x = C.x + dx, z = C.z + dz
      const g = s.groundAt(x, z)
      const pg = s.physGroundAt(x, z)
      if (g === null || pg === null) continue
      if (g - pg > 0.5 && (!worst || g - pg > worst.gap)) worst = { x, z, gap: +(g - pg).toFixed(2), nearest: +g.toFixed(2), lowest: +pg.toFixed(2) }
    }
  }
  if (!worst) return { noCrossing: true, levels: s.edgeLevels(C.x, C.z) }

  // build the heightfield and decks around it, then ask the SOLID ground what is there
  for (let i = 0; i < 80; i++) ph.update({ x: C.x, y: 0, z: C.z }, 1 / 60)
  const solid = ph.groundUnder(worst.x, worst.z)
  const decks = s.decksNear(C.x, C.z, 170).map((d) => {
    let hi = -Infinity
    for (let i = 2; i < d.positions.length; i += 3) hi = Math.max(hi, d.positions[i])
    return { key: d.key, tris: d.indices.length / 3, hi: +hi.toFixed(2) }
  })
  return { worst, solid: solid === null ? null : +solid.toFixed(2), decks, levels: s.edgeLevels(worst.x, worst.z).map((l) => [+l.y.toFixed(2), l.who]) }
})
await browser.close()

if (result.noCrossing) {
  console.log(`ok — no grade-separated crossing found near the probe point (levels: ${JSON.stringify(result.levels)})`)
  process.exit(0)
}
console.log(JSON.stringify(result, null, 1))

const fail = []
const { worst, solid, decks } = result
if (worst.gap < 3) fail.push(`found only a ${worst.gap} m step; expected a real grade separation`)
if (solid === null) fail.push('no solid ground under the crossing')
else if (Math.abs(solid - worst.lowest) > 0.5) fail.push(`the solid ground is ${solid} m, not the low road ${worst.lowest} m — a wall of ${(solid - worst.lowest).toFixed(2)} m`)
if (!decks.some((d) => d.hi > 40)) fail.push(`no elevated deck collider near the crossing (decks: ${JSON.stringify(decks)})`)
if (fail.length) {
  for (const f of fail) console.error('FAIL', f)
  process.exit(1)
}
console.log(`ok — ${worst.gap} m of ambiguity at (${worst.x.toFixed(0)}, ${worst.z.toFixed(0)}) resolved: solid ${solid} m follows the low road, deck carries ${decks.filter((d) => d.hi > 40).map((d) => d.key).join(',')}`)
