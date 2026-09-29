// Does an area vertex land where you clicked?
//
// Rich, 2026-09-29: "The draw area tool in the place editor for defining special areas for the map
// drops the points no where near where it was clicked… Also clicking moves the world around - we
// should disable world move and limit to zoom in/out only when dropping pins, and we should make
// it so you can click and drag an area pin as well."
//
// THE MEASUREMENT IS THE WHOLE PROBE. "A vertex was added" passes on a vertex a hundred metres
// away, which is exactly the bug — nothing errored, the point simply appeared somewhere else. So
// this clicks at a known pixel, reads back where the document says the point is, projects that
// site coordinate to the screen itself, and asserts the two pixels agree.
//
// It runs against `world.html`, NOT `editor.html`, on purpose: on the standalone editor page the
// canvas IS the viewport and the bug cannot reproduce. It only appears where the canvas is one
// pane of two.
//
//   node probes/corridor-areas.mjs [world-slug]
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const WORLD = process.argv[2] ?? 'arrowhead-farms'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await page.goto(`http://localhost:${PORT}/world.html?world=${WORLD}#${WORLD}`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForSelector('.seg', { timeout: 30000 })
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle', timeout: 90000 }).catch(() => {}),
  page.click('.seg[data-value="place"]'),
])
const manifest = await page.evaluate(async (w) => (await fetch(`/sites/${w}/web/manifest.json`)).status, WORLD)
if (manifest === 404) { console.log(`\nSKIP: ${WORLD} has no baked site`); await browser.close(); process.exit(0) }
await page.waitForFunction(() => !!window.corridor?.areas, null, { timeout: 120000 })
await page.evaluate(() => [...document.querySelectorAll('#se-rail button')].find((b) => /^areas$/i.test(b.textContent.trim()))?.click())
await page.waitForTimeout(1200)

