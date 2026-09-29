// The two driving models, side by side — driven BY THE KEYBOARD, through the viewer's own frame loop.
//
//   node probes/corridor-carswap.mjs [site]
//
// WHY THE KEYBOARD AND NOT `car.tick()`. The first version of this probe called `car.tick(dt, input)`
// itself, and passed while the car was completely undriveable in the real viewer. Two bugs got
// through it, both in the seam between the viewer and the physics:
//
//   1. `Vehicle.control` stored the caller's input OBJECT. A raycast vehicle applies its controls
//      inside the physics step, which is later than the call, and `main.ts` resets
//      `drive.input.throttle` on the line after it ticks — so the step read zero, every frame, on
//      every profile. Calling `tick` with a freshly-made object hid it perfectly.
//   2. The mesh was drawn at the chassis body's translation. A car model's origin is the ground
//      between its wheels; a chassis body's is the middle of its collider box, 0.94 m higher. The
//      car hovered a wheel-and-a-half off the road and every number in the old probe was still fine.
//
// So this holds a real arrow key down and waits for real frames. It is SLOW, and slower than it
// looks: measured on `acadia-ocean-dr`, forty-five wall-clock seconds bought **sixteen physics
// steps** — about four frames. So the check is SPEED, not distance: a car that has been accelerating
// for a tenth of a second has barely moved but is unambiguously being driven, and asserting metres
// would fail on a healthy car for reasons that have nothing to do with the car. The handling
// comparison across the five profiles is `corridor-physcar.mjs`, which drives the vehicle directly
// and is the fast one.
//
// WHAT IT ASSERTS:
//
//   the key drives it     holding ArrowUp gives the car SPEED. Not distance — see below.
//   the wheels are ON     the mesh origin is the wheel contact plane, so it must sit on the ground
//                         the renderer would draw — not a metre above it.
//   the interface holds   every field the HUD, the camera and the engine sound read is present.
//   the mesh follows      the drawn car is where the model says it is.
import { chromium } from 'playwright'

const site = process.argv[2] ?? 'acadia-ocean-dr'
const PORT = process.env.CORRIDOR_PORT ?? '5185'
const HOLD_S = Number(process.env.HOLD_S ?? 45)

async function run(kind) {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
  page.on('pageerror', (e) => console.log(`pageerror[${kind}]`, e.message))
  await page.route('**/@vite/client', (r) => r.abort())
  const q = kind === 'rapier' ? 'lite&phys=1&car=rapier&profile=stunts' : 'lite&phys=1&car=kinematic'
  await page.goto(`http://127.0.0.1:${PORT}/?${q}#${site}`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 240000 })
  await page.waitForFunction(() => !!window.corridor.physics, null, { timeout: 120000 })

  await page.keyboard.press('Tab')
  await page.waitForFunction(() => !!window.corridor.drive?.car, null, { timeout: 60000 })

  const before = await page.evaluate(() => {
    const c = window.corridor.drive.car
    return { x: c.pos.x, z: c.pos.z, yaw: c.yaw }
  })

  // HOLD THE KEY. `keyboard.down` and then wait — not `press`, which releases immediately and would
  // be seen by at most one frame.
  await page.keyboard.down('ArrowUp')
  await page.waitForTimeout(HOLD_S * 1000)
  await page.keyboard.up('ArrowUp')

  const out = await page.evaluate(({ before }) => {
    const a = window.corridor
    const car = a.drive.car
    const site = a.site
    const dx = car.pos.x - before.x
    const dz = car.pos.z - before.z
    const ground = site.groundAt(car.pos.x, car.pos.z)
    return {
      moved: +Math.hypot(dx, dz).toFixed(2),
      along: +(dx * Math.cos(before.yaw) + dz * Math.sin(before.yaw)).toFixed(2),
      speed: +car.speed.toFixed(2),
      // The mesh's origin is the wheel contact plane (`car.ts` builds it that way), so this IS the
      // height of the wheels above the road. It is the hover check and there is no other.
      wheelsAboveGround: ground === null ? null : +(car.mesh.position.y - ground).toFixed(3),
      meshGap: +Math.hypot(car.mesh.position.x - car.pos.x, car.mesh.position.z - car.pos.z).toFixed(3),
      onGrass: car.onGrass,
      fields: ['pos', 'forward', 'right', 'yaw', 'speed', 'slide', 'onGrass', 'event', 'mesh']
        .filter((k) => car[k] === undefined || (typeof car[k] === 'number' && !Number.isFinite(car[k]))),
      steps: a.physics?.stats?.().steps ?? 0,
    }
  }, { before })
  await browser.close()
  return out
}

const kinematic = await run('kinematic')
const rapier = await run('rapier')
console.log(JSON.stringify({ site, holdSeconds: HOLD_S, kinematic, rapier }, null, 1))

/* ---- the verdict ------------------------------------------------------------------------------ */

const fail = []
for (const [name, r] of [['kinematic', kinematic], ['rapier', rapier]]) {
  if (r.fields.length) fail.push(`${name}: missing or non-finite on the drivable interface: ${r.fields.join(', ')}`)
  if (r.steps < 4) fail.push(`${name}: only ${r.steps} physics steps ran in ${HOLD_S} s — too few to conclude anything; raise HOLD_S`)
  if (r.speed < 0.5) fail.push(`${name}: holding ArrowUp for ${HOLD_S} s left the car at ${r.speed} m/s — the key does not reach the wheels`)
  if (r.along < -0.05) fail.push(`${name}: moved ${r.along} m along its own nose — it went BACKWARDS`)
  if (r.meshGap > 0.05) fail.push(`${name}: the drawn car drifted ${r.meshGap} m from where the model says it is`)
  // The hover check. The mesh origin is the contact plane, so anything much above zero is a car
  // floating over the road — which every other number in the old probe was perfectly happy with.
  if (r.wheelsAboveGround === null) fail.push(`${name}: ended up off the baked data`)
  else if (Math.abs(r.wheelsAboveGround) > 0.35) fail.push(`${name}: the wheels are ${r.wheelsAboveGround} m from the road — the car is hovering`)
}

if (fail.length) {
  for (const f of fail) console.error('FAIL', f)
  process.exit(1)
}
console.log(`ok — ${HOLD_S} s on ArrowUp: kinematic ${kinematic.moved} m (wheels ${kinematic.wheelsAboveGround} m), rapier ${rapier.moved} m (wheels ${rapier.wheelsAboveGround} m)`)
