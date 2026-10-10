// The Route 3 jam, as authored through the MCP tools and nothing else: does it play?
//
// The level `crofton-jam` names a hero build, a traffic set, a program and (through the world's own
// documents) four traffic zones and a five-gate stage on Robert Crain Highway. This loads it the
// way Rich would, then checks each thing the tools claimed to have made is really in the world —
// and drives the stage by teleporting the car through the ring and the gates, which is enough to
// prove the race, the program and the win are wired to each other.
import { chromium } from 'playwright'

const VIEWER = process.env.VIEWER ?? 'http://127.0.0.1:5185/index.html'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: [
  'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} })',
  'export const updateStyle = () => {}', 'export const removeStyle = () => {}', 'export const injectQuery = (u) => u', 'export const ErrorOverlay = class {}', 'export default {}',
].join('\n') }))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

await p.goto(`${VIEWER}#crofton-triangle?level=crofton-jam`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site, null, { timeout: 240000 })
await p.waitForFunction(() => !!window.__apex?.game && !!window.__apex?.traffic, null, { timeout: 180000 }).catch(() => {})
await p.waitForTimeout(2000)
const r = await p.evaluate(async () => {
  const ap = window.__apex
  const out = { traffic: ap.traffic?.count ?? null, problems: ap.traffic?.problems ?? null, game: !!ap.game, goal: ap.game?.goalText ?? null, races: ap.races?.courses?.map((c) => c.id) ?? [], physics: !!ap.physics, driving: !!ap.drive?.on, car: ap.car?.constructor?.name ?? null }
  const doc = await (await fetch('/sites/crofton-triangle/courses.json')).json()
  const course = doc.courses.find((c) => c.id === 'route-3-jam')
  out.gates = course?.gates.length ?? 0
  // the jam is where the tools said it would be
  const mid = course ? course.gates[2] : null
  if (mid) {
    const mx = (mid.a[0] + mid.b[0]) / 2, my = (mid.a[1] + mid.b[1]) / 2
    out.densityAtCheckpoint = ap.traffic?.zones.densityAt(mx, my) ?? null
    out.densityFarAway = ap.traffic?.zones.densityAt(mx + 3000, my + 3000) ?? null
  }
  // how many traffic cars stand within 300 m of the course's start
  const { Transform } = await import('/src/actors.ts')
  const g0 = course?.gates[0]
  if (g0) {
    const sx = (g0.a[0] + g0.b[0]) / 2, sy = (g0.a[1] + g0.b[1]) / 2
    out.carsNearStart = ap.traffic.entities.filter((e) => Math.hypot(Transform.x[e] - sx, Transform.y[e] - sy) < 300).length
  }
  return out
})
console.log(JSON.stringify(r))
check(r.traffic > 100, `the level's traffic set put cars on the map (${r.traffic})`)
check(r.problems && r.problems.length === 0, `and every build in the set had a model (${(r.problems ?? []).join('; ') || 'no problems'})`)
check(r.densityAtCheckpoint >= 0.8 && r.densityFarAway === 0, `the jam is on Route 3 and nowhere else (checkpoint ${r.densityAtCheckpoint}, 3 km away ${r.densityFarAway})`)
check(r.carsNearStart > 10, `cars are queued near the start (${r.carsNearStart} within 300 m)`)
check(r.races.includes('route-3-jam') && r.gates === 5, `the stage is in the world with its five gates (${r.races.join(', ')})`)
check(r.game && /ring/i.test(r.goal ?? ''), `the program is running and set its goal ("${r.goal}")`)
check(r.driving && r.car === 'RapierCar', `the program put the player in the car (${r.car})`)

// now race it: through the ring, the countdown, and every gate, by teleport
const race = await p.evaluate(async () => {
  const ap = window.__apex
  const car = ap.car
  const doc = await (await fetch('/sites/crofton-triangle/courses.json')).json()
  const course = doc.courses.find((c) => c.id === 'route-3-jam')
  const dt = 1 / 30
  const phases = []
  const step = (x, y) => {
    // site (x east, y north) -> three (x, z south); the car's yaw is three's
    car.place(x, -y, 0)
    ap.races.tick({ x, y }, dt)
    ap.game.tick(dt)
    const ph = ap.races.state.phase
    if (phases[phases.length - 1] !== ph) phases.push(ph)
  }
  // into the ring (arms the race), then through each gate: from 6 m before to 6 m after, along
  // the road's direction (a->b is the left normal). The START gate begins the countdown and
  // gates crossed during it do not count, so the car waits it out before the checkpoints.
  step(course.entry.x, course.entry.y)
  for (let i = 0; i < 30; i++) step(course.entry.x, course.entry.y)
  for (const g of course.gates) {
    const lx = g.b[0] - g.a[0], ly = g.b[1] - g.a[1]
    const len = Math.hypot(lx, ly) || 1
    const fx = ly / len, fy = -lx / len
    const mx = (g.a[0] + g.b[0]) / 2, my = (g.a[1] + g.b[1]) / 2
    for (let k = -6; k <= 6; k += 2) step(mx + fx * k, my + fy * k)
    const wait = g.role === 'start' ? 30 * 5 : 15
    for (let i = 0; i < wait; i++) step(mx + fx * 8, my + fy * 8)
  }
  for (let i = 0; i < 30; i++) ap.game.tick(dt)
  const st = ap.races.state
  return { phases, phase: st.phase, time: +st.time.toFixed(1), penalties: st.penalties, outcome: ap.game.outcome, score: ap.game.score, messages: ap.game.messages.map((m) => m.text) }
})
console.log(JSON.stringify(race))
check(race.phases.includes('countdown') && race.phases.includes('running'), `driving into the ring committed the car and started the race (${race.phases.join(' → ')})`)
check(race.phase === 'finished' && race.penalties === 0, `every gate counted, in order, with no penalty (${race.phase}, ${race.penalties} penalties, ${race.time} s)`)
check(race.outcome === 'win' && race.score > 0, `and the program saw the finish and awarded the win (${race.outcome}, ${race.score} pts)`)
check(race.messages.some((m) => /^Go\./.test(m)), `the program spoke at the start ("${race.messages[0] ?? ''}")`)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
