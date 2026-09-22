// A look at the grass. Thins the field first: this box has no GPU and swiftshader falls off a
// cliff above ~60 k blade instances (probes/corridor-grassload.mjs), so a screenshot at Rich's
// density never returns. Colour, height and lean are what this is for; density is not.
//
//   PORT=5201 SLUG=bowie-racetrack-rd SEASONS=0,1,2,3 node probes/corridor-grassshot.mjs out-
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const OUT = process.argv[2] ?? '/tmp/grass-'
const SEASONS = (process.env.SEASONS ?? '2').split(',').map(Number)
const TYPES = (process.env.TYPES ?? '-1').split(',').map(Number)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug && !!window.corridor.site.grass, SLUG, { timeout: 300000 })
await page.keyboard.press('m') // the info panel covers half the frame
await page.evaluate(() => {
  const c = window.corridor, L = c.site.layers
  // the near tree models are the other swiftshader hog; grass is its own layer now, so this
  // leaves it alone
  if (L.trees) L.trees.visible = false
  c.site.grass.mesh.visible = true
  c.tune.set('GRASS_RADIUS', 22)
  c.tune.set('GRASS_SPRITE_RADIUS', 120)
  c.tune.set('GRASS_MOWN_PER_M2', 90)
  c.tune.set('GRASS_ROUGH_PER_M2', 55)
  // kneeling out on the rough verge, looking back along it over the mow line to the shoulder:
  // rough grass in the foreground, mown turf behind it, pavement at the top of the frame
  const st = c.site.spineAt(c.site.manifest.spine.photo_s)
  const side = new c.THREE.Vector3(-st.dir.z, 0, st.dir.x).normalize()
  const eye = { x: st.pos.x + side.x * 19, z: st.pos.z + side.z * 19 }
  const gy = c.site.groundAt(eye.x, eye.z) ?? st.pos.y
  // set the ORBIT TARGET as well as the position: the controls rebuild the camera from their own
  // target every frame, so writing camera.position alone gets pulled back within a second
  const aim = { x: eye.x + st.dir.x * 7 - side.x * 6, z: eye.z + st.dir.z * 7 - side.z * 6 }
  c.camera.position.set(eye.x, gy + 0.6, eye.z)
  c.orbit.target.set(aim.x, (c.site.groundAt(aim.x, aim.z) ?? gy) + 0.15, aim.z)
  c.orbit.update()
  c.camera.fov = 45
  c.camera.updateProjectionMatrix()
})
for (const t of TYPES) {
  for (const s of SEASONS) {
    await page.evaluate(({ t, s }) => { window.corridor.tune.set('GRASS_TYPE', t); window.corridor.tune.set('SEASON', s) }, { t, s })
    // the knobs emptied the cache; refill it before the shot
    // the knobs emptied the cache: drive the fill to completion rather than waiting on frames,
    // which arrive about once a second here
    await page.evaluate(() => {
      const c = window.corridor, g = c.site.grass
      const fwd = c.camera.getWorldDirection(new c.THREE.Vector3())
      let n = 0
      do { g.update(c.camera.position, fwd, 0) } while (g.counts.pending > 0 && ++n < 8000)
    })
    await page.waitForTimeout(1200)
    const name = `${OUT}${['common', 'wheat', 'bermuda', 'coastal'][t] ?? 'baked'}-${['winter', 'spring', 'summer', 'autumn'][s]}.png`
    await page.screenshot({ path: name, timeout: 180000 })
    console.log(name, JSON.stringify(await page.evaluate(() => window.corridor.site.grass.counts)))
  }
}
await browser.close()
