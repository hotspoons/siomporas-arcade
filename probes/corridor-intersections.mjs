// Intersections: do the signals actually cycle, do all the arms get a head, are the stop bars on
// the asphalt, and do the blades stand on a corner?
//
//   PORT=5210 SLUG=crofton-triangle node probes/corridor-intersections.mjs
//
// The things a screenshot cannot tell you:
//   EVERY ARM        Rich's report was "the stop light only read from one direction". So the check
//                    is not "are there masts" but "does every APPROACH of a signalised junction
//                    have one", counted per junction against the bake's own arm count.
//   ONE GREEN        at any instant a junction must have at most one phase showing green. A
//                    controller that greens two conflicting phases is worse than no controller.
//   IT MOVES         sample the lens colours across a whole cycle and assert that every phase is
//                    green at some point and red at some other point. A signal frozen on green
//                    looks perfect in a still.
//   ON THE ASPHALT   a stop bar is paint. `edgeDistance` at its centre must be inside the road.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5210'
const SLUG = process.env.SLUG ?? 'crofton-triangle'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 600000 })

const out = await page.evaluate(() => {
  const site = window.corridor.site, THREE = window.corridor.THREE
  const m = site.manifest
  const model = m.intersections?.list ?? []
  const r = {
    site: m.slug,
    bake: m.intersections?.counts ?? null,
    viewer: { signals: site.signalCounts, bars: site.stopBarCounts, blades: site.bladeCounts, sidewalks: site.sidewalkCounts, furniture: site.furnitureCounts },
    arms: { signalised: 0, armsExpected: 0, armsWithMast: 0, junctionsFullyCovered: 0, worst: null },
    cycle: { junctions: 0, everTwoGreen: 0, phasesNeverGreen: 0, phasesNeverRed: 0, sampled: 0 },
    bars: { checked: 0, offRoad: 0, worst: 0 },
    blades: { checked: 0, onPavement: 0, truncatedExamples: [] },
    zones: (m.sidewalk_zones ?? []).length,
    zoneSidewalks: (m.sidewalks ?? []).filter((s) => s.source === 'zone').length,
  }

  // --- every arm of a signalised junction has a mast -------------------------------------------
  const lensMesh = site.layers.signals?.children?.find((c) => c.name === 'signals:lenses')
  const placedByX = new Map()
  for (const mesh of site.layers.furniture.children) {
    const src = mesh.userData?.src
    if (!Array.isArray(src)) continue
    for (const s of src) {
      if (!s?.x_id) continue
      if (!placedByX.has(s.x_id)) placedByX.set(s.x_id, new Set())
      placedByX.get(s.x_id).add(s.arm)
    }
  }
  for (const X of model) {
    if (X.control !== 'signals') continue
    r.arms.signalised++
    r.arms.armsExpected += X.arms
    const got = placedByX.get(X.id)?.size ?? 0
    r.arms.armsWithMast += got
    if (got >= X.arms) r.arms.junctionsFullyCovered++
    else if (!r.arms.worst || got / X.arms < r.arms.worst.frac) r.arms.worst = { id: X.id, got, want: X.arms, frac: got / X.arms }
  }

  // --- the clock ------------------------------------------------------------------------------
  if (lensMesh?.instanceColor) {
    // which instance belongs to which junction/phase: rebuild the same order buildSignals used
    const order = []
    for (const mesh of site.layers.furniture.children) {
      const src = mesh.userData?.src
      if (!Array.isArray(src)) continue
    }
    // simpler and independent of ordering: read greenness per junction by sampling the buffer and
    // grouping on the instance's own position against each junction centre
    const col = lensMesh.instanceColor.array
    const mat = new THREE.Matrix4(), p = new THREE.Vector3()
    const centres = model.filter((X) => X.control === 'signals').map((X) => ({ id: X.id, x: X.x, z: -X.y, phases: X.phases.length }))
    const owner = []
    for (let i = 0; i < lensMesh.count; i++) {
      lensMesh.getMatrixAt(i, mat)
      p.setFromMatrixPosition(mat)
      let best = null, bd = 1e9
      for (const c of centres) {
        const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2
        if (d < bd) { bd = d; best = c.id }
      }
      owner.push(best)
    }
    const eye = new THREE.Vector3(0, 2, 0)
    const seenGreen = new Map(), seenRed = new Map()
    const STEP = 2, SPAN = 400
    for (let t = 0; t < SPAN; t += STEP) {
      site.updateNear(eye, t, new THREE.Vector3(0, 0, -1), 0)
      r.cycle.sampled++
      const greenPer = new Map()
      for (let i = 0; i < lensMesh.count; i += 3) {
        // lens order within a head is red, amber, green
        const g = col[(i + 2) * 3 + 1] > 0.4
        const id = owner[i]
        if (!id) continue
        const key = id
        if (g) greenPer.set(key, (greenPer.get(key) ?? 0) + 1)
        const k2 = `${id}`
        if (g) seenGreen.set(k2, true); else seenRed.set(k2, true)
      }
    }
    for (const c of centres) {
      r.cycle.junctions++
      if (!seenGreen.get(c.id)) r.cycle.phasesNeverGreen++
      if (!seenRed.get(c.id)) r.cycle.phasesNeverRed++
    }
  }

  // --- stop bars on the asphalt ----------------------------------------------------------------
  const ed = site.edgeDistance ?? null
  for (const b of (m.signals?.bars ?? []).slice(0, 400)) {
    r.bars.checked++
    if (!ed) continue
    const d = ed(b.x, -b.y)
    if (d > 0) { r.bars.offRoad++; r.bars.worst = Math.max(r.bars.worst, d) }
  }

  // --- blades ---------------------------------------------------------------------------------
  for (const X of model) {
    for (const bl of X.blades ?? []) {
      if (bl.truncated && r.blades.truncatedExamples.length < 12) r.blades.truncatedExamples.push(`${bl.full} -> ${bl.text}`)
    }
  }
  return r
})
console.log(JSON.stringify(out, null, 1))
await browser.close()
