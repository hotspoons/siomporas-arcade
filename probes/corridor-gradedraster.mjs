// Does the ground the BAKE graded agree with the ground the viewer grades at run time?
//
//   node probes/corridor-gradedraster.mjs <site> [--port 5191] [--compare] [--dump out.json]
//
// The pyramid's fine levels can carry the road grading folded in (tools/corridor/corridor/grade.py
// is scene.ts's `gradedHeight`, ported). On such a bake `physGroundAt` is one bilinear read of the
// raster instead of ~4 µs of station walk and spline per sample. That is only a saving if it is the
// SAME ANSWER, so this measures the difference, per class of ground, over a grid of points on and
// beside every road the site has:
//
//   --compare   load the site twice — `?grade=runtime` (the formula, as an old bake runs it) and
//               plain (the raster) — and report the error distribution of raster − formula, on the
//               pavement, across the verge, beyond it, and on decks. The targets (PERF-RIG.md) are
//               2 cm on the pavement, 10 cm across the verge, zero beyond the verge and on decks.
//   --dump      write the formula's answers (and the bare earth, the edge distance, the level that
//               answered) at every point to a JSON file, so the Python port can be held against the
//               viewer on a bake that was never graded — the cross-check that does not depend on the
//               bake's intermediates matching its served manifest.
//
// THE CONTROL IS THE POINT, as in corridor-physground.mjs: the two loads must also DISAGREE on a
// deliberately shifted sample, or the transect is flat and the agreement is not evidence. Every
// point is sampled only once its leaf tile is resident (the pyramid stream is driven to each region
// and polled for `levelAt === zmax`), because a coarse tile answering would be measuring the LOD,
// not the grading.
//
// STREAM_LOCAL is forced to 0 through the knob store before the page loads: with it on, only the
// kilometre around the start is built at load and a junction whose other road has not arrived has
// no target yet; the bake graded the WHOLE network, so the comparison must too.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const site = args.find((a) => !a.startsWith('--')) ?? 'crofton-triangle'
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const PORT = opt('--port', process.env.CORRIDOR_PORT ?? '5191')
const COMPARE = args.includes('--compare')
const DUMP = opt('--dump', null)
const SHIFT = 12 // m: the control offset
const QUICK = args.includes('--quick') // the spine and a dozen branches: a two-minute look, not the measurement

if (!COMPARE && !DUMP) { console.error('nothing to do: --compare and/or --dump <file>'); process.exit(2) }

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
  const errors = []
  page.on('pageerror', (e) => { errors.push(e.message); console.log('pageerror', e.message) })
  // NOT `page.route('**/@vite/client', abort)`, which the older probes do: under Vite 8 a page whose
  // client import is aborted never evaluates main.ts at all — no error, no fetch, a blank page that
  // times out looking booted-but-slow. Measured 2026-10-09; the client is harmless here.
  // the knob store: every tab's file is applied by name, so one tab is enough (ui/tune.ts restore)
  await page.addInitScript(() => {
    try { localStorage.setItem('apex-corridor-visuals.tune.v1', JSON.stringify({ v: 2, values: { STREAM_LOCAL: 0 }, touched: ['STREAM_LOCAL'] })) } catch {}
  })
  await page.goto(`http://127.0.0.1:${PORT}/#${site}?lite${query}`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 1500000 })
  if (errors.length) throw new Error(`page errors during boot: ${errors.join(' | ')}`)
  return page
}

/**
 * The sample grid, built in the page from the roads the viewer actually holds: along the spine
 * every 60 m and along every branch every 50 m, at lateral offsets that cross the pavement, the
 * 0.6–7 m blend, the rest of the verge, and the ground beyond it. Site frame for `heightAt`
 * (x, north); world frame for `physGroundAt` (x, z = -north).
 */
