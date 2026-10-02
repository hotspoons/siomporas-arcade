// The vehicle document: does the arithmetic mean anything, and does a car built from one behave
// like the numbers said it would?
//
// The test that matters is `settles at the cgHeight it was given`. Everything else here is
// arithmetic that can be read; that one builds a real Rapier car out of a document, drops it on
// real ground, and measures the centre of gravity back out. `cgHeight` is one of the three numbers
// the brief says people get wrong with nothing visibly failing until much later, and this is what
// makes it fail early instead.

import { beforeAll, describe, expect, it } from 'vitest'
import { PROFILES } from '@apex/engine/physics/profiles'
import { KINDS } from '../src/classes'
import { loadRapier, rapier } from '@apex/engine/physics/rapier'
import { Vehicle } from '@apex/engine/physics/vehicle'
import { PhysicsWorld } from '@apex/engine/physics/world'
import {
  axleGrip, cgHeightOf, defaultVehicle, describeVehicle, finalDriveFor, FINAL_DRIVE_MIN, gearedTopSpeed,
  mountPoint, mountYaw, originHeight, overrideRange, rebalanceGears,
  lampCounts, lampOffsets, peakTorque, toDriveProfile, toEngineTuning, toVehicleSpec, tractiveForce, validateVehicle,
  VEHICLE_CLASSES, VEHICLE_TEMPLATE_IDS, wheelBoneCount, type VehicleDoc,
} from '../src/vehicles'

beforeAll(async () => {
  await loadRapier()
})

describe('the defaults', () => {
  it('has a document per class and every one of them validates clean', () => {
    expect(VEHICLE_TEMPLATE_IDS.length).toBeGreaterThan(3)
    for (const kind of VEHICLE_TEMPLATE_IDS) {
      const r = validateVehicle(defaultVehicle(kind))
      expect(r.errors, `${kind} errors`).toEqual([])
      expect(r.ok, `${kind} ok`).toBe(true)
    }
  })

  it('hands back a copy, so editing one car does not edit the table', () => {
    const a = defaultVehicle('hero-car')
    const b = defaultVehicle('hero-car')
    a.spec.mass = 999
    a.engine.gears[0] = 9
    expect(b.spec.mass).not.toBe(999)
    expect(b.engine.gears[0]).not.toBe(9)
  })
})

describe('validation', () => {
  const clean = () => defaultVehicle('hero-car')

  it('catches an override that names a DriveProfile key which does not exist', () => {
    // `rollStiffness` is the trap: a plausible name — the brief's own example uses it — for
    // something the profile calls `antiRollPerKg` and `rollResist`. Without this check it would be
    // a number that is silently ignored for ever.
    const v = clean()
    v.profile.overrides = { rollStiffness: 0.62 }
    const r = validateVehicle(v)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/rollStiffness is not a DriveProfile key/)

    // and the negative twin: the real keys must pass, or the check is just refusing everything
    v.profile.overrides = { gripRear: 1.08, antiRollPerKg: 5, rollResist: 0.3 }
    expect(validateVehicle(v).errors).toEqual([])
  })

  it('refuses a profile that does not exist and accepts every one that does', () => {
    const v = clean()
    v.profile.base = 'gtaish'
    expect(validateVehicle(v).errors.join(' ')).toMatch(/not a drive profile/)
    for (const id of Object.keys(PROFILES)) {
      v.profile.base = id
      expect(validateVehicle(v).errors, id).toEqual([])
    }
  })

  it('warns about a car that would roll over before it slid, and not about one that would not', () => {
    const car = clean()
    expect(validateVehicle(car).warnings.join(' ')).not.toMatch(/roll over/)
    const topHeavy = clean()
    topHeavy.spec.cgHeight = 1.1 // on a 1.55 m track: SSF 0.70
    expect(validateVehicle(topHeavy).warnings.join(' ')).toMatch(/roll over before it slides/)
  })

  it('says so when the rig does not bind four wheels — but only if the car asked for rig wheels', () => {
    const v = clean()
    // `from_rig` defaults FALSE now, because nothing in the library has a skeleton, so a car that
    // never asked for bones must not be warned about not having them.
    expect(v.wheels.from_rig).toBe(false)
    expect(validateVehicle(v, { rigWheels: 0 }).warnings.join(' ')).not.toMatch(/wheel bone/)

    v.wheels.from_rig = true
    expect(validateVehicle(v, { rigWheels: 4 }).warnings.join(' ')).not.toMatch(/wheel bone/)
    const r = validateVehicle(v, { rigWheels: 2 })
    expect(r.ok).toBe(true) // a warning, not an error: the car is still saveable
    expect(r.warnings.join(' ')).toMatch(/binds 2 wheel bones/)
  })

  it('catches a gearbox that cannot shift up', () => {
    const v = clean()
    v.engine.gears = [3.42, 2.05, 2.4, 1.0]
    expect(validateVehicle(v).warnings.join(' ')).toMatch(/not lower than the gear before it/)
  })

  it('reports every problem at once rather than the first', () => {
    const v = clean()
    v.spec.mass = 0
    v.spec.drive = 'awful' as VehicleDoc['spec']['drive']
    v.profile.base = 'nope'
    v.engine.final_drive = -1
    const r = validateVehicle(v)
    expect(r.errors.length).toBeGreaterThanOrEqual(4)
  })
})

