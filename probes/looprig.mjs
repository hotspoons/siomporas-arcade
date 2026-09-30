// A loop, a car, and nothing else. No browser, no site, no trees, no renderer.
//
// READ THIS FIRST (2026-09-29): this rig is NOT the game's car. It drives a raw Rapier controller
// with its own springs, and — because it lives in `probes/` and imports the package by name — it
// runs on the repo root's Rapier 0.12, while the engine ships 0.21 in its own node_modules. Its
// "goes round" said nothing about why the real car stopped. `probes/looprig-real.sh` runs the
// engine's actual `Vehicle`, the real `@apex/stunt-pieces` loop through `connectFixture`, and the
// real assist, on the engine's Rapier; it reproduced the game's stop to the lane sample and found
// it (a trimesh internal-edge ghost collision — see `addSurface` in the engine's terrain.ts).
// Keep this one for what it is: a fast sanity check of the loop's geometry.
//
// Rich, 2026-09-29: *"Can you make a closed simulation of the loop and iterate on it until you can
// get a car to actually drive around the loop?"* Yes, and it should have been the first thing built.
// Every measurement so far has cost a two-minute browser run over a real corridor with terrain,
// trees and streaming — which is why it took six rounds to notice that two of the trees were inside
// the fixture. This runs in about a second and contains exactly two things: the loop's own surface,
// and a vehicle.
//
// WHAT IT IS FOR: iterating. Sweep the assist, the profile, the entry speed, the chassis, and see
// which combination gets a car round. What it deliberately cannot tell you is anything about the
// world the loop is standing in — that is what the browser probes are for.
//
//   node probes/looprig.mjs                      the defaults
//   node probes/looprig.mjs --speed 30           enter at 30 m/s
//   node probes/looprig.mjs --align 60 --pull 11 sweep the assist
//   node probes/looprig.mjs --sweep              a grid, and the best result
import RAPIER from '@dimforge/rapier3d-compat'

await RAPIER.init()

/* ---- the loop's geometry, without importing the app --------------------------------------------
 *
 * The lane is a circle in the vertical plane with a flat run-in and run-out, which is what
 * `@apex/stunt-pieces`' loop is: 80 m of footprint, a 36 m top, and the sideways drift that stops
 * the exit landing on the entry. Rebuilt here from its numbers rather than imported so the rig has
 * no dependency on the app's module graph — and so that changing the piece cannot quietly change
 * what this measures.
 */
const ARG_EARLY = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : dflt
}

const CELL = 40
const R = 18 // the loop's radius, from the measured lane: tightest turn 17.1 m
const RUN_IN = 40
const RUN_OUT = 40
/*
 * THE SIDEWAYS DRIFT, OFF BY DEFAULT.
 *
 * The real piece moves the lane a cell sideways so its exit does not land on its entry. In here
 * that only adds a steering problem to a rig built to answer a vertical question — and it did:
 * with the drift on and no steering, the car left the road eight metres wide at the end of the
 * run-in and the rig reported the loop had stopped it. A loop in a plane is the isolation. `--drift
 * 40` puts it back.
 */
const DRIFT = ARG_EARLY('drift', 0)
const HALF_W = 5

/** The lane: position, and the surface normal, every `step` metres. */
function lane(step = 0.5) {
  const out = []
  const loopLen = 2 * Math.PI * R
  const total = RUN_IN + loopLen + RUN_OUT
  for (let s = 0; s <= total; s += step) {
    /*
     * THE DRIFT HAPPENS THROUGH THE LOOP, not along the whole piece. That is what the real one does
     * and it is the only version that makes sense: the run-in is a straight you arrive on, the loop
     * carries you a cell sideways so the exit misses the entry, and the run-out is another straight.
     * Spread across the whole piece instead, the approach itself curves — which a rig measuring a
     * VERTICAL question should not have to steer for.
     */
    const through = Math.max(0, Math.min(1, (s - RUN_IN) / loopLen))
    const y = DRIFT * through
    if (s < RUN_IN) {
      out.push({ x: s, y, z: 0, up: { x: 0, y: 0, z: 1 } })
    } else if (s < RUN_IN + loopLen) {
      // round the circle: starts at the bottom heading +x, over the top, back to the bottom
      const a = (s - RUN_IN) / R
      out.push({
        x: RUN_IN + R * Math.sin(a),
        y,
        z: R * (1 - Math.cos(a)),
        up: { x: -Math.sin(a), y: 0, z: Math.cos(a) },
      })
    } else {
      out.push({ x: RUN_IN + (s - RUN_IN - loopLen), y, z: 0, up: { x: 0, y: 0, z: 1 } })
    }
  }
  return out
}

