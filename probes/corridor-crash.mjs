// Crashes are crashes: a traffic car hit hard comes off its rails and goes flying, a missile
// does the same from a distance, and the metal dents.
//
// Rich, 2026-09-30: *"we were supposed to have elastic collisions and mesh deformations and all
// that for crashes. We also need to be able to launch missiles at cars and when they hit explode
// them and make them go flying."* On the Route 3 jam: a blast under one car, and a missile fired
// down the lane at another.
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
  const THREE_V = ap.camera.position.constructor
  const V = (i) => t.view(i) // through the layer: a dynamic import of a module is a dead copy after HMR
  const car = ap.car
  // settle the world around the player, with the player parked in a lane behind a car
  const v0 = V(10)
  const bx = v0.x - Math.cos(v0.yaw) * 42, by = v0.y - Math.sin(v0.yaw) * 42
  car.place(bx, -by, -v0.yaw) // three yaw is the negative of the site yaw
  // THE EYE FOLLOWS THE CAR. The chase camera only moves in `frame()`, which never runs inside a
  // synchronous loop like this one, and the traffic places, draws and gives bodies to cars by
  // their distance from the eye: with the camera three kilometres away, the car being blasted
  // was never placed, and its body was woken at the origin and fell for ever — which this probe
  // once read as "thrown 3218 m". A car in the world is a car near the camera.
  const eye = ap.camera.position
  const follow = () => { eye.set(car.pos.x, car.pos.y + 6, car.pos.z + 12); t.player = { x: car.pos.x, y: -car.pos.z, vx: 0, vy: 0, length: 4.6 } }
  const step = () => { follow(); ap.missiles?.tick(dt); t.tick(dt, eye); ap.physics.update(car.pos, dt) }
  for (let i = 0; i < 120; i++) step()
  // 1. a blast under a car: it comes off its rails and moves
  const eA = t.entities[10]
  const meshA = t.group.children[10]
  const geoA = meshA.children[0]?.children?.[0]?.geometry?.uuid ?? null
  const a0 = meshA.position.clone()
  const moved = ap.boom({ x: a0.x + 1.5, y: a0.y, z: a0.z }, { radius: 9, impulse: 14, lift: 0.6, breakAt: 1 })
  for (let i = 0; i < 180; i++) step()
  const a1 = meshA.position.clone()
  const blast = { moved, wrecked: t.wrecked, dist: +a0.distanceTo(a1).toFixed(1), rose: +(a1.y - a0.y).toFixed(2) }
  // 2. a missile from the player's car at a car ahead
  // FROM THE SHOULDER, not from the lane: this is a jam, and a spot 30 m behind a car in its lane
  // is inside the car behind it — a missile launched from inside a car hits that car at once.
  // Four metres to the right of the lane, aimed at the target, with nothing within 8 m of the
  // launch spot.
  const spotFor = (i, back) => {
    const v = V(i)
    const rx = Math.sin(v.yaw), ry = -Math.cos(v.yaw) // right of travel in the site frame
    return { x: v.x - Math.cos(v.yaw) * back + rx * 4, y: v.y - Math.sin(v.yaw) * back + ry * 4 }
  }
  const clearAt = (sx, sy, except) => { for (let i = 0; i < t.count; i++) { if (i === except) continue; const v = V(i); if (v.visible && Math.hypot(v.x - sx, v.y - sy) <= 8) return false } return true }
  let e1 = -1
  for (let i = 12; i < t.count && e1 < 0; i++) {
    const v = V(i)
    if (v.wrecked || !v.visible) continue
    if (Math.hypot(v.x - car.pos.x, v.y + car.pos.z) > 150) continue
    const sp = spotFor(i, 30)
    if (clearAt(sp.x, sp.y, i)) e1 = i
  }
  const sp0 = spotFor(e1, 30)
  car.place(sp0.x, -sp0.y, -Math.atan2(V(e1).y - sp0.y, V(e1).x - sp0.x))
  for (let i = 0; i < 150; i++) step()
  const wreckedBefore = t.wrecked
  const wasWrecked = t.wreckedIds()
  const before = new Map(t.group.children.map((c, i) => [i, c.position.clone()]))
  // aim: at the car as it is NOW, then fire at once — a driver aims, a probe must too
  const sp1 = spotFor(e1, 30)
  car.place(sp1.x, -sp1.y, -Math.atan2(V(e1).y - sp1.y, V(e1).x - sp1.x))
  const fired = ap.fire()
  let landed = 0
  for (let i = 0; i < 240 && !landed; i++) { step(); landed = ap.missiles?.landed ?? 0 }
  for (let i = 0; i < 180; i++) step()
  const fresh = t.wreckedIds().filter((i) => !wasWrecked.includes(i))
  const freshState = fresh.length ? t.bodyState(fresh[0]) : null
  const freshBefore = fresh.length ? before.get(fresh[0]) : null
  const hitToCar = fresh.length && ap.missiles?.lastHit ? +Math.hypot(ap.missiles.lastHit.x - freshBefore.x, ap.missiles.lastHit.z - freshBefore.z).toFixed(1) : null
  const t0 = fresh.length ? before.get(fresh[0]) : new THREE_V()
  const t1 = fresh.length ? t.group.children[fresh[0]].position : t0
  const target = { position: t1 }
  // dents: a geometry that is its own now, not the shared model's
  let dentedMeshes = 0
  for (const c of t.group.children) c.traverse((o) => { if (o.isMesh && o.geometry?.userData?.__dented) dentedMeshes++ })
  const hit = ap.missiles?.lastHit
  const from = { x: car.pos.x, y: car.pos.y, z: car.pos.z }
  return { freshState, hitToCar, fresh, hit, from, target: { x: +t0.x.toFixed(1), y: +t0.y.toFixed(1), z: +t0.z.toFixed(1) }, fwd: [+car.forward.x.toFixed(2), +car.forward.z.toFixed(2)], blast, fired, landed, missileHit: { dist: +t0.distanceTo(t1).toFixed(1), wreckedNow: t.wrecked - wreckedBefore }, geoA, playerSpeed: +car.speed.toFixed(1) }
})
console.log(JSON.stringify(r))
check(r.blast.moved >= 1 && r.blast.wrecked >= 1 && r.blast.dist > 3 && r.blast.dist < 80 && r.blast.rose > -3, `a blast under a traffic car knocks it loose and throws it, and it lands (${r.blast.moved} bodies moved, ${r.blast.dist} m away, rose ${r.blast.rose} m, ${r.blast.wrecked} wrecked)`)
check(r.fired && r.landed >= 1, `a missile fired from the player lands (${r.landed})`)
check(r.missileHit.wreckedNow >= 1 && r.missileHit.dist > 2 && r.missileHit.dist < 120, `…and the car it hit goes flying, and lands (${r.missileHit.wreckedNow} more wrecked, ${r.missileHit.dist} m from where it was)`)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
