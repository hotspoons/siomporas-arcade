// Can you DRIVE the loop — in the game, with no flags, the way Rich opens it?
//
// Rich, 2026-09-29: *"stunts still not drivable"* — after a probe had already shown the trimesh
// collider existing and a ray hitting it. Both were true. `probes/corridor-stunt-drive.mjs` loads
// the viewer with `?phys=1`; the game does not. `PHYS_ENABLED` is 0, so there was no physics world
// for a fixture's trimesh to go into, and the default car follows `groundAt` — one height per
// column, which cannot describe a surface that is above itself.
//
// So the thing to prove is not that a collider CAN exist. It is that opening a world with a loop in
// it, pressing Tab and driving gets you onto the loop. No query parameters anywhere in this file.
import { chromium } from 'playwright'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const FILE = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/stunts.json`
const VIEWER = process.env.VIEWER ?? 'http://127.0.0.1:5185/index.html'
/*
 * THE PIECE THIS DRIVES BY DEFAULT.
 *
 * A hump by default; `PIECE=loop` passes too since 2026-09-29 (the stop at the loop's entry was a
 * trimesh internal-edge ghost collision — see the engine's terrain.ts `addSurface` — and the
 * stunt assist holds the car over the top). This probe is about the fixture being a road: driven
 * into, driven over, driven off; `MPS=30` holds an entry speed.
 *
 * `PIECE=loop node probes/corridor-stunt-drivable.mjs` runs the other one.
 */
const PIECE = process.env.PIECE ?? 'hump'

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({
  status: 200,
  contentType: 'application/javascript',
  /*
   * A STUB, NOT A BLOCK. Vite rewrites every module to import this for `import.meta.hot`, so
   * aborting it stops the app loading at all — measured: the site never appeared and the run timed
   * out after four minutes. Fulfilling it with the same shape and no websocket keeps the modules
   * loading and stops HMR navigating away mid-drive, which destroys the page's execution context
   * and throws the measurement away.
   */
  body: [
    'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} })',
    'export const updateStyle = () => {}',
    'export const removeStyle = () => {}',
    'export const injectQuery = (u) => u',
    'export const ErrorOverlay = class {}',
    'export default {}',
  ].join('\n'),
}))
if (existsSync(FILE)) unlinkSync(FILE)
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

// read the road first, so the loop lands on it
await p.goto(`${VIEWER}#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site, null, { timeout: 240000 })
await p.waitForTimeout(6000)

const noStunts = await p.evaluate(() => ({ physics: !!window.__apex.physics, stunts: !!window.__apex.stunts }))
/*
 * THE CONTROL, AND IT COMES FIRST. A world with no fixtures must be exactly as it was: no physics,
 * no cost, nothing changed. Without this the "it starts its own physics" check below would pass
 * just as well if physics had simply been switched on for everybody.
 */
check(!noStunts.physics, 'a world with no stunts runs with no physics, as it always has')

const where = await p.evaluate(() => {
  const site = window.__apex.site
  const mid = site.manifest.spine.length_m / 2
  const a = site.spineAt(mid - 60).pos
  const c = site.spineAt(mid + 60).pos
  const here = site.spineAt(mid).pos
  const start = site.spineAt(mid - 260)
  return {
    at: [here.x, -here.z],
    yaw: (Math.atan2(-(c.z - a.z), c.x - a.x) * 180) / Math.PI,
    entry: mid - 140,
    exit: mid + 140,
    // a run-up: on the road, well before the approach curve leaves it
    from: { x: start.pos.x, z: start.pos.z, yaw: Math.atan2(start.dir.z, start.dir.x), s: mid - 260 },
  }
})
writeFileSync(FILE, JSON.stringify({
  version: 1,
  fixtures: [{
    id: 'drivable-loop', name: 'The loop', piece: PIECE, style: 'stuntin',
    at: where.at, yaw_deg: where.yaw,
    entry: { kind: 'road', chain: 0, s: where.entry },
    exit: { kind: 'road', chain: 0, s: where.exit },
  }],
}, null, 1))

