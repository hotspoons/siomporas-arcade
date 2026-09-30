// Place a loop from the editor, turn it, drag its ends, save it, reload it.
//
// The unit tests cover the arithmetic; this covers the thing they cannot — that the mode is
// reachable, that a click on the road produces a fixture facing the way the road runs, and that
// what is saved comes back the same. The check that matters is the last one: a fixture whose
// heading is off by 180° places, renders and saves perfectly and simply cannot be driven.
import { chromium } from 'playwright'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const EDITOR = process.env.EDITOR ?? 'http://127.0.0.1:5185/editor.html'
const FILE = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/stunts.json`
const dir = '/tmp/claude-1000/-workspaces-apex-conduit/12eaed6d-83ff-4605-9fb1-f5c0b0bc5019/scratchpad'

if (existsSync(FILE)) unlinkSync(FILE)

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

await p.goto(`${EDITOR}#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 180000 })
await p.waitForTimeout(6000)

await p.keyboard.press('6')
await p.waitForTimeout(1500)
check(await p.evaluate(() => !!window.corridor.stunts), 'the stunts mode is mounted')
check(await p.evaluate(() => [...document.querySelectorAll('.chip')].some((c) => c.textContent === 'Loop')), 'the palette offers a Loop')

// arm the loop and click a point ON the road, the way a person does
const placed = await p.evaluate(() => {
  const st = window.corridor.stunts
  const site = window.corridor.site
  const mid = site.manifest.spine.length_m / 2
  const at = site.spineAt(mid).pos
  st.arm('loop')
  const id = st.placeAt({ x: at.x, y: -at.z })
  const f = st.doc.fixtures.find((x) => x.id === id)
  // what the road is doing there, to compare the heading against
  const d = site.spineAt(mid).dir
  return { id, yaw: f.yaw_deg, roadYaw: (Math.atan2(-d.z, d.x) * 180) / Math.PI, entry: f.entry?.s, exit: f.exit?.s, kind: f.entry?.kind, mid }
})
console.log('placed', JSON.stringify(placed))
check(!!placed.id, 'a click on the road placed one')
// THE HEADING IS THE ROAD'S. Backwards is the one mistake that looks right from above.
check(Math.abs(placed.yaw - placed.roadYaw) < 1, `it faces the way the road runs (${placed.yaw.toFixed(1)}° against ${placed.roadYaw.toFixed(1)}°)`)
check(placed.kind === 'road', `snapped, both its ends are road ends (${placed.kind})`)
check(placed.entry < placed.mid && placed.exit > placed.mid, 'its two ends straddle it along the road')

/*
 * THE BAKED ROAD STOPS. Counting road vertices with and without the skip is the only way to see
 * this: the fixture's own ribbon is drawn either way, so the two pictures look nearly identical.
 *
 * Only the `road` group is walked. Traversing the whole site — terrain tiles, trees, buildings —
 * crashed the swiftshader page outright.
 */
const suppressed = await p.evaluate(() => {
  const road = window.corridor.site.group.getObjectByName('road')
  if (!road) return { error: 'no road group' }
  /*
   * COUNT ONLY WHAT IS VISIBLE. The base road is built once and KEPT — a stunt hides it and shows a
   * holed copy over the top, so the base geometry is still in the graph and a blind traversal
   * counts both and reports the road getting BIGGER when a hole is punched in it.
   */
  const count = () => {
    let n = 0
    road.traverse((o) => {
      if (!o.visible) return
      let up = o.parent
      while (up) { if (!up.visible) return; up = up.parent }
      if (o.isMesh && o.geometry?.getAttribute?.('position')) n += o.geometry.getAttribute('position').count
    })
    return n
  }
  const withFixture = count()
  // EFFECTIVE visibility: the base road is hidden by setting its GROUP invisible, so its meshes
  // are each still `visible: true` and counting those alone reports nothing hidden.
  const shown = (o) => { let up = o; while (up) { if (!up.visible) return false; up = up.parent }; return true }
  let hidden = 0
  road.traverse((o) => { if (o.isMesh && !shown(o)) hidden++ })
  window.corridor.site.setRoadSkip(null)
  const whole = count()
  return { withFixture, whole, hidden, baseKept: hidden > 0 }
})
console.log('road vertices', JSON.stringify(suppressed))

