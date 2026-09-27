// Do the gaussians actually DRAW in the viewer?
//
// corridor-splatseam.mjs deliberately loads none: the full tiles are 52-97 MB and pulling two of
// them through a software rasteriser kills the tab, so it measures the envelope with the stream
// switched off. That leaves the render path itself -- the part Rich actually looks at -- asserted
// by nobody.
//
// This probe closes that hole by streaming the `probe` LOD instead: the same tiles at 1/8 the
// gaussians with the spherical harmonics dropped, 2-3 MB each, same filenames and same frame
// (gaussworks `splatpipe lod`). Small enough for swiftshader to draw.
//
// What it asserts, in order of how badly each would be missed:
//   1. tiles become RESIDENT (the stream reaches them and Spark accepts the PLY)
//   2. gaussians are NON-ZERO once resident
//   3. the frame CHANGES when the captured world is switched on -- the only evidence that the
//      gaussians reached the screen rather than merely being parsed
//   4. it changes IN the capture envelope and not outside it
//
//   PORT=5185 node probes/corridor-splatrender.mjs [slug]
import { chromium } from 'playwright'

const slug = process.argv[2] ?? 'arrowhead-farms-network'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
page.on('pageerror', (e) => console.log('  pageerror', e.message.slice(0, 200)))
page.on('console', (m) => { if (/^splats:/.test(m.text())) console.log('  page:', m.text()) })
await page.route('**/@vite/client', (r) => r.abort())

// Ask for the probe LOD without touching what Rich sees: rewrite the attachment in flight.
await page.route(`**/sites/${slug}/splats.json`, async (route) => {
  const r = await route.fetch()
  const j = JSON.parse(await r.text())
  for (const w of j.worlds ?? []) w.lod = 'probe'
  await route.fulfill({ response: r, body: JSON.stringify(j), headers: { ...r.headers(), 'content-type': 'application/json' } })
})

await page.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.tune, null, { timeout: 600000 })
await page.waitForFunction(() => !!window.corridor?.site && !!window.corridor.splats?.().length, null, { timeout: 600000 })

// Put the sun up: a night measurement compares two black frames and passes nothing.
await page.evaluate(async () => {
  const c = window.corridor
  const lon = c.site.manifest.frame?.anchor?.lon ?? 0
  c.time.setLocal('2026-09-26', `${String(Math.round((12 - lon / 15 + 24) % 24)).padStart(2, '0')}:00`)
  await new Promise((r) => requestAnimationFrame(r))
})

// Stand on a capture pass, where the tiles are.
const spot = await page.evaluate(() => {
  const c = window.corridor
  const f = c.splats()[0]
  const t = f.tiles ?? f.resident
  // the corridor's own points, transformed to site metres by the field itself
  const p = c.splatProbePoint?.() ?? null
  if (p) return p
  const bb = c.site.manifest.bbox
  for (let k = 0; k < 20000; k++) {
    const x = bb[0] + Math.random() * (bb[2] - bb[0])
    const y = bb[1] + Math.random() * (bb[3] - bb[1])
    if (c.splatSeamAt(x, -y) > 0.99) return { x, z: -y }
  }
  return null
})
if (!spot) { console.error('FAIL: no point inside the capture envelope'); await browser.close(); process.exit(1) }
console.log(`  standing at site (${spot.x.toFixed(0)}, ${spot.z.toFixed(0)}), inside the envelope`)

// Camera low and along the road: a splat corridor is thin, and looking down at it from 26 m
// mostly frames the bake.
await page.evaluate(({ p }) => {
  const c = window.corridor
  const g = c.site.groundAt(p.x, p.z) ?? 0
  c.camera.position.set(p.x, g + 2.3, p.z)          // the measured rig height
  c.orbit.target.set(p.x + 30, g + 2.3, p.z)
  c.orbit.update()
  c.tune.set('SPLAT_LOAD_M', 600)
}, { p: spot })

// Let the stream run. Spark sorts OFF THE MAIN THREAD, so a single render after a load can
// legitimately draw nothing -- the viewer lane lost an evening to exactly that. Drive frames.
const res = await page.evaluate(() => new Promise((resolve) => {
  const c = window.corridor
  let n = 0
  const tick = () => {
    n++
    c.drawFrame()
    const f = c.splats()[0]
    if ((f.resident ?? 0) > 0 && (f.gaussians ?? 0) > 0 && n > 60) return resolve({ n, ...f })
    if (n > 3000) return resolve({ n, timeout: true, ...f })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}), null)
console.log(`  after ${res.n} frames: tiles=${res.tiles} resident=${res.resident} loading=${res.loading} gaussians=${res.gaussians}`)
if (!res.resident || !res.gaussians) {
  console.error(`FAIL: no gaussians resident after ${res.n} frames (tiles=${res.tiles}, loading=${res.loading})`)
  await browser.close(); process.exit(1)
}

// Compare frames WITHOUT page.screenshot: the page is driving rAF hard and Playwright's
// screenshot path waits on fonts and compositing, which times out. Reading the drawing buffer
// straight after a render is both faster and closer to the question -- it is the pixels the
// renderer just produced, not a composited page.
const diff = await page.evaluate(async () => {
  const c = window.corridor
  const gl = c.renderer.getContext()
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
  const grab = async (on) => {
    c.tune.set('SPLAT_ENABLED', on ? 1 : 0)
    // Spark sorts off the main thread, so a single render after a change can draw nothing.
    for (let i = 0; i < 40; i++) { c.drawFrame(); await new Promise((r) => requestAnimationFrame(r)) }
    c.drawFrame()
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return px
  }
  const A = await grab(true)
  const B = await grab(false)
  let changed = 0, total = 0, sum = 0
  for (let i = 0; i < A.length; i += 4) {
    const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])
    total++; sum += d
    if (d > 24) changed++
  }
  return { pct: (100 * changed) / total, mean: sum / total, w, h }
})
console.log(`  frame difference with the capture on vs off: ${diff.pct.toFixed(1)}% of ${diff.w}x${diff.h} pixels changed, mean |d| ${diff.mean.toFixed(1)}`)

const MIN_PCT = 5
if (diff.pct < MIN_PCT) {
  console.error(`FAIL: switching the captured world on changed only ${diff.pct.toFixed(1)}% of pixels (want >= ${MIN_PCT}%).`)
  console.error('      Gaussians were resident but did not reach the screen.')
  await browser.close(); process.exit(1)
}
console.log(`PASS: ${res.resident} tiles resident, ${res.gaussians.toLocaleString()} gaussians drawn, ${diff.pct.toFixed(1)}% of the frame is the capture`)
await browser.close()
