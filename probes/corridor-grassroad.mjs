// Is there grass standing on the road?
//
// Rich, 2026-09-27, with two stances: "Found a couple more spots where grass is growing through
// the road. Definitely improved but needs to be solved."
//
// This measures the OUTCOME — where the blades and the sprite cards actually ended up — rather
// than any one of the tests that put them there. Three separate things had to be true for a blade
// to be placed correctly and each failed somewhere:
//
//   1. the road has to be IN the distance field at all. One road on crofton-triangle had stations
//      for the first 272 m of its 2,516 m, because a closure read an array's length when it ran
//      instead of when it was made, so every re-graded branch wrote its length into the LAST
//      branch's slot. The asphalt was drawn in full and the field said "+57 m to the nearest
//      road" while you stood on it. `probes/corridor-fieldcoverage.mjs` now guards that.
//   2. the MASKS — parking, walks, bare ground, paved imagery — have hard edges and no gradient,
//      so stepping to a blade along the geometry's gradient steps straight over them.
//   3. beside a DRIVEWAY the geometry itself bends faster than a straight line can follow.
//
//   PORT=5185 node probes/corridor-grassroad.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const SPOTS = [
  { name: 'Old Willow Way', x: -503.81, z: 1081.39 },
  { name: 'stance B', x: 735.52, z: -2067.48 },
]
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 700, height: 450 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/?lite=1#crofton-triangle`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForTimeout(3000)

const out = await page.evaluate(async (SPOTS) => {
  const site = window.corridor.site
  const THREE = window.corridor.THREE
  const d = (x, z) => site.edgeInfo(x, z, undefined, true).d
  const blocked = (x, z) => site.grassBlocked(x, z)
  const res = []
  for (const s of SPOTS) {
    // stand there and let the grass ring rebuild around the eye
    const eye = new THREE.Vector3(s.x, (site.groundAt(s.x, s.z) ?? 0) + 2, s.z)
    // the ring follows the eye and rebuilds asynchronously; give it frames, not a guess
    for (let k = 0; k < 30; k++) {
      site.updateNear(eye, k * 0.05, new THREE.Vector3(1, 0, 0), 0)
      await new Promise((r) => requestAnimationFrame(r))
    }
    let blades = 0
    let bladesOnRoad = 0
    let cards = 0
    let cardsOnRoad = 0
    let onMask = 0
    let worst = 0
    const eg = []
    window.corridor.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return
      const root = o.geometry.getAttribute('aRoot')
      const card = o.geometry.getAttribute('aCard')
      const a = root ?? card
      if (!a) return
      const n = o.geometry.instanceCount ?? a.count
      for (let i = 0; i < n; i++) {
        const x = a.getX(i)
        const z = a.getZ(i)
        if (Math.hypot(x - s.x, z - s.z) > 90) continue
        const dd = d(x, z)
        if (root) blades++
        else cards++
        if (blocked(x, z)) onMask++
        if (!(dd < 0)) continue
        if (root) bladesOnRoad++
        else cardsOnRoad++
        if (dd < worst) worst = dd
        if (eg.length < 4) eg.push({ kind: root ? 'blade' : 'card', at: [+x.toFixed(1), +z.toFixed(1)], d: +dd.toFixed(2) })
      }
    })
    res.push({ spot: s.name, blades, bladesOnRoad, cards, cardsOnRoad, onMask, worstM: +worst.toFixed(2), eg })
  }
  // CONTROL: the field and the mask must each be able to answer both ways near these spots,
  // or a clean result means only that the instrument is dead.
  const control = SPOTS.map((s) => {
    let on = 0, off = 0, blk = 0, clr = 0
    for (let k = 0; k < 400; k++) {
      const x = s.x + (Math.random() - 0.5) * 120, z = s.z + (Math.random() - 0.5) * 120
      d(x, z) < 0 ? on++ : off++
      blocked(x, z) ? blk++ : clr++
    }
    return { spot: s.name, onRoad: on, offRoad: off, masked: blk, clear: clr }
  })
  return { res, control }
}, SPOTS)
console.log(JSON.stringify(out, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
const total = out.res.reduce((a, r) => a + r.blades + r.cards, 0)
const onRoad = out.res.reduce((a, r) => a + r.bladesOnRoad + r.cardsOnRoad, 0)
const anyOn = out.control.reduce((a, c) => a + c.onRoad, 0)
const anyMasked = out.control.reduce((a, c) => a + c.masked, 0)
const worst = Math.min(...out.res.map((r) => r.worstM))
const onMaskTotal = out.res.reduce((a, r) => a + r.onMask, 0)
const emptySpot = out.res.find((r) => r.blades + r.cards === 0)
if (!total) fail('no grass was found at either spot — nothing was measured')
// a spot with no grass in it was not measured, and a pass that includes it is a pass about nothing
else if (emptySpot) fail(`no grass was built at "${emptySpot.spot}" — that spot was not measured, so this run cannot clear it`)
else if (!(anyOn > 0)) fail('the field never reports pavement around these spots, so a clean result would mean nothing')
else if (!(anyMasked > 0)) fail('the mask never reports a blocked point around these spots, so it cannot distinguish anything')
/*
 * A HARD ZERO, near enough.
 *
 * This was 2 per cent, and a build with both new checks switched off measured 1,657 masked roots
 * of 85,405 — 1.9 per cent — and PASSED. A threshold loose enough to admit the bug it was written
 * for is not a threshold. With the checks on it is exactly zero.
 *
 * This is also the assertion that catches what Rich actually sees. A driveway is not a
 * carriageway, so grass on a driveway apron reads as "off the road" to the check below while
 * looking exactly like grass growing through pavement. The masks know about aprons; `roadsOnly`
 * does not.
 */
else if (onMaskTotal > Math.max(4, total * 0.0005)) fail(`${onMaskTotal} of ${total} grass roots (${((onMaskTotal / total) * 100).toFixed(2)}%) stand where a mask says nothing grows — parking, a walk, a driveway apron, bare ground or paved imagery`)
else if (onRoad > 0) fail(`${onRoad} of ${total} grass roots stand on a carriageway, worst ${Math.abs(worst)} m past the kerb: ${JSON.stringify(out.res.flatMap((r) => r.eg).slice(0, 2))}`)
else console.log(`PASS: ${total} grass roots within 90 m of the two spots Rich sent, none on a carriageway and ${onMaskTotal} on masked ground`)