const buildPoints = (quick) => {
  const site = window.corridor.site
  const pts = []
  const offs = [0, 1.5, -1.5, 3, -3] // on the pavement, plus the lateral steps past its edge below
  const edgeSteps = [0.3, 1, 2, 3.5, 5, 6.5, 8, 11, 15, 25, 38] // metres past the edge: blend, verge
  const beyond = [45, 60] // past VERGE on the primary; past BRANCH_VERGE on a branch
  const chains = site.chains()
  let stride = 50
  for (const c of chains) {
    const isSpine = c.index === 0
    const step = isSpine ? 60 : stride
    if (!isSpine && c.length_m < 80) continue
    if (quick && c.index > 12) break
    for (let s = 20; s < c.length_m - 20; s += step) {
      const st = c.at(s)
      const sx = -st.dir.z, sz = st.dir.x // right of travel, flat
      const n = Math.hypot(sx, sz) || 1
      const push = (lat, kind) => {
        const x = st.pos.x + (sx / n) * lat, z = st.pos.z + (sz / n) * lat
        pts.push({ x: +x.toFixed(3), z: +z.toFixed(3), chain: c.index, s: +s.toFixed(1), lat: +lat.toFixed(2), kind })
      }
      for (const o of offs) if (Math.abs(o) < c.half) push(o, 'pavement')
      for (const sgn of [1, -1]) {
        for (const e of edgeSteps) push(sgn * (c.half + e), e <= 7 ? 'blend' : 'verge')
        for (const b of beyond) push(sgn * (c.half + b), 'beyond')
      }
    }
    // the branches are many: thin the grid as the count grows so a run stays in minutes
    if (pts.length > 60000) stride = 200
  }
  return pts
}

/** Drive the pyramid to each region and sample once the leaf answers under every point there. */
const sampleAll = async (page, pts) => {
  return await page.evaluate(async (pts) => {
    const site = window.corridor.site
    const pyr = site.pyramidStream
    const set = site.pyramidSet
    const zmax = site.manifest.layers.pyramid.zmax
    const cell = 700
    const groups = new Map()
    for (const p of pts) {
      const k = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(p)
    }
    const out = []
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    try { window.corridor.tune.set('PYR_CONE_DEG', 180) } catch {}
    let coarse = 0
    for (const [k, g] of groups) {
      const [cx, cz] = k.split(',').map(Number)
      const ex = cx * cell + cell / 2, ez = cz * cell + cell / 2
      // PARK THE CAMERA over the region, not just the stream's eye: the frame loop re-aims the
      // pyramid at the real camera every frame, so an `update(eye)` from here is overruled a frame
      // later and the far cells never see their leaf. Hovering 60 m up, looking down, the stream's
      // own walk wants the leaves under the view — the way the top view does it.
      // At a driver's height, not from above: a top-down view over a suburb is the draw load
      // that takes swiftshader's tab down (reference-headless-probe-traps), and the stream's own
      // cone is held at its full 180 so the whole half-space ahead is wanted; the camera faces each cell.
      const { camera, orbit } = window.corridor
      const gy = site.heightAt(ex, -ez)
      camera.position.set(ex, gy + 2.5, ez + 12)
      if (orbit) { orbit.target.set(ex, gy + 1, ez); orbit.update?.() }
      camera.lookAt(ex, gy + 1, ez)
      if (pyr) pyr.update(ex, ez, true)
      let ready = false
      for (let i = 0; i < 80 && !ready; i++) {
        ready = g.every((p) => set.levelAt(p.x, -p.z) === zmax)
        if (!ready) await sleep(250)
      }
      for (const p of g) {
        const lvl = set.levelAt(p.x, -p.z)
        if (lvl !== zmax) coarse++
        const e = site.edgeInfo(p.x, p.z)
        const tk = set.tileAt(p.x, -p.z)
        out.push({
          ...p,
          level: lvl,
          tile: tk ? `${tk.z}/${tk.x}/${tk.y}` : null,
          phys: site.physGroundAt(p.x, p.z),
          physShift: site.physGroundAt(p.x + 12, p.z),
          bare: site.bareAt(p.x, -p.z),
          raster: site.heightAt(p.x, -p.z),
          d: +e.d.toFixed(3),
          who: e.who,
          roadY: +e.y.toFixed(3),
        })
      }
    }
    return { out, coarse, gradedBake: site.gradedBake, junctionMeet: site.junctionMeet ?? null, chains: site.chains().length }
  }, pts)
}