await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site && !!window.__apex?.stunts, null, { timeout: 240000 }).catch(() => {})
await p.waitForTimeout(9000)

const started = await p.evaluate(() => ({
  physics: !!window.__apex.physics,
  surfaces: window.__apex.physics?.stuntSurfaces?.() ?? [],
  fixtures: window.__apex.stunts?.count ?? 0,
}))
console.log('loaded', JSON.stringify(started))
check(started.fixtures === 1, 'the world loaded its fixture')
// THE FIX. No `?phys=1` anywhere above: the document asked for it.
check(started.physics, 'a world with a loop in it starts its own physics')
check(started.surfaces.includes('drivable-loop'), `and the loop is solid (${started.surfaces.join(', ') || 'none'})`)

// Tab, the way a person does it
await p.keyboard.press('Tab')
await p.waitForTimeout(1500)
const car = await p.evaluate(() => ({
  driving: !!window.__apex.drive?.on,
  model: window.__apex.car?.constructor?.name ?? null,
}))
console.log('car', JSON.stringify(car))
check(car.driving, 'Tab puts you in the seat')
// THE OTHER HALF OF THE FIX. The kinematic car samples the terrain height under itself, so it
// drives THROUGH a loop however solid the loop is.
check(car.model === 'RapierCar', `and the car is the one that can hit a trimesh (${car.model})`)

/*
 * NOW DRIVE IT. The sim is stepped from here rather than waited on: headless swiftshader renders at
 * well under a frame a second, so ten seconds of wall clock can be almost no simulation at all and
 * every height would read its spawn value.
 */
/*
 * A CONTROLLED COMPARISON. `SUSP=1` gives the car more suspension travel and force before the same
 * drive: if the stop is the front axle being thrown by the ramp's kink, a suspension that can
 * absorb it gets further; if it is geometry, nothing changes. One variable, one run each.
 */
const SUSP = process.env.SUSP === '1'
if (SUSP) {
  const applied = await p.evaluate(async () => {
    const { profile } = await import('/@fs/workspaces/apex-conduit/packages/engine/src/physics/profiles.ts')
    const p2 = profile('stunts', { suspensionTravel: 0.6, suspensionRest: 0.55, maxSuspensionForce: 120000, compression: 0.6, relaxation: 0.85 })
    window.__apex.car.setProfile(p2)
    return { travel: window.__apex.car.profile.suspensionTravel, force: window.__apex.car.profile.maxSuspensionForce }
  })
  console.log('suspension', JSON.stringify(applied))
}

/*
 * THE ASSIST IS A SET OF KNOBS NOW, so a run can sweep them: `ALIGN=60 PULL=30 MPS=25 node …`.
 * Guessing at a torque and reporting that a loop does not work is how three runs were spent.
 */
for (const [k, v] of [['STUNT_ALIGN', process.env.ALIGN], ['STUNT_PULL', process.env.PULL], ['STUNT_AHEAD_S', process.env.AHEAD]]) {
  if (v === undefined) continue
  const ok = await p.evaluate(([name, value]) => window.corridor?.tune?.set?.(name, Number(value)) ?? false, [k, v])
  console.log(`knob ${k} = ${v} ${ok ? '' : '(REFUSED)'}`)
}
const assistKnobs = await p.evaluate(() => ({
  assist: window.corridor?.tune?.get?.('STUNT_ASSIST'),
  align: window.corridor?.tune?.get?.('STUNT_ALIGN'),
  pull: window.corridor?.tune?.get?.('STUNT_PULL'),
  ahead: window.corridor?.tune?.get?.('STUNT_AHEAD_S'),
}))
console.log('assist', JSON.stringify(assistKnobs))

