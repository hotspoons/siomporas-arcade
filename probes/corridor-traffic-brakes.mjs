// A traffic car brakes for the player in its lane, instead of driving through him.
//
// Rich, 2026-09-30, in the Route 3 jam: *"My car is stuck in place here, I can't drive forward
// or backwards."* Traffic cars are kinematic bodies — immovable — and their drivers only saw other
// ECS cars, so a jam crawled straight through the player and pinned him. Now the drivers see him.
import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export const ErrorOverlay = class {}; export default {}' }))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
await p.goto('http://127.0.0.1:5185/index.html#arrowhead-farms-network?level=probe-traffic', { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.traffic, null, { timeout: 240000 })
await p.waitForTimeout(2000)
const r = await p.evaluate(async () => {
  const ap = window.__apex, t = ap.traffic
  const { Transform, Vehicle } = await import('/src/actors.ts')
  const dt = 1 / 60
  // let the traffic get going, with nobody in the way
  t.player = null
  for (let i = 0; i < 240; i++) t.tick(dt, ap.camera.position)
  // the fastest car, and a point 25 m ahead of it in its own lane: park the player there
  let e = -1, best = 0
  for (const x of t.entities) if (Vehicle.speed[x] > best) { best = Vehicle.speed[x]; e = x }
  const yaw = Transform.yaw[e]
  const px = Transform.x[e] + Math.cos(yaw) * 25, py = Transform.y[e] + Math.sin(yaw) * 25
  const before = Vehicle.speed[e]
  const control = t.entities.filter((x) => x !== e).map((x) => Vehicle.speed[x])
  t.player = { x: px, y: py, vx: 0, vy: 0, length: 4.6 }
  let minGap = Infinity
  for (let i = 0; i < 360; i++) {
    t.tick(dt, ap.camera.position)
    const gap = Math.hypot(px - Transform.x[e], py - Transform.y[e])
    if (gap < minGap) minGap = gap
    // the player stays put; the car ahead is stationary as far as the driver knows
  }
  const after = Vehicle.speed[e]
  const others = t.entities.filter((x) => x !== e).map((x) => Vehicle.speed[x])
  const stillMoving = others.filter((v) => v > 1).length
  return { before: +before.toFixed(1), after: +after.toFixed(2), minGap: +minGap.toFixed(1), stillMoving, of: others.length, controlMoving: control.filter((v) => v > 1).length }
})
console.log(JSON.stringify(r))
check(r.before > 5 && r.after < 0.5, `the car behind the player brakes to a stop (${r.before} → ${r.after} m/s)`)
check(r.minGap > 3, `and never reaches him (closest ${r.minGap} m)`)
check(r.stillMoving > r.of * 0.5, `while the rest of the traffic keeps moving (${r.stillMoving} of ${r.of})`)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
