// Does the driving readout tell the truth about where you are and which way you are pointing?
//
// Rich, 2026-09-27: "can we add the ground elevation (e.g. 121 feet) and heading (e.g. e/ne) at
// the current position of the car when driving? along with the surface and speed".
//
// Two things can be quietly wrong here and both would look plausible on screen:
//
//   1. The DATUM. World Y is only "height above sea level" because the corridor DEM is NAVD88
//      metres and the bake anchors the frame at h = 0. If that ever stops being true the readout
//      becomes a confident lie, so this asserts the number against `groundAt` AND against the
//      site's own geodetic lattice rather than against a remembered convention.
//   2. The BEARING. World is (east, up, -north). atan2(x, z) instead of atan2(x, -z) reads 90
//      degrees out and still returns a tidy compass point. So the probe does not assume +x is
//      east: it reads that off the manifest's control lattice, which the bake wrote, and only
//      then checks the heading.
//
//   PORT=5185 node probes/corridor-hud-telemetry.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForTimeout(3000)

// WHICH WAY IS NORTH, derived rather than assumed, in two links:
//   1. the site's own projector puts a point 0.01 degrees north of the anchor somewhere in PLAN
//      coordinates, which says which plan axis is north and which is east;
//   2. the spine exists in both plan (manifest.spine.coords) and world (site.spineAt), which says
//      how plan maps to world.
// Compose them and you have the world's north with no convention taken on faith.
const frame = await page.evaluate(() => {
  const c = window.corridor
  const a = c.site.manifest.frame?.anchor
  if (!a || !c.project) return { error: 'no frame anchor, or no projector exposed' }
  const p0 = c.project(a.lon, a.lat)
  const pN = c.project(a.lon, a.lat + 0.01)
  const pE = c.project(a.lon + 0.01, a.lat)
  // the spine, in both coordinate systems
  const sp = c.site.manifest.spine.coords
  const mid = Math.floor(sp.length / 2)
  let s = 0
  for (let i = 1; i <= mid; i++) s += Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1])
  const w = c.site.spineAt(s).pos
  return {
    planNorth: [+(pN[0] - p0[0]).toFixed(1), +(pN[1] - p0[1]).toFixed(1)],
    planEast: [+(pE[0] - p0[0]).toFixed(1), +(pE[1] - p0[1]).toFixed(1)],
    plan: [+sp[mid][0].toFixed(1), +sp[mid][1].toFixed(1)],
    world: [+w.x.toFixed(1), +w.z.toFixed(1)],
  }
})

// drive
await page.keyboard.press('Tab')   // Tab toggles drive mode
await page.waitForTimeout(1500)
await page.keyboard.down('ArrowUp')
await page.waitForTimeout(3000)
await page.keyboard.up('ArrowUp')
await page.waitForTimeout(500)

const out = await page.evaluate(() => {
  const c = window.corridor
  const car = c.car
  if (!car) return { error: 'not driving — no car' }
  const el = document.querySelector('#pos, .pos, [data-pos], #hud-pos, .hud-pos')
  const text = el ? el.textContent : null
  const gy = c.site.groundAt(car.pos.x, car.pos.z)
  const brg = (Math.atan2(car.forward.x, -car.forward.z) * (180 / Math.PI) + 360) % 360
  return {
    text,
    carPos: [+car.pos.x.toFixed(1), +car.pos.y.toFixed(1), +car.pos.z.toFixed(1)],
    fwd: [+car.forward.x.toFixed(3), +car.forward.z.toFixed(3)],
    groundM: gy === null ? null : +gy.toFixed(2),
    expectFt: gy === null ? null : Math.round(gy * 3.28084),
    expectBrg: +brg.toFixed(0),
    speedMph: +(Math.abs(car.speed) * 2.237).toFixed(0),
  }
})
console.log(JSON.stringify({ frame, ...out }, null, 1))
await browser.close()

const fail = (m) => {
  console.error(`FAIL: ${m}`)
  process.exitCode = 1
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
if (frame.error) fail(frame.error)
else if (out.error) fail(out.error)
else if (!out.text) fail('no readout element on the page')
// link 1: plan y is north, plan x is east
else if (!(frame.planNorth[1] > 500 && Math.abs(frame.planNorth[0]) < 200)) fail(`0.01 degrees north moved the plan by ${frame.planNorth} — plan y is not north`)
else if (!(frame.planEast[0] > 500 && Math.abs(frame.planEast[1]) < 200)) fail(`0.01 degrees east moved the plan by ${frame.planEast} — plan x is not east`)
// link 2: world x is plan x, world z is MINUS plan y
else if (Math.abs(frame.world[0] - frame.plan[0]) > 1 || Math.abs(frame.world[1] + frame.plan[1]) > 1) fail(`the spine is at plan ${frame.plan} but world ${frame.world} — world is not (east, up, -north)`)
else {
  const ft = /(-?\d+) ft/.exec(out.text)
  const hd = /\b([NSEW]{1,3}) (\d{3})°/.exec(out.text)
  if (!ft) fail(`no elevation in the readout: ${JSON.stringify(out.text)}`)
  else if (!hd) fail(`no heading in the readout: ${JSON.stringify(out.text)}`)
  else if (Number(ft[1]) !== out.expectFt) fail(`readout says ${ft[1]} ft, ground is ${out.groundM} m = ${out.expectFt} ft`)
  else if (Math.abs(((Number(hd[2]) - out.expectBrg + 540) % 360) - 180) > 1) fail(`readout says ${hd[2]}°, the car is pointing ${out.expectBrg}°`)
  else if (hd[1] !== COMPASS[Math.round(Number(hd[2]) / 22.5) % 16]) fail(`${hd[2]}° is ${COMPASS[Math.round(Number(hd[2]) / 22.5) % 16]}, not ${hd[1]}`)
  // liveness: a run where the car never moved cannot have exercised the heading
  else if (!(out.speedMph > 0)) fail('the car never moved — the readout was never exercised')
  else console.log(`PASS: ${ft[1]} ft, ${hd[1]} ${hd[2]}°, ${out.speedMph} mph — agrees with the car and with the bake's own north`)
}
