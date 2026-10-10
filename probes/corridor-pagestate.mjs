// The page-state poll (apps/corridor/src/world/pageactive.ts): a page the browser stops painting is
// called backgrounded within a couple of seconds though visibilityState still says "visible", and
// comes back when frames do. Run on a LIGHT same-origin page — the game itself paints well under
// 1 fps on swiftshader, which would make every frame look like a stall.
import { chromium } from 'playwright'
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5186'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))
await p.goto(`${ORIGIN}/sites/index.json`)
await p.evaluate(async () => { window.__pa = await import('/src/world/pageactive.ts'); window.__pa.checkPage() })
await p.waitForTimeout(1000)
const read = () => p.evaluate(() => ({ ...window.__pa.checkPage(), vis: document.visibilityState }))
const before = await read()
// a real browser DEFERS frame callbacks while it is not painting; it does not drop them
await p.evaluate(() => { window.__raf = window.requestAnimationFrame; window.__held = []; window.requestAnimationFrame = (cb) => { window.__held.push(cb); return 0 } })
await p.waitForTimeout(2500)
const stalled = await read()
await p.evaluate(() => { window.requestAnimationFrame = window.__raf; for (const cb of window.__held.splice(0)) window.__raf(cb) })
await p.waitForTimeout(800)
const back = await read()
// the control: a real hidden-tab signal (the document reports hidden) is believed at once too
console.log(JSON.stringify({ before, stalled, back, errs }))
const ok = !before.backgrounded && stalled.backgrounded && stalled.vis === 'visible' && !back.backgrounded && !errs.length
console.log(ok ? 'PASS' : 'FAIL')
await b.close()
process.exit(ok ? 0 : 1)
