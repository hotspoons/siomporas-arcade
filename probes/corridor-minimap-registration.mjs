// Does the minimap's photograph line up with its linework?
//
// Rich, 2026-09-27: "new map drift issue … note the rendered vectors drifting from the sat
// imagery, this time mostly horizontally, not vertically like we saw before."
//
// The aerial overview's own grid is UTM zone 18N. The vectors go through the ENU projector about
// the site's frame anchor, which is TRUE north. UTM grid north is 1.06 degrees off true north
// here, so stamping the photograph into `layers.naip.bbox` — an axis-aligned box that cannot
// express a rotation — drew it turned back by that angle. And because the bounding box of a
// rotated rectangle is bigger than the rectangle, it was stretched to fill it as well, 1.7 per
// cent east and 2.0 per cent north.
//
// The result is zero at the site centre and grows linearly outwards, which is why it can look
// like a north-south problem in one place and an east-west one in another. It is neither: it is a
// rotation. So this probe does NOT measure one offset — it measures the whole field, at the
// bake's own control points, and reports the worst.
//
//   PORT=5185 node probes/corridor-minimap-registration.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
// the overview image loads separately from the world
await page.waitForFunction(() => !!window.corridor.minimapRegistration?.(), null, { timeout: 120000 })

const out = await page.evaluate(() => {
  const c = window.corridor
  const reg = c.minimapRegistration()
  const m = c.site.manifest
  const g = m.layers?.naip?.geo
  // CONTROL: the same measurement done the OLD way — stamping the photo into its bounding box —
  // must come out large, or this site cannot tell a correct placement from a wrong one and a
  // small number above would mean nothing.
  let bboxMax = 0
  if (g) {
    const [x0, y0, x1, y1] = m.layers.naip.bbox
    const n = g.n
    const northIsLastRow = g.lat[(n - 1) * n] > g.lat[0]
    for (let r = 0; r < n; r++) {
      for (let col = 0; col < n; col++) {
        const u = col / (n - 1)
        const v = (northIsLastRow ? n - 1 - r : r) / (n - 1)
        const px = x0 + u * (x1 - x0)
        const py = y1 - v * (y1 - y0)
        const [tx, ty] = c.project(g.lon[r * n + col], g.lat[r * n + col])
        bboxMax = Math.max(bboxMax, Math.hypot(px - tx, py - ty))
      }
    }
  }
  return { reg, bboxMax: +bboxMax.toFixed(1), convergenceDeg: m.frame?.utm_convergence_deg ?? null, lattice: g ? g.n * g.n : 0 }
})
console.log(JSON.stringify(out, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (!out.reg) fail('the minimap never reported a registration — the overview image did not load')
else if (!out.lattice) fail('this bake has no geodetic control lattice on its imagery, so there is nothing to check it against')
// liveness: prove the site can show the fault, or a clean result is not evidence of anything
else if (!(out.bboxMax > 20)) fail(`placing the photo by its bounding box would only be ${out.bboxMax} m out here — this site cannot distinguish a correct placement from a wrong one`)
else if (out.reg.maxM > 2) fail(`the photograph is up to ${out.reg.maxM} m from the linework (worst offset ${out.reg.worst} m east/north) across ${out.reg.points} control points`)
else console.log(`PASS: photograph within ${out.reg.maxM} m of the linework at all ${out.reg.points} control points (mean ${out.reg.meanM} m). Placing it by its bounding box, as before, would be ${out.bboxMax} m out — the grid convergence here is ${out.convergenceDeg} degrees.`)
