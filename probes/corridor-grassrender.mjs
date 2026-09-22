// What the grass costs the RENDERER, as an A/B: the same frames with the grass shown and hidden.
//
//   PORT=5201 SLUG=bowie-racetrack-rd W=640 H=400 N=6 node probes/corridor-grassrender.mjs
//
// This box has no GPU, so absolute frame time is swiftshader's, not Rich's card's. The DIFFERENCE
// between "grass shown" and "grass hidden" on identical frames is still a real, ordered signal:
// it says what share of the frame the grass geometry is, and it moves the right way when the
// triangle count moves. Keep the viewport at or above 1000 px: main.ts sets LITE below 900, and
// the phone path caps the blades at 90 k and halves the strip's resolution, so a narrow window
// silently measures a different scene.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const W = Number(process.env.W ?? 1000)
const H = Number(process.env.H ?? 700)
const N = Number(process.env.N ?? 6)

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
// the app picks its site from location.hash; a new bake reorders index.json, so assert it
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug && !!window.corridor.site.grass, SLUG, { timeout: 300000 })

console.log(JSON.stringify(await page.evaluate(async ({ n }) => {
  const site = window.corridor.site
  const grass = site.grass
  const camera = window.corridor.camera
  // stand on the road looking down it, the driver's view, and let the cache fill before timing
  const p = site.spineAt(site.manifest.spine.photo_s)
  camera.position.set(p.pos.x, p.pos.y + 1.6, p.pos.z)
  camera.lookAt(p.pos.x + p.dir.x * 60, p.pos.y + 1.2, p.pos.z + p.dir.z * 60)
  const fwd = camera.getWorldDirection(camera.position.clone())
  let guard = 0
  do { grass.update(camera.position, fwd, 0) } while (grass.counts.pending > 0 && ++guard < 4000)

  // time whole frames of the app's own loop; the grass is the only thing that changes between runs
  const timeFrames = () => new Promise((resolve) => {
    const out = []
    let last = performance.now()
    let i = 0
    const tick = () => {
      const t = performance.now()
      out.push(t - last)
      last = t
      if (++i >= n + 1) return resolve(out.slice(1)) // drop the frame the toggle landed in
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[s.length >> 1]) }
  grass.mesh.visible = true
  const on = await timeFrames()
  const tri = grass.perf.triangles
  const counts = grass.counts
  grass.mesh.visible = false
  const off = await timeFrames()
  grass.mesh.visible = true

  return {
    site: site.manifest.slug,
    viewport: [innerWidth, innerHeight],
    frames_each: n,
    grass_shown_ms: med(on),
    grass_hidden_ms: med(off),
    grass_share_ms: med(on) - med(off),
    grass_share_pct: Math.round(((med(on) - med(off)) / med(on)) * 100),
    blades: counts.blades,
    cards: counts.cards,
    grass_triangles: tri,
    ms_per_million_triangles: Math.round((med(on) - med(off)) / (tri / 1e6)),
  }
}, { n: N })))
await browser.close()
