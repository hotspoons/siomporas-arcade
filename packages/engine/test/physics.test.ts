// Does the physics module actually do physics?
//
// The rule this suite is written to (docs/sessions, and learned the hard way): ASSERT THE
// MECHANISM, and prove the assertion can fail. Half of these tests have a negative twin — the car
// accelerates on throttle AND does not accelerate without it, the wall is hit AND an empty world
// reports nothing — because a physics test that only ever checks "> 0" passes just as happily when
// the thing under test has quietly stopped running.
//
// All of it is headless: Rapier's `-compat` build runs in Node, so nothing here needs a browser,
// and "the car drives" is a question with an answer in CI.

import { beforeAll, describe, expect, it } from 'vitest'
import { groups, isLayer, LAYER, queryGroups, QUERY } from '../src/physics/layers'
import { blendProfiles, PROFILES, profile, SIM, STUNTS } from '../src/physics/profiles'
import { loadRapier, rapier } from '../src/physics/rapier'
import { Vehicle } from '../src/physics/vehicle'
import { PhysicsWorld } from '../src/physics/world'

beforeAll(async () => {
  await loadRapier()
})

/** A 1 km square of flat ground with its top at y = 0. */
function ground(phys: PhysicsWorld, friction = 1) {
  const R = rapier()
  const body = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -1, 0))
  const desc = R.ColliderDesc.cuboid(500, 1, 500).setFriction(friction)
  phys.describe(desc, 'terrain')
  return phys.world.createCollider(desc, body)
}

/** Run `seconds` of simulation in whole steps. */
function run(phys: PhysicsWorld, seconds: number) {
  const frame = 1 / 60
  for (let t = 0; t < seconds; t += frame) phys.step(frame)
}

describe('rapier loads', () => {
  it('is the version the engine asked for, not the root copy', () => {
    // `@types/three` drags an older rapier into the repo root. The engine pins its own, and the
    // whole reason `rapier.ts` is the only file allowed to import the package is so there is
    // exactly one in any bundle. If this ever reads 0.12 the nesting has collapsed.
    expect(rapier().version()).toBeTruthy()
    expect(typeof rapier().World).toBe('function')
  })
})

describe('collision layers', () => {
  it('packs membership high and filter low', () => {
    const g = groups('vehicle')
    expect(g >>> 16).toBe(LAYER.vehicle)
    expect(isLayer(g, 'vehicle')).toBe(true)
    expect(isLayer(g, 'debris')).toBe(false)
  })

  it('is symmetric where it claims to be, and asymmetric where it claims to be', () => {
    const test = (a: number, b: number) => ((a >>> 16) & (b & 0xffff)) !== 0 && ((b >>> 16) & (a & 0xffff)) !== 0
    // a car and a building: both ways
    expect(test(groups('vehicle'), groups('structure'))).toBe(true)
    // debris and the car: the design says you drive through your own wreckage
    expect(test(groups('debris'), groups('vehicle'))).toBe(false)
    // debris and debris: off, for the frame budget
    expect(test(groups('debris'), groups('debris'))).toBe(false)
    // debris and the ground: it has to land on something
    expect(test(groups('debris'), groups('terrain'))).toBe(true)
  })

  it('gives a query FULL membership, or it matches nothing at all', () => {
    // The trap: Rapier's test is (mine & theirs.filter) && (theirs.membership & my.filter). A
    // query with membership 0 fails the first half against everything, silently. This is the
    // assertion that would have caught a car falling through the world.
    const q = QUERY.ground
    expect(q >>> 16).toBe(0xffff)
    const hits = (query: number, layer: Parameters<typeof groups>[0]) => {
      const c = groups(layer)
      return ((query >>> 16) & (c & 0xffff)) !== 0 && ((c >>> 16) & (query & 0xffff)) !== 0
    }
    expect(hits(q, 'terrain')).toBe(true)
    expect(hits(q, 'structure')).toBe(true)
    expect(hits(q, 'prop')).toBe(true)
    // and the negative twin: a wheel ray must not stand on a pedestrian or a bin bag
    expect(hits(q, 'character')).toBe(false)
    expect(hits(q, 'debris')).toBe(false)
    expect(hits(queryGroups('debris'), 'terrain')).toBe(false)
  })
})

