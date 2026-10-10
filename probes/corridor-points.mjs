// Points: a home placed in the editor is where the world opens and where driving starts.
//
// Rich, 2026-09-30: "set the home point for the world by default as well as home points per
// scenario… level start points and end points (make it so we can name them) where driving or
// walking or flying". The editor's Points tab writes points.json; the viewer starts there.
import { chromium } from 'playwright'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
const FILE = 'tools/corridor/data/sites/crofton-triangle/points.json'
const before = existsSync(FILE) ? readFileSync(FILE, 'utf8') : null
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const stub = (p) => p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export const ErrorOverlay = class {}; export default {}' }))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
try {
  // ---- the editor: place a home and a flying start, save
  const e = await b.newPage({ viewport: { width: 1200, height: 800 } })
  e.on('pageerror', (x) => console.log('PAGEERROR', x.message.slice(0, 200)))
  await stub(e)
  await e.goto('http://127.0.0.1:5185/editor.html#crofton-triangle:points', { waitUntil: 'domcontentloaded', timeout: 120000 })
  await e.waitForFunction(() => !!window.corridor?.site && !!window.corridor?.points, null, { timeout: 240000 })
  const ed = await e.evaluate(async () => {
    const c = window.corridor
    c.setMode('points')
    const tabs = [...document.querySelectorAll('.inspector-body .tab')].map((t) => t.textContent.trim())
    // a spot on the primary road: 300 m along the spine, in the site frame (x east, y north)
    const st = c.site.spineAt(300)
    const at = { x: st.pos.x, y: -st.pos.z }
    const homeId = c.points.placeAt(at, 'home')
    const home = c.points.doc.points.find((p) => p.id === homeId)
    const flyId = c.points.placeAt({ x: at.x + 40, y: at.y + 40 }, 'start')
    const fly = c.points.doc.points.find((p) => p.id === flyId)
    fly.mode = 'fly'
    fly.lift_m = 60
    fly.name = 'Over the triangle'
    const msg = await c.points.save()
    return { tabs, homeId, home, flyId, yawRoad: Math.round((Math.atan2(-st.dir.z, st.dir.x) * 180) / Math.PI), docHome: c.points.doc.home, msg }
  })
  console.log(JSON.stringify(ed))
  check(ed.tabs.some((t) => /^Kinds/.test(t)) && ed.tabs.some((t) => /^Points/.test(t)) && ed.tabs.some((t) => /^Courses/.test(t)), `the Points tab has Kinds, Points and Courses (${ed.tabs.join(' | ')})`)
  check(ed.home && ed.home.kind === 'home' && Math.abs(ed.home.yaw_deg - ed.yawRoad) <= 1, `a home placed on the road takes the road's heading (${ed.home?.yaw_deg}° vs road ${ed.yawRoad}°)`)
  check(ed.docHome === ed.homeId, `the first home is the world's home (${ed.docHome})`)
  const saved = JSON.parse(readFileSync(FILE, 'utf8'))
  check(saved.points.length === 2 && saved.home === ed.homeId && saved.points[1].mode === 'fly', `points.json holds both, with the flying start (${saved.points.map((p) => `${p.id}:${p.mode ?? 'level'}`).join(', ')})`)
  await e.close()

  // ---- the viewer: the world opens at the home, and Tab starts driving there
  const v = await b.newPage({ viewport: { width: 900, height: 640 } })
  v.on('pageerror', (x) => console.log('PAGEERROR', x.message.slice(0, 200)))
  await stub(v)
  await v.goto('http://127.0.0.1:5185/index.html#crofton-triangle?nostance=1', { waitUntil: 'domcontentloaded', timeout: 120000 })
  await v.waitForFunction(() => !!window.__apex?.site, null, { timeout: 240000 })
  await v.waitForTimeout(1500)
  const vw = await v.evaluate(async () => {
    const ap = window.__apex
    try { localStorage.removeItem('apex-corridor-resume') } catch {}
    // a world with a home opens DRIVING at it; Tab would toggle that off. Only press it when not.
    const openedDriving = !!ap.drive?.on
    if (!openedDriving) document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true }))
    await new Promise((r) => setTimeout(r, 800))
    const car = ap.car
    return { openedDriving, driving: !!ap.drive?.on, x: car ? +car.pos.x.toFixed(1) : null, z: car ? +car.pos.z.toFixed(1) : null }
  })
  console.log(JSON.stringify(vw))
  const home = saved.points[0]
  const d = vw.x === null ? null : Math.hypot(vw.x - home.at[0], vw.z + home.at[1])
  check(vw.driving && d !== null && d < 3, `the world opens driving at its home (opened driving: ${vw.openedDriving}, ${d?.toFixed(1)} m from it)`)
  await v.close()
} finally {
  if (before === null) { if (existsSync(FILE)) unlinkSync(FILE) } else writeFileSync(FILE, before)
  await b.close()
}
process.exit(bad ? 1 : 0)
