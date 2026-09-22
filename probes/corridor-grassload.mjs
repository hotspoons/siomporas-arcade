// Frame cost as a function of how many blades we hand the renderer.
//
//   PORT=5201 SLUG=bowie-racetrack-rd node probes/corridor-grassload.mjs
//
// The camera stands still on the road; the only thing that changes between steps is the LOD
// density, so the only thing that changes is the instance count. Everything else in the frame —
// terrain, imagery, trees, impostors, structures, horizon — is identical. The curve this prints
// is therefore the grass's own cost, measured rather than reasoned about.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const N = Number(process.env.N ?? 5)
const STEPS = (process.env.STEPS ?? '0.05,0.15,0.3,0.5,0.75,1').split(',').map(Number)

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 750 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
// the app picks its site from location.hash; a new bake reorders index.json, so assert it
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug && !!window.corridor.site.grass && !!window.corridor.tune, SLUG, { timeout: 300000 })

console.log(JSON.stringify(await page.evaluate(async ({ steps, n }) => {
  const site = window.corridor.site, grass = site.grass, tune = window.corridor.tune, camera = window.corridor.camera
  const p = site.spineAt(site.manifest.spine.photo_s)
  camera.position.set(p.pos.x, p.pos.y + 1.6, p.pos.z)
  camera.lookAt(p.pos.x + p.dir.x * 60, p.pos.y + 1.2, p.pos.z + p.dir.z * 60)
  const fwd = camera.getWorldDirection(camera.position.clone())
  const midD = tune.get('GRASS_LOD_MID_DENSITY'), farD = tune.get('GRASS_LOD_FAR_DENSITY')

  const frames = (k) => new Promise((resolve) => {
    const out = []
    let last = performance.now(), i = 0
    const tick = () => {
      const t = performance.now()
      out.push(t - last)
      last = t
      if (++i >= k + 2) return resolve(out.slice(2)) // the first two carry the knob change
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[s.length >> 1]) }

  const rows = []
  for (const d of steps) {
    tune.set('GRASS_LOD_MID_DENSITY', midD * d)
    tune.set('GRASS_LOD_FAR_DENSITY', farD * d)
    // retune() emptied the cache; refill it synchronously so the timed frames do no generation
    let guard = 0
    do { grass.update(camera.position, fwd, 0) } while (grass.counts.pending > 0 && ++guard < 6000)
    const ms = med(await frames(n))
    rows.push({ density: +d.toFixed(2), blades: grass.counts.blades, cards: grass.counts.cards, triangles: grass.perf.triangles, frame_ms: ms })
  }
  tune.set('GRASS_LOD_MID_DENSITY', midD)
  tune.set('GRASS_LOD_FAR_DENSITY', farD)
  return { site: site.manifest.slug, viewport: [innerWidth, innerHeight], frames_each: n, rows }
}, { steps: STEPS, n: N })))
await browser.close()
