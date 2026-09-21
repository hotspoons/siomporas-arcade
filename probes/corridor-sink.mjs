// Is the coarse terrain hidden under the strip everywhere, and does it meet the strip at the rim?
//
//   PORT=5201 SLUG=bowie-racetrack-rd node probes/corridor-sink.mjs
//
// Ray-cast both meshes on a dense grid over the corridor. Two failures to look for:
//   POKE-THROUGH  terrain above the strip: the coarse 4 m lattice tears through the 1 m sheet
//   TRENCH        terrain far below the strip where the strip has ENDED, so nothing covers it —
//                 a ditch down both sides of the site, which is what the untapered sink left
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
  const site = window.corridor.site, mod = window.corridor.THREE
  let strip = null
  site.group.traverse((o) => { if (o.name === 'strip') strip = o })
  const cast = (x, z, m) => { const r = new mod.Raycaster(new mod.Vector3(x, 4000, z), new mod.Vector3(0, -1, 0), 0, 8000); const h = r.intersectObject(m, false)[0]; return h ? h.point.y : null }
  const len = site.manifest.spine.length_m
  let poke = { worst: 0, at: null }, samples = 0, covered = 0
  const pokes = []
  // A trench shows up as an abnormally large STEP in the terrain surface between neighbouring
  // samples near the rim. Comparing the mesh against `heightAt` does not work: that sampler is
  // nearest-neighbour on the 2 m DEM while the mesh interpolates a 4 m lattice, so on a bank the
  // two differ by over a metre with nothing wrong at all.
  const stepNearRim = { worst: 0, at: null }, stepElsewhere = { worst: 0, at: null }
  for (let s = 20; s < len - 20; s += 37) {
    const st = site.spineAt(s)
    const side = new mod.Vector3(-st.dir.z, 0, st.dir.x).normalize()
    const row = []
    for (let o = -46; o <= 46; o += 2) {
      const x = st.pos.x + side.x * o, z = st.pos.z + side.z * o
      const sy = cast(x, z, strip), ty = cast(x, z, site.terrain)
      if (ty === null) continue
      samples++
      if (sy !== null) {
        covered++
        if (ty > sy) pokes.push(ty - sy)
        if (ty - sy > poke.worst) poke = { worst: +(ty - sy).toFixed(2), at: [Math.round(s), o] }
      }
      row.push({ o, ty, onStrip: sy !== null })
    }
    for (let i = 1; i < row.length; i++) {
      const step = Math.abs(row[i].ty - row[i - 1].ty)
      const atRim = row[i].onStrip !== row[i - 1].onStrip || (i > 1 && row[i - 1].onStrip !== row[i - 2].onStrip)
      const bucket = atRim ? stepNearRim : stepElsewhere
      if (step > bucket.worst) bucket.worst = +step.toFixed(2), bucket.at = [Math.round(s), row[i].o]
    }
  }
  return { site: site.manifest.slug, samples, covered_by_strip: covered, poke_through: { count: pokes.length, share_pct: +(100 * pokes.length / Math.max(1, covered)).toFixed(1), over_20cm: pokes.filter((v) => v > 0.2).length, worst: poke }, terrain_step_between_2m_samples: { at_the_rim: stepNearRim, away_from_it: stepElsewhere } }
})))
await browser.close()
