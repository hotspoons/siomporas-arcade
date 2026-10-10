// Every mode's things in every mode; the active mode bolder and first on a click; the frame banner
// only when the roads say so.
//
// Rich, 2026-10-10: *"An ask I had early on was for all of the tabs assets to be visible from all
// other tabs in the place editor, so traffic zones will show up when you are in the structures tab,
// this never happened. The active tab's items should appear bolder than other tabs items and be
// first on selection when clicking."* — and, of the Traffic tab's frame banner on
// dc-metro-take-2: *"This screenshot about zones.json is bullshit."*
//
// Run against a dev server with the world's zones (WORLDEDITOR_REMOTE serves dc-metro-take-2):
//   EDITOR=http://127.0.0.1:5195/editor.html SLUG=dc-metro-take-2 node probes/corridor-editor-layers.mjs
// Screenshots go to $OUT (default /tmp). It never saves: the off-frame copy is served by a route
// intercept, moved in memory, and thrown away.
import { chromium } from 'playwright'

const SLUG = process.env.SLUG ?? 'crofton-triangle'
const EDITOR = process.env.EDITOR ?? 'http://127.0.0.1:5195/editor.html'
const OUT = process.env.OUT ?? '/tmp'

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
p.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message.slice(0, 300)) })
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
const t0 = Date.now()

await p.goto(`${EDITOR}#${SLUG}:structures`, { waitUntil: 'domcontentloaded', timeout: 180000 })
await p.waitForFunction(() => !!window.corridor?.site && !!window.corridor?.layers, null, { timeout: 900000, polling: 1000 })
await p.waitForTimeout(3000)
console.log(`booted ${SLUG} in ${((Date.now() - t0) / 1000).toFixed(0)} s`)

const zones = await p.evaluate(() => window.corridor.traffic.doc.zones.map((z) => ({ id: z.id, name: z.name, n: z.polygon.length })))
console.log('zones', JSON.stringify(zones))
check(zones.length > 0, `${SLUG} has traffic zones to look at (${zones.length})`)

/** a point inside zone i: the midpoint of a strip's opposite vertices, else the centroid */
const inside = (i) => p.evaluate((i) => {
  const poly = window.corridor.traffic.doc.zones[i].polygon
  const pin = (x, y) => { let h = false; for (let a = 0, c = poly.length - 1; a < poly.length; c = a++) { const [xi, yi] = poly[a], [xj, yj] = poly[c]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) h = !h } return h }
  const n = poly.length
  for (const f of [0.5, 0.25, 0.75]) { const k = Math.floor((n / 2) * f); const m = [(poly[k][0] + poly[n - 1 - k][0]) / 2, (poly[k][1] + poly[n - 1 - k][1]) / 2]; if (pin(m[0], m[1])) return m }
  let x = 0, y = 0; for (const q of poly) { x += q[0]; y += q[1] } return [x / n, y / n]
}, i)

/** look straight down at a point from `h` metres */
const lookAt = (pt, h) => p.evaluate(([pt, h]) => {
  const c = window.corridor
  const z = c.site.groundAt(pt[0], -pt[1]) ?? c.site.heightAt(pt[0], pt[1])
  c.orbitTarget.set(pt[0], z, -pt[1])
  c.camera.position.set(pt[0], z + h, -pt[1] + 1)
  c.orbit.update()
}, [pt, h])

const zoneState = () => p.evaluate(() => {
  const g = window.corridor.traffic.group
  const fills = [], lines = []
  g.traverse((o) => {
    if (o.userData.zoneId) fills.push(+o.material.opacity.toFixed(3))
    else if (o.isLine2) lines.push(+o.material.linewidth.toFixed(2))
  })
  return { visible: g.visible, fills: fills.slice(0, 3), lines: lines.slice(0, 3), mode: window.corridor.mode() }
})

// ---- 1. visible from Structures, quieter -----------------------------------------------------------
const at0 = await inside(0)
await lookAt(at0, Number(process.env.HEIGHT ?? 2500))
await p.evaluate(() => window.corridor.setMode('structures'))
await p.waitForTimeout(1500)
const passive = await zoneState()
console.log('in structures', JSON.stringify(passive))
check(passive.mode === 'structures', 'the editor is on the Structures tab')
check(passive.visible && passive.fills.length > 0, 'traffic zones are drawn while in Structures')
await p.screenshot({ path: `${OUT}/layers-${SLUG}-structures.png` })

await p.evaluate(() => window.corridor.setMode('traffic'))
await p.waitForTimeout(1500)
const active = await zoneState()
console.log('in traffic', JSON.stringify(active))
check(active.fills[0] > passive.fills[0] * 1.5, `the active mode's zones are bolder: fill ${active.fills[0]} vs ${passive.fills[0]}`)
check(active.lines[0] > passive.lines[0], `and their outlines wider: ${active.lines[0]} px vs ${passive.lines[0]} px`)
const labels = await p.evaluate(() => window.corridor.layers.labels())
check(zones.every((z) => labels.includes(z.name)), `the active mode's names are on the map (${labels.slice(0, 5).join(' · ')})`)
await p.screenshot({ path: `${OUT}/layers-${SLUG}-traffic.png` })

// ---- 2. a click on a zone from Structures goes to Traffic, with it selected --------------------------
await p.evaluate(() => { window.corridor.traffic.select(null); window.corridor.setMode('structures') })
await p.waitForTimeout(500)
const ranked = await p.evaluate((pt) => window.corridor.layers.hitsAt({ x: pt[0], y: pt[1] }), at0)
console.log('under the pointer, in order', JSON.stringify(ranked))
const jumped = await p.evaluate((pt) => {
  window.corridor.click({ x: pt[0], y: pt[1] })
  return { mode: window.corridor.mode(), selected: window.corridor.traffic.selected, row: document.querySelector('#inspector .item.sel .nm, .item.sel .nm')?.textContent ?? null }
}, at0)
console.log('clicked', JSON.stringify(jumped))
check(jumped.mode === 'traffic', `clicking a zone from Structures switches to Traffic (${jumped.mode})`)
check(jumped.selected === zones[0].id, `with that zone selected (${jumped.selected})`)
check(jumped.row === zones[0].name, `and its row highlighted in the panel (${jumped.row})`)