/** The ribbon, in the physics frame (x east, y up, z south), as a trimesh. */
function ribbon(path, half = HALF_W) {
  const pos = new Float32Array(path.length * 6)
  const idx = new Uint32Array((path.length - 1) * 6)
  for (let i = 0; i < path.length; i++) {
    const p = path[i]
    const q = path[Math.min(i + 1, path.length - 1)]
    const a = path[Math.max(i - 1, 0)]
    // the true 3D tangent, from the neighbours
    let tx = q.x - a.x
    let ty = q.y - a.y
    let tz = q.z - a.z
    const tl = Math.hypot(tx, ty, tz) || 1
    tx /= tl; ty /= tl; tz /= tl
    // across = tangent × normal, both 3D — the cross-section stays square to travel
    const ax = ty * p.up.z - tz * p.up.y
    const ay = tz * p.up.x - tx * p.up.z
    const az = tx * p.up.y - ty * p.up.x
    const al = Math.hypot(ax, ay, az) || 1
    const hx = (ax / al) * half
    const hy = (ay / al) * half
    const hz = (az / al) * half
    // site (x east, y north, z up) -> physics (x east, y up, z south)
    const k = i * 6
    pos[k] = p.x - hx; pos[k + 1] = p.z - hz; pos[k + 2] = -(p.y - hy)
    pos[k + 3] = p.x + hx; pos[k + 4] = p.z + hz; pos[k + 5] = -(p.y + hy)
    if (i) {
      const b = (i - 1) * 2
      const j = (i - 1) * 6
      idx[j] = b; idx[j + 1] = b + 1; idx[j + 2] = b + 2
      idx[j + 3] = b + 1; idx[j + 4] = b + 3; idx[j + 5] = b + 2
    }
  }
  return { pos, idx }
}

/* ---- the car ---------------------------------------------------------------------------------- */

const ARG = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : dflt
}
const FLAG = (name) => process.argv.includes(`--${name}`)

/** The stunts profile's numbers, as `packages/engine/src/physics/profiles.ts` has them. */
const PROFILE = {
  massKg: 1400,
  halfLength: 2.2,
  halfHeight: 0.6,
  halfWidth: 0.9,
  wheelRadius: 0.34,
  suspensionRest: 0.35,
  suspensionTravel: 0.3,
  stiffness: 32,
  compression: 0.82,
  relaxation: 0.88,
  maxSuspensionForce: 60000,
  grip: 2.24,
  sideStiffness: 1,
  powerPerKg: 11,
  chassisFriction: 0.04,
}

