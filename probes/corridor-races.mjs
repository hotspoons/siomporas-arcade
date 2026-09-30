// Placing a race: gates across the road, in order, and the tracker agreeing with them.
//
// Rich, 2026-09-29: *"where are the waypoints and start and finish fixtures for races?"*
//
// The check that matters is not "a gate was created" — it is that a gate laid by one click is
// SQUARE ACROSS THE ROAD and faces the way the road runs. A gate at an angle still counts crossings
// and still looks like a gate; it just misses the car that takes the inside line, and a gate facing
// backwards counts nobody at all. Both are invisible from above.
import { chromium } from 'playwright'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const FILE = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/courses.json`
if (existsSync(FILE)) unlinkSync(FILE)

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

await p.goto(`http://127.0.0.1:5185/editor.html#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 240000 })
await p.waitForTimeout(7000)
await p.keyboard.press('7')
await p.waitForTimeout(1200)
check(await p.evaluate(() => !!window.corridor.races), 'the races mode is mounted')

const built = await p.evaluate(async () => {
  const { crossing, FORWARD, gateForward, gateWidth, Run, validateCourse } = await import('/src/races.ts')
  const r = window.corridor.races
  const site = window.corridor.site
  const len = site.manifest.spine.length_m
  r.newCourse('stage')

  // a start, two checkpoints and a finish, spaced along the road
  const at = (s) => { const q = site.spineAt(s).pos; return { x: q.x, y: -q.z } }
  const stations = [len * 0.2, len * 0.4, len * 0.6, len * 0.8]
  const roles = ['start', 'checkpoint', 'checkpoint', 'finish']
  for (let i = 0; i < roles.length; i++) {
    r.arm(roles[i])
    r.placeAt(at(stations[i]))
  }
  const c = r.course

  // IS EACH GATE SQUARE ACROSS THE ROAD? Its own direction must match the road's there.
  const square = c.gates.map((g, i) => {
    const d = site.spineAt(stations[i]).dir
    const roadX = d.x, roadY = -d.z
    const f = gateForward(g)
    const n = Math.hypot(roadX, roadY) || 1
    return +(f.x * (roadX / n) + f.y * (roadY / n)).toFixed(3)
  })

  // DRIVE IT, through the tracker, sampling along the real centreline
  const run = new Run(c)
  const events = []
  let prev = at(0)
  for (let s = 10; s <= len; s += 10) {
    const now = at(s)
    events.push(...run.move(s / 10, prev, now))
    prev = now
  }
  return {
    gates: c.gates.length,
    widths: c.gates.map((g) => +gateWidth(g).toFixed(1)),
    square,
    errors: validateCourse(c).errors,
    events: events.map((e) => e.at),
    missed: run.state.missed,
    finished: run.state.finishedAt !== null,
  }
})
console.log(JSON.stringify(built))
check(built.gates === 4, 'four gates placed by four clicks')
// SQUARE ACROSS: a gate's forward must point along the road, not across it. 1 is perfect.
check(built.square.every((d) => d > 0.97), `every gate faces the way the road runs (${built.square.join(', ')})`)
check(built.widths.every((w) => w > 12), `and spans the road with room either side (${built.widths.join(', ')} m)`)
check(built.errors.length === 0, `the course validates (${built.errors.join('; ') || 'no errors'})`)
// DRIVING IT END TO END takes every gate and finishes, with no penalties.
check(built.events.includes('started'), 'driving it crosses the start line')
check(built.finished, 'and the finish line')
check(built.missed === 0, `taking every checkpoint on the way (${built.missed} missed)`)

const saved = await p.evaluate(() => window.corridor.races.save().then(() => 'ok', (e) => 'ERROR ' + e.message))
check(saved === 'ok', `it saved (${saved})`)
check(existsSync(FILE), 'courses.json is on disk')
if (existsSync(FILE)) {
  const doc = JSON.parse(readFileSync(FILE, 'utf8'))
  check(doc.courses?.[0]?.gates?.length === 4, 'with its four gates')
  unlinkSync(FILE)
}
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
