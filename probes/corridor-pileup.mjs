// The pile-up, as a thing that can go on for ever.
//
// Rich, 2026-09-30: "there will be a car just appear out of thin air" · "the traffic AI doesn't
// know to stop or slow down so cars start piling up" · "I wish we could have the cars keep piling
// up in a game mode where all of the drivers are blind … limit whatever is causing the CPU and
// GPU decline to a maximum number of bodies before old ones start disappearing" · "trying to
// straighten my car out was in slow motion when it was running at 12 FPS".
//
// So, on the Route 3 jam: a car that runs off its road comes back far from the player and
// moving; a driver stops behind a wreck unless the drivers are blind; wrecks past the cap are
// straightened out and recycled; a dent is centimetres, not a blob; and a slow frame still gets
// its full ration of physics steps.
import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u; export const ErrorOverlay = class {}; export default {}' }))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }
await p.goto('http://127.0.0.1:5185/index.html?level=crofton-jam#crofton-triangle', { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.traffic && !!window.__apex?.drive?.on && window.__apex?.car?.constructor?.name === 'RapierCar', null, { timeout: 240000 })
await p.waitForTimeout(2000)
const r = await p.evaluate(async () => {
  const ap = window.__apex, t = ap.traffic, dt = 1 / 60
  const car = ap.car
  const out = {}
  // EVERYTHING ABOUT A CAR COMES THROUGH `t.view(i)`. A dynamic import of `/src/traffic.ts` is a
  // second copy of the module after any HMR update, with its own empty component arrays.
  const V = (i) => t.view(i)
  // the eye follows the car and the drivers see the player, both of which `frame()` does and a
  // synchronous loop like this one must do itself
  const eye = ap.camera.position
  const follow = () => { eye.set(car.pos.x, car.pos.y + 6, car.pos.z + 12); t.player = { x: car.pos.x, y: -car.pos.z, vx: 0, vy: 0, length: 4.6 } }
  const step = () => { follow(); t.tick(dt, eye); ap.physics.update(car.pos, dt) }
  // park the player on the SHOULDER, four metres right of the lane and 42 m behind car 10: in the
  // lane it is an obstacle the drivers stop for, and this probe wants them to stop for the wreck
  const shoulder = (i, back) => { const v = V(i); const rx = Math.sin(v.yaw), ry = -Math.cos(v.yaw); return { x: v.x - Math.cos(v.yaw) * back + rx * 4, y: v.y - Math.sin(v.yaw) * back + ry * 4, yaw: v.yaw } }
  const sp = shoulder(10, 42)
  car.place(sp.x, -sp.y, -sp.yaw)
  for (let i = 0; i < 120; i++) step()

  // ---- 1. a slow frame still gets its physics: 0.1 s of real time in one update
  const s0 = ap.physics.stats().steps
  const t0 = performance.now()
  ap.physics.update(car.pos, 0.1)
  out.budget = { steps: ap.physics.stats().steps - s0, ms: +(performance.now() - t0).toFixed(1), dropped: ap.physics.stats().dropped }

  // ---- 2. a wreck in the lane: the car behind it stops; a blind one does not
  const follower = (of) => {
    const w = V(of)
    let best = -1, bestGap = Infinity
    for (let i = 0; i < t.count; i++) {
      if (i === of) continue
      const v = V(i)
      if (v.chain !== w.chain || v.lane !== w.lane || v.dir !== w.dir) continue
      const gap = w.s - v.s
      if (gap > 0 && gap < bestGap) { bestGap = gap; best = i }
    }
    return best
  }
  // ONE car, knocked loose where it stands: a blast just big enough for it and not the car
  // behind (this is a jam, and the car behind is close)
  const nudge = (i) => { const m = t.group.children[i]; return ap.boom({ x: m.position.x, y: m.position.y + 0.7, z: m.position.z }, { radius: 2.4, impulse: 1.2, lift: 0.15, breakAt: 1 }) }
  const iF = follower(10)
  const meshW = t.group.children[10]
  nudge(10)
  // the follower starts well over a hundred metres back at the limit; the model takes its time
  for (let i = 0; i < 60 * 24; i++) step()
  const f1 = V(iF), w1 = V(10)
  out.stops = { follower: iF, followerDriven: f1.driven, wrecked: t.wrecked, wakes: t.wakes.slice(), inLane: w1.chain !== 0xffff, gap: +(w1.s - f1.s).toFixed(1), seen: +f1.gap.toFixed(1), leader: f1.leader, speed: +f1.speed.toFixed(2), passed: f1.s > w1.s }
  t.blind = true
  for (let i = 0; i < 60 * 8; i++) step()
  const f2 = V(iF), w2 = V(10)
  // a blind driver reaches the wreck: past it, or into it hard enough to be knocked loose itself
  out.blind = { gap: +(w2.s - f2.s).toFixed(1), speed: +f2.speed.toFixed(2), passed: f2.s > w2.s, driven: f2.driven, reached: f2.s > w2.s - 6 || !f2.driven }
  t.blind = false

  // ---- 3. a dent is a dent, not a blob: the wreck's vertices moved by centimetres in the world
  const dentOf = (wreck) => {
    let dent = null
    wreck.traverse((o) => {
      if (dent || !o.isMesh) return
      const twin = t.group.children.find((c) => c !== wreck && c.name === wreck.name)
      let src = null
      twin?.traverse((q) => { if (!src && q.isMesh) src = q })
      if (!src || src.geometry === o.geometry) return
      const a = o.geometry.attributes.position.array, b = src.geometry.attributes.position.array
      const k = o.getWorldScale(new eye.constructor()).x
      let worst = 0, moved = 0
      for (let i = 0; i < a.length; i += 3) {
        const d = Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]) * k
        if (d > 1e-4) moved++
        if (d > worst) worst = d
      }
      dent = { own: true, worstM: +worst.toFixed(3), moved, verts: a.length / 3, scale: +k.toFixed(2) }
    })
    return dent ?? { own: false }
  }
  // the follower, blind, drove into the wreck: both are dented now
  out.dent = dentOf(meshW)
  out.dents = t.stats.dents

  // ---- 4. the cap: wreck more cars near the player with the cap at four; the oldest come back as cars
  window.corridor.tune.set('TRAFFIC_WRECKS_MAX', 4)
  const wokenBefore = t.woken
  const near = []
  for (let i = 0; i < t.count && near.length < 12; i++) {
    const v = V(i)
    if (i === 10 || v.wrecked || !v.visible) continue
    const m = t.group.children[i]
    if (Math.hypot(m.position.x - car.pos.x, m.position.z - car.pos.z) < 160) near.push(i)
  }
  for (const i of near) { nudge(i); for (let k = 0; k < 30; k++) step() }
  for (let i = 0; i < 60 * 6; i++) step()
  // a recycled car: straight, on rails, and either hidden or far from the player
  const recycledIdx = [10, ...near].find((i) => !V(i).wrecked) ?? -1
  let rc = null
  if (recycledIdx >= 0) {
    const m = t.group.children[recycledIdx]
    const v = V(recycledIdx)
    rc = { idx: recycledIdx, worst: dentOf(m).worstM ?? 0, visible: m.visible, hidden: v.hidden, driven: v.driven, distM: +Math.hypot(m.position.x - car.pos.x, m.position.z - car.pos.z).toFixed(0), dynamic: t.bodyState(recycledIdx)?.dynamic ?? null }
  }
  out.cap = { near: near.length, woken: t.woken - wokenBefore, wokenAll: t.woken, recycledAll: t.recycled, wrecked: t.wrecked, rc }

  // ---- 5. respawns: run the traffic for two minutes of world time with the player parked
  const before = t.respawned
  for (let i = 0; i < 50 * 120; i++) t.tick(1 / 50, eye)
  out.respawn = { n: t.respawned - before, minM: +t.respawnMin.toFixed(0), parked: t.parked, limit: window.corridor.tune.get('TRAFFIC_RESPAWN_M') }
  // and no car on the road sits still where it was put back: every non-wrecked visible car near the player is moving or queued behind another
  let still = 0, visible = 0
  for (let i = 0; i < t.count; i++) {
    const v = V(i)
    if (!v.visible || v.wrecked) continue
    visible++
    if (v.speed < 0.1 && v.leader < 0 && v.s < 20) still++
  }
  out.still = { still, visible }
  // ---- 6. what a frame of traffic costs here, for the record (swiftshader's CPU, not Rich's)
  let a = 0, pl = 0, ph = 0
  for (let i = 0; i < 60; i++) { step(); a += t.stats.actorsMs; pl += t.stats.placeMs; ph += ap.physics.stats().stepMs }
  out.cost = { actorsMs: +(a / 60).toFixed(2), placeMs: +(pl / 60).toFixed(2), physMs: +(ph / 60).toFixed(2), bodies: ap.physics.stats().bodies, cars: t.count }
  return out
})
console.log(JSON.stringify(r))
check(r.budget.steps >= 10, `a 100 ms frame runs its steps rather than 33 ms of them (${r.budget.steps} steps in ${r.budget.ms} ms, ${r.budget.dropped} dropped)`)
check(r.stops.inLane && r.stops.follower >= 0 && r.stops.followerDriven && r.stops.wrecked === 1 && r.stops.leader === 10 && !r.stops.passed && r.stops.speed < 0.5 && r.stops.gap > 0 && r.stops.gap < 15, `the driver behind a wreck stops behind it (gap ${r.stops.gap} m, ${r.stops.speed} m/s, following car ${r.stops.leader}; ${r.stops.wrecked} loose, in its lane: ${r.stops.inLane})`)
check(r.blind.reached, `…and a blind one drives on into it (gap ${r.blind.gap} m, ${r.blind.speed} m/s, still driven: ${r.blind.driven})`)
check(r.dent.own && r.dent.worstM > 0.005 && r.dent.worstM <= 0.36, `the wreck is dented in centimetres, not folded (worst ${r.dent.worstM} m over ${r.dent.moved} of ${r.dent.verts} vertices, scale ${r.dent.scale})`)
check(r.cap.woken >= 6 && r.cap.wrecked <= 4 && r.cap.recycledAll === r.cap.wokenAll - r.cap.wrecked, `wrecks past the cap are recycled (${r.cap.woken} knocked loose here, ${r.cap.wrecked} loose now, ${r.cap.recycledAll} recycled in all)`)
check(r.cap.rc && r.cap.rc.worst < 1e-3 && r.cap.rc.dynamic === false && r.cap.rc.driven && (!r.cap.rc.visible || r.cap.rc.distM >= 250), `a recycled car is straight, on rails and out of sight (${JSON.stringify(r.cap.rc)})`)
check(r.respawn.n >= 1 && r.respawn.minM >= r.respawn.limit - 1, `every car that ran off its road came back ${r.respawn.limit} m or more from the player (${r.respawn.n} respawns, nearest ${r.respawn.minM} m)`)
console.log('cost', JSON.stringify(r.cost))
check(r.cost.actorsMs < 8 && r.cost.placeMs < 8 && r.cost.physMs < 12, `a frame of traffic is cheap even here (actors ${r.cost.actorsMs} ms, place ${r.cost.placeMs} ms, physics ${r.cost.physMs} ms for ${r.cost.cars} cars)`)
check(r.still.still === 0, `no car was put back standing still at the start of a road (${r.still.still} of ${r.still.visible} visible)`)
await b.close()
process.exit(bad ? 1 : 0)
