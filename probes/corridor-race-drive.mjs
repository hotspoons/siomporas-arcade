// Author a stage, then DRIVE it: into the throbber, down the countdown, through every gate, finish.
//
// Rich, 2026-09-29: *"Goal for the morning is being able to hook up a rally stage or a circuit from
// waypoints."* This is that goal, end to end and in the game rather than in a unit test — the
// editor writes `courses.json`, the viewer loads it, and a car driven along the real centreline is
// counted by the real session.
//
// The failures it exists to catch are the ones the unit tests cannot see: the file not being loaded
// at all, the throbber sitting somewhere the road does not go, the player's position arriving in
// the wrong frame (site y is north, three's z is south — get that backwards and every gate is
// missed while the clock runs).
import { chromium } from 'playwright'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const FILE = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/courses.json`
if (existsSync(FILE)) unlinkSync(FILE)

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

/* ---- author it in the editor ---------------------------------------------------------------- */
await p.goto(`http://127.0.0.1:5185/editor.html#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 240000 })
await p.waitForTimeout(7000)
await p.keyboard.press('7')
await p.waitForTimeout(1000)

const authored = await p.evaluate(() => {
  const r = window.corridor.races
  const site = window.corridor.site
  const len = site.manifest.spine.length_m
  const at = (s) => { const q = site.spineAt(s).pos; return { x: q.x, y: -q.z } }
  r.doc.courses.length = 0
  r.newCourse('stage')
  // the throbber sits just before the start line, on the road
  const entryS = len * 0.15
  r.arm('entry')
  r.placeAt(at(entryS))
  for (const [role, frac] of [['start', 0.2], ['checkpoint', 0.4], ['checkpoint', 0.6], ['finish', 0.8]]) {
    r.arm(role)
    r.placeAt(at(len * frac))
  }
  r.course.name = 'Morning stage'
  return { gates: r.course.gates.length, entry: r.course.entry, stations: [entryS, len * 0.2, len * 0.8], len }
})
console.log('authored', JSON.stringify(authored))
check(authored.gates === 4 && !!authored.entry, 'a stage with four gates and an entry marker')
const saved = await p.evaluate(() => window.corridor.races.save().then(() => 'ok', (e) => 'ERROR ' + e.message))
check(saved === 'ok', `saved (${saved})`)
check(existsSync(FILE), 'courses.json is on disk')

/* ---- drive it in the game -------------------------------------------------------------------- */
await p.goto(`http://127.0.0.1:5185/index.html?phys=0#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site && !!window.__apex?.races, null, { timeout: 240000 }).catch(() => {})
await p.waitForTimeout(8000)

const drove = await p.evaluate(() => {
 try {
  const ap = window.__apex
  const w = ap.races
  if (!w) return { error: 'the world loaded no races' }
  const site = ap.site
  const len = site.manifest.spine.length_m
  const at = (s) => { const q = site.spineAt(s).pos; return { x: q.x, y: -q.z } }

  const phases = []
  const note = () => { const ph = w.state.phase; if (phases[phases.length - 1] !== ph) phases.push(ph) }
  note()

  // roll into the throbber and sit there a moment
  for (let i = 0; i < 4; i++) { w.tick(at(len * 0.15), 0.1); note() }
  const armed = w.state.phase

  // the countdown: reach the line, then hold while it runs down
  for (let s = len * 0.16; s <= len * 0.21; s += 8) { w.tick(at(s), 0.1); note() }
  const atLine = w.state.phase
  for (let i = 0; i < 40; i++) { w.tick(at(len * 0.21), 0.1); note() }
  const afterCountdown = w.state.phase

  // then drive the stage, ten metres at a time
  for (let s = len * 0.21; s <= len * 0.85; s += 10) { w.tick(at(s), 0.1); note() }

  return {
    armed, atLine, afterCountdown,
    phases,
    phase: w.state.phase,
    result: w.state.result,
    courses: w.courses.length,
    markers: w.markers.length,
  }
 } catch (e) {
  return { error: `${e.message} @ ${String(e.stack).split('\n')[1] ?? ''}` }
 }
})
console.log('drove', JSON.stringify(drove))
check(!drove.error, drove.error ?? 'the game loaded the course')
if (!drove.error) {
  check(drove.courses === 1 && drove.markers === 1, 'one course, one throbber')
  check(drove.armed === 'armed', `driving into the ring commits you (${drove.armed})`)
  check(drove.atLine === 'countdown', `reaching the start line begins the countdown (${drove.atLine})`)
  check(drove.afterCountdown === 'running', `and the clock starts on GO (${drove.afterCountdown})`)
  check(drove.phase === 'finished', `driving the stage finishes it (${drove.phase})`)
  check(!!drove.result && drove.result.penalties === 0,
    `with every checkpoint taken (${drove.result ? drove.result.penalties : '?'}s of penalties)`)
  check(!!drove.result && drove.result.total > 0, `and a real time (${drove.result?.total?.toFixed(2)}s)`)
}

if (existsSync(FILE)) unlinkSync(FILE)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
