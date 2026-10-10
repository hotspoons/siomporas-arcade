// Is the vegetation grid sampled where it actually lies?
//
// The LANDFIRE EVT grid picks the species mix for every tree. It was indexed by interpolating
// `layers.flora.bbox`, and a raster cannot be SAMPLED from its bounding box any more than it can
// be placed from one: the grid's own axes are UTM zone 18N, 1.06 degrees off the ENU true north
// the coordinates are in, so the bbox is the axis-aligned box AROUND a rotated rectangle. Zero
// error at the site centre, about 158 m at the corners — a tree near the edge of the site picking
// its neighbour's mix.
//
// THE DANGER IN FIXING IT is the row order, because getting that backwards flips every species
// mix on the site and still looks plausible. The two ends genuinely disagree: the control lattice
// runs south to north, so RasterFrame's `v` is 0 at the SOUTH, while the PNG is written unflipped
// from a north-up GeoTIFF, so its row 0 is the NORTH.
//
// So this probe does not check the arithmetic against itself, and it does not settle the question
// with a threshold either. It uses an INDEPENDENT fact — the bake writes 255 for every pixel
// outside the corridor polygon, and the corridor polygon is the road network — and it SCORES ALL
// FOUR conventions against it: stand on a road and the grid must know you are inside the
// corridor; stand a kilometre and a half from any road and it must say you are outside. Then it
// asserts that the one the code actually uses is the best of them. Reading the two ends of the
// pipeline argued for a vertical flip and the argument was wrong; the data was not.
//
//   PORT=5185 node probes/corridor-flora-registration.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 700, height: 450 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForTimeout(3000)

const out = await page.evaluate(() => {
  const site = window.corridor.site
  const m = site.manifest
  // `canopyAt` is fed by the CHM, not the EVT; the EVT class is what picks the mix, and the
  // viewer exposes it through the site's flora
  const fl = site.flora
  if (!fl || !fl.at) return { error: 'this site has no flora block' }
  const at = (x, y) => fl.at(x, y)

  // ON the corridor: the spine's own centreline, end to end
  let onN = 0
  let onKnown = 0
  const L = m.spine.length_m
  for (let s = 0; s <= L; s += Math.max(20, L / 120)) {
    const p = site.spineAt(s).pos
    onN++
    if (at(p.x, -p.z)) onKnown++
  }
  // OFF it: points at least 1.5 km from every road, which on this site is deep country
  let offN = 0
  let offKnown = 0
  const bb = m.bbox
  for (let k = 0; k < 600 && offN < 120; k++) {
    const x = bb[0] + Math.random() * (bb[2] - bb[0])
    const y = bb[1] + Math.random() * (bb[3] - bb[1])
    const d = site.edgeInfo(x, -y).d
    if (!(d > 1500)) continue
    offN++
    if (at(x, y)) offKnown++
  }
  /*
   * WHICH ORIENTATION IS RIGHT, decided by the corridor mask rather than by reasoning.
   *
   * The bake sets every pixel outside the corridor polygon to 255, and the corridor polygon is
   * the road network. So the correct convention is the one that says "inside" along the spine and
   * "outside" a kilometre and a half from any road. Four candidates are scored, plus the old
   * bounding-box indexing for comparison, and the numbers are printed so the choice is visible
   * rather than asserted.
   */
  const spine = []
  for (let s = 0; s <= L; s += Math.max(20, L / 120)) { const p = site.spineAt(s).pos; spine.push([p.x, -p.z]) }
  const far = []
  for (let k = 0; k < 4000 && far.length < 120; k++) {
    const x = bb[0] + Math.random() * (bb[2] - bb[0])
    const y = bb[1] + Math.random() * (bb[3] - bb[1])
    if (site.edgeInfo(x, -y).d > 1500) far.push([x, y])
  }
  const score = (fn) => {
    let on = 0, off = 0
    for (const [x, y] of spine) if (fn(x, y)) on++
    for (const [x, y] of far) if (fn(x, y)) off++
    return { onPct: +((on / Math.max(1, spine.length)) * 100).toFixed(0), offPct: +((off / Math.max(1, far.length)) * 100).toFixed(0) }
  }
  const byCell = (viaBbox, flipV, flipU) => (x, y) => fl.classOfCell(fl.cellAt(x, y, viaBbox, flipV, flipU))
  const options = {
    'lattice v (no flip)': score(byCell(false, false, false)),
    'lattice 1-v': score(byCell(false, true, false)),
    'lattice 1-v, 1-u': score(byCell(false, true, true)),
    'lattice v, 1-u': score(byCell(false, false, true)),
    'bounding box (old)': score(byCell(true, false, false)),
  }
  let oldDiff = 0
  let cmp = 0
  for (const [x, y] of spine) {
    const a = fl.cellAt(x, y, false)
    const b = fl.cellAt(x, y, true)
    if (a === null || b === null) continue
    cmp++
    if (a !== b) oldDiff++
  }
  return { onN, onKnown, offN, offKnown, cmp, oldDiff, options, spineN: spine.length, farN: far.length, gridSize: m.layers.flora?.size ?? null }
})
console.log(JSON.stringify(out, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (out.error) fail(out.error)
else if (!out.onN) fail('no spine points sampled — nothing was measured')
else if (!out.offN) fail('found no point 1.5 km from every road on this site, so the negative half of the test never ran')
// the corridor mask: on the road, the grid must know where it is
else if (!(out.onKnown > out.onN * 0.95)) fail(`the vegetation grid claims ${out.onN - out.onKnown} of ${out.onN} points on the spine's own centreline are OUTSIDE the corridor it was cut to — the grid is being sampled in the wrong place`)
else {
  // the live convention must beat every alternative on BOTH measures, or the orientation is wrong
  const live = out.options['lattice v (no flip)']
  const rivals = Object.entries(out.options).filter(([k]) => k !== 'lattice v (no flip)' && k !== 'bounding box (old)')
  const beaten = rivals.filter(([, r]) => r.onPct > live.onPct || r.offPct < live.offPct)
  // liveness: the fix must actually have moved something, or it is untested
  if (!(out.oldDiff > out.cmp * 0.5)) fail(`only ${out.oldDiff} of ${out.cmp} spine samples land in a different cell than the old bounding-box indexing — the fix changed almost nothing, so this run does not test it`)
  else if (beaten.length) fail(`a different orientation scores better than the one the code uses (${JSON.stringify(live)}): ${beaten.map(([k, r]) => `${k} ${JSON.stringify(r)}`).join('; ')}`)
  else console.log(`PASS: ${live.onPct}% of spine points inside the corridor mask, ${live.offPct}% of points 1.5 km away — the best of ${Object.keys(out.options).length} orientations tried. ${out.oldDiff} of ${out.cmp} samples moved cell from the old bounding-box indexing.`)
}
