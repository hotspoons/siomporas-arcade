// The minimap's chrome: is the grip where the panel's free corner is, does dragging it the
// intuitive way make the map BIGGER, and is there an obvious way out of full screen?
//   PORT=5185 node probes/corridor-minimap.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 1100, height: 700 } })
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(1500)
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
const box = async (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }, sel)
const panel0 = await box('#minimap')
const grip = await box('#minimap .mm-grip')
ok('the panel is pinned to the bottom-right', panel0 && panel0.x + panel0.w > 1050 && panel0.y + panel0.h > 650, JSON.stringify(panel0))
ok('a grip exists', !!grip, JSON.stringify(grip))
if (grip && panel0) {
  ok('the grip is at the panel\'s TOP-LEFT', Math.abs(grip.x - panel0.x) < 24 && Math.abs(grip.y - panel0.y) < 24, `grip ${grip.x},${grip.y} vs panel ${panel0.x},${panel0.y}`)
  // drag it up and to the left — the direction that should make the map bigger
  await p.mouse.move(grip.x + 8, grip.y + 8)
  await p.mouse.down()
  await p.mouse.move(grip.x - 92, grip.y - 92, { steps: 8 })
  await p.mouse.up()
  await p.waitForTimeout(300)
  const panel1 = await box('#minimap')
  ok('dragging the grip up-left grows the map', panel1.w > panel0.w + 60 && panel1.h > panel0.h + 60, `${panel0.w}x${panel0.h} -> ${panel1.w}x${panel1.h}`)
  ok('the bottom-right corner stayed put', Math.abs((panel1.x + panel1.w) - (panel0.x + panel0.w)) < 6 && Math.abs((panel1.y + panel1.h) - (panel0.y + panel0.h)) < 6)
  const canvas = await box('#minimap canvas')
  ok('the canvas followed the panel', Math.abs(canvas.w - panel1.w) < 4 && Math.abs(canvas.h - panel1.h) < 4, `${canvas.w}x${canvas.h}`)
}
// full screen: an obvious close, in the top right, that works
await p.evaluate(() => window.corridor.minimap?.setExpanded?.(true) ?? document.querySelector('#minimap .mm-expand').click())
await p.waitForTimeout(400)
const expanded = await box('#minimap')
ok('full screen covers the window', expanded.w > 1000 && expanded.h > 600, `${expanded.w}x${expanded.h}`)
const closeBtn = await box('#minimap .mm-expand')
const closeIcon = await p.evaluate(() => document.querySelector('#minimap .mm-expand svg')?.outerHTML.includes('M6 18 18 6') ?? false)
ok('the close button is in the top right', closeBtn && closeBtn.x > 900 && closeBtn.y < 200, JSON.stringify(closeBtn))
ok('it is an X', closeIcon)
await p.mouse.click(closeBtn.x + closeBtn.w / 2, closeBtn.y + closeBtn.h / 2)
await p.waitForTimeout(400)
const back = await box('#minimap')
ok('clicking it leaves full screen', back.w < 900, `${back.w}x${back.h}`)
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
