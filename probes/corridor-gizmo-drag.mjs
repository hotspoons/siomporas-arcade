// Does the gizmo actually MOVE and TURN a placement?
//
// Rich, 2026-09-29: *"clicking and dragging does nothing. It highlights like it is going to do
// something but nothing happens."*
//
// The cause was three listeners on one event. `place.ts` held the camera off with a CAPTURE-phase
// `pointerdown` on the canvas that called `stopPropagation()` — and stopping propagation from a
// capture listener ON THE TARGET cancels that target's bubble phase too, which is where
// TransformControls registers. So the gizmo highlighted on hover (`pointermove` was untouched) and
// never saw the press.
//
// Nothing about that is visible from outside: `enabled`, `object`, `axis` and the helper were all
// correct. Only a real press, driven through the browser's own event path, can tell — which is why
// this probe uses `page.mouse` rather than calling the class.
import { chromium } from 'playwright'
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1000, height: 700 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 250)))
await p.goto('http://127.0.0.1:5185/editor.html#frederick-i70', { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 240000 })
await p.waitForTimeout(9000)
await p.keyboard.press('2')
await p.waitForTimeout(1200)

// select one and fly the camera close so the gizmo is big on screen
const info = await p.evaluate(() => {
  const place = window.corridor.place
  const id = place.doc.items[0].id
  place.select(id)
  const o = place.objects.get(id)
  const cam = window.corridor.camera
  cam.position.set(o.position.x + 25, o.position.y + 18, o.position.z + 25)
  cam.lookAt(o.position)
  window.corridor.orbitTarget.copy(o.position)
  cam.updateMatrixWorld(true)
  const v = o.position.clone().project(cam)
  return {
    id,
    before: { x: place.doc.items[0].x, y: place.doc.items[0].y, yaw: place.doc.items[0].yaw_deg },
    screen: { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight },
    mode: place.gizmoMode,
  }
})
console.log('setup', JSON.stringify(info))
await p.waitForTimeout(1500)

// hover across the gizmo to find a handle, reporting what TransformControls thinks
for (const [dx, dy] of [[0, 0], [30, 0], [-30, 0], [0, -30], [0, 30], [22, 22], [50, 0]]) {
  await p.mouse.move(info.screen.x + dx, info.screen.y + dy)
  await p.waitForTimeout(120)
  const axis = await p.evaluate(() => window.corridor.place.gizmo?.axis ?? null)
  if (axis) { console.log('axis at offset', dx, dy, '->', axis); break }
}

console.log('gizmo state', JSON.stringify(await p.evaluate(() => {
  const g = window.corridor.place.gizmo
  return {
    axis: g?.axis ?? null,
    enabled: g?.enabled,
    dragging: g?.dragging,
    hasObject: !!g?.object,
    mode: g?.mode,
    showX: g?.showX, showY: g?.showY, showZ: g?.showZ,
    domIsCanvas: g?.domElement === document.querySelector('canvas'),
    proto: Object.getPrototypeOf(g)?.constructor?.name,
  }
})))

// INSTRUMENT: which handlers actually run, and what they decide
await p.evaluate(() => {
  const g = window.corridor.place.gizmo
  const log = (window.__log = [])
  const wrap = (name) => {
    const fn = g[name]
    if (typeof fn !== 'function') { log.push(`no ${name}`); return }
    g[name] = function (...a) { log.push(name); return fn.apply(this, a) }
  }
  wrap('pointerDown')
  wrap('pointerMove')
  wrap('pointerUp')
  const canvas = document.querySelector('canvas')
  canvas.addEventListener('pointerdown', () => log.push('canvas pointerdown (bubble)'), false)
  canvas.addEventListener('pointerdown', () => log.push('canvas pointerdown (capture)'), true)
  addEventListener('pointerdown', (e) => log.push(`window capture: target=${e.target?.tagName ?? e.target}`), true)
  document.addEventListener('pointerdown', () => log.push('document capture'), true)
  addEventListener('mousedown', (e) => log.push(`window mousedown: target=${e.target?.tagName}`), true)
  g.addEventListener('dragging-changed', (e) => log.push(`dragging-changed ${e.value}`))
})

// a real drag: down, several moves, up
await p.mouse.down()
for (let i = 1; i <= 8; i++) {
  await p.mouse.move(info.screen.x + 30 + i * 6, info.screen.y)
  await p.waitForTimeout(40)
}
await p.mouse.up()
await p.waitForTimeout(600)

console.log('LOG', JSON.stringify(await p.evaluate(() => window.__log)))
// AND THE ROTATOR. `G` swaps the handles; the ring must then turn the placement rather than move it.
await p.evaluate(() => { window.corridor.place.setGizmoMode('rotate'); window.__log.length = 0 })
await p.waitForTimeout(400)
const yawBefore = await p.evaluate(() => window.corridor.place.doc.items[0].yaw_deg)
for (const [dx, dy] of [[0, 0], [26, 0], [-26, 0], [0, 26], [0, -26], [18, 18], [40, 0], [-40, 0]]) {
  await p.mouse.move(info.screen.x + dx, info.screen.y + dy)
  await p.waitForTimeout(100)
  if (await p.evaluate(() => window.corridor.place.gizmo?.axis)) break
}
await p.mouse.down()
for (let i = 1; i <= 10; i++) { await p.mouse.move(info.screen.x + 40 + i * 5, info.screen.y + i * 4); await p.waitForTimeout(40) }
await p.mouse.up()
await p.waitForTimeout(500)
console.log('ROTATE', JSON.stringify(await p.evaluate(() => ({
  axis: window.corridor.place.gizmo?.axis,
  log: window.__log.filter((l) => !l.includes('capture') && !l.includes('mousedown')),
  yawNow: window.corridor.place.doc.items[0].yaw_deg,
}))), 'was', yawBefore)

const after = await p.evaluate(() => {
  const place = window.corridor.place
  const it = place.doc.items[0]
  return { x: it.x, y: it.y, yaw: it.yaw_deg, dragging: place.dragging, dirty: place.dirty }
})
console.log('after', JSON.stringify(after))

check(info.before.x !== after.x, `dragging the move handle moved it (${info.before.x} -> ${after.x})`)
check(yawBefore !== after.yaw, `dragging the turn ring turned it (${yawBefore}° -> ${after.yaw}°)`)
check(after.dirty, 'and the document knows it changed')
check(!after.dragging, 'and the drag ended cleanly')

console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