function drive(opts) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.integrationParameters.dt = 1 / opts.hz

  // the track
  const path = lane(opts.facet)
  const { pos, idx } = ribbon(path)
  const track = world.createCollider(
    RAPIER.ColliderDesc.trimesh(pos, idx).setFriction(1.1),
    world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
  )

  /*
   * The car, ON THE LANE — which is not the x axis. The piece drifts sideways across its footprint
   * so the exit does not land on the entry, so the run-in starts twenty metres off centre. Spawned
   * at the origin instead, the car was beside the track, fell off the edge, and the rig cheerfully
   * reported it had got round because the nearest lane sample to a falling car is anywhere.
   */
  const start = path[Math.round(4 / opts.facet)]
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(start.x, start.z + opts.rest + PROFILE.wheelRadius + PROFILE.halfHeight, -start.y)
      .setLinearDamping(0.02)
      .setAngularDamping(0.15)
      .setCcdEnabled(true),
  )
  let bodyCollider = null
  const chassis = RAPIER.ColliderDesc.cuboid(PROFILE.halfLength, PROFILE.halfHeight, PROFILE.halfWidth)
    .setFriction(opts.chassisFriction)
    .setRestitution(0.1)
  chassis.setMass(PROFILE.massKg)
  bodyCollider = world.createCollider(chassis, body)

  const vc = world.createVehicleController(body)
  vc.indexUpAxis = 1
  vc.setIndexForwardAxis = 0
  const wheels = [
    [PROFILE.halfLength * 0.7, -PROFILE.halfHeight, PROFILE.halfWidth],
    [PROFILE.halfLength * 0.7, -PROFILE.halfHeight, -PROFILE.halfWidth],
    [-PROFILE.halfLength * 0.7, -PROFILE.halfHeight, PROFILE.halfWidth],
    [-PROFILE.halfLength * 0.7, -PROFILE.halfHeight, -PROFILE.halfWidth],
  ]
  for (const [x, y, z] of wheels) {
    vc.addWheel({ x, y, z }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, opts.rest, PROFILE.wheelRadius)
  }
  for (let i = 0; i < 4; i++) {
    vc.setWheelSuspensionStiffness(i, opts.stiffness)
    vc.setWheelMaxSuspensionTravel(i, opts.travel)
    vc.setWheelSuspensionCompression(i, opts.compression)
    vc.setWheelSuspensionRelaxation(i, opts.relaxation)
    vc.setWheelMaxSuspensionForce(i, opts.maxForce)
    vc.setWheelFrictionSlip(i, PROFILE.grip)
    vc.setWheelSideFrictionStiffness(i, PROFILE.sideStiffness)
  }

  // give it its entry speed straight away: this rig is about the loop, not about accelerating to it
  body.setLinvel({ x: opts.speed, y: 0, z: 0 }, true)

  /** the nearest lane sample to a point, and the average up over the next `window` metres */
  const nearest = (p) => {
    let best = 0
    let bd = Infinity
    for (let i = 0; i < path.length; i++) {
      const d = (path[i].x - p.x) ** 2 + (path[i].z - p.y) ** 2 + (-path[i].y - p.z) ** 2
      if (d < bd) { bd = d; best = i }
    }
    return { i: best, d: Math.sqrt(bd) }
  }
  const upAhead = (i, metres) => {
    let run = 0
    let ux = 0, uy = 0, uz = 0, total = 0
    for (let k = i; k < path.length && run < metres; k++) {
      const w = 1 - 0.8 * (run / metres)
      ux += path[k].up.x * w
      uy += path[k].up.y * w
      uz += path[k].up.z * w
      total += w
      if (k + 1 < path.length) run += Math.hypot(path[k + 1].x - path[k].x, path[k + 1].y - path[k].y, path[k + 1].z - path[k].z)
    }
    const l = Math.hypot(ux, uy, uz) || 1
    // site z-up to physics y-up
    return { x: ux / l, y: uz / l, z: -uy / l }
  }

  const rot = (q, v) => {
    const ix = q.w * v.x + q.y * v.z - q.z * v.y
    const iy = q.w * v.y + q.z * v.x - q.x * v.z
    const iz = q.w * v.z + q.x * v.y - q.y * v.x
    const iw = -q.x * v.x - q.y * v.y - q.z * v.z
    return {
      x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
      y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
      z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
    }
  }

  const dt = 1 / opts.hz
  let best = { z: 0, at: 0 }
  /*
   * PROGRESS IS ONLY PROGRESS IF THE CAR IS STILL ON THE TRACK. Advancing on the nearest sample
   * alone counts a car that has fallen off and is sailing past the far end as having driven there.
   */
  let furthest = 0
  let offAt = null
  const trace = []
  let stuck = 0

  for (let step = 0; step < opts.hz * opts.seconds; step++) {
    const t = body.translation()
    const near = nearest(t)
    /*
     * PROGRESS HAS TO BE WALKED, NOT TELEPORTED TO. A loop's run-out passes within a few metres of
     * its own entry, so a car that falls off at the bottom lands next to lane samples three hundred
     * further on and the nearest-sample search happily reports it has driven there. Measured: 122 →
     * 360 in half a second at 30 m/s, which is 119 m of lane in 15 m of travel. Progress only counts
     * if it is near the lane AND continues from where the car already was.
     */
    if (near.d < opts.onTrack && near.i <= furthest + opts.maxJump) furthest = Math.max(furthest, near.i)
    else if (offAt === null) offAt = { t: +(step * dt).toFixed(2), i: near.i, d: +near.d.toFixed(1) }

    /*
     * THROTTLE, THROUGH THE SAME TRACTION BUDGET THE ENGINE USES.
     *
     * `vehicle.ts` limits each driven wheel to `frictionSlip × suspensionForce`, floored at a share
     * of the static load — and that floor is the whole point: without it a wheel that goes light on
     * a ramp's entry has a budget of zero and the engine delivers nothing at all. A rig that just
     * sets an engine force would be measuring a car we do not ship.
     */
    const v = body.linvel()
    const speed = Math.hypot(v.x, v.y, v.z)
    const want = speed < opts.speed ? PROFILE.powerPerKg * PROFILE.massKg : 0
    const driven = opts.awd ? [0, 1, 2, 3] : [2, 3]
    const staticLoad = (PROFILE.massKg * 9.81) / 4
    for (let i = 0; i < 4; i++) vc.setWheelEngineForce(i, 0)
    let delivered = 0
    let worstSide = 0
    let worstBudget = 0
    for (const i of driven) {
      const raw = vc.wheelSuspensionForce(i) || staticLoad
      const load = Math.max(raw, staticLoad * opts.tractionFloor)
      const budget = (vc.wheelFrictionSlip(i) ?? 1) * load
      /*
       * THE FRICTION CIRCLE, and this is the line Rich's description points at: *"the kind of weird
       * friction I get when I try to turn while accelerating."* Whatever the side force has taken,
       * the drive cannot have — so a wheel being pushed sideways hard enough gets NO drive at all,
       * however much power the engine has. On a loop, and while the assist is rotating the car into
       * one, the lateral demand is enormous.
       */
      const side = Math.abs(vc.wheelSideImpulse(i) ?? 0) / dt
      const circle = Math.sqrt(Math.max(0, budget * budget - side * side))
      const room = Math.max(circle, budget * opts.driveShare)
      const got = Math.max(-room, Math.min(want / driven.length, room))
      delivered += got
      worstSide = Math.max(worstSide, side)
      worstBudget = Math.max(worstBudget, budget)
      vc.setWheelEngineForce(i, got)
    }
    /*
     * STEERING, toward the lane a few metres ahead. Zero on a straight loop; the moment `--drift` is
     * on, it is the difference between driving the piece and driving off the side of it.
     */
    /*
     * A SPEED-SCALED LOOKAHEAD. Aiming eight metres ahead is a quarter of a second at 32 m/s, and a
     * pursuit controller that tight oversteers violently: measured, 0.31 rad of lock at the loop's
     * mouth, 42 kN of lateral force, and the friction circle closed on the drive completely.
     */
    const aimM = Math.max(10, Math.min(40, Math.hypot(v.x, v.y, v.z) * 0.9))
    const aim = path[Math.min(path.length - 1, near.i + Math.round(aimM / opts.facet))]
    /*
     * IN THREE DIMENSIONS, not in the ground plane. Half way up a loop the car's lateral axis points
     * mostly UP, so an error measured only in x and z is measuring almost nothing — the rig steered
     * confidently while sliding off the side of the loop, 3 m off the lane, then 11, then 17.
     */
    const fwd = rot(body.rotation(), { x: 1, y: 0, z: 0 })
    const side = rot(body.rotation(), { x: 0, y: 0, z: 1 })
    const dx = aim.x - t.x
    const dy = aim.z - t.y
    const dz = -aim.y - t.z
    const along = dx * fwd.x + dy * fwd.y + dz * fwd.z
    const across = dx * side.x + dy * side.y + dz * side.z
    /*
     * NEGATED, and measured rather than reasoned: with the other sign the lock went to half a
     * radian while the lateral error grew 0.2 → 2.4 → 6.1 m. Positive steering turns the car toward
     * −Z and `across` is measured toward +Z.
     */
    const steer = along > 0.1 ? Math.max(-0.5, Math.min(0.5, -Math.atan2(across, along))) : 0
    for (const w of [0, 1]) vc.setWheelSteering(w, steer)

    // the assist
    if (opts.align > 0 || opts.pull > 0) {
      const up = upAhead(near.i, opts.window)
      const u = rot(body.rotation(), { x: 0, y: 1, z: 0 })
      const ax = u.y * up.z - u.z * up.y
      const ay = u.z * up.x - u.x * up.z
      const az = u.x * up.y - u.y * up.x
      const sin = Math.hypot(ax, ay, az)
      const cos = u.x * up.x + u.y * up.y + u.z * up.z
      const angle = Math.atan2(sin, cos)
      if (sin > 1e-6 && opts.align > 0) {
        const nx = ax / sin, ny = ay / sin, nz = az / sin
        const w = body.angvel()
        const along = w.x * nx + w.y * ny + w.z * nz
        const imp = (angle * opts.align - along * opts.align * 0.35) * PROFILE.massKg * dt
        body.applyTorqueImpulse({ x: nx * imp, y: ny * imp, z: nz * imp }, true)
      }
      /*
       * AND THE HEADING. Aligning the car's UP to the surface is only half an orientation — the
       * other half is which way round it is facing on that surface, and a loop that drifts forty
       * metres sideways as it climbs demands a constant turn about the surface normal. Without it
       * the car climbs beautifully and slides off the side, which is what the rig measured: off the
       * lane by eight metres at 5.7 m up.
       *
       * The torque is about the SURFACE normal, not world up — on a wall those are ninety degrees
       * apart, and turning about the wrong one rolls the car off the track.
       */
      if (opts.heading > 0) {
        const ahead = path[Math.min(path.length - 1, near.i + Math.round(opts.window / opts.facet))]
        const at = path[near.i]
        let lx = ahead.x - at.x
        let ly = -(ahead.y - at.y)
        let lz = ahead.z - at.z
        // the lane's direction, flattened onto the surface
        const d = lx * up.x + lz * up.y + ly * up.z
        lx -= up.x * d
        lz -= up.y * d
        ly -= up.z * d
        const ll = Math.hypot(lx, lz, ly) || 1
        const tx = lx / ll
        const ty = lz / ll
        const tz = ly / ll
        const f = rot(body.rotation(), { x: 1, y: 0, z: 0 })
        const ax2 = f.y * tz - f.z * ty
        const ay2 = f.z * tx - f.x * tz
        const az2 = f.x * ty - f.y * tx
        // only the component about the surface normal: the rest is pitch, which `align` owns
        const about = ax2 * up.x + ay2 * up.y + az2 * up.z
        const w2 = body.angvel()
        const spin = w2.x * up.x + w2.y * up.y + w2.z * up.z
        const imp = (about * opts.heading - spin * opts.heading * 0.35) * PROFILE.massKg * dt
        body.applyTorqueImpulse({ x: up.x * imp, y: up.y * imp, z: up.z * imp }, true)
      }
      if (opts.pull > 0) {
        const scale = Math.max(0, Math.min(2, 1 - up.y))
        const p = Math.min(opts.pull * scale, 9.81 * 2.5) * PROFILE.massKg * dt
        body.applyImpulse({ x: -up.x * p, y: -up.y * p, z: -up.z * p }, true)
      }
    }

    vc.updateVehicle(dt, undefined, 0xffffffff)
    world.step()

    if (t.y > best.z) best = { z: +t.y.toFixed(2), at: +(step * dt).toFixed(2) }
    if (speed < 1) stuck++
    else stuck = 0
    if (step % Math.round(opts.hz * opts.every) === 0) {
      const u = rot(body.rotation(), { x: 0, y: 1, z: 0 })
      const su = upAhead(near.i, 1)
      const agree = +(u.x * su.x + u.y * su.y + u.z * su.z).toFixed(2)
      // how many contacts the CHASSIS has: a body dragging on the road is the other way to lose speed
      let touching = 0
      world.contactPairsWith(bodyCollider, () => { touching++ })
      trace.push({
        t: +(step * dt).toFixed(2),
        y: +t.y.toFixed(1),
        v: +speed.toFixed(1),
        lane: near.i,
        off: +near.d.toFixed(1),
        up: agree,
        steer: +steer.toFixed(2),
        side: Math.round(worstSide),
        budget: Math.round(worstBudget),
        drive: Math.round(delivered),
        body: touching,
      })
    }
    if (stuck > opts.hz * 1.5) break
    if (near.d > opts.onTrack * 3) break // it is not coming back
    if (furthest > path.length - 6) break
  }

  /*
   * AND GOING ROUND MEANS GOING OVER THE TOP. Reaching the far end is not enough on its own — the
   * run-out is reachable by falling off — so the car must also have been up there.
   */
  const done = furthest > path.length - 10 && best.z > R * 1.5
  return { done, top: best, furthest, of: path.length, offAt, trace }
}

