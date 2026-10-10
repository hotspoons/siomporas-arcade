// Is there concrete out on the road?
//
// Rich, 2026-09-27: "sidewalks rendering over streets, in this case 3 sidewalks extending over
// streets, probably want to figure this out."
//
// A zone sidewalk is a pure lateral offset of one road's centreline, and OSM splits a road at its
// junction nodes — so each way's offset curve ends about six metres out from the junction node,
// which is a point in the MIDDLE of the cross street, and the next way's offset starts there. The
// concrete ran straight across every intersection, on both sides, for both roads.
//
// This walks the built sidewalk geometry and asks the road distance field where each vertex is.
// `edgeDistance` is a NUMBER; `edgeInfo` is the record with `.d` and `.who` — reading `.d` off the
// number returns undefined and every comparison then quietly reports zero offenders, which is how
// this probe first "passed".
//
//   PORT=5185 node probes/corridor-sidewalk-onroad.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 700, height: 450 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForTimeout(4000)

const out = await page.evaluate(() => {
  const site = window.corridor.site
  const THREE = window.corridor.THREE
  const info = site.edgeInfo ? (x, z) => site.edgeInfo(x, z, undefined, true).d : (x, z) => site.edgeDistance(x, z)
  // CONTROL: the field must be able to say both "on the road" and "off it", or a clean result
  // means only that the instrument is dead. Sampling rather than picking two points by hand —
  // a point chosen 40 m off the spine landed on a different road and read as pavement.
  const p = site.spineAt(site.manifest.spine.photo_s).pos
  const bb = site.manifest.bbox
  let neg = 0, pos = 0
  for (let k = 0; k < 400; k++) {
    const x = bb[0] + Math.random() * (bb[2] - bb[0])
    const y = bb[1] + Math.random() * (bb[3] - bb[1])
    const d = info(x, -y)
    if (d < 0) neg++
    else pos++
  }
  const control = { onSpine: +info(p.x, p.z).toFixed(2), sampledOnRoad: neg, sampledOffRoad: pos }

  const v = new THREE.Vector3()
  let verts = 0
  let onRoad = 0
  let worst = 0
  const hist = [0, 0, 0, 0, 0, 0] // 0-.5, .5-1, 1-1.5, 1.5-2, 2-4, >4 m past the kerb
  const examples = []
  window.corridor.scene.traverse((o) => {
    if (!o.isMesh || !/sidewalk:concrete/.test(o.name || '')) return
    const pos = o.geometry.getAttribute('position')
    o.updateMatrixWorld(true)
    for (let i = 0; i < pos.count; i += 3) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)
      verts++
      const d = info(v.x, v.z)
      if (d >= 0) continue
      onRoad++
      hist[d > -0.5 ? 0 : d > -1 ? 1 : d > -1.5 ? 2 : d > -2 ? 3 : d > -4 ? 4 : 5]++
      if (d < worst) {
        worst = d
        if (examples.length < 4) examples.push({ at: [+v.x.toFixed(1), +v.z.toFixed(1)], d: +d.toFixed(2) })
      }
    }
  })
  return { control, verts, onRoad, depthHistogram: { '0-0.5': hist[0], '0.5-1': hist[1], '1-1.5': hist[2], '1.5-2': hist[3], '2-4': hist[4], '>4': hist[5] }, worstPenetrationM: +worst.toFixed(2), examples, counts: site.sidewalkCounts ?? null }
})
console.log(JSON.stringify(out, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
/*
 * WHERE THE LINE IS, and why it is not zero.
 *
 * Two different things put sidewalk concrete on asphalt here and only one of them is a bug:
 *
 *   under ~2.6 m — the walk is running ALONGSIDE its own road and overlapping the shoulder,
 *                  because the bake's lateral offset assumes a kerb the road does not have.
 *                  Measured before any fix: at most 1.70 m at the centreline, plus about 0.9 m
 *                  of half-width at the kerb edge. Visible as a walk on the hard shoulder.
 *   over ~3.6 m  — the walk is running ACROSS a DIFFERENT road. Measured before any fix:
 *                  3.65 m to 8.55 m, and 3.96 m and 6.66 m are exactly half the paved width of
 *                  a kerbed residential street and of Defense Highway. The walk is through the
 *                  geometric centre of the cross street. This is what Rich saw.
 *
 * Nothing was measured between 2.6 and 3.6, so the threshold sits in the gap.
 */
const CLEAR = 3.0
if (!out.verts) fail('no sidewalk geometry was found — nothing was measured')
// the control proves the instrument before the result is believed
else if (!(out.control.onSpine < 0)) fail(`the middle of the spine reads ${out.control.onSpine} — the road distance field is not reporting pavement, so a clean result would mean nothing`)
else if (!(out.control.sampledOnRoad >= 1 && out.control.sampledOffRoad >= 1)) fail(`400 random points gave ${out.control.sampledOnRoad} on-road and ${out.control.sampledOffRoad} off-road — the field only ever gives one answer, so it cannot distinguish anything`)
else if (out.worstPenetrationM < -CLEAR) fail(`sidewalk concrete reaches ${Math.abs(out.worstPenetrationM)} m onto a carriageway (${out.onRoad} of ${out.verts} vertices) — past ${CLEAR} m it is crossing a different road, not overlapping its own shoulder`)
else console.log(`PASS: ${out.verts} sidewalk vertices, ${out.onRoad} touching asphalt, worst ${Math.abs(out.worstPenetrationM)} m — shoulder overlap, no road crossed. ${out.counts?.metres ?? '?'} m of walk kept, ${out.counts?.overRoad ?? '?'} segments dropped.`)
