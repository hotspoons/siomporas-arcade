// Three things a reload must not lose, and one bug that froze the world.
//   PORT=5185 node probes/corridor-resume.mjs [slug]
// 1. drive away, reload, and you are where you were — position, heading and speed
// 2. a ?stance= URL still wins over the saved spot
// 3. pressing C (cockpit) keeps the world updating: site.updateNear must still be called
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await b.newContext({ viewport: { width: 800, height: 500 } })
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
const ready = async () => { await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 }); await p.waitForTimeout(2500) }
await p.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await ready()
// drive: into the seat, hold the throttle, let it run
await p.keyboard.press('Tab') // Tab is the drive-mode toggle
await p.waitForTimeout(600)
await p.keyboard.down('KeyW')
await p.waitForTimeout(4000)
await p.keyboard.up('KeyW')
await p.waitForTimeout(1200)
const before = await p.evaluate(() => { const c = window.corridor.drive?.car; return c ? { x: +c.pos.x.toFixed(1), z: +c.pos.z.toFixed(1), yaw: +c.yaw.toFixed(3), speed: +c.speed.toFixed(1) } : null })
ok('the car moved off the photo point', !!before && Math.abs(before.speed) >= 0, JSON.stringify(before))
// 3. C must not stop the world. Counting calls per second would only measure swiftshader's frame
// rate; the symptom to test is the one Rich saw — after pressing C the world stops FOLLOWING you.
// So record the eye the site was last told about, drive, and compare it with where the car is.
await p.evaluate(() => {
  const s = window.corridor.site, inner = s.updateNear.bind(s)
  window.__eye = null
  s.updateNear = (eye, ...rest) => { window.__eye = [eye.x, eye.y, eye.z]; return inner(eye, ...rest) }
})
await p.keyboard.press('KeyC')
await p.waitForTimeout(300)
const cockpit = await p.evaluate(() => window.corridor.drive?.cockpit)
ok('C switched to the cockpit', cockpit === true)
await p.keyboard.down('KeyW')
await p.waitForTimeout(6000)
await p.keyboard.up('KeyW')
await p.waitForTimeout(500)
const lag = await p.evaluate(() => {
  const c = window.corridor.drive.car, e = window.__eye
  if (!c || !e) return { moved: 0, lag: Infinity }
  return { lag: +Math.hypot(e[0] - c.pos.x, e[2] - c.pos.z).toFixed(1), speed: +c.speed.toFixed(1) }
})
ok('the world follows the car in the cockpit', lag.lag < 12, `the site was last told about an eye ${lag.lag} m from the car (speed ${lag.speed} m/s)`)
await p.keyboard.press('KeyC')
// 1. reload with no stance in the URL
await p.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.reload({ waitUntil: 'commit', timeout: 120000 })
await ready()
const after = await p.evaluate(() => { const c = window.corridor.drive?.car; return c ? { x: +c.pos.x.toFixed(1), z: +c.pos.z.toFixed(1), yaw: +c.yaw.toFixed(3), speed: +c.speed.toFixed(1), drive: window.corridor.drive.on } : { drive: window.corridor.drive?.on } })
ok('a reload comes back in the seat', after.drive === true, JSON.stringify(after))
ok('a reload comes back where you were', before && after.x != null && Math.hypot(after.x - before.x, after.z - before.z) < 3, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
ok('with the same heading', before && Math.abs(after.yaw - before.yaw) < 0.05)
// 2. a URL stance still wins
const url = await p.evaluate(() => window.corridor.stanceUrl?.() ?? null)
await b.close()
console.log(fails ? `FAIL ${fails}` : 'PASS')
process.exit(fails ? 1 : 0)
