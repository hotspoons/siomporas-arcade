// Launch probe: do the wheels leave the ground only over real crests, and only at speed?
//
//   node probes/corridor-launch.mjs [site] [offset_m]     (CORRIDOR_PORT, default :5202)
//
// Two independent measurements of the same thing, so a disagreement is informative:
//
//  A. The crest table — geometry only, no car. Sample the ground along the driven line every metre,
//     smooth it over a 6 m wheelbase-ish window, and take the vertical curvature d²z/ds². A car
//     following the ground at speed v needs a downward acceleration v²·|d²z/ds²| to stay on it; over
//     a crest (curvature negative) gravity can supply only g, so the wheels leave at
//         v_launch = sqrt(g / |d²z/ds²|).
//     Every station gets its v_launch; the table is the sorted list of the sharpest crests. This is
//     the ground truth "which crests are real", and it does not know CAR_LAUNCH_GAP exists.
//
//  B. The driven run — the actual sim, pure-pursuit along the spine at a held speed, logging every
//     'launch' event with its station, air time, and peak height over the ground.
//
// A launch in B whose station has no crest in A (v_launch far above the test speed) is the car
// flying off lidar noise, which is the bug CAR_LAUNCH_GAP exists to suppress.
import { chromium } from 'playwright'

const site = process.argv[2] ?? 'bacon-ridge-rd'
const offset = Number(process.argv[3] ?? 0) // metres right of the centreline: 0 road, ~6 verge
const PORT = process.env.CORRIDOR_PORT ?? '5202'
// CORRIDOR_SPEEDS=45,55  CORRIDOR_KNOBS=CAR_LAUNCH_MAX_RISE:1000
const speeds = (process.env.CORRIDOR_SPEEDS ?? '13,22,30,40').split(',').map(Number)
const crestOverride = process.env.CORRIDOR_CREST ? Number(process.env.CORRIDOR_CREST) : null
const knobs = Object.fromEntries((process.env.CORRIDOR_KNOBS ?? '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split(':'); return [k, Number(v)] }))
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?lite#${site}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 240000 })
await page.keyboard.press('Tab')

const r = await page.evaluate(({ offset, speeds, knobs, crestOverride }) => {
  const { drive, site } = window.corridor
  const car = drive.car
  // knobs through the same setters the F6 panel uses (window.corridor.tune === TUNE_TABS)
  const allKeys = (window.corridor.tune ?? []).flatMap((t) => t.sections.flatMap((sec) => sec.keys))
  const knobOf = (n) => allKeys.find((k) => k.name === n)
  const applied = {}
  for (const [n, v] of Object.entries(knobs)) { const k = knobOf(n); if (k) { k.set(v); applied[n] = v } }
  const T = Object.fromEntries(['CAR_LAUNCH_MIN_SPEED', 'CAR_LAUNCH_GAP', 'CAR_LAUNCH_MAX_RISE', 'CAR_GRIP_LATERAL'].map((n) => [n, knobOf(n)?.get() ?? null]))
  const DT = 1 / 120
  const L = site.manifest.spine.length_m
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
  /** Point `off` metres right of the spine at station s, in world x/z. */
  const at = (s) => {
    const p = site.spineAt(Math.max(0, Math.min(L, s)))
    return { x: p.pos.x - p.dir.z * offset, z: p.pos.z + p.dir.x * offset, dir: p.dir }
  }

  // --- A: the crest table -----------------------------------------------------------------------
  const STEP = 1
  const n = Math.floor(L / STEP)
  const z = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const p = at(i * STEP)
    z[i] = site.groundAt(p.x, p.z) ?? NaN
  }
  // smooth over ~6 m: a 4.4 m car does not feel a 1 m dimple, and the DEM/lidar strip has metre noise
  const HALF = 3
  const zs = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0
    for (let k = -HALF; k <= HALF; k++) {
      const j = i + k
      if (j >= 0 && j < n && Number.isFinite(z[j])) { sum += z[j]; cnt++ }
    }
    zs[i] = cnt ? sum / cnt : NaN
  }
  const g = 9.81
  const crests = []
  for (let i = 1; i < n - 1; i++) {
    const k2 = (zs[i + 1] - 2 * zs[i] + zs[i - 1]) / (STEP * STEP) // d²z/ds²
    if (!Number.isFinite(k2) || k2 >= -1e-6) continue // only crests (convex up)
    crests.push({ s: +(i * STEP).toFixed(0), curvature: +k2.toFixed(4), v_launch: +Math.sqrt(g / -k2).toFixed(1) })
  }
  crests.sort((a, b) => a.v_launch - b.v_launch)
  // merge crests within 15 m of each other, keeping the sharpest
  const merged = []
  for (const c of crests) if (!merged.some((m) => Math.abs(m.s - c.s) < 15)) merged.push(c)

  // --- B: driven runs ---------------------------------------------------------------------------
  // Pure pursuit, properly: the station comes from projecting the car onto the line each tick (dead
  // reckoning lets the aim point run away when the car lags), and the wheel is asked for the yaw rate
  // the geometry needs — ω = 2·v·sin α / Ld — divided by what one unit of steer buys. A run that
  // leaves the pavement is reported as such and its launches are NOT crest launches: the first
  // version of this probe drove off Sideling's embankment at 40 m/s and called it 17 jumps.
  const drive1 = (v) => {
    const s0 = 30
    const p0 = at(s0)
    car.place(p0.x, p0.z, Math.atan2(p0.dir.z, p0.dir.x))
    car.speed = v
    let s = s0
    const launches = []
    let cur = null
    let airTicks = 0, offRoadTicks = 0, lat = -99
    let strayedAt = null
    const ticks = Math.floor(((L - 60) / v) / DT)
    for (let i = 0; i < ticks; i++) {
      // project onto the line: walk s forward while the spine point gets closer
      let best = Infinity, bs = s
      for (let ds = 0; ds <= v * DT * 4 + 1; ds += 0.25) {
        const q = at(s + ds)
        const d = (q.x - car.pos.x) ** 2 + (q.z - car.pos.z) ** 2
        if (d < best) { best = d; bs = s + ds }
      }
      s = bs
      if (s > L - 30) break
      const Ld = Math.max(12, v * 0.7)
      const tgt = at(s + Ld)
      const alpha = wrap(Math.atan2(tgt.z - car.pos.z, tgt.x - car.pos.x) - car.yaw)
      const omega = (2 * v * Math.sin(alpha)) / Ld
      const steer = Math.max(-1, Math.min(1, omega / 2.4))
      if (car.mode === 'ground') car.speed = v
      car.tick(DT, { throttle: 0.2, brake: 0, steer, handbrake: false })
      const air = car.mode === 'air'
      if (air) airTicks++
      const ed = site.edgeDistance(car.pos.x, car.pos.z)
      if (Number.isFinite(ed)) {
        lat = Math.max(lat, ed)
        if (ed > 0) { offRoadTicks++; if (strayedAt == null) strayedAt = +s.toFixed(0) }
      }
      if (car.event === 'launch') cur = { s: +s.toFixed(0), v: +car.speed.toFixed(1), edge: Number.isFinite(ed) ? +ed.toFixed(2) : null, ticks: 0, peak: 0 }
      if (cur) {
        cur.ticks++
        const gh = site.groundAt(car.pos.x, car.pos.z)
        if (gh != null) cur.peak = Math.max(cur.peak, +(car.pos.y - gh).toFixed(2))
        if (!air) { cur.air_s = +(cur.ticks * DT).toFixed(2); delete cur.ticks; launches.push(cur); cur = null }
      }
    }
    const onRoad = launches.filter((q) => q.edge != null && q.edge <= 0)
    return {
      v,
      tracked: strayedAt == null,
      strayedAt,
      worstEdge_m: +lat.toFixed(2),
      launches_on_pavement: onRoad.length,
      launches_total: launches.length,
      airShare: +(airTicks / ticks).toFixed(3),
      offRoadShare: +(offRoadTicks / ticks).toFixed(3),
      list: onRoad.slice(0, 12),
    }
  }

  // The number the story needs: the slowest speed at which a given crest actually throws the car.
  // Drive the 200 m around one crest at a held speed and see whether a 'launch' fires; bisect.
  const launchesAt = (sc, v) => {
    const s0 = Math.max(10, Math.min(sc - 40, sc - 120))
    const p0 = at(s0)
    car.place(p0.x, p0.z, Math.atan2(p0.dir.z, p0.dir.x))
    car.speed = v
    let s = s0
    const ticks = Math.floor((240 / v) / DT)
    for (let i = 0; i < ticks; i++) {
      let best = Infinity, bs = s
      for (let ds = 0; ds <= v * DT * 4 + 1; ds += 0.25) {
        const q = at(s + ds)
        const d = (q.x - car.pos.x) ** 2 + (q.z - car.pos.z) ** 2
        if (d < best) { best = d; bs = s + ds }
      }
      s = bs
      if (s > Math.min(L - 5, sc + 60)) break
      const Ld = Math.max(12, v * 0.7)
      const tgt = at(s + Ld)
      const alpha = wrap(Math.atan2(tgt.z - car.pos.z, tgt.x - car.pos.x) - car.yaw)
      const steer = Math.max(-1, Math.min(1, ((2 * v * Math.sin(alpha)) / Ld) / 2.4))
      if (car.mode === 'ground') car.speed = v
      car.tick(DT, { throttle: 0.2, brake: 0, steer, handbrake: false })
      const ed = site.edgeDistance(car.pos.x, car.pos.z)
      if (Number.isFinite(ed) && ed > 0) return null // left the pavement: this run says nothing
      if (car.event === 'launch') return +s.toFixed(0)
    }
    return false
  }
  const minLaunchSpeed = (sc) => {
    let lo = 0, hi = 0
    for (const v of [22, 30, 40, 55, 70, 82]) { const r = launchesAt(sc, v); if (r) { hi = v; break } if (r === false) lo = v }
    if (!hi) return { crest_s: sc, launches_below_82: false, lo }
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2
      if (launchesAt(sc, mid)) hi = mid; else lo = mid
    }
    return { crest_s: sc, min_launch_speed_mps: +hi.toFixed(1), min_launch_mph: +(hi * 2.2369).toFixed(0) }
  }
  // a crest 26 m from the end of the site is still a crest (Chesterfield's is at s=3556 of 3582)
  const sharpest = crestOverride != null
    ? [{ s: crestOverride, v_launch: merged.find((c) => Math.abs(c.s - crestOverride) < 20)?.v_launch ?? null }]
    : merged.filter((c) => c.s > 50 && c.s < L - 20).slice(0, 3)

  return {
    site: site.manifest.slug,
    min_launch_speed: sharpest.map((c) => ({ ...minLaunchSpeed(c.s), geometric_v_launch: c.v_launch })),
    offset,
    length_m: +L.toFixed(0),
    knobs: T,
    knobs_applied: applied,
    crests: merged.slice(0, 10),
    runs: speeds.map(drive1),
  }
}, { offset, speeds, knobs, crestOverride })
console.log(JSON.stringify(r, null, 1))
await browser.close()
