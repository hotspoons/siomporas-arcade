// Click anything in the editor and land on its panel.
//
// Rich, 2026-09-29: *"clicking stunts from the areas tab would focus the stunt and activate the
// stunts tab… would love to be able to click anything from the editor and have it highlighted in
// the place editor on the right."*
//
// The thing that makes this worth a probe rather than a unit test is the PRECEDENCE. A cross-mode
// pick that is too eager takes clicks away from the tool you are using — you go to deselect an area
// and end up in the traffic panel — so the rules are: a tool mid-gesture keeps every click, a tool
// that has something of its own under the pointer keeps the click, and only then does the editor
// follow what else is there.
import { chromium } from 'playwright'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const EDITOR = process.env.EDITOR ?? 'http://127.0.0.1:5185/editor.html'
const FILE = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/stunts.json`
if (existsSync(FILE)) unlinkSync(FILE)

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1200, height: 820 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

await p.goto(`${EDITOR}#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 180000 })
await p.waitForTimeout(6000)

// put a stunt on the road, then go back to the areas tab
const made = await p.evaluate(() => {
  const st = window.corridor.stunts
  const site = window.corridor.site
  const at = site.spineAt(site.manifest.spine.length_m / 2).pos
  st.arm('loop')
  const id = st.placeAt({ x: at.x, y: -at.z })
  return { id, at: [at.x, -at.z] }
})
check(!!made.id, 'a fixture is on the road')

await p.keyboard.press('1') // areas
await p.waitForTimeout(800)
check(await p.evaluate(() => window.corridor.mode() === 'areas'), 'and the editor is on the areas tab')

/*
 * THE ASK: click the loop while in areas, and arrive at the loop's own panel.
 * `routeClick` is what the canvas calls, so this is the same path a click takes.
 */
const jumped = await p.evaluate((at) => {
  // deselect first, or "it is selected" proves nothing — it was selected when it was placed
  window.corridor.stunts.select(null)
  window.corridor.click({ x: at[0], y: at[1] })
  return {
    mode: window.corridor.mode(),
    selected: window.corridor.stunts.selected,
    panel: (document.querySelector('.inspector-body')?.textContent ?? '').slice(0, 60),
  }
}, made.at)
console.log('jumped', JSON.stringify(jumped))
check(jumped.mode === 'stunts', `clicking a fixture from another tab activates the stunts tab (${jumped.mode})`)
check(jumped.selected === made.id, `and selects the one you clicked (${jumped.selected})`)

/*
 * AND THE PRECEDENCE. Drawing an area must keep its own clicks — otherwise every vertex you place
 * inside a traffic zone throws you into the traffic panel mid-polygon.
 */
const whileDrawing = await p.evaluate((at) => {
  const a = window.corridor.areas
  window.corridor.setMode('areas')
  a.startDraw()
  const before = window.corridor.mode()
  window.corridor.click({ x: at[0], y: at[1] })
  const after = window.corridor.mode()
  const verts = a.drawing ? 'still drawing' : 'not drawing'
  a.startDraw?.() // leave it tidy for the next check
  return { before, after, verts }
}, made.at)
console.log('while drawing', JSON.stringify(whileDrawing))
check(whileDrawing.after === 'areas', `a tool mid-gesture keeps its clicks (${whileDrawing.after})`)

if (existsSync(FILE)) unlinkSync(FILE)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
