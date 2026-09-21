// The four grass types have to be visibly different, and the season knob has to work from F6.
//
//   PORT=5201 SLUG=bowie-racetrack-rd node probes/corridor-grasstype.mjs
//
// Numbers, not a screenshot: for each type, the blade count and mean height/width/lean the
// generator actually produced over a fixed patch, plus the colour uniforms it will shade with.
// Then the same for each season. Two types that read the same on screen will read the same here.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug && !!window.corridor.site.grass, SLUG, { timeout: 300000 })

console.log(JSON.stringify(await page.evaluate(() => {
  const site = window.corridor.site, grass = site.grass, tune = window.corridor.tune, camera = window.corridor.camera
  const p = site.spineAt(site.manifest.spine.photo_s)
  camera.position.set(p.pos.x, p.pos.y + 1.6, p.pos.z)
  camera.lookAt(p.pos.x + p.dir.x * 60, p.pos.y + 1.2, p.pos.z + p.dir.z * 60)
  const fwd = camera.getWorldDirection(camera.position.clone())
  const settle = () => { let g = 0; do { grass.update(camera.position, fwd, 0) } while (grass.counts.pending > 0 && ++g < 8000) }

  // read the generator's own output: the instance attributes it just assembled
  const sample = () => {
    let bg = null
    grass.mesh.traverse((o) => { if (o.name === 'grass-blades') bg = o })
    const g = bg.geometry, a = g.getAttribute('aBlade'), n = g.instanceCount
    let h = 0, w = 0, l = 0
    const step = Math.max(1, Math.floor(n / 4000))
    let k = 0
    for (let i = 0; i < n; i += step) { h += a.getY(i); w += a.getZ(i); l += a.getW(i); k++ }
    const m = grass.mesh.children.find((c) => c.name === 'grass-blades').material
    const hex = (c) => '#' + c.getHexString()
    return {
      blades: n, cards: grass.counts.cards,
      height_m: +(h / k).toFixed(3), width_m: +(w / k).toFixed(4), lean: +(l / k).toFixed(3),
      base: hex(m.uniforms.uBase.value), tip: hex(m.uniforms.uTip.value),
      dry: +m.uniforms.uDry.value.toFixed(2), hue: +m.uniforms.uHue.value.toFixed(1), sat: +m.uniforms.uSat.value.toFixed(2),
    }
  }

  const out = { site: site.manifest.slug, baked_type: grass.grassType, types: {}, seasons: {} }
  for (let t = 0; t <= 3; t++) {
    tune.set('GRASS_TYPE', t)
    settle()
    grass.tick(1)
    out.types[grass.counts.type] = sample()
  }
  tune.set('GRASS_TYPE', -1)
  settle()
  for (let s = 0; s <= 3; s++) {
    tune.set('SEASON', s)
    settle()
    grass.tick(1)
    out.seasons[['winter', 'spring', 'summer', 'autumn'][s]] = sample()
  }
  tune.set('SEASON', -1)
  return out
})))
await browser.close()