check(!suppressed.error, 'the road group is there to measure')
check(suppressed.whole > suppressed.withFixture,
  `the road has a hole where the loop stands (${suppressed.withFixture} vertices, against ${suppressed.whole} with the whole road)`)
/*
 * AND THE BASE OSM ROAD IS STILL THERE. Rich, 2026-09-29: "would require all of these fixtures to
 * be layers on top of the map instead of baked into it, the underlying OSM data should exist and
 * the stunts modify on top of the base data." So the check is not only that the hole appears — it
 * is that clearing the skip brings the whole road back WITHOUT a rebuild, which is only possible
 * if the base geometry was kept.
 */
check(suppressed.baseKept, `the base road is kept and merely hidden (${suppressed.hidden} hidden road meshes while a fixture stands)`)

const meshed = await p.evaluate(() => {
  let ribbons = 0
  window.corridor.stunts.group.traverse((o) => { if (o.isMesh) ribbons++ })
  return ribbons
})
check(meshed >= 3, `the approach, the stunt and the exit are all built (${meshed} ribbons)`)

// drag the entry handle up the road, and confirm it moved along the road rather than to the pointer
const dragged = await p.evaluate(() => {
  const st = window.corridor.stunts
  const site = window.corridor.site
  const f = st.doc.fixtures[0]
  const before = f.entry.s
  const target = site.spineAt(Math.max(0, before - 200)).pos
  st.grabbed = 'entry' // the handle a person would have grabbed
  st.dragTo({ x: target.x + 40, y: -target.z + 40 }) // deliberately OFF the road
  const after = f.entry.s
  st.drop()
  return { before, after }
})
check(Math.abs(dragged.after - (dragged.before - 200)) < 30, `dragging an end slides it ALONG the road (${dragged.before.toFixed(0)} → ${dragged.after.toFixed(0)} m)`)

const saved = await p.evaluate(() => window.corridor.stunts.save().then((m) => m, (e) => 'ERROR ' + e.message))
console.log('save:', saved)
check(!String(saved).startsWith('ERROR'), 'it saved')
check(existsSync(FILE), 'stunts.json is on disk')
if (existsSync(FILE)) {
  const doc = JSON.parse(readFileSync(FILE, 'utf8'))
  check(doc.fixtures?.length === 1 && doc.fixtures[0].piece === 'loop', 'and it is a loop')
  check(doc.fixtures[0].entry?.kind === 'road' && doc.fixtures[0].exit?.kind === 'road', 'with both ends recorded as road ends')
}

/*
 * A TRACK IN A FIELD.
 *
 * Rich, 2026-09-29: *"we should have the ability to toggle this off and place the pieces freely,
 * then click waypoints to add them back to a section of road - or not have them link to roads at
 * all. That way I can build complete stunt tracks in a field."*
 *
 * The three things that have to be true of that: a free placement goes WHERE YOU CLICKED rather
 * than onto the nearest road, it comes up with both ends open, and two free pieces can be joined to
 * each other by the same curve that joins one to a road.
 */
const field = await p.evaluate(() => {
  const st = window.corridor.stunts
  const site = window.corridor.site
  /*
   * A POINT JUST OFF THE ROAD — thirty metres, well inside the snapping radius. Four hundred metres
   * out would pass whether the toggle worked or not, because there is nothing near enough to snap
   * to: the check has to be made where snapping WOULD fire.
   */
  const here = site.spineAt(site.manifest.spine.length_m / 2).pos
  const spot = { x: here.x + 30, y: -here.z + 30 }
  st.snapToRoad = false
  st.select(null)
  st.arm('loop')
  // the id FIRST: calling placeAt inside a find() predicate places one per fixture examined
  const aId = st.placeAt(spot)
  const a = st.doc.fixtures.find((f) => f.id === aId)
  // and a second one beyond it, which should arrive joined to the first
  st.arm('corkscrew')
  const bId = st.placeAt({ x: spot.x + 220, y: spot.y + 30 })
  const b = st.doc.fixtures.find((f) => f.id === bId)
  const built = st.group.getObjectByName(`fixture:${b.id}`)
  let approach = 0
  built?.traverse((o) => { if (o.isMesh && o.name === `approach:${b.id}`) approach++ })
  return {
    wanted: spot,
    at: a.at,
    away: Math.hypot(a.at[0] - spot.x, a.at[1] - spot.y),
    aEnds: [a.entry?.kind ?? 'none', a.exit?.kind ?? 'none'],
    bEntry: b.entry,
    aExit: a.exit,
    approach,
  }
})
console.log('field', JSON.stringify(field))
check(field.away < 0.2, `a free placement stays where you clicked (${field.away.toFixed(2)} m from the pointer, not dragged to a road)`)
check(field.aEnds[0] === 'none', 'and comes up with its entry open')
check(field.bEntry?.kind === 'fixture' && field.bEntry.id, `the next piece arrives joined to it (${field.bEntry?.kind}: ${field.bEntry?.id})`)
check(field.aExit?.kind === 'fixture', 'and the first one knows it, so both panels tell the truth')
check(field.approach === 1, `the join is drawn once, as a curve (${field.approach} approach ribbon)`)