// THE CANVAS IS NOT THE WINDOW, which is the entire point of this probe.
const box = await page.$eval('#gl', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
say('canvas vs window', { canvas: [Math.round(box.w), Math.round(box.h)], window: [1500, 950], offset: [Math.round(box.x), Math.round(box.y)] })
if (box.w >= 1500 && box.h >= 950) fail.push('the canvas fills the window here — this probe cannot see the bug it exists for')

/* ---- 1 · start a draw, and the camera stops moving ---- */
// THE BUTTON, not the shortcut. `n` means "new world" to the page the site editor is embedded in
// and "new area" to the site editor, and both listen on `window` — pressing it started a polygon
// and threw you out of Place in the same keystroke. That is fixed, and asserted below, but a probe
// should drive the control a person can see.
await page.evaluate(() => [...document.querySelectorAll('#se-inspector button')].find((b) => /draw|new area/i.test(b.textContent))?.click())
await page.waitForTimeout(700)
const drawing = await page.evaluate(() => window.corridor?.areas?.drawing)
say('drawing?', drawing)
if (!drawing) fail.push('the panel offers no way to start drawing an area')

// and the shortcut must no longer take the page with it
const before = await page.evaluate(() => window.__we?.mode?.())
await page.keyboard.press('n')
await page.waitForTimeout(500)
const after = await page.evaluate(() => window.__we?.mode?.())
say('n kept us in Place', { before, after })
if (before === 'place' && after !== 'place') fail.push('pressing n while drawing left the Place mode')
const orbit = await page.evaluate(() => {
  const o = window.corridor.orbit ?? window.__ed?.orbit
  return o ? { rotate: o.enableRotate, pan: o.enablePan, zoom: o.enableZoom } : null
})
say('orbit while drawing', orbit ?? '(no handle)')
if (!orbit) fail.push('cannot see the orbit controls from a probe')
else {
  if (orbit.rotate) fail.push('the world still rotates while dropping pins')
  if (orbit.pan) fail.push('the world still pans while dropping pins')
  if (!orbit.zoom) fail.push('zoom was disabled too — it is the one camera control you want mid-draw')
}

/* ---- 2 · click three points and check WHERE each landed ---- */
const click = async (px, py) => {
  await page.mouse.move(box.x + px, box.y + py)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(450)
}
const spots = [[box.w * 0.30, box.h * 0.45], [box.w * 0.60, box.h * 0.40], [box.w * 0.55, box.h * 0.70]]
for (const [px, py] of spots) await click(px, py)

// project each stored vertex back to the screen with the page's own camera: if the ray was right,
// the pixel comes back where the mouse was
const landed = await page.evaluate(({ box }) => {
  const c = window.corridor
  const draw = c.areas.drawPoints?.() ?? null
  if (!draw) return null
  // a Vector3 without the THREE namespace: clone one the page already has. `window.THREE` is not
  // exported by the bundle and a probe has no business importing three of its own — two copies of
  // a matrix library is how a projection test starts measuring itself.
  const scratch = c.camera.position.clone()
  return draw.map(([x, y]) => {
    const v = scratch.clone()
    v.set(x, c.site.groundAt(x, -y) ?? 0, -y)
    v.project(c.camera)
    return [box.x + ((v.x + 1) / 2) * box.w, box.y + ((1 - v.y) / 2) * box.h]
  })
}, { box })
say('vertices recorded', landed ? landed.length : '(no drawPoints accessor)')
/*
 * THE COUNT FIRST, and this is not a formality.
 *
 * The first run of this probe reported PASS on ZERO vertices: `landed` was an empty array, so the
 * per-vertex loop below never executed and nothing was ever compared. A measurement that is
 * skipped reads exactly like a measurement that succeeded.
 */
if (landed && landed.length !== spots.length) {
  fail.push(`${spots.length} clicks on the ground produced ${landed.length} vertices`)
}

if (!landed) {
  // fall back to the raw document coordinates and a coarse sanity check: three clicks spread
  // across the canvas must not produce three points within a few metres of each other
  const pts = await page.evaluate(() => window.corridor.areas.drawPoints?.() ?? null)
  say('fallback — raw points', pts)
  if (!pts || pts.length !== 3) fail.push(`three clicks produced ${pts ? pts.length : 'no'} vertices`)
} else {
  for (let i = 0; i < landed.length; i++) {
    if (!landed[i]) { fail.push('could not project a vertex back to the screen'); break }
    const want = [box.x + spots[i][0], box.y + spots[i][1]]
    const off = Math.hypot(landed[i][0] - want[0], landed[i][1] - want[1])
    say(`vertex ${i} off by`, `${off.toFixed(1)} px`)
    // a few pixels is the terrain's own slope under a 2 m handle; tens of pixels is the bug
    if (off > 12) fail.push(`vertex ${i} landed ${off.toFixed(0)} px from the click`)
  }
}

/* ---- 3 · close the ring, then DRAG a pin ---- */
// Rich, 2026-09-29: "we should make it so you can click and drag an area pin as well." The drag
// itself has existed since the tool was written — `grab`/`dragTo`/`drop` — but the handles are
// 2.2 m spheres and the ray was missing by tens of metres, so no pointer ever landed on one. This
// is the check that says whether they are reachable, not whether the code exists.
await page.keyboard.press('Enter')
await page.waitForTimeout(900)
const area = await page.evaluate(() => {
  const a = window.corridor.areas.doc.areas.at(-1)
  return a ? { id: a.id, polygon: a.polygon.map(([x, y]) => [x, y]) } : null
})
say('closed the ring', area ? `${area.id}, ${area.polygon.length} vertices` : 'no area')
if (!area) fail.push('three vertices and Enter did not make an area')
else {
  // the camera is free again now the draw is over, so a drag has to be the handle's, not the
  // camera's — which is exactly what a wrong ray could not tell apart
  const target = [box.x + box.w * 0.45, box.y + box.h * 0.62]
  const wantAt = await page.evaluate(({ x, y }) => window.corridor.groundAtPixel(x, y), { x: target[0], y: target[1] })
  const from = await page.evaluate(({ box }) => {
    const c = window.corridor
    const [x, y] = c.areas.doc.areas.at(-1).polygon[0]
    const v = c.camera.position.clone()
    v.set(x, c.site.groundAt(x, -y) ?? 0, -y)
    v.project(c.camera)
    return [box.x + ((v.x + 1) / 2) * box.w, box.y + ((1 - v.y) / 2) * box.h]
  }, { box })
  await page.mouse.move(from[0], from[1])
  await page.mouse.down()
  await page.mouse.move(target[0], target[1], { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(700)

  const moved = await page.evaluate(() => window.corridor.areas.doc.areas.at(-1).polygon[0])
  const cameraMoved = await page.evaluate(() => window.corridor.camera.position.toArray())
  say('pin dragged to', { want: wantAt && [Math.round(wantAt.x), Math.round(wantAt.y)], got: moved.map(Math.round) })
  if (!wantAt) fail.push('the drag target is not over the ground')
  else {
    const off = Math.hypot(moved[0] - wantAt.x, moved[1] - wantAt.y)
    say('pin off by', `${off.toFixed(1)} m`)
    // the handle sits 0.8 m above the ground and the terrain slopes, so a metre or two is honest
    if (off > 3) fail.push(`the pin ended ${off.toFixed(1)} m from where it was dropped`)
    if (Math.hypot(moved[0] - area.polygon[0][0], moved[1] - area.polygon[0][1]) < 1) {
      fail.push('the pin did not move at all — the drag never reached a handle')
    }
  }
  say('camera after the drag', cameraMoved.map(Math.round))
}

if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: points land under the cursor, and the camera holds still while you drop them')
await browser.close()
process.exit(fail.length ? 1 : 0)