describe('the drivetrain arithmetic', () => {
  it('states torque when it is given and marks it estimated when it is not', () => {
    const v = defaultVehicle('hero-car')
    expect(peakTorque(v.engine).estimated).toBe(true)
    v.engine.torque_nm = 380
    expect(peakTorque(v.engine)).toEqual({ nm: 380, estimated: false })
  })

  it('makes the final drive change the top speed, so the gearing is not decoration', () => {
    const v = defaultVehicle('hero-car')
    const before = gearedTopSpeed(v.engine, v.spec.wheelRadius)
    v.engine.final_drive *= 2
    const after = gearedTopSpeed(v.engine, v.spec.wheelRadius)
    expect(after).toBeCloseTo(before / 2, 5)
    // and it lands somewhere a car actually goes
    expect(before * 2.237).toBeGreaterThan(90)
    expect(before * 2.237).toBeLessThan(260)
  })

  it('computes tractive force as torque × gear × final ÷ radius', () => {
    const v = defaultVehicle('hero-car')
    const t = peakTorque(v.engine).nm
    const want = (t * v.engine.gears[0] * v.engine.final_drive) / v.spec.wheelRadius
    expect(tractiveForce(v.engine, v.spec.wheelRadius)).toBeCloseTo(want, 6)
  })

  it('gives a truck less acceleration per kilo than a hot hatch, which is the whole point', () => {
    const car = toDriveProfile(defaultVehicle('hero-car'))
    const truck = toDriveProfile(defaultVehicle('truck'))
    expect(car.powerPerKg).toBeGreaterThan(truck.powerPerKg)
    expect(truck.topSpeed).toBeLessThan(car.topSpeed)
  })

  it('maps the gearbox onto the engine-sound knobs, per vehicle', () => {
    const bus = toEngineTuning(defaultVehicle('bus'))
    const car = toEngineTuning(defaultVehicle('hero-car'))
    expect(bus.ENGINE_GEAR_1).toBe(6.7)
    expect(bus.ENGINE_GEAR_6).toBe(0) // a five-speed: the sixth is out of the box
    expect(car.ENGINE_GEAR_6).toBeGreaterThan(0)
    // shift points are fractions of the range, so a 2400 rpm diesel shifts and does not just sit there
    expect(bus.ENGINE_SHIFT_UP_RPM).toBeGreaterThan(bus.ENGINE_SHIFT_DOWN_RPM)
    expect(bus.ENGINE_SHIFT_UP_RPM).toBeLessThan(defaultVehicle('bus').engine.redline_rpm)
  })
})

describe('the document becomes a profile', () => {
  it('lets the chassis decide which wheels are driven, over the profile', () => {
    const v = defaultVehicle('hero-car')
    v.profile.base = 'street' // street is rwd
    v.spec.drive = 'awd'
    expect(toDriveProfile(v).drive).toBe('awd')
  })

  it('applies base, then blend, then overrides, in that order', () => {
    const v = defaultVehicle('hero-car')
    v.profile = { base: 'sim', blendWith: 'taxi', blend: 0.5, overrides: { yawAssist: 0.11 } }
    const p = toDriveProfile(v)
    // the override wins over the blend
    expect(p.yawAssist).toBe(0.11)
    // and a key nobody overrode carries the blend
    const mid = (PROFILES.sim.gripFront + PROFILES.taxi.gripFront) / 2
    expect(p.gripFront).toBeCloseTo(mid, 6)
  })

  it('turns the steering lock from degrees into radians', () => {
    const v = defaultVehicle('hero-car')
    v.wheels.steer_max_deg = 30
    expect(toDriveProfile(v).steerMax).toBeCloseTo(Math.PI / 6, 6)
  })
})

