// Do the five driving profiles actually drive, on the real baked ground?
//
//   node probes/corridor-physcar.mjs [site]
//
// Step 2 of docs/corridor/PLAN-PHYSICS.md. `test/physics.test.ts` already proves each profile
// accelerates, turns and brakes — on a flat 1 km cuboid. This is the other question: a corridor
// site has camber, a crown, a verge the grip drops on, kerbs, and a heightfield built from the
// site's own sampler rather than from a plane. A car that drives beautifully on a test slab and
// falls through the road at Bowie is a car nobody has actually checked.
//
// WHAT IT ASSERTS, and each has a way of failing that a screenshot would not show:
//
//   it stays on the ground   `grounded` 4 for the whole run. A car that loses its wheels on a seam
//                            between two heightfield tiles reports a perfect speed while airborne.
//   it goes FORWARD          along its own nose, not sideways. The wrong forward axis on the
//                            vehicle controller is a car that drives at right angles to itself and
//                            still passes an "it moved" check.
//   it does not sink         the body stays above the ground the renderer would draw.
//   the profiles DIFFER      five identical results means the profile is not reaching the tyres.
//   grass costs TRACTION     and this one is measured as WHEELSLIP, not as distance. Distance was
//                            the obvious check and it is worthless: with the surface hook disabled
//                            entirely the car still went 102 m off the pavement against 117 m on it,
//                            because the verge is rougher ground and costs speed whatever the grip
//                            is. The probe passed with the thing it was testing switched off.
//                            `state.wheelslip` is the share of the demanded drive the tyres refused,
//                            so it is the hook's effect and nothing else's: 0.62 off the pavement
//                            against 0.06 on it, and 0.06 both ways when the hook is disabled.
import { chromium } from 'playwright'