describe('the world', () => {
  it('runs whole fixed steps and carries the remainder', () => {
    const phys = new PhysicsWorld({ hz: 100 })
    expect(phys.step(0.005)).toBe(0) // less than a step: nothing runs, it is banked
    expect(phys.step(0.006)).toBe(1) // 0.011 s banked, one 10 ms step comes out
    expect(phys.stats.steps).toBe(1)
    phys.free()
  })

  it('drops a long stall instead of paying it back all at once', () => {
    const phys = new PhysicsWorld({ hz: 100, maxSteps: 4 })
    expect(phys.step(10)).toBe(4) // ten seconds arrives; four steps run
    expect(phys.stats.dropped).toBeGreaterThan(900) // and the rest is thrown away, loudly
    expect(phys.step(0.01)).toBe(1) // the next frame is normal again, not a burst
    phys.free()
  })

  it('makes a dropped body fall and land on the ground, not through it', () => {
    const phys = new PhysicsWorld()
    const R = rapier()
    ground(phys)
    const body = phys.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 10, 0))
    const d = R.ColliderDesc.cuboid(0.5, 0.5, 0.5)
    phys.describe(d, 'debris')
    phys.world.createCollider(d, body)
    run(phys, 3)
    const y = body.translation().y
    expect(y).toBeLessThan(1) // it fell
    expect(y).toBeGreaterThan(0.4) // and it is resting on top, not inside
    phys.free()
  })

  it('interpolates a tracked body between steps and refuses one it is not tracking', () => {
    const phys = new PhysicsWorld({ hz: 60 })
    const R = rapier()
    // Both need a collider: a dynamic body with no shape has no mass, and Rapier applies gravity as
    // a force, so a massless body sits in the air for ever and the test proves nothing.
    const drop = (y: number) => {
      const b = phys.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, y, 0))
      const d = R.ColliderDesc.ball(0.5)
      phys.describe(d, 'debris')
      phys.world.createCollider(d, b)
      return b
    }
    const body = drop(100)
    const other = drop(100)
    phys.track(body)
    run(phys, 1)
    const out = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
    expect(phys.pose(body, out)).toBe(true)
    expect(out.y).toBeLessThan(100)
    expect(phys.pose(other, out)).toBe(false) // untracked reports false rather than inventing a pose
    phys.free()
  })
})

describe('impacts', () => {
  it('reports a wall hit with a point, a normal and an impulse — and nothing when nothing happens', () => {
    const phys = new PhysicsWorld({ impactThreshold: 1000 })
    const R = rapier()
    ground(phys)
    // a wall across the path at x = 20
    const wall = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(20, 2, 0))
    const wd = R.ColliderDesc.cuboid(0.5, 2, 10)
    phys.describe(wd, 'structure')
    phys.world.createCollider(wd, wall)

    const hits: { x: number; impulse: number; nx: number }[] = []
    phys.onImpact((i) => hits.push({ x: i.x, impulse: i.impulse, nx: i.nx }))

    // quiet first: two seconds of an empty world must report nothing, or "we saw an impact" means
    // nothing when the interesting one arrives
    run(phys, 2)
    expect(hits.length).toBe(0)

    const body = phys.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setCcdEnabled(true).setLinvel(30, 0, 0))
    const bd = R.ColliderDesc.cuboid(2, 0.6, 1).setMass(1400)
    phys.describe(bd, 'vehicle')
    phys.world.createCollider(bd, body)
    run(phys, 2)

    expect(hits.length).toBeGreaterThan(0)
    const worst = hits.reduce((a, b) => (b.impulse > a.impulse ? b : a))
    expect(worst.impulse).toBeGreaterThan(1000)
    // the contact is at the wall's face, not at the origin — the bug this walk exists to avoid
    expect(worst.x).toBeGreaterThan(17)
    expect(worst.x).toBeLessThan(21)
    expect(Math.abs(worst.nx)).toBeGreaterThan(0.7) // and the normal points along the impact
    phys.free()
  })
})

describe('profiles', () => {
  it('has the five Rich asked for', () => {
    expect(Object.keys(PROFILES).sort()).toEqual(['rush', 'sim', 'street', 'stunts', 'taxi'])
  })

  it('puts the arcade↔sim axis where the header says it is', () => {
    expect(PROFILES.sim.yawAssist).toBe(0)
    expect(PROFILES.stunts.yawAssist).toBe(1)
    expect(PROFILES.stunts.yawGripLimited).toBe(1)
    expect(PROFILES.street.yawAssist).toBeLessThan(PROFILES.rush.yawAssist)
    expect(PROFILES.rush.yawAssist).toBeLessThan(PROFILES.taxi.yawAssist)
    // Rush is the one about the air, and the numbers had better say so
    expect(PROFILES.rush.airRoll).toBeGreaterThan(PROFILES.street.airRoll)
    expect(PROFILES.sim.airRoll).toBe(0)
  })

  it('overrides on top of a base rather than copying it', () => {
    const p = profile('street', { gripRear: 2 })
    expect(p.gripRear).toBe(2)
    expect(p.gripFront).toBe(PROFILES.street.gripFront)
    expect(() => profile('nonesuch')).toThrow(/no drive profile/)
  })

  it('blends numbers and takes the nearer end for everything else', () => {
    const mid = blendProfiles(STUNTS, SIM, 0.5)
    expect(mid.yawAssist).toBeCloseTo(0.5)
    expect(mid.drive).toBe(SIM.drive) // t >= 0.5 takes b
    expect(blendProfiles(STUNTS, SIM, 0).yawAssist).toBe(STUNTS.yawAssist)
    expect(blendProfiles(STUNTS, SIM, 1).yawAssist).toBe(SIM.yawAssist)
  })
})

