// Do the things beside the road stop a car, and do signs come off?
//
//   node probes/corridor-props.mjs [site]
//
// Rich, 2026-09-29: collide with houses, street signs, stop lights, power line poles and any placed
// prop; signs and stop signs should DETACH with real physics, with their weight worked out from
// their geometry.
//
// WHAT IT ASSERTS, and each is a way the feature can be wrong while looking right:
//
//   things exist         the catalogue found props, and colliders stand near the player. A site with
//                        1,092 sign instances and 0 colliders is the failure the fleet roster would
//                        never show.
//   the weights are sane every prop weighs something a person would recognise. A 0 kg sign is fired
//                        into orbit by a bicycle; a 4-tonne one is a bollard.
//   a sign comes off     driven into at speed, it detaches, becomes dynamic, and MOVES.
//   a pole does not      the same hit on a power pole leaves it standing. If everything detaches,
//                        "detaches" means nothing.
//   the drawn thing goes with it — the instance is emptied out of its buffer and a standalone mesh
//                        follows the body, or the sign topples invisibly.
import { chromium } from 'playwright'

const site = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.CORRIDOR_PORT ?? '5185'

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?lite&phys=1#${site}`, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 300000 })
await page.waitForFunction(() => !!window.corridor.physics, null, { timeout: 120000 })

const result = await page.evaluate(() => {
  const a = window.corridor
  const phys = a.physics
  const site = a.site

  // Somewhere with furniture on it. A junction has signs; open road may not.
  const len = site.manifest.spine.length_m ?? 1000
  const here = site.spineAt(len / 2)
  for (let i = 0; i < 300; i++) phys.update(here.pos, 1 / 60)
  const stats = phys.stats()

  /*
   * DRIVE AT ONE. `spawnCar` puts a car on the ground; aim it at the prop and hold the throttle.
   * The prop has to be far enough away that the car arrives with real speed, and the run has to be
   * long enough to get there.
   */
  const hit = (wanted, notWanted) => {
    const cat = phys.catalogue ? phys.catalogue() : null
    void cat
    // find a prop of the right kind near the middle of the road
    const target = phys.nearestProp ? phys.nearestProp(here.pos.x, here.pos.z, wanted, notWanted) : null
    if (!target) return null
    const aim = Math.atan2(target.z - here.pos.z, target.x - here.pos.x)
    const d = Math.hypot(target.x - here.pos.x, target.z - here.pos.z)
    // back off so there is room to build speed
    const from = { x: target.x - Math.cos(aim) * Math.max(40, d), z: target.z - Math.sin(aim) * Math.max(40, d) }
    const g = site.groundAt(from.x, from.z)
    if (g === null) return null
    const car = phys.spawnCar({ x: from.x, z: from.z, yaw: aim }, 'street')
    for (let i = 0; i < 120; i++) phys.update(from, 1 / 120)
    car.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
    const before = phys.stats().broken
    const wasDetached = phys.detachedProps().length
    let moved = 0
    // The speed AT IMPACT, not the speed afterwards: a car that hits a sign at 25 m/s and stops is
    // reported by `car.state.speed` as 0, which reads as "it came off at 0 m/s".
    let peak = 0
    for (let i = 0; i < 1200; i++) {
      const p = car.body.translation()
      phys.update(p, 1 / 120)
      peak = Math.max(peak, Math.abs(car.state.speed))
      moved = Math.hypot(p.x - from.x, p.z - from.z)
      if (moved > Math.max(40, d) + 30) break
    }
    const nowDetached = phys.detachedProps()
    const out = {
      kind: target.kind,
      mass: +target.mass.toFixed(1),
      breakAt: +target.breakAt.toFixed(0),
      broke: phys.stats().broken > before,
      // END TO END: a detached mesh of the RIGHT KIND now exists that did not before. Counting
      // breaks alone would have credited this target with somebody else's sign.
      swapped: nowDetached.length > wasDetached && nowDetached.some((m) => m.kind === target.kind),
      impactSpeed: +peak.toFixed(1),
      carSpeed: +car.state.speed.toFixed(1),
      carDamage: +car.state.damage.toFixed(3),
      travelled: +moved.toFixed(1),
    }
    car.free()
    return out
  }

  return {
    site: site.manifest.slug,
    stats: { props: stats.props, catalogued: stats.catalogued, trees: stats.trees },
    sign: hit(['furniture'], ['signal']),
    pole: hit(['power'], []),
    masses: phys.propMasses ? phys.propMasses() : null,
    merged: stats.merged ?? 0,
  }
})

console.log(JSON.stringify(result, null, 1))
await browser.close()

const fail = []
if (!result.stats.catalogued) fail.push('the catalogue is empty — nothing beside this road was written down')
if (!result.stats.props) fail.push('no prop colliders are standing near the player')
/*
 * MASS ONLY MATTERS FOR WHAT CAN MOVE.
 *
 * A building weighs thousands of tonnes and is quite right to: at 350 kg/m³ and 5% solidity, a
 * 100 × 100 × 15 m warehouse really is about 2,600 t, and it is a fixed body that will never be
 * asked to accelerate. Asserting a ceiling on it would be asserting something nobody cares about.
 * What matters is that everything which DETACHES weighs something a person would recognise.
 */
if (result.masses) {
  for (const [kind, m] of Object.entries(result.masses)) {
    if (!m.breakable) continue
    if (!(m.min > 0.5)) fail.push(`${kind} has a prop weighing ${m.min} kg — that light, it is fired into orbit by a bicycle`)
    if (!(m.max < 5000)) fail.push(`${kind} has a detachable prop weighing ${m.max} kg — that is not a sign`)
  }
}
if (result.merged) console.error(`note: ${result.merged} merged batches were skipped — fences and walls are not collidable yet`)
if (result.sign === null) console.error('note: no furniture was in range to drive at; the detach check did not run')
else {
  if (!result.sign.broke) fail.push(`a ${result.sign.mass} kg ${result.sign.kind} (breaks at ${result.sign.breakAt} N·s) did not come off when hit at ${result.sign.impactSpeed} m/s`)
  else if (!result.sign.swapped) fail.push(`the ${result.sign.kind} detached in the physics but no mesh left its instance buffer — it toppled invisibly`)
}
if (result.pole && result.pole.broke) fail.push('a power pole came off — if everything detaches, detaching means nothing')

if (fail.length) {
  for (const f of fail) console.error('FAIL', f)
  process.exit(1)
}
console.log(`ok — ${result.stats.catalogued} props catalogued, ${result.stats.props} standing${result.sign ? `; a ${result.sign.mass} kg ${result.sign.kind} came off at ${result.sign.impactSpeed} m/s` : ''}`)