describe('the chassis becomes a spec', () => {
  it('clamps a centre of gravity that was typed in the wrong units into the body', () => {
    const v = defaultVehicle('hero-car')
    v.spec.cgHeight = 5.2 // somebody meant 0.52
    const s = toVehicleSpec(v)
    expect(Math.abs(s.comY!)).toBeLessThanOrEqual(s.halfHeight)
  })

  it('puts a lower cgHeight lower in the body', () => {
    const low = defaultVehicle('hero-car')
    const high = defaultVehicle('hero-car')
    low.spec.cgHeight = 0.35
    high.spec.cgHeight = 0.75
    expect(toVehicleSpec(low).comY!).toBeLessThan(toVehicleSpec(high).comY!)
  })
})

describe('a car built from a document', () => {
  function drive(v: VehicleDoc) {
    const R = rapier()
    const phys = new PhysicsWorld({ hz: 120 })
    const gb = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -1, 0))
    const gd = R.ColliderDesc.cuboid(500, 1, 500).setFriction(1)
    phys.describe(gd, 'terrain', { events: false })
    phys.world.createCollider(gd, gb)
    const p = toDriveProfile(v)
    const spec = toVehicleSpec(v, p)
    const car = new Vehicle(phys, spec, p)
    car.place(0, originHeight(v.spec, p, spec.halfHeight) + 0.1, 0, 0)
    for (let t = 0; t < 4; t += 1 / 60) phys.step(1 / 60)
    return { phys, car, spec }
  }

  it('settles on its wheels at the centre of gravity it was given', () => {
    const v = defaultVehicle('hero-car')
    const { phys, car, spec } = drive(v)
    expect(car.state.grounded).toBe(4)
    const measured = cgHeightOf(car.body, spec, 0)
    // TIGHT, deliberately. A loose tolerance here is what would let a unit mistake in `cgHeight`
    // hide: 0.52 vs 5.2 has to fail, and so does the geometry bug this test caught once already
    // (axle mounts pinned to the box floor, which settled a 0.52 m CG at 0.67 m).
    expect(Math.abs(measured - v.spec.cgHeight)).toBeLessThan(0.02)
    phys.free()
  })

  it('sags by the closed form, which is what lets the ride height be predicted at all', () => {
    // δ = g / (4 × stiffness), with the mass cancelling — the claim in `suspensionSag`. If Rapier
    // ever changes how the suspension scales, this is what says so, rather than every car quietly
    // sitting a few centimetres wrong.
    for (const kind of ['hero-car', 'bus']) {
      const v = defaultVehicle(kind)
      const p = toDriveProfile(v)
      const { phys, car, spec } = drive(v)
      const bodyY = car.body.translation().y
      const wantOrigin = originHeight(v.spec, p, spec.halfHeight)
      expect(Math.abs(bodyY - wantOrigin), `${kind} settled at ${bodyY.toFixed(3)}, predicted ${wantOrigin.toFixed(3)}`).toBeLessThan(0.02)
      phys.free()
    }
  })

  it('makes a top-heavy van lean further than a low car through the same corner', () => {
    const lean = (kind: string) => {
      const v = defaultVehicle(kind)
      const { phys, car } = drive(v)
      car.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
      for (let t = 0; t < 5; t += 1 / 60) phys.step(1 / 60)
      car.control({ throttle: 0.7, brake: 0, steer: 1, handbrake: false })
      let worst = 0
      for (let t = 0; t < 2; t += 1 / 60) {
        phys.step(1 / 60)
        const q = car.body.rotation()
        /*
         * ROLL is the WORLD-Y component of the body's own RIGHT axis (local +Z), which is the third
         * column's middle term: `2(qy·qz − qx·qw)`.
         *
         * The first version of this used `2(qy·qw + qz·qx)` — the world-X component of the same
         * axis, which is the car's HEADING, not its lean. It read 0.9999 for both cars (a car that
         * has turned ninety degrees) and the test passed on an accident of ordering; fixing the
         * steering sign reversed which car turned further and the accident stopped holding.
         */
        const ry = 2 * (q.y * q.z - q.x * q.w)
        worst = Math.max(worst, Math.abs(ry))
      }
      phys.free()
      return worst
    }
    expect(lean('van')).toBeGreaterThan(lean('hero-car'))
  })

  it('accelerates a hot hatch harder than a bus from the same standstill', () => {
    const reach = (kind: string) => {
      const v = defaultVehicle(kind)
      const { phys, car } = drive(v)
      car.control({ throttle: 1, brake: 0, steer: 0, handbrake: false })
      for (let t = 0; t < 5; t += 1 / 60) phys.step(1 / 60)
      const s = car.state.speed
      phys.free()
      return s
    }
    expect(reach('hero-car')).toBeGreaterThan(reach('bus'))
  })
})