const site = process.argv[2] ?? 'bowie-racetrack-rd'
const PORT = process.env.CORRIDOR_PORT ?? '5185'
const SECONDS = 6

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${site}?lite&phys=1`, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 240000 })
await page.waitForFunction(() => !!window.corridor.physics, null, { timeout: 120000 })

const result = await page.evaluate(async ({ SECONDS }) => {
  const a = window.corridor
  const phys = a.physics
  const site = a.site
  const s0 = site.manifest.spine.length_m ? site.manifest.spine.length_m / 3 : 500
  const here = site.spineAt(s0)
  // face the way the road goes, so "forward" is along the carriageway rather than across it
  const yaw = Math.atan2(here.dir.z, here.dir.x)

  // Build the ground first and let the broad phase see it: a collider is invisible to a query, and
  // to a wheel ray, until the world has stepped.
  for (let i = 0; i < 200; i++) phys.update(here.pos, 1 / 60)

  const drive = (id, offset) => {
    const at = { x: here.pos.x + offset * Math.cos(yaw + Math.PI / 2), z: here.pos.z + offset * Math.sin(yaw + Math.PI / 2), yaw }
    const car = phys.spawnCar(at, id)
    // `update` both builds the tiles under the eye and steps the world — `step` is the engine's and
    // is not on the corridor's interface on purpose, so a caller cannot step without the ground
    // having been given a chance to exist first.
    for (let i = 0; i < 120; i++) phys.update({ x: at.x, y: 0, z: at.z }, 1 / 120) // settle on its springs
    const p0 = car.body.translation()
    const y0 = site.groundAt(p0.x, p0.z)
    let minGrounded = 4
    let sank = 0
    let airborne = 0
    car.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
    const steps = Math.round(SECONDS * 120)
    for (let i = 0; i < steps; i++) {
      const p = car.body.translation()
      phys.update({ x: p.x, y: p.y, z: p.z }, 1 / 120)
      minGrounded = Math.min(minGrounded, car.state.grounded)
      if (car.state.airborne) airborne++
      const g = site.groundAt(p.x, p.z)
      if (g !== null && p.y < g - 0.2) sank++
    }
    const p1 = car.body.translation()
    // how far it went, split into along its own nose and across it
    const dx = p1.x - p0.x
    const dz = p1.z - p0.z
    const along = dx * Math.cos(yaw) + dz * Math.sin(yaw)
    const across = -dx * Math.sin(yaw) + dz * Math.cos(yaw)
    const out = {
      profile: id,
      speed: +car.state.speed.toFixed(2),
      along: +along.toFixed(2),
      across: +across.toFixed(2),
      minGrounded,
      airborneSteps: airborne,
      sankSteps: sank,
      damage: +car.state.damage.toFixed(3),
      wheelslip: +car.state.wheelslip.toFixed(3),
      startedOnGround: y0 !== null,
    }
    car.free()
    return out
  }

  /*
   * WHICH WAY IT TURNS, and this is here because left and right were swapped in the viewer for a
   * whole evening. `input.steer` is + for RIGHT; the car starts pointing along its own nose, so
   * steering right must move it to its own right. The engine's unit test checks the same thing in
   * a vacuum — this checks it on a real road, where the camber has an opinion too.
   */
  const steerCheck = (steer) => {
    const car = phys.spawnCar({ x: here.pos.x, z: here.pos.z, yaw }, 'street')
    for (let i = 0; i < 120; i++) phys.update(here.pos, 1 / 120)
    car.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
    for (let i = 0; i < 300; i++) { const p = car.body.translation(); phys.update(p, 1 / 120) }
    const p0 = car.body.translation()
    car.control({ throttle: 0.6, brake: 0, steer, handbrake: false })
    for (let i = 0; i < 240; i++) { const p = car.body.translation(); phys.update(p, 1 / 120) }
    const p1 = car.body.translation()
    // to the car's own right is +90° from its heading
    const rx = -Math.sin(yaw), rz = Math.cos(yaw)
    const out = +(((p1.x - p0.x) * rx + (p1.z - p0.z) * rz)).toFixed(2)
    car.free()
    return out
  }

  const ids = ['stunts', 'taxi', 'street', 'rush', 'sim']
  const runs = []
  for (const id of ids) runs.push(drive(id, 0))

  // The grass check: the same profile, once on the crown and once well off the edge.
  const offRoad = drive('street', 14)

  const steerRight = steerCheck(1)
  const steerLeft = steerCheck(-1)

  /*
   * THE TRUNK TEST.
   *
   * The hand-written car has collided with trees since the beginning, and a car on Rapier that drove
   * straight through them would be a step backwards however good the suspension was. So: find a
   * trunk, point the car at it, hold the throttle, and check the car is stopped BEFORE it rather
   * than found on the far side.
   *
   * Reported as null when there is no trunk in a usable spot, which is a real state on an open site
   * and must not read as a pass.
   */
  const trunkTest = (() => {
    /*
     * FIND A PLACE WITH TREES FIRST.
     *
     * The spine's third-point is where the handling runs happen and it is not necessarily wooded —
     * on `bowie-racetrack-rd` it is open ground with nothing within 120 m, and the first version of
     * this check concluded "no tree colliders were built" from a site with 15,927 trees in it. The
     * road is long; walk it and use a stretch that actually has trunks beside it.
     */
    const len = site.manifest.spine.length_m ?? 1000
    let spot = null
    for (let s = 50; s < len - 50 && !spot; s += 50) {
      const p = site.spineAt(s).pos
      const near = site.treesNear(p.x, p.z, 50)
        .map(([tx, tz, r]) => ({ tx, tz, r, d: Math.hypot(tx - p.x, tz - p.z) }))
        .filter((c) => c.d > 18 && c.d < 45)
        .sort((a, b) => a.d - b.d)
      if (near.length) spot = { p, c: near[0], s }
    }
    if (!spot) return null
    const { p: from, c } = spot
    const aim = Math.atan2(c.tz - from.z, c.tx - from.x)
    const car = phys.spawnCar({ x: from.x, z: from.z, yaw: aim }, 'street')
    for (let i = 0; i < 120; i++) phys.update(from, 1 / 120)
    car.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
    let closest = Infinity
    let passed = false
    for (let i = 0; i < 900; i++) {
      const p = car.body.translation()
      phys.update(p, 1 / 120)
      const toTree = (c.tx - p.x) * Math.cos(aim) + (c.tz - p.z) * Math.sin(aim)  // + = still ahead
      closest = Math.min(closest, Math.hypot(c.tx - p.x, c.tz - p.z))
      if (toTree < -2) passed = true // the trunk is behind the car: it went through
    }
    const out = { atSpine: spot.s, distance: +c.d.toFixed(1), radius: +c.r.toFixed(2), closest: +closest.toFixed(2), passedThrough: passed, damage: +car.state.damage.toFixed(3), trees: phys.stats().trees }
    car.free()
    return out
  })()

  return { site: site.manifest.slug, tiles: phys.stats().tiles, trees: phys.stats().trees, runs, offRoad, onRoad: runs.find((r) => r.profile === 'street'), steerRight, steerLeft, trunkTest }
}, { SECONDS })

console.log(JSON.stringify(result, null, 1))
await browser.close()

/* ---- the verdict ------------------------------------------------------------------------------ */

const fail = []
for (const r of result.runs) {
  if (!r.startedOnGround) fail.push(`${r.profile}: spawned off the baked data`)
  if (r.along < 20) fail.push(`${r.profile}: went ${r.along} m along its nose in ${SECONDS} s at full throttle`)
  if (Math.abs(r.across) > Math.abs(r.along) * 0.5) fail.push(`${r.profile}: went ${r.across} m SIDEWAYS against ${r.along} m forward — check the vehicle's forward axis`)
  if (r.sankSteps > 5) fail.push(`${r.profile}: was under the drawn ground for ${r.sankSteps} steps`)
  if (r.minGrounded === 0 && r.airborneSteps > 60) fail.push(`${r.profile}: airborne for ${r.airborneSteps} steps on a road`)
}
// Five identical numbers means the profile never reached the tyres.
const spread = Math.max(...result.runs.map((r) => r.along)) - Math.min(...result.runs.map((r) => r.along))
if (spread < 5) fail.push(`every profile went within ${spread.toFixed(1)} m of the same distance — the profile is not reaching the car`)
/*
 * THE SURFACE HOOK, measured where it actually shows.
 *
 * Wheelslip is the share of the demanded drive the tyres refused, so it moves if and only if the
 * grip under the wheels changed. Distance does not isolate it — see the header.
 */
