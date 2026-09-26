// A LOOK at the intersection furniture on a box with no GPU.
//
//   PORT=5210 SLUG=crofton-triangle node probes/corridor-intersectionshot-lite.mjs /tmp/x-
//
// `corridor-intersectionshot.mjs` is the real one and it needs a real GPU: a full crofton-triangle
// frame is past swiftshader's cliff and `page.screenshot` times out at 30 s. This one strips the
// scene to the things this lane builds — the road, the masts, the lenses, the bars, the blades —
// and shoots small. It is not a pretty picture and it is not meant to be. It is here to answer the
// questions counts cannot: are the lenses ON the heads, is the bar ACROSS the lane and not along
// it, are the blades above the ground and the right way up.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5210'
const SLUG = process.env.SLUG ?? 'crofton-triangle'
const OUT = process.argv[2] ?? '/tmp/xlite-'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 600000 })
await page.keyboard.press('m')

// everything this lane did not build, off. 240 km of sidewalk and 12 000 parking stalls are what
// put the frame past the cliff, and none of it is what I need to look at.
console.log(await page.evaluate(() => {
  const site = window.corridor.site, L = site.layers
  for (const k of ['trees', 'grass', 'crops', 'buildings', 'parking', 'barriers', 'sidewalks', 'power', 'rocks', 'water', 'horizon', 'structures', 'placements', 'markers', 'spine']) {
    if (L[k]) L[k].visible = false
  }
  if (site.grass) site.grass.mesh.visible = false
  return JSON.stringify({ stripped: true, junctionPaint: site.junctionPaint ?? null })
}))

const shoot = async (name, fn) => {
  const meta = await page.evaluate(fn)
  if (!meta) return console.log(name, 'SKIPPED — nothing to look at')
  await page.waitForTimeout(2500)
  try {
    await page.screenshot({ path: `${OUT}${name}.png`, timeout: 120000 })
    console.log(name, JSON.stringify(meta))
  } catch (e) {
    console.log(name, 'screenshot failed:', e.message.split('\n')[0])
  }
}

// 1. the busiest signalised junction, close in on the mast heads
await shoot('signal', () => {
  const c = window.corridor, site = c.site
  const X = site.manifest.intersections.list.filter((q) => q.control === 'signals').sort((a, b) => b.arms - a.arms)[0]
  if (!X) return null
  const gy = site.groundAt(X.x, -X.y) ?? 0
  c.camera.position.set(X.x + 15, gy + 7, -X.y + 15)
  c.orbit.target.set(X.x, gy + 5, -X.y)
  c.orbit.update()
  return { id: X.id, arms: X.arms, cycle_s: X.cycle_s, blades: (X.blades ?? []).map((b) => b.text) }
})

// 2. the same junction a whole cycle later, so the aspects differ
await page.evaluate(() => window.corridor.tune.set('SIGNAL_RATE', 12))
await shoot('signal-later', () => {
  const L = window.corridor.site.layers.signals.children[0]
  if (!L?.instanceColor) return null
  const a = L.instanceColor.array
  let red = 0, amber = 0, green = 0
  for (let k = 0; k < L.count; k += 3) {
    if (a[k * 3] > 0.4) red++
    if (a[(k + 1) * 3] > 0.4) amber++
    if (a[(k + 2) * 3 + 1] > 0.4) green++
  }
  return { lit: { red, amber, green } }
})

// 3. a residential crossroads with a stop bar and two blades, from a driver's eye
await shoot('approach', () => {
  const c = window.corridor, site = c.site
  const model = site.manifest.intersections.list
  const X = model.find((q) => q.control !== 'signals' && (q.blades ?? []).length >= 2 && q.arms >= 4 && q.approaches.some((a) => a.stop)) ?? model.find((q) => (q.blades ?? []).length >= 2)
  if (!X) return null
  const a = X.approaches.find((q) => q.stop) ?? X.approaches[0]
  const th = (a.bearing_deg * Math.PI) / 180
  const BACK = Number(window.__back ?? 13)
  const px = X.x - Math.sin(th) * BACK, py = X.y - Math.cos(th) * BACK
  const gy = site.groundAt(px, -py) ?? 0
  c.camera.position.set(px, gy + 1.6, -py)
  c.orbit.target.set(X.x, gy + 1.8, -X.y)
  c.orbit.update()
  return { id: X.id, control: X.control, arms: X.arms, stopping: X.approaches.filter((q) => q.stop).map((q) => q.name), blades: X.blades.map((b) => b.text) }
})

// 4. straight down on the same crossroads: is the bar ACROSS the lane?
await shoot('plan', () => {
  const c = window.corridor, site = c.site
  const model = site.manifest.intersections.list
  const X = model.find((q) => q.control !== 'signals' && (q.blades ?? []).length >= 2 && q.arms >= 4 && q.approaches.some((a) => a.stop)) ?? model.find((q) => (q.blades ?? []).length >= 2)
  if (!X) return null
  const gy = site.groundAt(X.x, -X.y) ?? 0
  c.camera.position.set(X.x + 0.01, gy + 42, -X.y + 0.01)
  c.orbit.target.set(X.x, gy, -X.y)
  c.orbit.update()
  return { id: X.id, view: 'plan 42 m' }
})
await browser.close()
