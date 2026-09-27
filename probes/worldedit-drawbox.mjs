// Drawing a world is dragging a box.
//
// Rich, 2026-09-27, first time using it: "when creating a world, you need to be able to drag the
// bounding box and modify the corners as the first interaction. Right now not very intuitive."
//
// It was a polygon tool — click to drop a vertex, click the first one again to close, right-click
// to undo — which is the right interface for an arbitrary shape and the wrong one here, because
// the bake takes a SQUARE about a centre and the polygon was only ever reduced to the smallest
// circle containing it.
//
// This drives real pointer events at the canvas rather than calling methods, because the whole
// complaint was about the gesture, and a test that calls setBox() directly would pass on a build
// where the mouse does nothing at all.
//
//   PORT=5185 node probes/worldedit-drawbox.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
// WAIT FOR BOOT, not just for the handle. `window.__we` is assigned when the module finishes
// evaluating; `boot()` runs after that and ends by calling setMode() itself, so a mode set in
// between is silently undone. Waiting on `config()` was not enough — it arrives before that last
// setMode — and the failure was intermittent because it raced the world list. `ready()` is the
// last line of boot.
await page.waitForFunction(() => window.__we?.ready?.() === true, null, { timeout: 60000 })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

const ring = () => page.evaluate(() => window.__we.map.ring.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]))
const closed = () => page.evaluate(() => window.__we.map.ringClosed)
const box = () => page.evaluate(() => {
  const r = window.__we.map.ring
  if (r.length !== 4) return null
  return {
    west: Math.min(...r.map((p) => p.lon)), east: Math.max(...r.map((p) => p.lon)),
    south: Math.min(...r.map((p) => p.lat)), north: Math.max(...r.map((p) => p.lat)),
  }
})
const drag = async (from, to, steps = 12) => {
  await page.mouse.move(from[0], from[1])
  await page.mouse.down()
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps)
  }
  await page.mouse.up()
}
/** Where a lon/lat sits on screen right now, so a handle can be grabbed by its real position. */
const screenOf = (lon, lat) => page.evaluate(([lon, lat]) => {
  const [x, y] = window.__we.map.toScreen({ lon, lat })
  const r = document.querySelector('canvas').getBoundingClientRect()
  return [x + r.left, y + r.top]
}, [lon, lat])

await page.evaluate(() => window.__we.setMode('define'))
await page.waitForFunction(() => window.__we.map.mode === 'draw', null, { timeout: 10000 })

// ── one drag makes a world ────────────────────────────────────────────────────────────────────
await drag([420, 330], [700, 560])
const first = await box()
ok('a single drag produces a closed four-point box',
  (await ring()).length === 4 && (await closed()) === true && !!first,
  first ? `${(await ring()).length} points, closed` : `ring is ${JSON.stringify(await ring())}`)
ok('and it is axis-aligned, which is what the bake takes',
  first && first.east > first.west && first.north > first.south,
  first ? `${(first.east - first.west).toFixed(4)}° x ${(first.north - first.south).toFixed(4)}°` : 'no box')

// ── and the panel measured it ─────────────────────────────────────────────────────────────────
//
// HERE, straight after the first clean drag, and not at the end of the file. Run last it measured
// whatever the flip test happened to leave — a 315 m box — and went red about one run in three.
// A check that depends on the state four unrelated tests left behind is testing them, not it.
//
// Against the panel's STATE, not its innerText: scraping for the words "centre" and "half-width"
// is a test of the labels, and the labels are what this change is churning.
await page.waitForFunction(() => !!window.__we.define.preview, null, { timeout: 30000 }).catch(() => {})
const measured = await page.evaluate(() => {
  const p = window.__we.define.preview
  return p ? { radius_m: p.circle.radius_m, ways: p.selection.square.ways, extent: !!window.__we.map.extent } : null
})
ok('the box was measured', !!measured && measured.radius_m > 0,
  measured ? `${measured.radius_m} m half-width, ${measured.ways} ways` : 'no preview came back')
