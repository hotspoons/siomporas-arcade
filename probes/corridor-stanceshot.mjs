// Render a stance URL, with the isolation switches an embankment/float bug needs.
//
//   PORT=5201 node probes/corridor-stanceshot.mjs '<stance url>' out.png
//   HIDE=terrain,strip  THIN=1  WIRE=1  node probes/corridor-stanceshot.mjs '<url>' out.png
//
// Why not probes/corridor-stance.mjs: this box has no GPU, and at Rich's grass density
// swiftshader takes seconds per frame, so a screenshot times out (probes/corridor-grassload.mjs
// has the curve). THIN=1 (the default) turns the grass down far enough to render and says so in
// the printed counts; THIN=0 shoots it as Rich has it, slowly.
//
// HIDE takes mesh or layer names: terrain, strip, road, trees, grass, imagery, structures,
// horizon, placements. That is the bisection — hide one surface at a time until the gap between
// two of them shows which is which.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5201'
const THIN = process.env.THIN !== '0'
const WIRE = process.env.WIRE === '1'
const HIDE = (process.env.HIDE ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const [, , url, out] = process.argv
const local = url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${PORT}`)

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(local, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 300000 })
await page.waitForTimeout(1500)

console.log(await page.evaluate(({ thin, hide, wire }) => {
  const c = window.corridor, site = c.site
  if (thin && site.grass) {
    c.tune.set('GRASS_RADIUS', 40)
    c.tune.set('GRASS_SPRITE_RADIUS', 150)
    c.tune.set('GRASS_MOWN_PER_M2', 30)
    c.tune.set('GRASS_ROUGH_PER_M2', 20)
  }
  const named = new Map()
  site.group.traverse((o) => { if (o.name) named.set(o.name, o) })
  const hideOne = (n) => {
    // the grass mesh is a CHILD of the `trees` group, so hiding trees hides ground cover too;
    // hide its siblings instead when asked for trees
    if (n === 'trees' && site.layers.trees) {
      for (const ch of site.layers.trees.children) if (ch !== site.grass?.mesh) ch.visible = false
      return true
    }
    if (n === 'grass' && site.grass) { site.grass.mesh.visible = false; return true }
    if (n === 'imagery') {
      site.setImagery(false)
      return true
    }
    const o = named.get(n) ?? site.layers[n]
    if (!o) return false
    o.visible = false
    return true
  }
  const hidden = hide.filter(hideOne)
  if (wire) site.setWire(true)
  // drive the grass fill to completion: frames arrive about once a second here, so waiting on
  // them would take minutes
  if (site.grass) {
    const fwd = c.camera.getWorldDirection(new c.THREE.Vector3())
    let n = 0
    do { site.grass.update(c.camera.position, fwd, 0) } while (site.grass.counts.pending > 0 && ++n < 8000)
  }
  return JSON.stringify({
    site: site.manifest.slug,
    cam: c.camera.position.toArray().map((v) => +v.toFixed(1)),
    target: c.orbit?.target.toArray().map((v) => +v.toFixed(1)),
    thinned: thin, wire, hidden, notHidden: hide.filter((n) => !hidden.includes(n)),
    grass: site.grass?.counts ?? null,
  })
}, { thin: THIN, hide: HIDE, wire: WIRE }))

await page.keyboard.press('m') // the info panel covers half the frame
await page.waitForTimeout(2500)
await page.screenshot({ path: out, timeout: 300000 })
await browser.close()
