// Does the fly camera actually slow down when you turn it down?
//
// Rich, 2026-09-27: "can we make flying speed adjustable? Right now it feels too fast, I'd like to
// be able to crank it down in the tuning panel."
//
// A knob that is read but never used looks identical to one that works, from the panel. This
// holds W down for a fixed wall-clock time and measures how far the camera actually travelled, at
// three settings of the knob — so the claim "it is adjustable" is a measurement rather than the
// existence of a slider.
//
//   PORT=5185 node probes/corridor-flyspeed.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 800, height: 560 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 160)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 900000 })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

/**
 * Metres per second with W held, at a known camera-to-target distance.
 *
 * ONE STEP, not a second of them. Speed scales with that distance, and the fly camera's target
 * eases toward the ground under it — so over a second of steps the geometry drifts, the distance
 * grows, and the number you get is an average over a geometry that changed underneath you. That
 * is how an earlier version of this probe measured 74.7 m/s where the arithmetic says 32, and how
 * its altitude control "failed" by measuring a camera that had descended out of the case it was
 * supposed to be testing.
 *
 * NOT by holding a real key against the real frame loop, either. That measures the renderer:
 * under swiftshader the loop stalls for seconds while tiles stream, and the first version read
 * 138 m on one pass and 0 m on the next two — with "it got slower" passing on 9.8 > 0.0 > 0.0,
 * a probe agreeing with itself about nothing.
 */
const speedAt = (DIST, dt = 1 / 60) => page.evaluate(([DIST, dt]) => {
  const c = window.corridor
  c.orbit.target.set(c.camera.position.x, c.camera.position.y - DIST * 0.7, c.camera.position.z - DIST * 0.7)
  const from = c.camera.position.clone()
  const press = (type) => dispatchEvent(new KeyboardEvent(type, { code: 'KeyW', bubbles: true }))
  press('keydown')
  c.fly.update(dt)
  press('keyup')
  // HORIZONTAL ONLY. W is a horizontal move, but the same step also eases the orbit target toward
  // the ground beneath it, and that vertical correction is proportional to how far off the ground
  // the target was put — which, measured as 3D distance, swamped the thing being measured and
  // read 164 m/s where the arithmetic says 32.
  return {
    metres: Math.hypot(c.camera.position.x - from.x, c.camera.position.z - from.z),
    seconds: dt, dist: DIST,
  }
}, [DIST, dt])

// The knob has to exist under the name the panel shows, or nothing below means anything.
const names = await page.evaluate(() => window.corridor.tune.names())
for (const k of ['FLY_SPEED', 'FLY_SPEED_FLOOR_M', 'FLY_SPRINT_X', 'WALK_SPEED']) {
  ok(`the panel has ${k}`, names.includes(k), names.includes(k) ? 'present' : 'MISSING from the tuning panel')
}

const set = (k, v) => page.evaluate(([k, v]) => window.corridor.tune.set(k, v), [k, v])
await set('FLY_SPEED_FLOOR_M', 40)

const runs = []
for (const speed of [0.8, 0.4, 0.1]) {
  await set('FLY_SPEED', speed)
  const r = await speedAt(120)
  runs.push({ speed, ...r, rate: r.metres / r.seconds })
  console.log(`      FLY_SPEED ${speed}: ${r.metres.toFixed(1)} m in ${r.seconds.toFixed(2)} s = ${(r.metres / r.seconds).toFixed(1)} m/s`)
}

// The arithmetic, not just the trend: at 120 m out with FLY_SPEED 0.8 the speed IS 96 m/s.
ok('the speed is max(distance, floor) x FLY_SPEED, to the metre',
  Math.abs(runs[0].rate - 120 * 0.8) < 1, `${runs[0].rate.toFixed(2)} m/s, arithmetic says ${(120 * 0.8).toFixed(2)}`)
ok('turning FLY_SPEED down makes it slower', runs[0].rate > runs[1].rate && runs[1].rate > runs[2].rate,
  runs.map((r) => `${r.rate.toFixed(1)}`).join(' > '))
// PROPORTIONAL, not merely smaller — a knob that is consulted once and then clamped would also
// pass a "slower" check. Half the knob must be about half the speed.
const ratio = runs[1].rate / runs[0].rate
ok('and it is proportional: half the knob is half the speed', Math.abs(ratio - 0.5) < 0.12,
  `${ratio.toFixed(3)}× at half`)

// THE FLOOR IS THE ACTUAL COMPLAINT. Down close, `max(dist, floor)` is the floor, so that number
// alone decides how fast street level feels — and it must be measured with the camera CLOSE IN.
// The first version of this check measured at 120 m, where the floor never binds at all, and
// reported the same speed twice while calling it a failure.
await set('FLY_SPEED', 0.8)
await set('FLY_SPEED_FLOOR_M', 40)
const wide = await speedAt(10)
await set('FLY_SPEED_FLOOR_M', 5)
const tight = await speedAt(10)
ok('at street level the floor is what sets the speed',
  tight.metres / tight.seconds < (wide.metres / wide.seconds) * 0.6,
  `${(wide.metres / wide.seconds).toFixed(1)} m/s at a 40 m floor → ${(tight.metres / tight.seconds).toFixed(1)} m/s at 5 m`)
// And it does NOT bind when the camera is far out, which is why the floor exists at all: a view
// from two kilometres up still wants to cross two kilometres.
await set('FLY_SPEED_FLOOR_M', 40)
const highWide = await speedAt(400)
await set('FLY_SPEED_FLOOR_M', 5)
const highTight = await speedAt(400)
ok('CONTROL: and it changes nothing at altitude',
  Math.abs(highTight.metres - highWide.metres) < highWide.metres * 0.02,
  `${(highWide.metres / highWide.seconds).toFixed(1)} vs ${(highTight.metres / highTight.seconds).toFixed(1)} m/s at 400 m out`)

await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: flying speed is adjustable')
process.exit(fails.length ? 1 : 0)