describe('the summary line', () => {
  it('reads like a person would say it', () => {
    const s = describeVehicle(defaultVehicle('hero-car'))
    expect(s).toMatch(/kg/)
    expect(s).toMatch(/hp/)
    expect(s).toMatch(/RWD/)
    expect(s).toMatch(/6-speed/)
    expect(s).toMatch(/street/)
  })
})

describe('the decisions the form makes', () => {
  it('reads the bound wheel bones, falls back to the guess, and says which', () => {
    // The bug this exists for: `AssetItem.rig.roles.wheel` is a string[], and
    // `MeshView.rig().roles.wheel` is a NUMBER. Reading `.length` off the guess gives undefined on
    // every asset, so the four-wheel warning silently never fires.
    expect(wheelBoneCount(['fl', 'fr', 'rl', 'rr'], undefined)).toEqual({ count: 4, guessed: false })
    expect(wheelBoneCount(undefined, 4)).toEqual({ count: 4, guessed: true })
    // the binding wins over the guess, because it is what the game will read
    expect(wheelBoneCount(['fl', 'fr'], 4)).toEqual({ count: 2, guessed: false })
    // and "we cannot tell" is not "no wheels"
    expect(wheelBoneCount(undefined, undefined).count).toBeUndefined()
    expect(wheelBoneCount(null, null).count).toBeUndefined()
    // an explicit empty binding IS zero, and must not be mistaken for unknown
    expect(wheelBoneCount([], undefined)).toEqual({ count: 0, guessed: false })
    expect(wheelBoneCount(undefined, 0)).toEqual({ count: 0, guessed: true })
  })

  it('gives every profile knob a slider range worth dragging, including the ones that default to 0', () => {
    for (const key of Object.keys(PROFILES.street) as (keyof typeof PROFILES.street)[]) {
      const def = PROFILES.street[key]
      if (typeof def !== 'number') continue
      const r = overrideRange(def)
      expect(r.max, `${key} max`).toBeGreaterThan(r.min)
      expect(r.step, `${key} step`).toBeGreaterThan(0)
      // the default has to be reachable on the control, or a knob cannot be put back by hand
      expect(def, `${key} default in range`).toBeGreaterThanOrEqual(r.min)
      expect(def, `${key} default in range`).toBeLessThanOrEqual(r.max)
    }
    // a zero default is the case that produces a dead control if the span is proportional only
    expect(overrideRange(0).max).toBeGreaterThan(0)
    // and a negative one gets a symmetric range rather than a zero floor it cannot reach
    expect(overrideRange(-0.25).min).toBeLessThan(-0.25)
  })
})