ok('and the map drew the square the bake will take', !!measured?.extent, `extent ${measured?.extent}`)

/*
 * None of what these panels used to say.
 *
 * THE SLUGS, NOT THE WORD. An earlier version of this checked for "crofton" and went red on every
 * run — because "Crofton Parkway" is a real road in the extract and the Spine dropdown lists it,
 * correctly. A check that cannot tell a hardcoded reference from a place name is a check that
 * bans a place from existing.
 */
const panel = await page.evaluate(() => document.querySelector('.inspector')?.textContent ?? '')
for (const gone of ['radius_m is the bake', 'crofton-triangle', 'crofton-crownsville', '4/π', 'SQUARE of side', 'for scale']) {
  ok(`no monologue: "${gone}"`, !panel.toLowerCase().includes(gone.toLowerCase()), 'absent')
}

// ── the corners move ──────────────────────────────────────────────────────────────────────────
const nw = await screenOf(first.west, first.north)
await drag(nw, [nw[0] - 120, nw[1] - 90])
const grown = await box()
ok('dragging the north-west corner grows the box from that corner',
  grown.west < first.west && grown.north > first.north
  && Math.abs(grown.east - first.east) < 1e-9 && Math.abs(grown.south - first.south) < 1e-9,
  `west ${first.west.toFixed(4)}→${grown.west.toFixed(4)}, east held at ${grown.east.toFixed(4)}`)

// ── an edge moves one side only ───────────────────────────────────────────────────────────────
const eMid = await screenOf(grown.east, (grown.north + grown.south) / 2)
await drag(eMid, [eMid[0] + 80, eMid[1] + 60])
const wider = await box()
ok('dragging the east edge moves only that edge',
  wider.east > grown.east
  && Math.abs(wider.west - grown.west) < 1e-9
  && Math.abs(wider.north - grown.north) < 1e-9 && Math.abs(wider.south - grown.south) < 1e-9,
  `east ${grown.east.toFixed(4)}→${wider.east.toFixed(4)}, the other three unchanged`)

// ── the middle moves the whole thing without resizing it ──────────────────────────────────────
const mid = await screenOf((wider.east + wider.west) / 2, (wider.north + wider.south) / 2)
const sizeBefore = [wider.east - wider.west, wider.north - wider.south]
await drag(mid, [mid[0] + 70, mid[1] - 50])
const moved = await box()
const sizeAfter = [moved.east - moved.west, moved.north - moved.south]
ok('dragging the middle moves the box without resizing it',
  moved.west > wider.west && moved.north > wider.north
  && Math.abs(sizeAfter[0] - sizeBefore[0]) < 1e-6 && Math.abs(sizeAfter[1] - sizeBefore[1]) < 1e-6,
  `moved, size ${sizeBefore[0].toFixed(4)}° → ${sizeAfter[0].toFixed(4)}°`)

// ── a corner dragged past the far side flips rather than inverting ────────────────────────────
const se = await screenOf(moved.east, moved.south)
const far = await screenOf(moved.west, moved.north)
await drag(se, [far[0] - 60, far[1] - 60])
const flipped = await box()
ok('dragging a corner past the opposite one flips the box rather than inverting it',
  flipped && flipped.east > flipped.west && flipped.north > flipped.south,
  `${(flipped.east - flipped.west).toFixed(4)}° x ${(flipped.north - flipped.south).toFixed(4)}°, still positive`)

// ── a click is not a gesture ──────────────────────────────────────────────────────────────────
// It used to drop a vertex, so a stray click while reading the panel silently started a polygon.
const before = await ring()
await page.mouse.click(1100, 200)
await page.waitForTimeout(150)
ok('a stray click outside the box changes nothing',
  JSON.stringify(await ring()) === JSON.stringify(before), 'ring unchanged')

await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: a world is a box you drag')
process.exit(fails.length ? 1 : 0)