describe('the vehicle', () => {
  function car(id: string) {
    const phys = new PhysicsWorld({ hz: 120 })
    ground(phys)
    const v = new Vehicle(phys, {}, profile(id))
    v.place(0, 1.0, 0, 0)
    run(phys, 1) // let the suspension settle
    return { phys, v }
  }

  it('settles on its wheels instead of sinking or bouncing away', () => {
    const { phys, v } = car('street')
    const y = v.body.translation().y
    expect(v.state.grounded).toBe(4)
    expect(y).toBeGreaterThan(0.4)
    expect(y).toBeLessThan(1.2)
    phys.free()
  })

  it('accelerates on throttle — and does NOT without it', () => {
    const { phys, v } = car('stunts')
    v.control({ throttle: 0, brake: 0, steer: 0, handbrake: false })
    run(phys, 3)
    expect(Math.abs(v.state.speed)).toBeLessThan(0.5) // the negative twin

    v.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
    run(phys, 5)
    // CAR_ACCEL is 11 m/s² and five seconds of it is a great deal more than this; the assertion is
    // deliberately loose because the tyres, not the number, decide how much reaches the road.
    expect(v.state.speed).toBeGreaterThan(15)
    expect(v.body.translation().x).toBeGreaterThan(20) // and it went FORWARD, along its own nose
    phys.free()
  })

  it('brakes', () => {
    const { phys, v } = car('street')
    v.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
    run(phys, 5)
    const fast = v.state.speed
    expect(fast).toBeGreaterThan(10)
    v.control({ throttle: 0, brake: 1, steer: 0, handbrake: false })
    run(phys, 2)
    expect(v.state.speed).toBeLessThan(fast * 0.5)
    phys.free()
  })

  it('turns the way you steered — right is right — on every profile', () => {
    /*
     * THE SIGN, NOT THE MAGNITUDE.
     *
     * This test used to assert `Math.abs(right) > 1`, which passes just as happily when left and
     * right are swapped — and they were, on every profile, in the viewer. `input.steer` is + for
     * right; the chassis frame is forward +X, up +Y, right +Z; and a rotation about +Y takes +X
     * toward -Z. Handing Rapier the un-negated angle steered the car the wrong way and an absolute
     * value could never see it.
     */
    for (const id of Object.keys(PROFILES)) {
      for (const [steer, sense] of [[1, 'right'], [-1, 'left']] as const) {
        const { phys, v } = car(id)
        v.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
        run(phys, 4)
        const straight = v.body.translation().z
        v.control({ throttle: 0.6, brake: 0, steer, handbrake: false })
        run(phys, 3)
        const moved = v.body.translation().z - straight
        // the car started pointing along +X, so right is +Z and left is -Z
        expect(moved * steer, `${id} steered ${sense}`).toBeGreaterThan(1)
        phys.free()
      }
    }
  })

  it('makes the handbrake slide the car sideways', () => {
    const { phys, v } = car('taxi')
    v.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
    run(phys, 5)
    v.control({ throttle: 0.5, brake: 0, steer: 1, handbrake: true })
    run(phys, 1)
    expect(Math.abs(v.state.slide)).toBeGreaterThan(1)
    phys.free()
  })

  it('understeers rather than spins when the Stunts grip limit is asked for too much', () => {
    // The whole point of the port: above the limit the car turns LESS. Compare the yaw rate a
    // grip-limited car reaches at speed with the same car with the limit switched off.
    const at = (limited: number) => {
      const phys = new PhysicsWorld({ hz: 120 })
      ground(phys)
      const v = new Vehicle(phys, {}, profile('stunts', { yawGripLimited: limited }))
      v.place(0, 1, 0, 0)
      run(phys, 1)
      v.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
      run(phys, 8)
      v.control({ throttle: 1, brake: 0, steer: 1, handbrake: false })
      run(phys, 1)
      const w = v.body.angvel()
      const yaw = Math.abs(w.y)
      const speed = v.state.speed
      phys.free()
      return { yaw, speed }
    }
    const limited = at(1)
    const free = at(0)
    expect(limited.speed).toBeGreaterThan(20) // it really was going fast enough to be limited
    expect(limited.yaw).toBeLessThan(free.yaw)
  })

  it('gives the air-control profiles authority in flight and the ground ones none', () => {
    const roll = (id: string) => {
      const phys = new PhysicsWorld({ hz: 120 })
      const v = new Vehicle(phys, {}, profile(id))
      v.place(0, 50, 0, 0) // no ground at all: it is airborne from the first step
      v.control({ throttle: 0, brake: 0, steer: 1, handbrake: false })
      run(phys, 1)
      const w = v.body.angvel()
      const mag = Math.hypot(w.x, w.y, w.z)
      phys.free()
      return mag
    }
    expect(roll('rush')).toBeGreaterThan(1) // Rush: the knob that is the whole game
    expect(roll('stunts')).toBeLessThan(0.05) // Stunts: a thrown brick with good manners
    expect(roll('sim')).toBeLessThan(0.05)
  })

  it('takes damage from a crash and none from driving along', () => {
    const phys = new PhysicsWorld({ hz: 120, impactThreshold: 5000 })
    const R = rapier()
    ground(phys)
    const wall = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(60, 2, 0))
    const wd = R.ColliderDesc.cuboid(1, 3, 12)
    phys.describe(wd, 'structure')
    phys.world.createCollider(wd, wall)
    const v = new Vehicle(phys, {}, profile('street'))
    v.place(0, 1, 0, 0)
    v.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
    run(phys, 3)
    expect(v.state.damage).toBe(0) // driving is not damage
    run(phys, 6) // into the wall
    expect(v.state.damage).toBeGreaterThan(0)
    phys.free()
  })

  it('takes a surface hook and loses grip where it says the ground is soft', () => {
    const slide = (grip: number) => {
      const phys = new PhysicsWorld({ hz: 120 })
      ground(phys)
      const v = new Vehicle(phys, {}, profile('street'))
      v.setSurface(() => grip)
      v.place(0, 1, 0, 0)
      v.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
      run(phys, 6)
      const s = v.state.speed
      phys.free()
      return s
    }
    // The same six seconds of full throttle gets less far on a surface the hook calls worthless.
    // This is the assertion that caught Rapier clamping only the SIDE force: before the traction
    // limit in `vehicle.ts` these two were equal to thirteen decimal places.
    expect(slide(0)).toBeLessThan(slide(1) * 0.9)
  })
})

