// The arrow in the corner points at the next waypoint and says what it is.
//
// Rich, 2026-09-30: an indicator with an arrow to the next waypoint, and the mission message
// (e.g. "race starts at …") that folds and unfolds on a click. On the Route 3 jam: before you
// commit it points at the entry ring and names the road; in the ring it asks for the start line;
// running, it names the next gate.
import { chromium } from 'playwright'
const innerWidth = 900
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export const ErrorOverlay = class {}; export default {}' }))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
await p.goto('http://127.0.0.1:5185/index.html?level=crofton-jam#crofton-triangle', { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.game && !!window.__apex?.drive?.on, null, { timeout: 240000 })
await p.waitForFunction(() => !document.querySelector('.waypoint')?.hidden, null, { timeout: 60000 }).catch(() => {})
const read = () => p.evaluate(() => { const w = document.querySelector('.waypoint'); return { hidden: w.hidden, text: w.querySelector('.waypoint-msg')?.textContent ?? '', dist: w.querySelector('.waypoint-dist')?.textContent ?? '', folded: w.querySelector('.waypoint-msg')?.classList.contains('folded') } })
const idle = await read()
console.log(JSON.stringify(idle))
check(!idle.hidden && /starts at the ring on Robert Crain Highway/.test(idle.text) && /m|km/.test(idle.dist), `before committing it points at the ring and names the road ("${idle.text}", ${idle.dist})`)
// lower left, off the corner, and above the attribution list when it is open
const place = await p.evaluate(async () => {
  const w = document.querySelector('.waypoint').getBoundingClientRect()
  const short = document.querySelector('#attribution .attrib-short')
  const closed = { left: w.left, bottomGap: innerHeight - w.bottom, right: w.right }
  short.click(); await new Promise((r) => setTimeout(r, 900))
  const a = document.getElementById('attribution').getBoundingClientRect()
  const w2 = document.querySelector('.waypoint').getBoundingClientRect()
  short.click()
  return { closed, openTop: a.top, waypointBottom: w2.bottom }
})
check(place.closed.left >= 20 && place.closed.bottomGap >= 40 && place.closed.right < innerWidth / 2, `it sits in the lower left, off the corner (left ${place.closed.left | 0}, ${place.closed.bottomGap | 0} px up)`)
check(place.waypointBottom <= place.openTop, `and steps over the attribution block when that is open (arrow bottom ${place.waypointBottom | 0} ≤ block top ${place.openTop | 0})`)
await p.click('.waypoint-msg'); await p.waitForTimeout(300)
const folded = await read()
check(folded.folded && folded.text === '…', 'a click folds the message to a marker')
await p.click('.waypoint-msg'); await p.waitForTimeout(300)
check(!(await read()).folded, 'and another opens it')
// into the ring, through the countdown, and the arrow turns to the gates
const running = await p.evaluate(async () => {
  const ap = window.__apex
  const doc = await (await fetch('/sites/crofton-triangle/courses.json')).json()
  const c = doc.courses.find((x) => x.id === 'route-3-jam')
  const car = ap.car
  const dt = 1 / 30
  const step = (x, y) => { car.place(x, -y, 0); ap.races.tick({ x, y }, dt); ap.game.tick(dt) }
  for (let i = 0; i < 20; i++) step(c.entry.x, c.entry.y)
  await new Promise((r) => setTimeout(r, 400))
  const armed = document.querySelector('.waypoint-msg').textContent
  const g = c.gates[0]
  const lx = g.b[0] - g.a[0], ly = g.b[1] - g.a[1], len = Math.hypot(lx, ly) || 1, fx = ly / len, fy = -lx / len
  const mx = (g.a[0] + g.b[0]) / 2, my = (g.a[1] + g.b[1]) / 2
  for (let k = -6; k <= 6; k += 2) step(mx + fx * k, my + fy * k)
  for (let i = 0; i < 30 * 4; i++) step(mx + fx * 8, my + fy * 8)
  await new Promise((r) => setTimeout(r, 400))
  return { armed, running: document.querySelector('.waypoint-msg').textContent, phase: ap.races.state.phase }
})
console.log(JSON.stringify(running))
check(/cross the start line/.test(running.armed), `in the ring it asks for the start line ("${running.armed}")`)
check(running.phase === 'running' && /Checkpoint 1/.test(running.running), `running, it names the next gate ("${running.running}")`)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
