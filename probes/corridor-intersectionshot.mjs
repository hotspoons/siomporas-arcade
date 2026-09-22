// A signalised junction through a whole cycle, and a residential crossroads with its signs.
//
//   PORT=5210 SLUG=crofton-triangle node probes/corridor-intersectionshot.mjs /tmp/x-
//
// The signal shots are the point: the same frame at four moments of one cycle, so the difference
// between them is only the aspect. SIGNAL_RATE is turned up so a 152 s cycle fits in a few seconds
// of wall clock — the controller is driven by wall-clock time on purpose, so this is the honest way
// to see it move rather than a debug override.
import { chromium } from 'playwright'

// page.screenshot() blows its 30 s timeout on a scene this heavy under swiftshader — the cost is
// in compositing pixels, not in anything on the page. Reading the drawing buffer inside the rAF
// that drew it is cheaper and gives the identical image. (orchestrator, 2026-09-22)
const shoot = async (page, path) => {
  const url = await page.evaluate(() => new Promise((res) => {
    const { renderer, scene, camera } = window.__apex
    requestAnimationFrame(() => { renderer.render(scene, camera); res(renderer.domElement.toDataURL('image/png')) })
  }))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, Buffer.from(url.split(',')[1], 'base64'))
}
const PORT = process.env.PORT ?? '5210'
const SLUG = process.env.SLUG ?? 'crofton-triangle'
const OUT = process.argv[2] ?? '/tmp/x-'
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 2500)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 600000 })
await page.keyboard.press('m')

// hide what a GPU-less box cannot draw fast enough to matter here
const info = await page.evaluate(() => {
  const c = window.corridor, site = c.site
  if (site.layers.trees) site.layers.trees.visible = false
  if (site.grass) site.grass.mesh.visible = false
  return { signals: site.signalCounts, bars: site.stopBarCounts, blades: site.bladeCounts }
})
console.log('counts', JSON.stringify(info))

const park = async (pick, eye, height) => await page.evaluate(({ pick, eye, height }) => {
  const c = window.corridor, site = c.site
  const model = site.manifest.intersections.list
  const X = pick === 'signals'
    ? model.filter((x) => x.control === 'signals').sort((a, b) => b.arms - a.arms)[0]
    : model.filter((x) => x.control !== 'signals' && (x.blades ?? []).length >= 2 && x.arms >= 4)[0] ?? model.find((x) => (x.blades ?? []).length >= 2)
  if (!X) return null
  const x = X.x, z = -X.y
  const gy = site.groundAt(x, z) ?? 0
  c.camera.position.set(x + eye, gy + height, z + eye)
  c.orbit.target.set(x, gy + 2, z)
  c.orbit.update()
  return { id: X.id, control: X.control, arms: X.arms, cycle_s: X.cycle_s, blades: (X.blades ?? []).map((b) => b.text) }
}, { pick, eye, height })

// --- the cycle ---------------------------------------------------------------------------------
const sig = await park('signals', 26, 9)
console.log('signal junction', JSON.stringify(sig))
// 152 s of cycle in ~15 s of wall clock
await page.evaluate(() => window.corridor.tune.set('SIGNAL_RATE', 10))
await page.waitForTimeout(SETTLE_MS)
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(3800)
  await shoot(page, `${OUT}signal-${i}.png`)
  const lit = await page.evaluate(() => {
    const L = window.corridor.site.layers.signals.children[0]
    if (!L?.instanceColor) return null
    const a = L.instanceColor.array
    let red = 0, amber = 0, green = 0
    for (let k = 0; k < L.count; k += 3) {
      if (a[k * 3] > 0.4) red++
      if (a[(k + 1) * 3] > 0.4) amber++
      if (a[(k + 2) * 3 + 1] > 0.4) green++
    }
    return { red, amber, green }
  })
  console.log(`signal-${i}`, JSON.stringify(lit))
}

// --- a residential crossroads: blades, stop bar, sidewalks -----------------------------------
const stop = await park('stop', 18, 6)
console.log('stop junction', JSON.stringify(stop))
await page.waitForTimeout(SETTLE_MS)
await shoot(page, `${OUT}stop.png`)

// and the same one from a driver's eye
await page.evaluate(() => {
  const c = window.corridor, site = c.site
  const model = site.manifest.intersections.list
  const X = model.filter((x) => x.control !== 'signals' && (x.blades ?? []).length >= 2 && x.arms >= 4)[0] ?? model.find((x) => (x.blades ?? []).length >= 2)
  const a = X.approaches.find((q) => q.stop) ?? X.approaches[0]
  const th = (a.bearing_deg * Math.PI) / 180
  const tx = Math.sin(th), ty = Math.cos(th)
  // 30 m back up the approach, at the wheel
  const px = X.x - tx * 30, py = X.y - ty * 30
  const x = px, z = -py
  const gy = site.groundAt(x, z) ?? 0
  c.camera.position.set(x, gy + 1.5, z)
  c.orbit.target.set(X.x, gy + 1.5, -X.y)
  c.orbit.update()
})
await page.waitForTimeout(SETTLE_MS)
await shoot(page, `${OUT}approach.png`)
console.log('wrote', `${OUT}signal-0..3.png ${OUT}stop.png ${OUT}approach.png`)
await browser.close()