// hover, through the real canvas: project the point and move the mouse there
await p.evaluate(() => window.corridor.setMode('structures'))
const px = await p.evaluate((pt) => {
  const c = window.corridor
  const z = c.site.groundAt(pt[0], -pt[1]) ?? c.site.heightAt(pt[0], pt[1])
  const v = c.camera.position.clone().set(pt[0], z, -pt[1]).project(c.camera)
  const r = document.querySelector('#gl').getBoundingClientRect()
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
}, at0)
await p.mouse.move(px.x, px.y)
await p.mouse.move(px.x + 1, px.y + 1)
await p.waitForTimeout(400)
const hov = await p.evaluate(() => window.corridor.layers.hovered())
check(hov === `traffic:${zones[0].id}`, `hovering a zone from Structures outlines it (${hov})`)
await p.screenshot({ path: `${OUT}/layers-${SLUG}-hover.png` })

// ---- 3. the frame: no banner over zones that sit on the road -----------------------------------------
await p.evaluate(() => { window.corridor.setMode('traffic'); window.corridor.traffic.panelTab = 'placed'; window.corridor.traffic.select(null) })
await p.waitForTimeout(500)
const frame = await p.evaluate(() => {
  const f = window.corridor.traffic.frame
  return { state: f?.state ?? null, measure: f?.measure ?? null, stamp: window.corridor.traffic.doc.frame ?? null, banner: document.querySelectorAll('.framewarn').length }
})
console.log('frame verdict', JSON.stringify(frame))
check(frame.banner === 0, `no frame banner over ${SLUG}'s zones (${frame.state})`)
check(frame.state === 'stamped' || frame.state === 'fits', `they measure as in the bake's frame (${frame.state})`)

// …and an off-frame copy of the same file still gets the offer. Served in place of zones.json,
// picked up by the editor's own look at the disk (store/docwatch.ts) — the path an MCP write takes.
const original = await p.evaluate(() => window.corridor.traffic.doc.zones.map((z) => z.polygon))
const conv = await p.evaluate(() => window.corridor.site.manifest.frame)
const unmove = ([x, y]) => {
  const t = (-conv.utm_convergence_deg * Math.PI) / 180, s = 1 / (conv.utm_scale ?? 1)
  return [Math.round(s * (Math.cos(t) * x - Math.sin(t) * y) * 10) / 10, Math.round(s * (Math.sin(t) * x + Math.cos(t) * y) * 10) / 10]
}
const offDoc = await p.evaluate(() => structuredClone(window.corridor.traffic.doc))
delete offDoc.frame
for (const z of offDoc.zones) z.polygon = z.polygon.map(unmove)
await p.route(`**/sites/${SLUG}/zones.json`, (r) => r.request().method() === 'GET' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(offDoc, null, 1) }) : r.abort())
const reloaded = await p.evaluate(() => window.corridor.layers.poll())
await p.evaluate(() => { window.corridor.traffic.panelTab = 'placed'; window.corridor.setMode('traffic') })
await p.waitForTimeout(500)
const off = await p.evaluate(() => {
  const f = window.corridor.traffic.frame
  const b = document.querySelector('.framewarn')
  return { state: f?.state ?? null, measure: f?.measure ?? null, text: b?.textContent ?? null, button: b?.querySelector('button')?.textContent ?? null, first: window.corridor.traffic.doc.zones[0].polygon[0] }
})
console.log('off-frame copy', JSON.stringify({ reloaded, ...off }))
// the editor's own eight-second look may have got there first; what matters is what it now holds
check(off.first[0] === offDoc.zones[0].polygon[0][0] && off.first[1] === offDoc.zones[0].polygon[0][1], `a zones.json changed on disk is reloaded into the editor (${reloaded.join(', ') || 'by the timer'})`)
check(off.state === 'old' && !!off.text, `the off-frame copy is caught: ${off.text}`)
check(off.button === 'Move them into this frame', 'with a one-click move')
await p.screenshot({ path: `${OUT}/layers-${SLUG}-offframe.png` })
await p.unroute(`**/sites/${SLUG}/zones.json`)
const moved = await p.evaluate(() => {
  document.querySelector('.framewarn button').click()
  const t = window.corridor.traffic
  return { polys: t.doc.zones.map((z) => z.polygon), dirty: t.dirty, state: t.frame?.state, banner: document.querySelectorAll('.framewarn').length }
})
let worst = 0
moved.polys.forEach((poly, i) => poly.forEach((q, k) => { worst = Math.max(worst, Math.hypot(q[0] - original[i][k][0], q[1] - original[i][k][1])) }))
check(worst < 0.5, `the move puts every vertex back within ${worst.toFixed(2)} m of where it belongs`)
check(moved.dirty && moved.banner === 0, 'and leaves the file unsaved, with the banner gone')
// put the real document back without saving anything
await p.evaluate(() => window.corridor.traffic.load(window.corridor.site.manifest.slug, (x, y) => window.corridor.site.groundAt(x, -y) ?? window.corridor.site.heightAt(x, y), window.corridor.site))

check(errors.length === 0, `no page errors (${errors.length})`)
await b.close()
console.log(bad ? `${bad} FAILED` : 'all ok')
process.exit(bad ? 1 : 0)
