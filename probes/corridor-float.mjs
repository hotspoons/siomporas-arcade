// "The landscape floats a metre or two above the imagery." Which surface is which, and by how much?
//
//   PORT=5201 SLUG=bowie-racetrack-rd node probes/corridor-float.mjs
//
// No screenshots: the two surfaces that could disagree are both meshes, so ray-cast straight down
// onto each of them separately over a transect across the corridor and print the numbers. For
// each offset from the spine: the strip mesh's surface, the coarse terrain mesh's surface, the
// DEM sampler `heightAt` the rest of the code places things with, and `site.groundAt` (what grass
// and trees actually stand on).
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 300000 })

const OFFSETS = process.env.OFFSETS ? process.env.OFFSETS.split(',').map(Number) : null
if (OFFSETS) await page.evaluate((o) => { window.__offsets = o }, OFFSETS)
console.log(JSON.stringify(await page.evaluate(async ({ stations }) => {
  const site = window.corridor.site
  const mod = window.corridor.THREE
  let strip = null
  const terrain = site.terrain
  site.group.traverse((o) => { if (o.name === 'strip') strip = o })
  if (!strip) return { error: 'no strip mesh' }

  // a downward ray from well above the ground, hit-tested against one mesh at a time
  const cast = (x, z, mesh) => {
    const r = new mod.Raycaster(new mod.Vector3(x, 4000, z), new mod.Vector3(0, -1, 0), 0, 8000)
    const hit = r.intersectObject(mesh, false)[0]
    return hit ? hit.point.y : null
  }
  const out = []
  for (const s of stations) {
    const st = site.spineAt(s)
    const side = new mod.Vector3(st.dir.z, 0, -st.dir.x).normalize() // right of travel, flat
    const row = { s, offsets: [] }
    for (const o of (window.__offsets ?? [0, 5, 10, 15, 20, 30, 40, 45, 50, 60, 80])) {
      const x = st.pos.x + side.x * o, z = st.pos.z + side.z * o
      const sy = cast(x, z, strip)
      const ty = cast(x, z, terrain)
      row.offsets.push({
        o,
        edge: +site.edgeDistance(x, z).toFixed(2),
        strip: sy === null ? null : +sy.toFixed(2),
        terrain: ty === null ? null : +ty.toFixed(2),
        dem: +site.heightAt(x, -z).toFixed(2),
        groundAt: +(site.groundAt(x, z) ?? NaN).toFixed(2),
        strip_minus_terrain: sy !== null && ty !== null ? +(sy - ty).toFixed(2) : null,
      })
    }
    out.push(row)
  }
  return { site: site.manifest.slug, rows: out }
}, { stations: (process.env.STATIONS ?? '1000,2000,3219').split(',').map(Number) })))
await browser.close()