const base = {
  hz: ARG('hz', 240),
  seconds: ARG('seconds', 14),
  speed: ARG('speed', 32),
  align: ARG('align', 40),
  pull: ARG('pull', 11),
  window: ARG('window', 35),
  facet: ARG('facet', 0.5),
  travel: ARG('travel', PROFILE.suspensionTravel),
  maxForce: ARG('maxForce', PROFILE.maxSuspensionForce),
  // the shipped profile's springs, so the rig can drive the car the game actually has
  stiffness: ARG('stiffness', PROFILE.stiffness),
  rest: ARG('rest', PROFILE.suspensionRest),
  compression: ARG('compression', PROFILE.compression),
  relaxation: ARG('relaxation', PROFILE.relaxation),
  chassisFriction: ARG('chassisFriction', PROFILE.chassisFriction),
  /** how far from the lane still counts as on it, metres — half the road plus a margin */
  onTrack: ARG('onTrack', 8),
  /** the most lane samples progress may advance in one step, so a fall cannot count as a drive */
  maxJump: ARG('maxJump', 12),
  every: ARG('every', 0.5),
  awd: ARG('awd', 1) > 0,
  heading: ARG('heading', 25),
  tractionFloor: ARG('tractionFloor', 0.25),
  driveShare: ARG('driveShare', 0.33),
}