/*
 * AND THE ENDS GO BACK ONTO A ROAD BY CLICKING ONE.
 *
 * "click waypoints to add them back to a section of road": arm the end, click the tarmac. What
 * makes this worth a probe rather than a unit test is that the click has to be taken by the LINK
 * rather than by the selection — clicking a road while a link is armed must not deselect.
 */
const joined = await p.evaluate(() => {
  const st = window.corridor.stunts
  const site = window.corridor.site
  const f = st.doc.fixtures[st.doc.fixtures.length - 1]
  st.select(f.id)
  const at = site.spineAt(site.manifest.spine.length_m / 2 + 300).pos
  st.link('exit', 'road')
  st.click({ x: at.x, y: -at.z })
  const built = st.group.getObjectByName(`fixture:${f.id}`)
  let departure = 0
  built?.traverse((o) => { if (o.isMesh && o.name === `departure:${f.id}`) departure++ })
  return { end: f.exit, still: st.selected === f.id, linking: st.linking, departure }
})
console.log('joined', JSON.stringify(joined))
check(joined.end?.kind === 'road', `clicking the road joins the end to it (${joined.end?.kind} at ${joined.end?.s?.toFixed(0)} m)`)
check(joined.still, 'and does not deselect the piece it belongs to')
check(joined.linking === null, 'the pick is over once it is taken')
check(joined.departure === 1, 'and a curve now leaves it for the road')

/*
 * THE GIZMO. Rich, 2026-09-29: *"Make sure the pieces can be moved and rotated with a gizmo."*
 *
 * The handles cannot be dragged headlessly, so this drives what a drag drives: the anchor object
 * the gizmo is attached to, followed by the tool's own `objectChange` handler. That is the whole
 * path from a handle to the document, and it is the path that was broken for placements.
 */
const gizmo = await p.evaluate(() => {
  const st = window.corridor.stunts
  const f = st.doc.fixtures[st.doc.fixtures.length - 1]
  st.select(f.id)
  const g = st.gizmo
  const anchor = st.anchor
  const before = { at: [...f.at], yaw: f.yaw_deg, attached: g?.object === anchor, mode: st.gizmoModeNow }
  anchor.position.x += 25
  anchor.position.z -= 10
  g.dispatchEvent({ type: 'objectChange' })
  const moved = [...f.at]
  st.setGizmoMode('rotate')
  anchor.rotation.y += Math.PI / 4
  g.dispatchEvent({ type: 'objectChange' })
  return { before, moved, yaw: f.yaw_deg, rings: g.showY && !g.showX, helper: !!st.group.getObjectByName('stunt-gizmo') }
})
console.log('gizmo', JSON.stringify(gizmo))
check(gizmo.helper, 'the piece has a gizmo on it')
check(gizmo.before.attached, 'attached to the selected fixture')
check(Math.abs(gizmo.moved[0] - (gizmo.before.at[0] + 25)) < 0.6 && Math.abs(gizmo.moved[1] - (gizmo.before.at[1] + 10)) < 0.6,
  `dragging it moves the piece (${gizmo.before.at.map((n) => n.toFixed(0))} → ${gizmo.moved.map((n) => n.toFixed(0))})`)
check(Math.abs(((gizmo.yaw - gizmo.before.yaw) % 360 + 360) % 360 - 45) < 0.5,
  `and turning it turns the piece (${gizmo.before.yaw.toFixed(0)}° → ${gizmo.yaw.toFixed(0)}°)`)
check(gizmo.rings, 'the turn mode shows the yaw ring and nothing else')

