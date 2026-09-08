#!/usr/bin/env node
// Headless check of the COASTLINE world builder. A typecheck cannot tell you
// whether dragging a waypoint moves the road, so this drives the editor with a
// real pointer: it builds a track from nothing, bends it by its handles, places
// a prop, a scene change, two vibe shifts, an ocean front and a crossroads,
// raises a hill in the profile strip, undoes it, smooths the corners out, forks
// into a second track in the set view, saves, and drives the result — then
// checks the built-in route still drives untouched.
//
//   just dev coast          # in one terminal
//   just editor-smoke       # in another
//
// APEX_URL overrides the target. Exits non-zero on any failed check or console error.

import { chromium } from 'playwright'

const url = process.env.APEX_URL ?? 'http://localhost:5182'
let failures = 0

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const logs = []
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`))
page.on('console', (m) => {
  if (m.type() === 'error') logs.push(`[error] ${m.text()}`)
})
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)

await page.evaluate(() => {
  const g = window.__apex.game
  g.openEditor()
  g.editor.setWorld({ v: 1, name: 'Hand built', start: 't1', tracks: [{ id: 't1', name: 'One', nodes: [{ x: 0, z: 0, y: 0 }, { x: 0, z: 600, y: 0 }, { x: 0, z: 1200, y: 0 }], scenes: [{ at: 0, scene: 'coast' }], vibes: [{ at: 0, vibe: 'day' }], props: [], spans: [], crossings: [], next: [] }] }, null)
  g.editor.action('mode-track')
})
await page.waitForTimeout(400)

const box = await page.evaluate(() => {
  const r = document.querySelector('.editor canvas.plan').getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
})
/** Canvas point for a world position, in page coordinates. */
const at = async (x, z) => {
  const p = await page.evaluate(([x, z]) => window.__apex.game.editor.toPx(x, z), [x, z])
  return { x: box.x + p.x, y: box.y + p.y }
}
const state = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__apex.game.editor.current)))
// A point on the road itself, a fraction of the way along. Anything that has to land *on* the road
// uses this rather than a waypoint's raw coordinates: the plan view stretches the lateral axis, so a
// point beside the road can be hundreds of pixels away even when it is metres away in the world.
const onRoad = (frac) =>
  page.evaluate((f) => {
    const path = window.__apex.game.editor.path()
    const s = { s: 0, x: 0, z: 0, y: 0, heading: 0, bank: 0 }
    path.at(f * path.length, s)
    return { x: s.x, z: s.z }
  }, frac)
const tool = async (label) => {
  // Exact text: "Palm" must not pick "Palm coast".
  await page.click(`.editor .palette .tool span:text-is("${label}")`)
  await page.waitForTimeout(60)
}
const clickPx = async (fx, fy) => {
  await page.mouse.click(box.x + box.w * fx, box.y + box.h * fy)
  await page.waitForTimeout(80)
}
const clickAt = async (x, z) => {
  const p = await at(x, z)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(80)
}
/** Drag from a world point by a pixel offset. Distances across the road are exaggerated in the plan
 *  view, so a drag written in metres can fly off the canvas; when the test cares about "pull this
 *  sideways a bit", pixels are what it means. */
const dragPx = async (from, dx, dy, steps = 8) => {
  const a = await at(from[0], from[1])
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + (dx * i) / steps, a.y + (dy * i) / steps)
  await page.mouse.up()
  await page.waitForTimeout(90)
}
const dragAt = async (from, to, steps = 8) => {
  const a = await at(from[0], from[1])
  const b = await at(to[0], to[1])
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps)
  await page.mouse.up()
  await page.waitForTimeout(90)
}

/** Re-fit the plan view. A drag written in world metres can put a waypoint far outside the canvas —
 *  the lateral axis is exaggerated — and a click on a point that is off-screen reaches no element. */
const refit = async () => {
  await page.evaluate(() => window.__apex.game.editor.action('fit'))
  await page.waitForTimeout(80)
}

const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
}

// 1. Extend the road with the waypoint tool, past the far end of what is there.
await tool('Add waypoint')
await clickPx(0.62, 0.14)
await clickPx(0.74, 0.06)
let w = await state()
check('waypoint tool appends', w.tracks[0].nodes.length === 5, `${w.tracks[0].nodes.length} nodes`)

// 2. Drag a waypoint.
await tool('Select / move')
await dragAt([0, 600], [-260, 600])
w = await state()
check('drag moves a waypoint', Math.abs(w.tracks[0].nodes[1].x + 260) < 40, `x=${w.tracks[0].nodes[1].x}`)
await refit()

// 3. Select it, then drag its out-handle (the road should get longer).
const before = await page.evaluate(() => window.__apex.game.editor.path().length)
await clickAt(w.tracks[0].nodes[1].x, w.tracks[0].nodes[1].z)
const h = await page.evaluate(() => {
  // The auto out-handle of a smooth node is a sixth of the chord through its neighbours.
  const ns = window.__apex.game.editor.current.tracks[0].nodes
  return { x: ns[1].x + (ns[2].x - ns[0].x) / 6, z: ns[1].z + (ns[2].z - ns[0].z) / 6 }
})
await dragPx([h.x, h.z], -220, 120)
w = await state()
const after = await page.evaluate(() => window.__apex.game.editor.path().length)
check('handle drag bends the road', w.tracks[0].nodes[1].outX !== undefined && Math.abs(after - before) > 1, `len ${before.toFixed(0)} → ${after.toFixed(0)}, handle ${w.tracks[0].nodes[1].outX?.toFixed(0)},${w.tracks[0].nodes[1].outZ?.toFixed(0)}`)

await refit()

// 4. Place a prop beside the road.
await tool('Palm')
const p2 = w.tracks[0].nodes[2]
await clickAt(p2.x + 26, p2.z + 8)
w = await state()
check('prop placed beside the road', w.tracks[0].props.length === 1, JSON.stringify(w.tracks[0].props[0]))

// 5. A scene change part-way along.
await tool('Downtown')
await clickAt(w.tracks[0].nodes[3].x, w.tracks[0].nodes[3].z)
w = await state()
check('scene stop added', w.tracks[0].scenes.length === 2 && w.tracks[0].scenes[1].scene === 'city', JSON.stringify(w.tracks[0].scenes))

// 6. Two vibe shifts.
await tool('Sunset')
await clickAt(w.tracks[0].nodes[2].x, w.tracks[0].nodes[2].z)
await tool('Night')
await clickAt(w.tracks[0].nodes[4].x, w.tracks[0].nodes[4].z)
w = await state()
check('two vibe shifts along the track', w.tracks[0].vibes.length === 3, w.tracks[0].vibes.map((v) => `${v.vibe}@${v.at.toFixed(2)}`).join(' '))

// 7. Drag an ocean front along part of the road.
await tool('Ocean front · left')
const shoreA = await onRoad(0.08)
const shoreB = await onRoad(0.3)
await dragAt([shoreA.x, shoreA.z], [shoreB.x, shoreB.z])
w = await state()
check('macro element dragged out', w.tracks[0].spans.length === 1 && w.tracks[0].spans[0].kind === 'shore', JSON.stringify(w.tracks[0].spans[0]))

// 8. A crossroads.
await tool('Crossroads')
await clickAt(w.tracks[0].nodes[3].x, w.tracks[0].nodes[3].z)
w = await state()
check('crossroads placed', w.tracks[0].crossings.length === 1)

// 9a. A waypoint cannot be dragged into a cliff.
await page.click('.editor .palette .tool span:text-is("Select / move")')
const tall = await page.evaluate(() => {
  const ed = window.__apex.game.editor
  const before = ed.track.nodes[2].y
  ed.pushUndo()
  ed.setNodeHeight(2, 5000)
  return { before, after: ed.track.nodes[2].y, limit: ed.path().heightRange(2).hi, grade: ed.report().maxGrade }
})
check('a waypoint cannot be dragged into a cliff', tall.after < tall.limit + 0.2 && tall.after < 500 && tall.grade <= 0.33, JSON.stringify(tall))
await page.keyboard.down('Control')
await page.keyboard.press('KeyZ')
await page.keyboard.up('Control')
await page.waitForTimeout(80)

// 9. Elevation from the profile strip: drag a waypoint up.
const pbox = await page.evaluate(() => {
  const r = document.querySelector('.editor canvas.profile').getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
})
const nodeStripX = await page.evaluate(() => {
  const ed = window.__apex.game.editor
  return ed.stripX(ed.path().nodeS[2] / ed.path().length, document.querySelector('.editor canvas.profile'))
})
const nodeStripY = await page.evaluate(() => window.__apex.game.editor.profileY(0))
await page.mouse.move(pbox.x + nodeStripX, pbox.y + nodeStripY)
await page.mouse.down()
await page.mouse.move(pbox.x + nodeStripX, pbox.y + nodeStripY - 30, { steps: 6 })
await page.mouse.up()
await page.waitForTimeout(90)
w = await state()
check('profile strip raises a waypoint', w.tracks[0].nodes[2].y > 3, `y=${w.tracks[0].nodes[2].y}`)

// 10. Undo puts the height back.
await page.keyboard.down('Control')
await page.keyboard.press('KeyZ')
await page.keyboard.up('Control')
await page.waitForTimeout(80)
w = await state()
check('undo works', Math.abs(w.tracks[0].nodes[2].y) < 0.01, `y=${w.tracks[0].nodes[2].y}`)

// 11. Smooth opens the corners out.
const tight = await page.evaluate(() => window.__apex.game.editor.report().minRadius)
await page.click('.editor button[data-act="smooth"]')
await page.waitForTimeout(120)
const loose = await page.evaluate(() => window.__apex.game.editor.report().minRadius)
check('smooth opens corners out', loose >= tight, `${Math.round(tight)} m → ${Math.round(loose)} m`)

// 12. Add a second track and fork into it from the set view.
await page.click('.editor button[data-act="mode-set"]')
await page.waitForTimeout(150)
await page.click('.editor .palette .tool:has-text("New track")')
await page.waitForTimeout(150)
const ports = await page.evaluate(() => {
  const ed = window.__apex.game.editor
  const r = document.querySelector('.editor canvas.plan').getBoundingClientRect()
  const out = {}
  for (const t of ed.current.tracks) {
    const o = ed.setToPx(t.ui?.x ?? 0, t.ui?.y ?? 0)
    out[t.id] = { port: { x: r.left + o.x + 168 * ed.setView.scale, y: r.top + o.y + 33 * ed.setView.scale }, body: { x: r.left + o.x + 60 * ed.setView.scale, y: r.top + o.y + 33 * ed.setView.scale } }
  }
  return out
})
await page.mouse.move(ports.t1.port.x, ports.t1.port.y)
await page.mouse.down()
await page.mouse.move(ports.t2.body.x, ports.t2.body.y, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(150)
w = await state()
check('dragging a port links two tracks', w.tracks[0].next.includes('t2'), JSON.stringify(w.tracks.map((t) => `${t.id}→${t.next}`)))

// 13. The swell control, the check dialog, and save / open round-trip.
await page.click('.editor button[data-act="mode-track"]')
await page.waitForTimeout(150)
await page.click('.editor .palette .tool:has-text("Swell")')
await page.waitForTimeout(120)
const rolled = await page.evaluate(() => window.__apex.game.editor.track.roll)
check('swell control changes the roll', Boolean(rolled) && rolled.amp !== 3.2, JSON.stringify(rolled))

await page.click('.editor button[data-act="check"]')
await page.waitForTimeout(300)
const reportLines = await page.$$eval('.editor-dialog .report li', (ls) => ls.length)
check('check dialog reports on every track', reportLines >= 3, `${reportLines} lines`)
await page.screenshot({ path: 'shots/ed-check.png' })
await page.click('.editor-dialog .buttons button')
await page.waitForTimeout(150)

await page.click('.editor button[data-act="save"]')
await page.waitForTimeout(200)
const saved = await page.evaluate(() => ({ id: window.__apex.game.editor.currentId, list: window.__apex.game.worlds.list().map((x) => x.name) }))
check('save puts the world in the store', Boolean(saved.id) && saved.list.includes('Hand built'), JSON.stringify(saved))

await page.screenshot({ path: 'shots/ed-hand.png' })

// 14. Escape leaves the editor for the title, where the world can be chosen. (This used the Menu
// button while the engine's keyboard edges were mid-rewrite and Escape latched; that has landed.)
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
const onTitle = await page.evaluate(() => ({ state: window.__apex.game.state, hidden: document.querySelector('.editor').classList.contains('hidden') }))
check('Escape leaves the editor for the title', onTitle.state === 'title' && onTitle.hidden, JSON.stringify(onTitle))
const rows = await page.$$eval('.menu .items .item .label', (ls) => ls.map((l) => l.textContent.trim()))
check('the title menu offers WORLD and BUILD A WORLD', rows.some((r) => r.startsWith('WORLD')) && rows.some((r) => r.startsWith('BUILD A WORLD')), rows.slice(0, 6).join(' | '))
check('and a way straight back to the editor', rows.some((r) => r.includes('BACK TO THE EDITOR')), '')

// 15. Pick the saved world on the title screen and drive it from there.
await page.evaluate(() => {
  const g = window.__apex.game
  g.settings.update((d) => {
    d.world = 'user:0'
    d.startStage = 't1'
  })
  g.applyWorld()
  g.startRun()
})
await page.waitForTimeout(300)
await page.keyboard.down('KeyW')
await page.waitForTimeout(3800)
await page.keyboard.up('KeyW')
const fromTitle = await page.evaluate(() => ({ world: window.__apex.game.route.worldName, stage: window.__apex.snap.stageId, z: Math.round(window.__apex.snap.z), total: window.__apex.snap.hud.stagesTotal }))
check('the saved world drives from the title screen', fromTitle.world === 'Hand built' && fromTitle.z > 40 && fromTitle.total === 2, JSON.stringify(fromTitle))
await page.screenshot({ path: 'shots/ed-title-run.png' })

// 16. And the built-in route is still the default and still drives.
await page.evaluate(() => {
  const g = window.__apex.game
  g.quitToTitle()
  g.settings.update((d) => {
    d.world = 'builtin'
    d.startStage = 'A'
  })
  g.applyWorld()
  g.startRun()
})
await page.waitForTimeout(300)
await page.keyboard.down('KeyW')
await page.waitForTimeout(3800)
await page.keyboard.up('KeyW')
const builtin = await page.evaluate(() => ({ world: window.__apex.game.route.worldName, stage: window.__apex.snap.stageId, z: Math.round(window.__apex.snap.z), total: window.__apex.snap.hud.stagesTotal }))
check('the built-in route still drives', builtin.world === 'Coast to Coast' && builtin.stage === 'A' && builtin.z > 40 && builtin.total === 7, JSON.stringify(builtin))
await page.screenshot({ path: 'shots/ed-builtin-run.png' })

// 17. Unsaved work survives a reload.
await page.evaluate(() => {
  const g = window.__apex.game
  g.openEditor()
  g.editor.action('mode-track')
  g.editor.pushUndo()
  g.editor.track.name = 'Survived the crash'
  g.editor.changed()
})
await page.waitForTimeout(1200)
const parked = await page.evaluate(() => Boolean(localStorage.getItem('apex-coast.editor.draft.v1')))
check('an edit is parked in the browser a beat later', parked)

await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.evaluate(() => window.__apex.game.openEditor())
await page.waitForTimeout(400)
const prompt = await page.evaluate(() => document.querySelector('.editor-dialog p')?.textContent ?? '')
check('the editor offers the unsaved work back after a reload', /Unsaved edits/.test(prompt), prompt.slice(0, 90))
await page.click('.editor-dialog .buttons button.primary')
await page.waitForTimeout(400)
const recovered = await page.evaluate(() => ({ names: window.__apex.game.editor.current.tracks.map((t) => t.name), marked: document.querySelector('.editor [data-title]').textContent }))
check('and picking it up restores the edit', recovered.names.includes('Survived the crash') && recovered.marked.startsWith('•'), JSON.stringify(recovered))

// 18. Saving clears the draft, so the next open does not nag.
await page.click('.editor button[data-act="save"]')
await page.waitForTimeout(300)
const afterSave = await page.evaluate(() => ({ draft: localStorage.getItem('apex-coast.editor.draft.v1'), title: document.querySelector('.editor [data-title]').textContent }))
check('saving clears the draft and the unsaved marker', afterSave.draft === null && !afterSave.title.startsWith('•'), JSON.stringify(afterSave))

console.log(logs.length ? `\nCONSOLE:\n${logs.join('\n').slice(0, 3000)}` : '\nno console errors')
await browser.close()
if (failures || logs.length) {
  console.error(`\n${failures} check${failures === 1 ? '' : 's'} failed, ${logs.length} console message${logs.length === 1 ? '' : 's'}`)
  process.exit(1)
}
console.log('\neditor smoke: all checks passed')
