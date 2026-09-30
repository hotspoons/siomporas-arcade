// Every mode has a palette you can drag from and a placed list that stays put when you select.
//
// Rich, 2026-09-30: the stunt list vanished on select (a scroll container squeezed to its borders
// by the grid it sits in), only the place palette could be dragged from, the tabs did not look
// like tabs, and clicking a thing from another mode did not take you to it. Each is checked here
// by doing it: a drag-and-drop of every palette's first chip, a select, a cross-mode click.
import { chromium } from 'playwright'
import { existsSync, unlinkSync } from 'node:fs'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const EDITOR = process.env.EDITOR ?? 'http://127.0.0.1:5185/editor.html'
for (const f of ['stunts', 'zones', 'courses', 'adjustments', 'structures']) {
  const file = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/${f}.json`
  if (existsSync(file)) unlinkSync(file)
}
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1200, height: 800 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

await p.goto(`${EDITOR}#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 180000 })
await p.waitForTimeout(5000)

/** a pixel on the canvas over the road, `along` metres from the photo station */
const roadPixel = (along) => p.evaluate((along) => {
  const site = window.corridor.site, cam = window.__ed.camera
  const s = Math.min(site.manifest.spine.length_m - 10, Math.max(10, site.manifest.spine.photo_s + along))
  const at = site.spineAt(s).pos
  const V = cam.position.constructor
  const q = new V(at.x, at.y, at.z).project(cam)
  const r = document.querySelector('canvas').getBoundingClientRect()
  return { x: r.left + ((q.x + 1) / 2) * r.width, y: r.top + ((1 - q.y) / 2) * r.height, site: { x: at.x, y: -at.z } }
}, along)
/** drop a palette chip's payload on the canvas at a pixel, the way the browser does it */
const dropOn = async (mode, id, px) => p.evaluate(({ mode, id, px }) => {
  const canvas = document.querySelector('canvas')
  const dt = new DataTransfer()
  dt.setData('text/apex-drop', JSON.stringify({ mode, id }))
  for (const type of ['dragover', 'drop']) canvas.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: px.x, clientY: px.y, dataTransfer: dt }))
}, { mode, id, px })
const panel = () => p.evaluate(() => {
  const body = document.querySelector('.inspector-body')
  const list = body.querySelector('.list')
  return {
    hash: location.hash,
    tabs: [...body.querySelectorAll('.tab-strip .tab')].map((t) => t.textContent + (t.classList.contains('on') ? '*' : '')),
    tabLooksLikeTab: (() => { const t = body.querySelector('.tab-strip .tab'); if (!t) return false; const c = getComputedStyle(t); return c.borderTopWidth === '0px' && c.backgroundColor === 'rgba(0, 0, 0, 0)' })(),
    listH: list ? list.getBoundingClientRect().height : null, items: list ? list.querySelectorAll('.item').length : 0,
    sel: body.querySelector('.item.sel')?.textContent ?? null, detail: !!body.querySelector('.detail'),
    chips: body.querySelectorAll('.palette .chip[draggable=true]').length,
  }
})

// 1. every mode: a palette tab of draggable chips, and a placed tab
// Grow is a third tab inside Place now, and the World tab took key 7; the rail is 1–7 without it
for (const [key, m] of [['1', 'areas'], ['3', 'structures'], ['4', 'traffic'], ['5', 'stunts'], ['6', 'points'], ['2', 'place']]) {
  await p.keyboard.press(key); await p.waitForTimeout(400)
  const s = await panel()
  // Place has a Grow tab; Points has Kinds, Points and the race Courses
  const want = m === 'place' || m === 'points' ? 3 : 2
  check(s.tabs.length === want && s.chips > 0, `${m}: ${want === 3 ? 'three' : 'two'} tabs (${s.tabs.join(' | ')}) and ${s.chips} draggable chips`)
  if (m === 'stunts') check(s.tabLooksLikeTab, 'the tabs are styled as the shell’s tabs, not as grey buttons')
}