describe('lamps', () => {
  it('defaults to a pair, and to one lamp on a motorcycle', () => {
    expect(lampCounts(defaultVehicle('traffic').spec)).toEqual({ headlights: 2, taillights: 2 })
    expect(lampCounts(defaultVehicle('motorcycle').spec)).toEqual({ headlights: 1, taillights: 1 })
    // a narrow body that never had the fields filled in is still a motorcycle
    expect(lampCounts({ width: 0.7 })).toEqual({ headlights: 1, taillights: 1 })
    // a saved count wins over the width
    expect(lampCounts({ width: 0.7, headlights: 2, taillights: 0 })).toEqual({ headlights: 2, taillights: 0 })
  })

  it('puts one lamp on the centreline and a pair out on the corners', () => {
    expect(lampOffsets(1, 1.8)).toEqual([0])
    expect(lampOffsets(0, 1.8)).toEqual([])
    const pair = lampOffsets(2, 1.8)
    expect(pair[0]).toBeLessThan(-0.4)
    expect(pair[1]).toBeGreaterThan(0.4)
    expect(pair[0]).toBeCloseTo(-pair[1])
  })
})

describe('the class vocabulary', () => {
  it('names classes the asset library actually has', () => {
    // The mismatch this exists for: `VEHICLE_CLASSES` invented its own words (van, truck, bus) and
    // the library's are `emergency` and `commercial-vehicle`. Nothing fails when they disagree —
    // the tab simply reports an empty fleet while the library is full of cars.
    for (const k of VEHICLE_CLASSES) expect(KINDS, `${k} is a real class`).toContain(k)
    // and every class must produce a usable document rather than silently falling back
    for (const k of VEHICLE_CLASSES) expect(validateVehicle(defaultVehicle(k)).errors, k).toEqual([])
    // the negative twin: scenery must NOT be treated as a vehicle
    for (const k of ['furniture', 'vegetation', 'signage', 'prop']) expect(VEHICLE_CLASSES).not.toContain(k)
  })
})

describe('a level naming the car, and a car naming its own engine', () => {
  it('lets the LEVEL pick the game and the CAR keep its engine', () => {
    /*
     * The layering `physics.spawnCar` relies on, and the claim made to the editor lane.
     *
     * A level says `profile: "taxi"`; the asset says 205 kW through a 3.7 final drive. Taking the
     * level's profile whole would give the hatchback the taxi's power and gearbox, which is not what
     * anybody means by choosing a handling model. Swapping only the BASE keeps both.
     */
    const doc = defaultVehicle('hero-car') // base: street
    const asStreet = toDriveProfile(doc)
    const asTaxi = toDriveProfile({ ...doc, profile: { ...doc.profile, base: 'taxi' } })

    // the game changed
    expect(asStreet.yawAssist).toBe(PROFILES.street.yawAssist)
    expect(asTaxi.yawAssist).toBe(PROFILES.taxi.yawAssist)
    expect(asTaxi.gripFront).toBe(PROFILES.taxi.gripFront)

    // the car did not: power, top speed and brakes still come from this car's own drivetrain
    expect(asTaxi.powerPerKg).toBeCloseTo(asStreet.powerPerKg, 9)
    expect(asTaxi.topSpeed).toBeCloseTo(asStreet.topSpeed, 9)
    expect(asTaxi.brakePerKg).toBeCloseTo(asStreet.brakePerKg, 9)
    // and they are the CAR's numbers, not the profile's
    expect(asTaxi.powerPerKg).not.toBeCloseTo(PROFILES.taxi.powerPerKg, 3)
    expect(asTaxi.topSpeed).not.toBeCloseTo(PROFILES.taxi.topSpeed, 3)
  })

  it('still gives a usable car when the level names one with no dynamics document', () => {
    // 120 of the library's 120 vehicles have no dynamics saved, so "no document" is the common case
    // and must mean "the default chassis", never "no car".
    const p = toDriveProfile(defaultVehicle('hero-car'))
    expect(Number.isFinite(p.powerPerKg)).toBe(true)
    expect(p.powerPerKg).toBeGreaterThan(0)
    expect(validateVehicle(defaultVehicle('hero-car')).ok).toBe(true)
  })
})

/*
 * WEAPON MOUNTS.
 *
 * The mount is a NAMED PLACE, not three numbers, so the thing worth testing is that the place moves
 * with the car: a nose gun on a 5.9 m pickup must be further forward than one on a 3.4 m kei, and
 * nobody should have to retype an offset when they change the length.
 */
