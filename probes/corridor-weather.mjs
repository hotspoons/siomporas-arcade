// Weather: is anything falling, does it settle, and does it let go of the road?
//
//   PORT=5201 SLUG=bowie-racetrack-rd node probes/corridor-weather.mjs
//
// For each weather: the particle count actually drawn, the fog and sky the scene ended up with,
// the grip left for car.ts, and — the one that needs time rather than a frame — how far the
// settled layer has built after a simulated minute, since snow that appears instantly reads as a
// bug and the whole point of the ramp is that it does not.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 300000 })

console.log(JSON.stringify(await page.evaluate(() => {
  const c = window.corridor, site = c.site, tune = c.tune
  const rows = []
  const hex = (col) => '#' + col.getHexString()
  let t = 0
  const run = (seconds) => {
    for (let i = 0; i < seconds * 60; i++) { t += 1 / 60; site.updateNear(c.camera.position, t, c.camera.getWorldDirection(new c.THREE.Vector3()), 0) }
  }
  for (let w = 0; w <= 4; w++) {
    // melt whatever the previous weather left, or every reading is measured from the last one's
    // settled layer and snow looks as though it lands in seconds
    tune.set('WEATHER', 0)
    run(120)
    tune.set('WEATHER', w)
    run(60)
    const settled60 = site.weather.settled
    run(240)
    rows.push({
      weather: site.weather.current,
      particles: site.weather.particles,
      settled_after_1min: +settled60.toFixed(3),
      settled_after_5min: +site.weather.settled.toFixed(3),
      grip: tune.get('WEATHER_GRIP_SCALE'),
      fog: +c.scene.fog.density.toExponential(2),
      sky: hex(c.scene.background),
      sun: +c.scene.children.filter((o) => o.isDirectionalLight)[0].intensity.toFixed(2),
    })
  }
  tune.set('WEATHER', 0)
  return { site: site.manifest.slug, rows }
})))
await browser.close()