if (!FLAG('sweep')) {
  const r = drive(base)
  // one line, so a shell can read it and a person can too
  console.log(JSON.stringify({ done: r.done, furthest: r.furthest, of: r.of, top: r.top, offAt: r.offAt }))
  for (const row of r.trace) console.log('  ' + JSON.stringify(row))
  console.log(r.done ? 'ROUND THE LOOP' : `stopped at lane sample ${r.furthest} of ${r.of}, top ${r.top.z} m`)
  process.exit(r.done ? 0 : 1)
}

/*
 * THE SWEEP. Four variables, coarse: entry speed, alignment, pull, and how far ahead the surface is
 * read. Prints every combination that gets round, and the best of the rest.
 */
const wins = []
let bestTry = { furthest: -1 }
for (const speed of [18, 24, 30, 36, 44]) {
  for (const align of [0, 20, 40, 80]) {
    for (const pull of [0, 11, 20]) {
      for (const window of [20, 35, 60]) {
        const r = drive({ ...base, speed, align, pull, window })
        const row = { speed, align, pull, window, furthest: r.furthest, top: r.top.z, done: r.done }
        if (r.done) wins.push(row)
        if (r.furthest > bestTry.furthest) bestTry = row
      }
    }
  }
}
console.log(`tried ${5 * 4 * 3 * 3} combinations`)
if (wins.length) {
  console.log(`ROUND THE LOOP in ${wins.length}:`)
  for (const w of wins.slice(0, 12)) console.log(' ', JSON.stringify(w))
} else {
  console.log('none got round. the best was:', JSON.stringify(bestTry))
}
process.exit(wins.length ? 0 : 1)