const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(4) : null }
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 0.5), p90: pct(xs, 0.9), p99: pct(xs, 0.99), max: xs.length ? +Math.max(...xs).toFixed(4) : null })

const t0 = Date.now()
const pageA = await open('&grade=runtime')
const pts = await pageA.evaluate(buildPoints, QUICK)
console.log(`${site}: ${pts.length} sample points, booted in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
const A = await sampleAll(pageA, pts)
console.log(`runtime: ${A.out.length} sampled, ${A.coarse} answered by a coarse tile; chains ${A.chains}; junctions`, A.junctionMeet)

if (DUMP && !COMPARE) {
  writeFileSync(DUMP, JSON.stringify({ site, points: A.out, junctionMeet: A.junctionMeet, gradedBake: A.gradedBake }))
  console.log(`dumped ${A.out.length} points to ${DUMP}`)
}

let verdict = []
if (COMPARE) {
  const pageB = await open('')
  const B = await sampleAll(pageB, pts)
  console.log(`raster:  ${B.out.length} sampled, ${B.coarse} coarse; gradedBake=${B.gradedBake}`)
  if (DUMP) {
    // both passes, point for point, so the worst can be looked at offline with their tile and road
    writeFileSync(DUMP, JSON.stringify({ site, runtime: A.out, raster: B.out, junctionMeet: A.junctionMeet }))
    console.log(`dumped both passes (${A.out.length} points) to ${DUMP}`)
  }
  if (!B.gradedBake) verdict.push('the plain load did not take the raster path (manifest has no graded flag, or adjustments are active)')
  if (A.gradedBake) verdict.push('`?grade=runtime` did not force the formula')
  // classify each point by what the FORMULA saw: on a deck the raster is the earth by design
  const byClass = {}
  const control = []
  for (let i = 0; i < pts.length; i++) {
    const a = A.out[i], b = B.out[i]
    if (a.level !== b.level || a.level == null) continue
    const deck = a.who >= 0 && a.d < 7 && a.roadY - a.bare > 3.0
    const cls = deck ? 'deck' : a.kind
    const err = b.phys - a.phys
    ;(byClass[cls] ??= []).push(Math.abs(err))
    control.push(Math.abs(b.phys - a.physShift))
  }
  const report = {}
  for (const [k, v] of Object.entries(byClass)) report[k] = stats(v)
  report.control = stats(control)
  console.log(JSON.stringify({ site, points: pts.length, byClass: report }, null, 1))
  const over = (cls, lim) => { const s = byClass[cls]; return s ? s.filter((e) => e > lim).length : 0 }
  if (report.pavement && report.pavement.p99 > 0.02) verdict.push(`pavement p99 ${report.pavement.p99} m > 0.02 (${over('pavement', 0.02)}/${report.pavement.n} over)`)
  if (report.blend && report.blend.p99 > 0.10) verdict.push(`blend p99 ${report.blend.p99} m > 0.10 (${over('blend', 0.10)}/${report.blend.n} over)`)
  if (report.verge && report.verge.p99 > 0.10) verdict.push(`verge p99 ${report.verge.p99} m > 0.10 (${over('verge', 0.10)}/${report.verge.n} over)`)
  if (report.beyond && report.beyond.max > 0.011) verdict.push(`beyond the verge the raster moved: max ${report.beyond.max} m (${over('beyond', 0.011)}/${report.beyond.n} over one DEM count)`)
  if (report.deck && report.deck.max > 0.011) verdict.push(`on a deck the raster moved: max ${report.deck.max} m`)
  if (report.control.p50 !== null && report.control.p50 < 0.05) verdict.push(`the control agrees too (median ${report.control.p50} m): the transect is flat, this proves nothing`)
}

await browser.close()
if (verdict.length) { console.log('FAIL\n  ' + verdict.join('\n  ')); process.exit(1) }
console.log('OK')