// 2. drop one of each on the road; each lands in its own document and the panel shows it placed
const drops = [['stunts', 'loop', 0], ['races', 'start', 120], ['traffic', 'slow', 260], ['structures', 'flatten', 400], ['areas', 'square', 540]]
for (const [m, id, along] of drops) {
  const px = await roadPixel(along)
  // the race gates live in the Courses tab of Points: open it, so the drop is a gate and not a point
  if (m === 'races') await p.evaluate(() => { window.corridor.setMode('points'); window.corridor.points.panelTab = 'courses' })
  await dropOn(m === 'races' ? 'points' : m, id, px)
  await p.waitForTimeout(600)
  const s = await panel()
  const n = await p.evaluate((m) => {
    const c = window.corridor
    return m === 'stunts' ? c.stunts.doc.fixtures.length : m === 'races' ? c.races.doc.courses.reduce((a, x) => a + x.gates.length, 0) : m === 'traffic' ? c.traffic.doc.zones.length : m === 'structures' ? c.structs.doc.items.length : window.__ed.site && c.areas ? c.areas.doc.areas.length : -1
  }, m)
  const modeOf = m === 'races' ? 'points' : m
  check(s.hash.endsWith(`:${modeOf}`) && n >= 1, `dropping a ${id} from the ${m} palette placed it (${n} in the document, editor in ${s.hash.split(':')[1]})`)
  check(s.tabs.some((t, i) => i > 0 && t.endsWith('*') && !/^(Kinds|Courses)/.test(t)) && s.listH > 40 && s.items >= 1, `…and the panel shows the placed tab with the list still there (${s.listH | 0} px, ${s.items} rows, ${s.sel ? 'one selected' : 'none selected'})`)
}
// the traffic strip hugs the road: the zone reads on the centreline it was dropped on
const strip = await p.evaluate(() => {
  const c = window.corridor, z = c.traffic.doc.zones[0]
  const Z = new c.zonesModule.Zones(); Z.set([z])
  const site = c.site
  const s = site.manifest.spine.photo_s + 260
  const at = site.spineAt(s).pos, off = site.spineAt(s + 300).pos
  return { on: Z.densityAt(at.x, -at.z), off: Z.densityAt(off.x, -off.z), pts: z.polygon.length }
})
check(strip.on > 0.7 && strip.off === 0, `the dropped traffic level is a strip of that road (${strip.on} on it, ${strip.off} three hundred metres on, ${strip.pts} points)`)

// 3. selecting keeps the list: the stunt list, with its detail under it
await p.keyboard.press('5'); await p.waitForTimeout(300)
await p.evaluate(() => window.corridor.stunts.select(window.corridor.stunts.doc.fixtures[0].id))
await p.waitForTimeout(300)
const st = await panel()
check(st.detail && st.listH > 40 && st.items === 1 && !!st.sel, `selecting a stunt keeps the list (${st.listH | 0} px) and shows its detail`)

// 4. a click from another mode lands on the thing and takes you to its tab
await p.keyboard.press('2'); await p.waitForTimeout(300)
const gatePx = await p.evaluate(() => {
  const c = window.corridor, cam = window.__ed.camera, site = c.site
  const g = c.races.doc.courses[0].gates[0]
  const x = (g.a[0] + g.b[0]) / 2, y = (g.a[1] + g.b[1]) / 2
  const z = site.groundAt(x, -y) ?? 0
  const V = cam.position.constructor
  const q = new V(x, z, -y).project(cam)
  const r = document.querySelector('canvas').getBoundingClientRect()
  return { x: r.left + ((q.x + 1) / 2) * r.width, y: r.top + ((1 - q.y) / 2) * r.height, id: g.id }
})
await p.mouse.click(gatePx.x, gatePx.y); await p.waitForTimeout(500)
const afterGate = await panel()
const gateSel = await p.evaluate(() => window.corridor.races.selectedGate)
check(afterGate.hash.endsWith(':points') && gateSel === gatePx.id && afterGate.tabs.find((t) => /^Races/.test(t))?.endsWith('*'), `clicking a gate from place mode opens the Courses tab of Points on it (${afterGate.hash.split(':')[1]}, gate ${gateSel}, tabs ${afterGate.tabs.join(' | ')})`)
// and with a piece ARMED, a click is a placement, never a selection of something else
await p.keyboard.press('5'); await p.waitForTimeout(300)
await p.evaluate(() => window.corridor.stunts.arm('hump'))
await p.mouse.click(gatePx.x, gatePx.y); await p.waitForTimeout(600)
const armed = await p.evaluate(() => ({ hash: location.hash, fixtures: window.corridor.stunts.doc.fixtures.length }))
check(armed.hash.endsWith(':stunts') && armed.fixtures === 2, `with a piece armed, the same click places it instead of selecting the gate (${armed.fixtures} fixtures, still in ${armed.hash.split(':')[1]})`)

for (const f of ['stunts', 'zones', 'courses', 'adjustments', 'structures']) {
  const file = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/${f}.json`
  if (existsSync(file)) unlinkSync(file)
}
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
