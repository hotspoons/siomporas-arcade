// What a tuning-panel knob costs. Rich drives with F6 open, so a slider that throws the tile cache
// away is three seconds of grass growing back in every time he nudges it.
//
//   PORT=5201 SLUG=bowie-racetrack-rd node probes/corridor-grasstune.mjs
//
// For each knob: set it, then count how many update() calls it takes before the queue is empty
// again. A knob that only feeds a uniform or the LOD prefix should cost 0.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const KNOBS = (process.env.KNOBS ?? 'GRASS_HUE,GRASS_SAT,GRASS_LIGHT,GRASS_DRY_ADD,GRASS_WIND,GRASS_SPRITE_WIDTH,GRASS_SPRITE_LEAN,GRASS_LOD_MID_DENSITY,GRASS_LOD_FAR_DENSITY,GRASS_ROUGH_PER_M2,GRASS_MOW_LINE,GRASS_ROUGH_HEIGHT').split(',')
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug && !!window.corridor.site.grass, SLUG, { timeout: 300000 })
console.log(JSON.stringify(await page.evaluate(async ({ knobs }) => {
  const site = window.corridor.site, grass = site.grass, tune = window.corridor.tune, camera = window.corridor.camera
  const p = site.spineAt(site.manifest.spine.photo_s)
  camera.position.set(p.pos.x, p.pos.y + 1.6, p.pos.z)
  camera.lookAt(p.pos.x + p.dir.x * 60, p.pos.y + 1.2, p.pos.z + p.dir.z * 60)
  const fwd = camera.getWorldDirection(camera.position.clone())
  const settle = () => { let g = 0; do { grass.update(camera.position, fwd, 0) } while (grass.counts.pending > 0 && ++g < 8000); return g }
  settle()
  const rows = []
  for (const name of knobs) {
    const v0 = tune.get(name)
    if (v0 === undefined) { rows.push({ knob: name, error: 'no such knob' }); continue }
    tune.set(name, v0 === 0 ? 0.1 : v0 * 1.1)
    const t0 = performance.now()
    const calls = settle()
    rows.push({ knob: name, refill_update_calls: calls, refill_ms: Math.round(performance.now() - t0), tiles: grass.counts.tiles })
    tune.set(name, v0)
    settle()
  }
  return { site: site.manifest.slug, rows }
}, { knobs: KNOBS })))
await browser.close()