describe('a weapon bolted to a car', () => {
  const kei = { mass: 720, wheelbase: 2.4, track: 1.3, cgHeight: 0.52, wheelRadius: 0.28, drive: 'fwd' as const, length: 3.4, width: 1.48, height: 1.5 }
  const truck = { ...kei, length: 5.9, width: 2.03, height: 1.95 }

  it('puts each named place where the chassis says, and moves it when the car changes', () => {
    expect(mountPoint(kei, 'nose').x).toBeCloseTo(1.7, 6)
    expect(mountPoint(truck, 'nose').x).toBeCloseTo(2.95, 6)
    expect(mountPoint(truck, 'nose').x).toBeGreaterThan(mountPoint(kei, 'nose').x)
    // up is +Y, right is +Z, and the tail is behind the origin
    expect(mountPoint(kei, 'roof').y).toBeCloseTo(0.75, 6)
    expect(mountPoint(kei, 'underbody').y).toBeCloseTo(-0.75, 6)
    expect(mountPoint(kei, 'right').z).toBeCloseTo(0.74, 6)
    expect(mountPoint(kei, 'left').z).toBeCloseTo(-0.74, 6)
    expect(mountPoint(kei, 'tail').x).toBeLessThan(0)
  })

  it('points a side gun sideways and a tail gun backwards unless told otherwise', () => {
    expect(mountYaw({ weapon: 'minigun', at: 'roof' })).toBeCloseTo(0, 6)
    expect(mountYaw({ weapon: 'minigun', at: 'right' })).toBeCloseTo(Math.PI / 2, 6)
    expect(mountYaw({ weapon: 'minigun', at: 'left' })).toBeCloseTo(-Math.PI / 2, 6)
    expect(mountYaw({ weapon: 'minigun', at: 'tail' })).toBeCloseTo(Math.PI, 6)
    // an explicit angle wins, including an explicit zero on a side mount
    expect(mountYaw({ weapon: 'minigun', at: 'right', yaw_deg: 0 })).toBeCloseTo(0, 6)
  })

  it('refuses a mount with nothing on it, and one naming a weapon that was never built', () => {
    const v = defaultVehicle('hero-car')
    v.mounts = [{ weapon: '', at: 'roof' }]
    expect(validateVehicle(v).errors.join(' ')).toMatch(/no weapon chosen/)

    v.mounts = [{ weapon: 'railgun', at: 'roof' }]
    expect(validateVehicle(v, { weapons: ['minigun'] }).errors.join(' ')).toMatch(/not a built weapon/)
    // and it passes when the armoury has it — the check can succeed as well as fail
    expect(validateVehicle(v, { weapons: ['railgun'] }).errors).toEqual([])
    // with no armoury passed there is nothing to check it against, so it must NOT invent a problem
    expect(validateVehicle(v).errors).toEqual([])
  })
})

/*
 * THE GEARBOX SET BY ITS RESULT, AND THE TWO THINGS THAT MAKE A CAR HANDLE.
 *
 * Rich, 2026-09-29: top speed should be the field you edit and the final drive should follow;
 * weight distribution and tyre width should reach the handling. All four are arithmetic, so all
 * four are checked here rather than by driving.
 */
describe('gearing you set by the speed you want', () => {
  it('finds the final drive that reaches a top speed, and the round trip lands back', () => {
    const v = defaultVehicle('hero-car')
    const want = 62 // m/s, about 139 mph
    v.engine.final_drive = finalDriveFor(v.engine, v.spec.wheelRadius, want)
    expect(gearedTopSpeed(v.engine, v.spec.wheelRadius)).toBeCloseTo(want, 6)
    // and a bigger wheel needs a numerically higher diff to reach the same speed
    const small = finalDriveFor(v.engine, 0.28, want)
    const big = finalDriveFor(v.engine, 0.38, want)
    expect(big).toBeGreaterThan(small)
  })

  it('calls an unreachable top speed an error rather than quietly gearing for it', () => {
    const v = defaultVehicle('hero-car')
    v.engine.final_drive = finalDriveFor(v.engine, v.spec.wheelRadius, 400) // 900 mph
    expect(v.engine.final_drive).toBeLessThan(FINAL_DRIVE_MIN)
    expect(validateVehicle(v).errors.join(' ')).toMatch(/final_drive/)
    // and an ordinary one is not an error
    v.engine.final_drive = finalDriveFor(v.engine, v.spec.wheelRadius, 62)
    expect(validateVehicle(v).errors).toEqual([])
  })

  it('rebalances the middle gears geometrically and keeps the two ends', () => {
    const six = rebalanceGears([3.4, 2.0, 1.4, 1.0, 0.82, 0.68], 6)
    expect(six[0]).toBe(3.4)
    expect(six[5]).toBe(0.68)
    // every shift is the same proportional drop: that is what geometric means
    const steps = six.slice(1).map((g, i) => six[i] / g)
    for (const s of steps) expect(s).toBeCloseTo(steps[0], 3)

    // adding one keeps the ends and re-spaces the rest
    const seven = rebalanceGears(six, 7)
    expect(seven).toHaveLength(7)
    expect(seven[0]).toBe(3.4)
    expect(seven[6]).toBe(0.68)
    expect(seven[1]).toBeGreaterThan(six[1]) // a closer first shift
    // removing one, likewise
    const five = rebalanceGears(six, 5)
    expect(five).toHaveLength(5)
    expect(five[0]).toBe(3.4)
    expect(five[4]).toBe(0.68)
    // and the top speed is unchanged by any of it, because top and final drive are untouched
    const e = { ...defaultVehicle('hero-car').engine, gears: six }
    expect(gearedTopSpeed({ ...e, gears: seven }, 0.32)).toBeCloseTo(gearedTopSpeed(e, 0.32), 6)
  })
})

