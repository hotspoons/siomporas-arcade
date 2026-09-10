// Phone emulation probe (landscape iPhone-ish, touch, mobile UA) against a URL.
//   node scripts/probe-mobile.mjs https://xxx.trycloudflare.com shots/mobile.png
import { chromium, devices } from 'playwright'
const [url = 'http://localhost:5180', out = 'shots/mobile.png'] = process.argv.slice(2)
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true })
const page = await ctx.newPage()
const logs = []
page.on('console', (m) => { if (!['debug', 'log'].includes(m.type()) && !/GL Driver|vite\]/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(3000)
await page.screenshot({ path: out.replace('.png', '-title.png') })
// Tap "SINGLE COURSE", then hold thrust + fire via CDP touch events.
await page.locator('.menu .item').filter({ hasText: process.env.PROBE_TAP ?? 'SINGLE COURSE' }).first().tap()
await page.waitForTimeout(500)
const cdp = await ctx.newCDPSession(page)
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
// Hold points (viewport px); default matches conduit's pads, PROBE_TOUCH="x,y;x,y" overrides (stuntin: gas bottom-right).
const pts = (process.env.PROBE_TOUCH ?? '60,130;790,200').split(';').map((p, i) => { const [x, y] = p.split(',').map(Number); return { x, y, id: i + 1 } })
const thrust = pts[0]
const fire = pts[1] ?? pts[0]
await touch('touchStart', [thrust])
await touch('touchStart', [thrust, fire])
await page.waitForTimeout(2500)
const mid = await page.evaluate(() => { const a = window.__apex; if (!a) return 'no apex'; const s = a.snap; const speed = s.vehicle ? s.vehicle.speed : s.car.speed; return { state: a.game.state, speed, fire: a.input.frame.fire, throttle: a.input.frame.throttle, touch: !!a.game.touch, sensors: a.game.touch?.sensorsOk ?? a.game.touch?.tilt?.ok, extras: a.input.extras.length } })
await page.screenshot({ path: out })
await touch('touchEnd', [])
// Drag steering fallback: swipe in the free centre band.
await touch('touchStart', [{ x: 420, y: 200, id: 3 }])
await touch('touchMove', [{ x: 560, y: 200, id: 3 }])
await page.waitForTimeout(600)
const steer = await page.evaluate(() => window.__apex?.input.frame.steer)
await touch('touchEnd', [])
console.log(JSON.stringify({ mid, steerDuringDrag: steer }))
console.log(logs.join('\n'))
await browser.close()
