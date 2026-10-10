// The tuning panel as a working surface: drag it, resize it, dock it, and no scrim when docked.
//   PORT=5185 node probes/corridor-dockpanel.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } })
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/#crofton-triangle?lite=1&fresh`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(2500)
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
const box = (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }, sel)
const scrim = () => p.evaluate(() => {
  const s = document.querySelector('.dialog-scrim')
  if (!s) return null
  const cs = getComputedStyle(s)
  return { docked: s.classList.contains('docked'), bg: cs.backgroundColor, pointer: cs.pointerEvents }
})
await p.keyboard.press('F6')
await p.waitForTimeout(700)
ok('the panel opens', !!(await box('.dialog')))
const floating = await box('.dialog')
const s0 = await scrim()
ok('floating, it dims the scene behind it', s0 && !s0.docked && s0.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(s0))
// RESIZE FIRST, THEN DRAG. Dragging the panel down and right puts its bottom-right corner — and
// so the grip — past the edge of the window, where a synthetic mouse cannot reach it. That is
// ordinary window behaviour, not a bug, but it makes the order of this probe matter.
const grip0 = await box('.dialog-grip')
await p.mouse.move(grip0.x + 8, grip0.y + 8)
await p.mouse.down()
await p.mouse.move(grip0.x + 100, grip0.y + 40, { steps: 8 })
await p.mouse.up()
await p.waitForTimeout(300)
const resized = await box('.dialog')
ok('the grip resizes it', resized.w > floating.w + 60 && resized.h > floating.h + 20, `${floating.w}x${floating.h} -> ${resized.w}x${resized.h}`)
// drag it by the title bar
await p.mouse.move(resized.x + 120, resized.y + 14)
await p.mouse.down()
await p.mouse.move(resized.x + 220, resized.y + 90, { steps: 10 })
await p.mouse.up()
await p.waitForTimeout(300)
const moved = await box('.dialog')
ok('dragging the title bar moves it', Math.abs(moved.x - resized.x - 100) < 30 && Math.abs(moved.y - resized.y - 76) < 30, `${resized.x},${resized.y} -> ${moved.x},${moved.y}`)
ok('and it keeps the size it was given', Math.abs(moved.w - resized.w) < 4 && Math.abs(moved.h - resized.h) < 4)
// dock right
await p.evaluate(() => window.corridor.tuneDialog.dock('right'))
await p.waitForTimeout(400)
const docked = await box('.dialog')
const s1 = await scrim()
ok('docked right, it is a column at the right edge', Math.abs(docked.x + docked.w - 1280) < 4 && docked.h > 600, JSON.stringify(docked))
ok('and the scrim is gone', s1.docked && s1.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(s1))
ok('so clicks reach the scene', s1.pointer === 'none')
// the scene is still live behind it: the world keeps updating
const before = await p.evaluate(() => window.corridor.camera.position.x)
await p.evaluate(() => { const c = window.corridor; c.camera.position.x += 30; c.orbit.target.x += 30; c.orbit.update() })
await p.waitForTimeout(600)
ok('and the scene behind it is live', (await p.evaluate(() => window.corridor.camera.position.x)) !== before)
// dock left, then reload: the choice sticks
await p.evaluate(() => window.corridor.tuneDialog.dock('left'))
await p.waitForTimeout(300)
const left = await box('.dialog')
ok('docked left, it is a column at the left edge', left.x < 4, JSON.stringify(left))
await p.reload({ waitUntil: 'commit', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(2000)
await p.keyboard.press('F6')
await p.waitForTimeout(700)
const after = await box('.dialog')
ok('the dock survives a reload', after && after.x < 4 && after.h > 600, JSON.stringify(after))
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