describe('weight distribution and tyre width reach the handling', () => {
  it('puts the centre of mass where the weight is', () => {
    const v = defaultVehicle('hero-car')
    expect(toVehicleSpec(v).comX).toBeCloseTo(0, 6)          // nothing said: 50/50
    v.spec.weightFront = 0.6
    expect(toVehicleSpec(v).comX).toBeCloseTo(v.spec.wheelbase * 0.1, 6) // forward, +X
    v.spec.weightFront = 0.4
    expect(toVehicleSpec(v).comX).toBeCloseTo(-v.spec.wheelbase * 0.1, 6)
  })

  /*
   * THE BALANCE, not the level. `street` already has a rear end deliberately looser than its front
   * (gripRear 1.25 against gripFront 1.35, which is the profile's power-on oversteer), so the thing
   * to assert is that the chassis MOVES that balance — an absolute ordering would be testing the
   * profile's opinion rather than this arithmetic.
   */
  const balance = (v: ReturnType<typeof defaultVehicle>) => {
    const p = toDriveProfile(v)
    return p.gripFront / p.gripRear
  }

  it('gives the loaded axle less grip — which is where understeer comes from', () => {
    const stock = balance(defaultVehicle('hero-car'))
    const nose = defaultVehicle('hero-car')
    nose.spec.weightFront = 0.6
    const tail = defaultVehicle('hero-car')
    tail.spec.weightFront = 0.4
    expect(balance(nose)).toBeLessThan(stock)     // weight on the front costs the front grip
    expect(balance(tail)).toBeGreaterThan(stock)
    // and it is a real difference, not a rounding one: about 10% across a 60/40 split
    expect(balance(tail) / balance(nose)).toBeGreaterThan(1.08)
  })

  it('gives the wider end more, so 255f/305r moves the balance rearward', () => {
    const stock = balance(defaultVehicle('hero-car'))
    const staggered = defaultVehicle('hero-car')
    staggered.spec.tyreFront_mm = 255
    staggered.spec.tyreRear_mm = 305
    expect(balance(staggered)).toBeLessThan(stock)

    // wider all round is worth something, but not much — this is not a grip cheat code
    const square = defaultVehicle('hero-car')
    square.spec.tyreFront_mm = 305
    square.spec.tyreRear_mm = 305
    const wide = toDriveProfile(square)
    const plain = toDriveProfile(defaultVehicle('hero-car'))
    expect(wide.gripFront).toBeGreaterThan(plain.gripFront)
    expect(wide.gripFront / plain.gripFront).toBeLessThan(1.15)
    // and it does not disturb the balance, because both ends gained the same
    expect(balance(square)).toBeCloseTo(stock, 6)
  })

  it('does not punish a bus for being heavy — the profile still sets the level', () => {
    const bus = defaultVehicle('commercial-vehicle')
    bus.spec.mass = 12000
    const g = axleGrip(bus.spec)
    expect(g.front).toBeCloseTo(1, 6)
    expect(g.rear).toBeCloseTo(1, 6)
  })
})