describe('the controls', () => {
  it('copies the input rather than keeping the caller\'s object', () => {
    /*
     * THE BUG THIS EXISTS FOR, and it made the car completely undriveable in the viewer.
     *
     * A raycast vehicle applies its controls inside the physics STEP, which is later than the call.
     * `main.ts` reuses one input object for the whole session and resets throttle and brake on the
     * line after it ticks — so a stored reference read zero every time. The keys did nothing, on
     * every profile, and nothing in the symptom pointed at aliasing.
     */
    const phys = new PhysicsWorld({ hz: 120 })
    ground(phys)
    const v = new Vehicle(phys, {}, profile('street'))
    v.place(0, 1, 0, 0)
    run(phys, 1)

    const shared = { throttle: 1, brake: 0, steer: 0, handbrake: false }
    v.control(shared)
    // …and now the caller reuses its object, exactly as the viewer does
    shared.throttle = 0
    shared.brake = 0
    run(phys, 4)
    expect(v.state.speed, 'the car used the input as it was when control() was called').toBeGreaterThan(8)
    phys.free()
  })

  it('knows how far its body sits above the wheels, for hanging a mesh on', () => {
    // A car model's origin is the ground between its wheels; a chassis body's is the middle of its
    // collider. Drawing one at the other floats the whole car — measured at about 0.94 m on the
    // default spec, which reads on screen as a car hovering a wheel-and-a-half off the road.
    const phys = new PhysicsWorld({ hz: 120 })
    ground(phys)
    const v = new Vehicle(phys, {}, profile('street'))
    v.place(0, 1.2, 0, 0)
    run(phys, 3)
    expect(v.state.grounded).toBe(4)
    // the settled body, minus the drop, should land on the road it is standing on
    const y = v.body.translation().y
    expect(y - v.contactDrop).toBeCloseTo(0, 1)
    expect(v.contactDrop).toBeGreaterThan(0.3)
    phys.free()
  })
})