// back to the way the rest of this probe expects to find things
await p.evaluate(() => {
  const st = window.corridor.stunts
  for (const f of [...st.doc.fixtures]) if (f.id !== st.doc.fixtures[0].id) st.remove(f.id)
  st.snapToRoad = true
  st.setGizmoMode('translate')
  st.select(st.doc.fixtures[0].id)
})

/*
 * THE THINGS YOU DO TO ONE AFTER YOU HAVE PLACED IT.
 *
 * Rich, 2026-09-29: *"doesn't seem to be a way to delete stunts after you place them"*. Delete
 * worked; there was no CONTROL that said so, which is not the same thing. So this asserts the
 * buttons exist and that each one does what it says.
 */
const buttons = await p.evaluate(() =>
  [...document.querySelectorAll('.inspector-body button')].map((b) => b.textContent.trim()))
check(buttons.includes('remove'), `there is a way to remove one (${buttons.join(', ')})`)
check(buttons.includes('turn it round'), 'and a one-click fix for a backwards fixture')

const turned = await p.evaluate(() => {
  const before = window.corridor.stunts.doc.fixtures[0].yaw_deg
  ;[...document.querySelectorAll('.inspector-body button')].find((b) => b.textContent.trim() === 'turn it round').click()
  return { before, after: window.corridor.stunts.doc.fixtures[0].yaw_deg }
})
// normalise the turn into 0…360 and compare with 180. The first version subtracted 180 twice and
// reported a perfect half turn as a 180° error.
const turn = (((turned.after - turned.before) % 360) + 360) % 360
const delta = Math.abs(turn - 180)
check(delta < 1, `turning it round is a half turn (${turned.before.toFixed(0)}° → ${turned.after.toFixed(0)}°)`)

// AND A BACKWARDS FIXTURE MUST STILL SAVE, because the editor's preview saves everything first and
// one fixture halfway through being turned must not block the whole site.
const savedBackwards = await p.evaluate(() => window.corridor.stunts.save().then(() => 'ok', (e) => 'ERROR ' + e.message))
check(savedBackwards === 'ok', `a fixture facing the wrong way still saves (${savedBackwards})`)

const removed = await p.evaluate(() => {
  ;[...document.querySelectorAll('.inspector-body button')].find((b) => b.textContent.trim() === 'remove')?.click()
  // THE FIXTURE'S OWN MESHES, not everything in the group: the gizmo's helper lives there too and
  // counting it reports a removed fixture as still in the world
  let meshes = 0
  for (const c of window.corridor.stunts.group.children) {
    if (!c.name.startsWith('fixture:')) continue
    c.traverse((o) => { if (o.isMesh) meshes++ })
  }
  const gizmoShown = window.corridor.stunts.group.getObjectByName('stunt-gizmo-host')?.visible
  return { left: window.corridor.stunts.doc.fixtures.length, meshes, gizmoShown }
})
check(removed.left === 0, 'remove takes it out of the document')
// AND OUT OF THE SCENE. A fixture deleted from the document but left in the world is the failure
// that looks like the button not working.
check(removed.meshes === 0, `and out of the world (${removed.meshes} meshes left)`)
// AND THE HANDLES GO WITH IT. A gizmo left floating where a deleted piece was is the clearest
// possible way to say the delete did not work.
check(removed.gizmoShown === false, 'and the gizmo goes with it')

// put one back for the picture
await p.evaluate(() => {
  const site = window.corridor.site
  const at = site.spineAt(site.manifest.spine.length_m / 2).pos
  window.corridor.stunts.arm('loop')
  window.corridor.stunts.placeAt({ x: at.x, y: -at.z })
})
await p.waitForTimeout(800)

// look at it from the side
await p.evaluate(() => {
  const site = window.corridor.site
  const mid = site.manifest.spine.length_m / 2
  const a = site.spineAt(mid - 60).pos
  const c = site.spineAt(mid + 60).pos
  const here = site.spineAt(mid).pos
  const heading = Math.atan2(-(c.z - a.z), c.x - a.x)
  const cam = window.corridor.camera
  cam.position.set(here.x - Math.sin(heading) * 150, here.y + 45, here.z - Math.cos(heading) * 150)
  cam.lookAt(here.x, here.y + 18, here.z)
  window.corridor.orbitTarget.set(here.x, here.y + 18, here.z)
})
await p.waitForTimeout(2500)
await p.screenshot({ path: `${dir}/stuntmode.png` })
console.log('shot', `${dir}/stuntmode.png`)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
