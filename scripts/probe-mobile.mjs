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
await page.getByText('SINGLE COURSE').tap()
await page.waitForTimeout(500)
const cdp = await ctx.newCDPSession(page)
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
const thrust = { x: 60, y: 130, id: 1 }
const fire = { x: 790, y: 200, id: 2 }
await touch('touchStart', [thrust])
await touch('touchStart', [thrust, fire])
await page.waitForTimeout(2500)
const mid = await page.evaluate(() => { const a = window.__apex; return a ? { state: a.game.state, speed: a.snap.vehicle.speed, s: a.snap.vehicle.s, fire: a.input.frame.fire, throttle: a.input.frame.throttle, touch: !!a.game.touch, sensors: a.game.touch?.sensorsOk, extras: a.input.extras.length } : 'no apex' })
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
