// Handling probe for the corridor car: measure, don't eyeball.
//
//   node probes/corridor-handling.mjs [site]        (dev server on :5185; default site clarksburg-i270)
//
// Test A — turning radius: hold the car at a speed, full right lock, and report the radius two ways:
//   R_yaw  = v / yaw-rate           (what the nose does)
//   R_path = Δs / Δcourse            (what the car actually traces: the course is the velocity direction)
// A road car at 15 m/s full lock should trace 10–20 m, not hundreds. Above the grip limit the radius
// is v²/grip whatever you do with the wheel (stuntin: GRIP_LATERAL 22 m/s² → 10 m at 15 m/s, 305 m at 82).
//
// Test B — slide: from 25 m/s, handbrake + full right for 0.8 s, then release and counter-steer left.
//   yawRateSign  vs steer: the nose should rotate the way you steer, both phases.
//   slip = course − yaw: in a right-hand handbrake slide the tail goes out to the left, so the velocity
//   is LEFT of the nose (slip < 0, "outward"). A car whose slip is on the steer side is sliding *into*
//   its own turn, and counter-steering then makes it worse — the "steers backwards in a slide" bug.
import { chromium } from 'playwright'

const site = process.argv[2] ?? 'clarksburg-i270'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.goto(`http://127.0.0.1:5185/?lite#${site}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('Tab')

const r = await page.evaluate(() => {
  const { drive, site } = window.corridor
  const car = drive.car
  const DT = 1 / 120
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
  const start = () => {
    const p = site.spineAt(site.manifest.spine.photo_s)
    const yaw = Math.atan2(p.dir.z, p.dir.x)
    const sx = -p.dir.z, sz = p.dir.x // right of the road
    car.place(p.pos.x + sx * 1.83, p.pos.z + sz * 1.83, yaw)
  }
  /** Run ticks; return per-tick samples of pos, yaw, speed, slide, event. */
  const run = (ticks, input, holdSpeed) => {
    const out = []
    for (let i = 0; i < ticks; i++) {
      if (holdSpeed !== undefined) car.speed = holdSpeed
      car.tick(DT, input)
      out.push({ x: car.pos.x, z: car.pos.z, y: car.pos.y, yaw: car.yaw, v: car.speed, slide: car.slide, ev: car.event, grass: car.onGrass })
    }
    return out
  }
  /** Course (velocity direction) and its rate, yaw rate, arc length over a window of samples. */
  const stats = (s) => {
    let ds = 0, dcourse = 0, dyaw = 0, n = 0, slipSum = 0
    for (let i = 2; i < s.length; i++) {
      const dx = s[i].x - s[i - 1].x, dz = s[i].z - s[i - 1].z
      const pdx = s[i - 1].x - s[i - 2].x, pdz = s[i - 1].z - s[i - 2].z
      const c = Math.atan2(dz, dx), pc = Math.atan2(pdz, pdx)
      ds += Math.hypot(dx, dz)
      dcourse += wrap(c - pc)
      dyaw += wrap(s[i].yaw - s[i - 1].yaw)
      slipSum += wrap(c - s[i].yaw)
      n++
    }
    const t = n * DT
    const vMean = ds / t
    const yawRate = dyaw / t
    const courseRate = dcourse / t
    return {
      vMean: +vMean.toFixed(2),
      yawRate: +yawRate.toFixed(3),
      R_yaw: +(Math.abs(yawRate) > 1e-6 ? vMean / Math.abs(yawRate) : Infinity).toFixed(1),
      R_path: +(Math.abs(courseRate) > 1e-6 ? vMean / Math.abs(courseRate) : Infinity).toFixed(1),
      slipMean: +(slipSum / n).toFixed(3),
      slideMean: +(s.reduce((a, b) => a + b.slide, 0) / s.length).toFixed(2),
      events: [...new Set(s.map((q) => q.ev).filter((e) => e !== 'none'))],
    }
  }

  const out = { site: site.manifest.slug }

  // --- A: turning radius, full lock, speed held. Left, toward the median: there is ~6.7 m of
  // pavement that way, so a 0.2 s settle + 0.4 s window stays on it at every speed; the grass share
  // of the window is reported so a verge excursion cannot hide in the number.
  out.radius = {}
  for (const v of [8, 15, 30, 45, 82]) {
    start()
    const input = { throttle: 0, brake: 0, steer: -1, handbrake: false }
    run(24, input, v)
    const w = run(48, input, v)
    out.radius[`${v}mps`] = { ...stats(w), grassShare: +(w.filter((q) => q.grass).length / w.length).toFixed(2) }
  }
  // the same at 15 m/s but held for 1.5 s, which carries the car off the pavement: the verge's number
  start()
  {
    const input = { throttle: 0, brake: 0, steer: 1, handbrake: false }
    run(180, input, 15)
    const w = run(60, input, 15)
    out.radius['15mps_verge'] = { ...stats(w), grassShare: +(w.filter((q) => q.grass).length / w.length).toFixed(2) }
  }

  // --- B: handbrake slide, then counter-steer ---
  start()
  const straight = run(1, { throttle: 0, brake: 0, steer: 0, handbrake: false }, 25)
  const yaw0 = straight[0].yaw
  const slidePhase = run(96, { throttle: 0.4, brake: 0, steer: 1, handbrake: true }) // 0.8 s
  const slideStats = stats(slidePhase)
  const yawAfterSlide = wrap(car.yaw - yaw0)
  const slipAtRelease = wrap(Math.atan2(slidePhase.at(-1).z - slidePhase.at(-2).z, slidePhase.at(-1).x - slidePhase.at(-2).x) - car.yaw)
  const counter = run(60, { throttle: 0.4, brake: 0, steer: -1, handbrake: false }) // 0.5 s
  const counterStats = stats(counter)
  const slipAtEnd = wrap(Math.atan2(counter.at(-1).z - counter.at(-2).z, counter.at(-1).x - counter.at(-2).x) - car.yaw)
  out.slide = {
    steerRight_handbrake: {
      ...slideStats,
      yawTurned: +yawAfterSlide.toFixed(3),
      yawRateFollowsSteer: slideStats.yawRate > 0,
      slipAtRelease: +slipAtRelease.toFixed(3),
      // right-hand slide: velocity should be LEFT of the nose (slip < 0)
      driftSide: slipAtRelease < -0.01 ? 'outward (left, correct)' : slipAtRelease > 0.01 ? 'INTO the turn (right, inverted)' : 'none',
    },
    counterSteerLeft: {
      ...counterStats,
      yawRateFollowsSteer: counterStats.yawRate < 0,
      slipAtEnd: +slipAtEnd.toFixed(3),
      slipShrank: Math.abs(slipAtEnd) < Math.abs(slipAtRelease),
    },
  }
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
