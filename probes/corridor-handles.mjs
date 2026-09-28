// Can you move and rotate something after you have placed it?
//
// Rich, 2026-09-28: "We can't move or rotate the item after we place it, we need handles so we can
// do this." Dragging an object and Q/E to spin it both worked already — and neither was visible,
// which for a person is the same as not existing.
//
// WHAT IS ACTUALLY CHECKED is the write-back, because that is where this goes wrong. The object is
// what three drags; the PLACEMENT is what gets saved, and the two disagree about signs on purpose:
// `y` is `-z`, and the compass bearing is the negative of the rotation (place.ts says why). A
// gizmo that moved the model and wrote the wrong numbers would look perfect in the editor and put
// the barn somewhere else in the game.
//
//   node probes/corridor-handles.mjs [world-slug]
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const WORLD = process.argv[2] ?? 'crofton-triangle'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await page.goto(`http://localhost:${PORT}/world.html?world=${WORLD}#${WORLD}`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForSelector('.seg', { timeout: 30000 })
await page.click('.seg[data-value="place"]')
const up = await page.waitForFunction(() => !!window.corridor?.place, null, { timeout: 90000 }).then(() => true).catch(() => false)
if (!up) { console.log(`\nSKIP: ${WORLD} would not open in Place`); await browser.close(); process.exit(0) }
await page.waitForTimeout(2500)
// the site editor has its own rail: Areas | Place | Grow | Structures
await page.evaluate(() => [...document.querySelectorAll('#se-rail button')].find((b) => /^place$/i.test(b.textContent.trim()))?.click())
await page.waitForTimeout(800)

/* ---- something to hold ---- */
const placed = await page.evaluate(async () => {
  // at the site origin, which always exists — where the camera is pointing is another probe's job
  const ok = await window.corridor.place.addAt('barn-01', 0, 0)
  return ok ? window.__apexPlace.last() : null
})
say('placed', placed && { id: placed.id, asset: placed.asset })
if (!placed) { console.log('\nFAIL:\n  nothing could be placed, so there is nothing to move'); await browser.close(); process.exit(1) }
await page.evaluate((id) => window.corridor.place.select(id), placed.id)
await page.waitForTimeout(700)

/* ---- the handles exist, and say which ones ---- */
const buttons = await page.evaluate(() => [...document.querySelectorAll('#se-inspector .detail button')].map((b) => b.textContent?.trim()))
say('buttons on the item', buttons)
for (const want of ['move (G)', 'rotate (R)']) if (!buttons.includes(want)) fail.push(`no “${want}” control`)

const gizmo = await page.evaluate(() => {
  const g = window.corridor.scene.getObjectByName('place-gizmo')
  return g ? { visible: g.visible } : null
})
say('handles in the scene', gizmo ?? 'absent')
if (!gizmo?.visible) fail.push('the handles are not showing on the selected item')

/* ---- which axes each mode offers ---- */
const axes = await page.evaluate(() => {
  const place = window.corridor.place
  const read = () => ({ x: place.gizmo.showX, y: place.gizmo.showY, z: place.gizmo.showZ, mode: place.gizmo.mode })
  place.setGizmoMode('translate')
  const t = read()
  place.setGizmoMode('rotate')
  const r = read()
  place.setGizmoMode('translate')
  return { translate: t, rotate: r }
})
say('axes', axes)
// a building tilted off the vertical is never what anybody meant, and the document has one angle
if (axes.rotate.x || axes.rotate.z) fail.push('rotation offers pitch and roll, which cannot be saved')
if (!axes.rotate.y) fail.push('rotation offers no yaw')
if (!axes.translate.x || !axes.translate.z) fail.push('moving does not offer the ground plane')

/* ---- and the write-back, with its signs ---- */
const trip = await page.evaluate((id) => {
  const place = window.corridor.place
  const o = [...place.group.children].find((c) => c.userData.placeId === id)
  o.position.set(10, o.position.y, -20)
  o.rotation.y = -Math.PI / 2
  place.gizmo.dispatchEvent({ type: 'objectChange' })
  const p = place.doc.items.find((x) => x.id === id)
  return { x: p.x, y: p.y, yaw: p.yaw_deg, snap: p.snap, dirty: place.dirty }
}, placed.id)
say('dragged to x10 z-20 yaw-90°', trip)
if (trip.x !== 10) fail.push(`x came back as ${trip.x}`)
if (trip.y !== 20) fail.push(`y came back as ${trip.y} — the z sign is wrong, so it saves to the wrong place`)
if (trip.yaw !== 90) fail.push(`yaw came back as ${trip.yaw}° — the bearing sign is wrong, so it faces the wrong way in the game`)
if (!trip.dirty) fail.push('moving it did not mark the document unsaved')

/* ---- nothing selected, no handles ---- */
await page.evaluate(() => window.corridor.place.select(null))
await page.waitForTimeout(400)
const after = await page.evaluate(() => window.corridor.scene.getObjectByName('place-gizmo')?.visible)
say('with nothing selected', after)
if (after) fail.push('the handles are still showing with nothing selected')

if (errs.length) { say('page errors', errs.slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: handles on the selection, yaw only, and the numbers it writes are the right ones')
await browser.close()
process.exit(fail.length ? 1 : 0)