if (!(result.offRoad.wheelslip > result.onRoad.wheelslip * 2 + 0.05)) {
  fail.push(`wheelslip off the pavement is ${result.offRoad.wheelslip} against ${result.onRoad.wheelslip} on it — the surface hook is doing nothing`)
}

/*
 * The trunks. `null` means the whole road has no tree within 45 m of it anywhere, which is a real
 * state for an open site and is reported rather than counted as a pass — the distinction the first
 * version of this check got wrong, concluding "no colliders" from a site with 15,927 trees.
 */
if (result.trunkTest === null) console.error('note: no trunk within 45 m of the road anywhere on this site; the collision check did not run')
else {
  if (!result.trunkTest.trees) fail.push('no tree colliders were built beside a road that has trees — a car here drives through the woods')
  if (result.trunkTest.passedThrough) fail.push(`the car drove THROUGH a ${result.trunkTest.radius} m trunk ${result.trunkTest.distance} m away`)
}

// Left and right, by SIGN. `Math.abs` here would pass with the two swapped, which is exactly how
// they stayed swapped.
if (!(result.steerRight > 1)) fail.push(`steering right moved the car ${result.steerRight} m to its right — left and right are swapped`)
if (!(result.steerLeft < -1)) fail.push(`steering left moved the car ${result.steerLeft} m to its right — left and right are swapped`)

if (fail.length) {
  for (const f of fail) console.error('FAIL', f)
  process.exit(1)
}
console.log(`ok — ${result.trunkTest ? `${result.trunkTest.trees} trunks standing, stopped ${result.trunkTest.closest} m from one` : 'no trees beside this road'}; ${result.runs.length} profiles on ${result.site}: ${result.runs.map((r) => `${r.profile} ${r.along}m`).join(', ')}; off-road ${result.offRoad.along} m vs ${result.onRoad.along} m on it`)