const run = await p.evaluate(async ({ from, TARGET }) => {
  const ap = window.__apex
  const car = ap.car
  const site = ap.site
  const dt = 1 / 60

  /*
   * WARM THE TERRAIN FIRST. Collider tiles are built around the eye with a per-frame budget, so a
   * car placed two hundred metres from where the last frame was looking is a car placed over a hole
   * — it falls through the world and every height after that is meaningless. Stepping with the eye
   * AT the spawn before putting the car there is what the renderer does over its first few frames.
   */
  const eye = { x: from.x, y: (site.groundAt(from.x, from.z) ?? 0) + 2, z: from.z }
  for (let i = 0; i < 120; i++) ap.physics.update(eye, dt)
  car.place(from.x, from.z, from.yaw)
  for (let i = 0; i < 30; i++) { car.tick(dt, { throttle: 0, brake: 0, steer: 0, handbrake: false }); ap.physics.update(car.pos, dt) }
  const settled = { y: +car.pos.y.toFixed(2), ground: +((site.groundAt(car.pos.x, car.pos.z) ?? 0).toFixed(2)) }

  /*
   * AND THEN STEER. A player drives INTO the mouth of the loop; holding the wheel straight down a
   * road whose tarmac has been replaced by a fixture drives into the side of it at 44 m/s, which is
   * what the first version of this measured and reported as "not drivable".
   *
   * So: the road up to the entry, then the fixture's own authored line, as one list of points, and
   * a pure-pursuit controller aiming a fixed distance ahead. Nothing here teleports the car — every
   * metre is driven by the same `tick` the keyboard drives.
   */
  const { connectFixture } = await import('/src/stunts.ts')
  const f = ap.stunts.fixtures[0]
  const chains = site.chains()
  const road = (s, chain) => {
    const c = chains.find((x) => x.index === chain) ?? chains[0]
    if (!c || s < 0 || s > c.length_m) return null
    const at = c.at(s)
    return { x: at.pos.x, y: -at.pos.z, z: at.pos.y, dx: at.dir.x, dy: -at.dir.z }
  }
  const parts = connectFixture(f, road, { groundAt: (x, y) => site.groundAt(x, -y) ?? site.heightAt(x, y) ?? 0 })
  // the run-up along the road, then everything the fixture authored
  const lead = []
  for (let s = from.s; s < f.entry.s; s += 5) { const q = road(s, 0); if (q) lead.push(q) }
  const path = [...lead, ...parts.approach, ...parts.through, ...parts.departure]
    .map((q) => ({ x: q.x, y: q.z, z: -q.y }))

  /*
   * FOLLOWED BY ARC LENGTH, NOT BY PROXIMITY. A loop's lane crosses over itself in plan: the point
   * fifty metres further round is a few metres away on the map, so a "nearest point ahead" search
   * races to the far side of the fixture and aims the car at the outside of it. Measured: the car
   * stopped 36 m short of the mouth with the target index already 28 points into the loop.
   *
   * So progress only ever advances through a short window of the path, and the aim point is a fixed
   * distance FURTHER ALONG THE LINE from there.
   */
  /**
   * The chassis' own contacts, and what the wheels can see, at one instant.
   *
   * `contactPairsWith(collider, f)` PASSES ONE ARGUMENT — the other collider — and nothing else.
   * The first version of this took a second parameter and called it `manifold`, so it was reading
   * `undefined?.numContacts?.() ?? 0` and reporting "no contacts" for every pair it was handed.
   * That is how a probe says the opposite of the truth while passing: the chassis had two contacts
   * and the run said zero. `contactPair(a, b, f)` is the call that hands over a manifold.
   */
  const contacts = (car) => {
    const v = car.vehicle
    const world = ap.physics.phys.world
    const mine = v.body.collider(0)
    const hits = []
    try {
      world.contactPairsWith(mine, (other) => {
        world.contactPair(mine, other, (m, flipped) => {
          const n = m.numContacts()
          let deepest = 0
          for (let k = 0; k < n; k++) deepest = Math.min(deepest, m.contactDist(k))
          const nm = m.normal()
          hits.push({
            other: other.handle,
            n,
            depth: +deepest.toFixed(3),
            flipped,
            // a normal pointing along the ground is a WALL; one pointing up is a floor
            normal: [+nm.x.toFixed(2), +nm.y.toFixed(2), +nm.z.toFixed(2)],
          })
        })
      })
    } catch (e) {
      hits.push({ error: String(e).slice(0, 140) })
    }
    /*
     * EVERY FORCE THROUGH EVERY WHEEL. With nothing touching the body and all four tyres on the
     * road, whatever is stopping the car can only arrive through them — so this reads what the
     * vehicle controller actually did, rather than inferring it from the result.
     */
    const wheels = []
    for (let k = 0; k < 4; k++) {
      wheels.push({
        down: v.controller.wheelIsInContact(k) ?? null,
        susp: +(v.controller.wheelSuspensionLength(k) ?? -1).toFixed(2),
        // the load the spring is carrying: what the whole traction budget is computed from
        N: Math.round(v.controller.wheelSuspensionForce(k) ?? -1),
        slip: +(v.controller.wheelFrictionSlip(k) ?? -1).toFixed(2),
        side: Math.round((v.controller.wheelSideImpulse(k) ?? 0) / (1 / 120)),
        fwd: Math.round((v.controller.wheelForwardImpulse(k) ?? 0) / (1 / 120)),
        drive: Math.round(v.controller.wheelEngineForce(k) ?? 0),
        brake: Math.round(v.controller.wheelBrake(k) ?? 0),
      })
    }
    return {
      hits, wheels, vy: +v.body.linvel().y.toFixed(1), chassisFriction: mine.friction(),
      // and what the car itself thinks is happening
      state: { slide: +(car.slide ?? 0).toFixed(2), slip: +(v.state?.wheelslip ?? -1).toFixed(2), grounded: v.state?.grounded ?? -1, event: v.state?.event ?? null },
    }
  }

  const AHEAD = 18
  let i0 = 0
  let best = { gain: 0, y: 0, ground: 0, t: 0 }
  let stopped = null
  let wasFast = false
  let prevSpeed = 0
  let assists = 0
  const trace = []
  for (let i = 0; i < 60 * 20; i++) {
    // progress: the closest point within the next twenty, so it can only creep forward
    let bestI = i0
    let bestD = Infinity
    for (let k = i0; k < Math.min(path.length, i0 + 20); k++) {
      const d = (path[k].x - car.pos.x) ** 2 + (path[k].z - car.pos.z) ** 2 + (path[k].y - car.pos.y) ** 2
      if (d < bestD) { bestD = d; bestI = k }
    }
    i0 = bestI
    // and the aim point, AHEAD metres further along the line
    let j = i0
    let run = 0
    while (j < path.length - 1 && run < AHEAD) {
      run += Math.hypot(path[j + 1].x - path[j].x, path[j + 1].z - path[j].z, path[j + 1].y - path[j].y)
      j++
    }
    const t = path[j]
    /*
     * STEERED IN THREE DIMENSIONS, in the car's own axes.
     *
     * A heading computed from x and z is a heading on the map, and half way up a loop the car's
     * lateral axis points mostly UP — so a ground-plane error measures almost nothing and the
     * controller drives confidently off the side. `probes/looprig.mjs` could not get round the loop
     * until this was fixed there either; the loop was drivable the whole time and the probe was not.
     */
    const dx = t.x - car.pos.x
    const dy = t.y - car.pos.y
    const dz = t.z - car.pos.z
    const along = dx * car.forward.x + dy * car.forward.y + dz * car.forward.z
    const across = dx * car.right.x + dy * car.right.y + dz * car.right.z
    const steer = along > 0.1 ? Math.max(-1, Math.min(1, Math.atan2(across, along) * 1.6)) : 0
    /*
     * HOLD A SPEED IF ASKED. A loop's vertical radius is about 18 m, so v²/r at 46 m/s is 12 g into
     * the suspension at the bottom — more than any spring holds, and the car is thrown off the
     * surface rather than carried round it. `MPS=20` drives it at the speed the geometry actually
     * allows: enough to stay on at the top (√(g·r) ≈ 13 m/s) and not enough to be ejected at the
     * bottom.
     */
    const throttle = TARGET ? (car.speed < TARGET ? 1 : 0) : 1
    const brake = TARGET && car.speed > TARGET * 1.15 ? 0.4 : 0
    car.tick(dt, { throttle, brake, steer, handbrake: false })
    /*
     * THE ASSIST, THROUGH THE SAME FUNCTION THE FRAME LOOP CALLS. This probe steps the car itself —
     * headless frames are far too slow to drive with — so without this it is measuring a car the
     * game does not have. It measured one for three runs.
     */
    if (ap.assist(dt)) assists++
    ap.physics.update(car.pos, dt)
    const ground = site.groundAt(car.pos.x, car.pos.z) ?? 0
    const gain = car.pos.y - ground
    if (gain > best.gain) best = { gain: +gain.toFixed(2), y: +car.pos.y.toFixed(2), ground: +ground.toFixed(2), t: +(i * dt).toFixed(1) }
    if (i % 90 === 0) trace.push([+(i * dt).toFixed(1), +gain.toFixed(1), +car.speed.toFixed(1), i0])
    if (!stopped && car.speed < 5 && wasFast) {
      /*
       * WHAT STOPPED IT. A car that runs out of speed climbing decelerates and slides back; a car
       * that hits something goes from 50 m/s to nothing in a step and reports an impact. The two
       * have completely different fixes — more power, or a ramp the chassis does not catch on — so
       * the probe records which one happened rather than leaving it to be guessed.
       */
      stopped = {
        t: +(i * dt).toFixed(1), x: +car.pos.x.toFixed(1), y: +car.pos.y.toFixed(2), z: +car.pos.z.toFixed(1),
        i0, ground: +ground.toFixed(2), event: car.event ?? null,
        was: +prevSpeed.toFixed(1),
        pitch: +((Math.asin(Math.max(-1, Math.min(1, car.forward.y))) * 180) / Math.PI).toFixed(1),
        /*
         * WHAT IS IT TOUCHING. Two candidates are left and they have different fixes: the CHASSIS
         * striking geometry ahead of the wheels, or the WHEEL RAYS missing the ribbon at 46 m/s so
         * the body lands on it. Rapier can be asked both — the narrow phase for what the chassis
         * box is in contact with and how deep, and the vehicle controller for whether each wheel
         * found ground. Guessing between them is what the last two messages did.
         */
        ...contacts(car),
        assists,
        /*
         * WHAT ELSE IS STANDING HERE. A stunt fixture is dropped into a wooded corridor and does
         * NOT clear the trees under it — and a trunk has a vertical face, which is the one shape
         * that stops a car dead at any speed, from any tessellation, whatever the friction. That
         * would explain a stop in the same place through six different fixes.
         */
        trees: (ap.site.treesNear?.(car.pos.x, car.pos.z, 6) ?? []).length,
        treesWide: (ap.site.treesNear?.(car.pos.x, car.pos.z, 15) ?? []).length,
        /*
         * EVERYTHING SOLID WITHIN REACH, not just the trees. A corridor is also full of fence
         * posts, power poles, mailboxes and signs, all of which get colliders and none of which a
         * tree-density area touches. Enumerated rather than guessed at: the world is asked what is
         * actually there, by shape, so the answer cannot be another theory.
         */
        /*
         * EVERYTHING SOLID WITHIN REACH, not just the trees. A corridor is also full of fence
         * posts, power poles, mailboxes and signs: all get colliders, and a tree-density area
         * touches none of them. The world is asked what is actually there rather than offered
         * another theory.
         */
        solid: (() => {
          const world = ap.physics?.phys?.world
          if (!world) return null
          const own = car.vehicle.body.collider(0).handle
          const found = []
          for (let a = 0; a < 8; a++) {
            for (const rad of [1.5, 3, 5]) {
              const px = car.pos.x + Math.cos((a * Math.PI) / 4) * rad
              const pz = car.pos.z + Math.sin((a * Math.PI) / 4) * rad
              const hit = world.projectPoint({ x: px, y: car.pos.y, z: pz }, true)
              if (hit && hit.collider && hit.collider.handle !== own) {
                found.push({
                  h: hit.collider.handle,
                  shape: hit.collider.shape?.type ?? '?',
                  d: +Math.hypot(hit.point.x - px, hit.point.y - car.pos.y, hit.point.z - pz).toFixed(1),
                })
              }
            }
          }
          const seen = new Set()
          return found.filter((f) => (seen.has(f.h) ? false : (seen.add(f.h), true))).slice(0, 8)
        })(),
        // what the car thinks is up, against what the track says is up where it is standing
        carUp: [+car.up.x.toFixed(2), +car.up.y.toFixed(2), +car.up.z.toFixed(2)],
        track: (() => {
          const w = ap.stunts
          const at = { x: car.pos.x, y: -car.pos.z, z: car.pos.y }
          const n = w?.nearestPose?.(at)
          /*
           * `up` IS OPTIONAL ON A POSE and absent on every link curve — `hermite` does not produce
           * one — so this reads it defensively. That is not just probe hygiene: a pose with no `up`
           * is treated as flat by the assist, which is exactly the state the car is in here.
           */
          const u = n?.pose?.up
          return n ? { d: +n.d.toFixed(2), up: u ? [+u.x.toFixed(2), +u.y.toFixed(2), +u.z.toFixed(2)] : 'none (a link pose)' } : null
        })(),
      }
    }
    prevSpeed = car.speed
    if (car.speed > 20) wasFast = true
  }
  const mouth = parts.through[0]
  const road0 = road(f.entry.s, 0)
  return {
    settled, best, points: path.length, speed: +car.speed.toFixed(1), reached: i0, trace, stopped,
    lead: lead.length, approach: parts.approach.length, through: parts.through.length,
    mouth: { x: +mouth.x.toFixed(1), y: +mouth.y.toFixed(1), z: +mouth.z.toFixed(2), ground: +((site.groundAt(mouth.x, -mouth.y) ?? 0).toFixed(2)) },
    entry: { x: +road0.x.toFixed(1), y: +road0.y.toFixed(1), z: +road0.z.toFixed(2), ground: +((site.groundAt(road0.x, -road0.y) ?? 0).toFixed(2)) },
    baseZ: +parts.baseZ.toFixed(2),
  }
}, { from: where.from, TARGET: Number(process.env.MPS ?? 0) })
console.log('drove', JSON.stringify(run))
/*
 * HOW HIGH IS HIGH ENOUGH. A car sitting on tarmac reads about a metre above `groundAt` — the body
 * origin is the middle of the chassis. The loop is 36 m tall, so anything past a few metres can
 * only be the fixture; 3 m is comfortably past the noise and well short of claiming a full lap of
 * the inside of it.
 */
check(run.best.gain > 3,
  `driving into it puts the car on it (${run.best.gain} m above the ground at ${run.best.t} s, y = ${run.best.y})`)
/*
 * AND OUT THE OTHER SIDE. Getting onto a fixture is half of it; the half that was broken for a
 * month is the far end, where the departure curve has to put the car back on the road rather than
 * into a hillside. `reached` is how far along the authored line the car got, and the line ends on
 * the tarmac.
 */
check(run.reached > run.points * 0.9,
  `and drives it end to end, back onto the road (${run.reached} of ${run.points} points of the line)`)

await p.waitForTimeout(500)
/*
 * THE PICTURE IS NOT THE POINT. Under swiftshader a screenshot regularly exceeds its own timeout,
 * and an exception here threw away a run's measurements after the work was already done — three
 * times. The numbers are printed above this line; the picture is a bonus.
 */
await p.screenshot({ path: '/tmp/claude-1000/-workspaces-apex-conduit/12eaed6d-83ff-4605-9fb1-f5c0b0bc5019/scratchpad/stunt-drivable.png', timeout: 20000 })
  .catch((e) => console.log('(no screenshot:', String(e).split('\n')[0], ')'))

if (existsSync(FILE)) unlinkSync(FILE)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
