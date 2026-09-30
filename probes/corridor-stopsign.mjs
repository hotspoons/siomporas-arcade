// Hit a stop sign at full throttle: the sign flies, the car does not.
//
// Rich, 2026-09-30, from the spawn of the Route 3 jam: *"if you crash into the stop sign right in
// front of you at full speed, instead of yeeting the sign, your car flies hundreds of feet
// through the air going end over end."* A rigid post met the sled's raked nose and the solver
// put the whole stop into the car, upward, before the sign could break. Signs are soft now.
import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export const ErrorOverlay = class {}; export default {}' }))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
await p.goto('http://127.0.0.1:5185/index.html?level=crofton-jam#crofton-triangle', { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.traffic && window.__apex?.car?.constructor?.name === 'RapierCar', null, { timeout: 240000 })
await p.waitForTimeout(2000)
const r = await p.evaluate(async () => {
  const ap = window.__apex, car = ap.car, site = ap.site, dt = 1 / 60
  // the nearest stop sign to the spawn, and a run-up straight at it from 45 m away
  const sign = ap.physics.nearestProp(car.pos.x, car.pos.z, ['furniture:sign:stop'])
  if (!sign) return { error: 'no stop sign catalogued near the spawn' }
  const ang = Math.atan2(sign.z - car.pos.z, sign.x - car.pos.x)
  const sx = sign.x - Math.cos(ang) * 45, sz = sign.z - Math.sin(ang) * 45
  car.place(sx, sz, ang)
  const step = (throttle) => { car.tick(dt, { throttle, brake: 0, steer: 0, handbrake: false }); ap.traffic.tick(dt, ap.camera.position); ap.physics.update(car.pos, dt) }
  for (let i = 0; i < 60; i++) step(0)
  const broken0 = ap.physics.stats().broken
  let maxGain = 0, peakSpeed = 0, minDist = Infinity
  const trace = []
  // measured up to a third of a second past the post — a launch from the contact shows at once: the probe's straight line then leaves the road,
  // and what a ditch does at 27 m/s is not the sign's doing
  let passedAt = -1
  for (let i = 0; i < 60 * 5; i++) {
    step(1)
    const dNow = Math.hypot(sign.x - car.pos.x, sign.z - car.pos.z)
    if (passedAt < 0 && dNow < 2) passedAt = i
    if (passedAt >= 0 && i > passedAt + 18) break
    const g = site.groundAt(car.pos.x, car.pos.z) ?? car.pos.y
    if (i % 6 === 0) trace.push([+(i / 60).toFixed(1), +Math.hypot(sign.x - car.pos.x, sign.z - car.pos.z).toFixed(1), +(car.pos.y - g).toFixed(2), +car.up.y.toFixed(2), +car.speed.toFixed(1), site.edgeDistance(car.pos.x, car.pos.z) < 0 ? 'road' : 'verge'])
    maxGain = Math.max(maxGain, car.pos.y - g)
    peakSpeed = Math.max(peakSpeed, car.speed)
    minDist = Math.min(minDist, Math.hypot(sign.x - car.pos.x, sign.z - car.pos.z))
  }
  const up = car.up
  return { trace, broken: ap.physics.stats().broken - broken0, maxGain: +maxGain.toFixed(2), peakSpeed: +peakSpeed.toFixed(1), speedNow: +car.speed.toFixed(1), minDist: +minDist.toFixed(1), upright: up.y > 0.7, detached: ap.physics.detachedProps().length }
})
console.log(JSON.stringify({ ...r, trace: undefined }))
for (const row of r.trace ?? []) console.log('  ', JSON.stringify(row))
check(!r.error && r.minDist < 3, `the car reached the sign at speed (${r.peakSpeed} m/s, within ${r.minDist} m)`)
check(r.broken >= 1 && r.detached >= 1, `the sign broke off and is loose (${r.broken} broken, ${r.detached} detached props)`)
check(r.maxGain < 1.6 && r.upright, `the car stayed on the road through the contact (at most ${r.maxGain} m above it, ${r.upright ? 'upright' : 'NOT upright'})`)
check(r.speedNow > 10, `and kept going (${r.speedNow} m/s after)`)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
