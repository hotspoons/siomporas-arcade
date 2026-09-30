// A car: a rigid body, four rays for wheels, and the layer of assists that turns one set of
// equations into five different games.
//
// WHY A RAYCAST VEHICLE AND NOT FOUR WHEEL COLLIDERS. Rich: "no need for tire patch simulation or
// anything but I would like it to feel nice." A raycast vehicle — Rapier's
// `DynamicRayCastVehicleController`, which is Bullet's model — casts one ray per corner, puts a
// spring on what it hits, and applies a longitudinal and a lateral force at the contact. It has no
// contact patch, no slip curve and no tyre temperature, and it is what almost every driving game
// that is not a simulator actually runs on. The alternative, a cylinder collider per wheel, spends
// its whole budget on the solver fighting four rolling contacts and feels *worse*, because a game
// car wants forces a designer can name.
//
// WHAT THIS FILE ADDS ON TOP, and why it is not just a thin wrapper:
//
//   1. **the assist layer** — `yawAssist`, the grip limit, the drift, the air control. Rapier gives
//      you a physical vehicle; a physical vehicle is a simulator and nothing else. Every arcade
//      profile in `profiles.ts` is this layer.
//   2. **forces in per-kilogram units.** A profile says 11 m/s² of acceleration, not 15,400 N, so
//      the same profile drives a hatchback and a truck and means the same thing about both.
//   3. **the surface hook.** The corridor knows what is pavement and what is verge, in its own
//      distance field, and that has to reach the tyres. One callback per wheel per step.
//   4. **events.** launch, land, crash, bump — the vocabulary `apps/corridor/src/car.ts` already
//      speaks, so the HUD, the sound and the camera do not have to be rewritten around a new one.
//
// FRAME, AND IT MATTERS: the chassis' local axes are nose +X, up +Y, right +Z, which is the
// convention the existing car mesh is already built in (`car.ts` buildMesh: "The model's nose is
// local +X, up +Y, right +Z"). Rapier's vehicle controller has to be TOLD that — its defaults are
// not this — and `indexForwardAxis` left at its default is a car that drives sideways.

import type { Collider, RigidBody } from '@dimforge/rapier3d-compat'
import type { DynamicRayCastVehicleController } from '@dimforge/rapier3d-compat'
import { clamp } from '../math/scalar'
import { QUERY } from './layers'
import type { DriveProfile } from './profiles'
import { rapier } from './rapier'
import type { PhysicsWorld } from './world'

/** What the car IS, as opposed to how it behaves. */
export interface VehicleSpec {
  massKg: number
  /** chassis collider half-extents, m: along the nose, up, across */
  halfLength: number
  halfHeight: number
  halfWidth: number
  /** centre of mass relative to the body origin, m. Lower is calmer; ahead of centre understeers */
  comX?: number
  comY?: number
  /** axle centres either side of the body origin, m */
  wheelbase: number
  /** left wheel to right wheel, m */
  track: number
  wheelRadius: number
  /** where the suspension mounts sit, relative to the body origin, m (negative = under the floor) */
  axleY?: number
  /**
   * The chassis collider's shape.
   *
   * `box` is a cuboid and is what every car had until the loop. `sled` is the same box with its
   * underside cut like an off-road truck's: the bottom face is shorter and narrower than the top,
   * so the belly meets the road at approach and departure angles rather than with a sharp edge,
   * and every corner is rounded by `skidRadius`. See the constructor for why that matters.
   */
  shape?: 'box' | 'sled'
  /** the sled's corner radius, m; also how far its bottom face is inset from its top, per metre of height */
  skidRadius?: number
}

/** A sensible small saloon: the Kestrel-ish 4.4 × 1.9 m body the corridor already draws. */
export const DEFAULT_SPEC: VehicleSpec = {
  massKg: 1400,
  halfLength: 2.2,
  halfHeight: 0.55,
  halfWidth: 0.95,
  comY: -0.25, // below the box centre: a car's mass is in its floor, and a high CoM rolls over
  wheelbase: 2.8,
  track: 1.8,
  wheelRadius: 0.34,
  axleY: -0.35,
  // the skid-plate hull, for every car: see `chassisShape`. A box is still there for anything that asks.
  shape: 'sled',
  skidRadius: 0.18,
}

export interface VehicleInput {
  /** 0…1 */
  throttle: number
  /** 0…1 */
  brake: number
  /** -1…1, + = right */
  steer: number
  handbrake: boolean
  /** in the air, nose up (+) and down (-). Left out, the throttle and brake do it */
  pitch?: number
}

export type VehicleEvent = 'none' | 'launch' | 'land' | 'crash' | 'bump'

/** What the ground under one wheel is like. 1 = the pavement the profile was tuned on. */
export type SurfaceGrip = (x: number, y: number, z: number) => number

const FL = 0, FR = 1, RL = 2, RR = 3

/** Rotate a vector by a quaternion, into `out`. Allocation-free; the hot path calls it six times. */
function qrot(q: { x: number; y: number; z: number; w: number }, vx: number, vy: number, vz: number, out: { x: number; y: number; z: number }) {
  const tx = 2 * (q.y * vz - q.z * vy)
  const ty = 2 * (q.z * vx - q.x * vz)
  const tz = 2 * (q.x * vy - q.y * vx)
  out.x = vx + q.w * tx + q.y * tz - q.z * ty
  out.y = vy + q.w * ty + q.z * tx - q.x * tz
  out.z = vz + q.w * tz + q.x * ty - q.y * tx
}

const fwd = { x: 1, y: 0, z: 0 }
const up = { x: 0, y: 1, z: 0 }
const rgt = { x: 0, y: 0, z: 1 }
const lin = { x: 0, y: 0, z: 0 }
const ang = { x: 0, y: 0, z: 0 }
const tmp = { x: 0, y: 0, z: 0 }
const quat = { x: 0, y: 0, z: 0, w: 1 }

export class Vehicle {
  readonly body: RigidBody
  readonly collider: Collider
  readonly controller: DynamicRayCastVehicleController
  readonly spec: VehicleSpec
  profile: DriveProfile

  /** what the HUD, the sound and the camera read */
  readonly state = {
    /** m/s along the nose; negative in reverse */
    speed: 0,
    /** m/s across the car, + right. The "sliding" readout */
    slide: 0,
    /** 0…1: how far past what the tyres hold the corner is asking */
    slip: 0,
    /** 0…1: the share of the demanded drive the tyres refused. Wheelspin, for smoke and sound */
    wheelslip: 0,
    /** how many of the four wheels are on something */
    grounded: 4,
    airborne: false,
    /** seconds since the wheels last touched */
    airTime: 0,
    /** rad, the front road-wheel angle actually applied */
    steer: 0,
    /** rad, accumulated: what the wheel meshes are spun by */
    wheelSpin: 0,
    /** 0…1, accumulated impact damage */
    damage: 0,
    event: 'none' as VehicleEvent,
  }

  private input: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false }
  private surface: SurfaceGrip | null = null
  private detach: (() => void)[] = []
  /** the wheel-ray filter, so a wheel stands on ground and not on a pedestrian */
  private readonly wheelFilter = QUERY.ground
  private readonly phys: PhysicsWorld

  constructor(phys: PhysicsWorld, spec: Partial<VehicleSpec> = {}, profile: DriveProfile) {
    const R = rapier()
    this.phys = phys
    this.spec = { ...DEFAULT_SPEC, ...spec }
    this.profile = profile
    const s = this.spec

    this.body = phys.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(0, 0, 0)
        // CCD, because this is the object that will be doing 70 m/s at a lamp post. Without it a
        // fast body can pass a thin collider entirely between two steps — 0.58 m per step at 70 m/s
        // against a 0.1 m sign post.
        .setCcdEnabled(true)
        .setLinearDamping(0)
        .setAngularDamping(0.15),
    )

    // The chassis shape. A cuboid, not the silhouette: the mesh's raked screen and fastback change
    // nothing about how a car hits a wall, and a convex hull of the body costs more in every
    // contact test for a difference nobody can see. A game that wants a shaped shell passes its own.
    const desc = chassisShape(R, s)
      .setMassProperties(
        s.massKg,
        { x: s.comX ?? 0, y: s.comY ?? 0, z: 0 },
        boxInertia(s.massKg, s.halfLength * 2, s.halfHeight * 2, s.halfWidth * 2),
        { x: 0, y: 0, z: 0, w: 1 },
      )
      /*
       * THE SKID PLATE. `chassisFriction` is how much the BODY grips what it scrapes, and it is low
       * for a stunt car on purpose — see the note on the field. 0.4 is the old value and stays the
       * default, so nothing that did not ask for a skid plate has changed.
       */
      .setFriction(profile.chassisFriction ?? 0.4)
      /*
       * AND THE SKID PLATE WINS. Rapier combines two colliders' friction by AVERAGING them unless
       * told otherwise, so a 0.04 skid plate on a 1.1 stunt ribbon was really 0.57 — the plate
       * was never doing what its number said. `Min` makes the lower of the two the one that
       * applies, which is what a plate of steel under a car means.
       */
      .setFrictionCombineRule(R.CoefficientCombineRule.Min)
      .setRestitution(0.1)
    phys.describe(desc, 'vehicle')
    this.collider = phys.world.createCollider(desc, this.body)

    this.controller = phys.world.createVehicleController(this.body)
    this.controller.indexUpAxis = 1
    // The setter really is called `setIndexForwardAxis` — an assignment, not a call. Rapier's
    // TypeScript declares `set setIndexForwardAxis(axis: number)`, so `controller.setIndexForwardAxis(0)`
    // is a TypeError at runtime and this line is the one that works.
    this.controller.setIndexForwardAxis = 0

    const wb = s.wheelbase / 2
    const tr = s.track / 2
    const ay = s.axleY ?? -s.halfHeight
    // FL, FR, RL, RR — the order every loop below assumes. Left is -Z because right is +Z.
    for (const [x, z] of [[wb, -tr], [wb, tr], [-wb, -tr], [-wb, tr]] as const) {
      this.controller.addWheel({ x, y: ay, z }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, profile.suspensionRest, s.wheelRadius)
    }
    this.applyProfile(profile)
    phys.track(this.body)
    this.detach.push(phys.onPreStep((dt) => this.tick(dt)))
    this.detach.push(phys.onImpact((im) => this.onImpact(im)))
  }

  /* ---- setup ------------------------------------------------------------------------------ */

  /**
   * Push a profile's numbers into the wheels.
   *
   * Live: swapping profiles mid-drive is a supported thing to do, because it is how the F6 panel
   * and the editor's picker are going to be used — drive, switch, drive, compare. The only state
   * that does not survive is the suspension's current compression, which resettles within a step.
   */
  applyProfile(p: DriveProfile) {
    this.profile = p
    // the skid plate too, so swapping profiles mid-drive really does swap all of the handling
    this.collider?.setFriction(p.chassisFriction ?? 0.4)
    const c = this.controller
    for (let i = 0; i < 4; i++) {
      c.setWheelSuspensionRestLength(i, p.suspensionRest)
      c.setWheelMaxSuspensionTravel(i, p.suspensionTravel)
      c.setWheelSuspensionStiffness(i, p.suspensionStiffness)
      c.setWheelSuspensionCompression(i, p.compression)
      c.setWheelSuspensionRelaxation(i, p.relaxation)
      c.setWheelMaxSuspensionForce(i, p.maxSuspensionForce)
      c.setWheelFrictionSlip(i, i < 2 ? p.gripFront : p.gripRear)
      c.setWheelSideFrictionStiffness(i, p.sideStiffness)
      c.setWheelRadius(i, this.spec.wheelRadius)
    }
  }

  /** Where the ground is soft. Called once per wheel per step at the contact point. */
  setSurface(fn: SurfaceGrip | null) {
    this.surface = fn
  }

  /** Put the car somewhere, stopped and level. The respawn, and the editor's drop-a-car. */
  place(x: number, y: number, z: number, yaw: number) {
    const half = yaw * 0.5
    // yaw about +Y. The mesh convention negates it (three's +Y rotation turns +X toward -Z while
    // our forward is (cos yaw, 0, sin yaw)); this is the physics body, so it is the physics sign.
    this.body.setTranslation({ x, y, z }, true)
    this.body.setRotation({ x: 0, y: Math.sin(-half), z: 0, w: Math.cos(-half) }, true)
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    this.state.speed = 0
    this.state.slide = 0
    this.state.slip = 0
    this.state.airTime = 0
    this.state.airborne = false
    this.state.event = 'none'
  }

  /**
   * Hand over the controls.
   *
   * THE INPUT IS COPIED, and that is not tidiness — it is a bug fix. A raycast vehicle applies its
   * controls inside the PHYSICS step, which happens later than the call, so storing the caller's
   * object means reading whatever that object holds by then. `apps/corridor/src/main.ts` reuses one
   * `drive.input` for the whole session and resets `throttle` and `brake` to the phone-pad values
   * on the line after it ticks the car — so the physics step read zero every time and the car could
   * not be driven at all, while the hand-written model (which reads its input synchronously) was
   * fine. Nothing in the failure pointed at aliasing: the keys did nothing, on every profile.
   */
  control(input: VehicleInput) {
    this.input.throttle = input.throttle
    this.input.brake = input.brake
    this.input.steer = input.steer
    this.input.handbrake = input.handbrake
    this.input.pitch = input.pitch
  }

  /**
   * How far the body origin sits ABOVE the wheels' contact plane at rest, metres.
   *
   * For hanging a mesh on this. The chassis body's origin is the centre of its collider box, and a
   * car model's origin is almost always the ground between its wheels — so drawing the mesh at the
   * body's translation floats the whole car by this much, which is what happened: about 0.94 m on
   * the default spec, and it looks exactly like a car hovering a wheel-and-a-half off the road.
   *
   * `suspensionSag` is the closed form for how far the springs give under the car's own weight:
   * Bullet's suspension force is `stiffness × compression × mass`, so at rest
   * `δ = g / (4 × stiffness)` and the mass cancels.
   */
  get contactDrop(): number {
    const s = this.spec
    const p = this.profile
    const sag = 9.81 / (4 * Math.max(1e-3, p.suspensionStiffness))
    const axleY = s.axleY ?? -s.halfHeight
    return -(axleY - (p.suspensionRest - sag) - s.wheelRadius)
  }

  /* ---- the step --------------------------------------------------------------------------- */

  private tick(dt: number) {
    const p = this.profile
    const s = this.spec
    const st = this.state
    const body = this.body
    st.event = 'none'

    const q = body.rotation(quat)
    qrot(q, 1, 0, 0, fwd)
    qrot(q, 0, 1, 0, up)
    qrot(q, 0, 0, 1, rgt)
    body.linvel(lin)
    const vF = lin.x * fwd.x + lin.y * fwd.y + lin.z * fwd.z
    const vS = lin.x * rgt.x + lin.y * rgt.y + lin.z * rgt.z
    const speed = Math.hypot(lin.x, lin.y, lin.z)
    st.speed = vF
    st.slide = vS

    /* steering: a rack with a rate, an authority that falls with speed, and a ramp that stops a
     * parked car pirouetting. Straight out of the hand-written model, because that is the shape of
     * steering every one of the five profiles wants — they differ in the numbers, not the rule. */
    const fast = clamp((Math.abs(vF) - p.steerFullSpeed) / Math.max(1, p.topSpeed - p.steerFullSpeed), 0, 1)
    const authority = 1 - (1 - p.steerAtSpeed) * fast
    let want = this.input.steer * p.steerMax * authority
    if (p.counterSteer > 0 && Math.abs(vF) > 3) {
      // The car corrects a slide for you: steer into it, by the angle the velocity actually makes
      // with the nose. `counterSteer` 1 would hold the car straight with no input at all, which is
      // why nothing on the list uses more than 0.6.
      want += clamp(Math.atan2(vS, Math.abs(vF)), -p.steerMax, p.steerMax) * p.counterSteer
    }
    want = clamp(want, -p.steerMax, p.steerMax)
    const maxStep = p.steerRate * dt
    st.steer += clamp(want - st.steer, -maxStep, maxStep)
    /*
     * NEGATED, AND THIS IS THE SIGN CONVENTION THE WHOLE FILE TURNS ON.
     *
     * `input.steer` is + for RIGHT, and `state.steer` keeps that sense because it is what the HUD
     * and the wheel meshes read. But the chassis frame is forward +X, up +Y, right +Z, and a
     * rotation about +Y takes +X toward -Z — which is LEFT. So a positive steering angle handed
     * straight to Rapier steers the car the wrong way, and it did: left and right were swapped in
     * the viewer on every profile.
     *
     * The same inversion applies to the yaw assist below, for the same reason, and `car.ts` has
     * carried it all along — its `updateMesh` writes `rotation.set(0, -this.yaw, 0)`, because this
     * app's `yaw` increases to the RIGHT and three's rotation about +Y does not.
     */
    this.controller.setWheelSteering(FL, -st.steer)
    this.controller.setWheelSteering(FR, -st.steer)

    /* what the wheels are standing on. The corridor has a distance field that knows pavement from
     * verge to the centimetre; this is the one line that lets it reach the tyres. It runs BEFORE the
     * engine so the traction limit below sees this step's grip and not last step's. */
    const mass = s.massKg
    if (this.surface) {
      for (let i = 0; i < 4; i++) {
        const cp = this.controller.wheelIsInContact(i) ? this.controller.wheelContactPoint(i, tmp) : null
        // 1 = pavement, 0 = the worst the surface gets. Grip runs between `offroadGrip` and full,
        // per wheel, so two wheels on the verge and two on the tarmac pulls the car toward the road
        // the way it should rather than averaging into a car that is slightly wrong everywhere.
        const g = cp ? clamp(this.surface(cp.x, cp.y, cp.z), 0, 1) : 1
        const base = i < 2 ? p.gripFront : p.gripRear
        this.controller.setWheelFrictionSlip(i, base * (p.offroadGrip + (1 - p.offroadGrip) * g))
      }
    }

    /* the engine. Force tapers as the ratio of speed to topSpeed rises, with a floor — so top speed
     * is where drive and drag balance rather than a number the speedometer is clamped to. That is
     * the existing model's behaviour and it is the better one: a downhill really is faster. */
    const ratio = clamp(Math.abs(vF) / p.topSpeed, 0, 1)
    const reversing = this.input.brake > 0 && vF < 0.5
    let drive = 0
    if (reversing) drive = -this.input.brake * p.powerPerKg * p.reverse * mass
    else drive = this.input.throttle * p.powerPerKg * mass * Math.max(0.15, 1 - ratio * ratio)
    const driven = p.drive === 'awd' ? [FL, FR, RL, RR] : p.drive === 'fwd' ? [FL, FR] : [RL, RR]

    /*
     * TRACTION, WHICH RAPIER DOES NOT DO FOR US, and this is the most important paragraph in the
     * file.
     *
     * The raycast vehicle is Bullet's, and Bullet's `updateFriction` computes one friction budget
     * per wheel — `frictionSlip × suspensionForce × dt` — and then, when the demand exceeds it,
     * scales **only the side impulse** down. The forward impulse is `engineForce × dt` and passes
     * through untouched. Measured here: a street car on a surface the hook called worthless
     * (friction slip 1.25 → 0.75) reached exactly the same 21.0 m/s in exactly the same distance as
     * one on dry tarmac, to the centimetre. So with Rapier alone there is no wheelspin, ice is as
     * fast as asphalt, and `offroadGrip` would only ever have meant "corners worse".
     *
     * So the budget is spent here instead. Each driven wheel gets what the friction circle leaves
     * after the side force has taken its share, which is also what gives an arcade car power-on
     * oversteer for free: ask for everything in a bend and there is nothing left to hold the back.
     * `state.wheelslip` is what was refused, for tyre smoke, for the sound, and for the HUD.
     */
    const staticLoad = (mass * 9.81) / 4
    let demanded = 0
    let delivered = 0
    for (let i = 0; i < 4; i++) this.controller.setWheelEngineForce(i, 0)
    for (const i of driven) {
      const want = drive / driven.length
      /*
       * THE FLOOR UNDER THE LOAD. `wheelSuspensionForce` is an instantaneous reading and it falls to
       * nearly nothing whenever a wheel goes light — over a crest, into a dip, and above all on the
       * concave entry to a ramp, where the nose rises and the back unloads. Taken literally it sets
       * the traction budget to zero and the engine delivers nothing at the exact moment the car is
       * trying to climb. See `tractionFloor`.
       */
      const raw = this.controller.wheelSuspensionForce(i) || staticLoad
      const load = Math.max(raw, staticLoad * (p.tractionFloor ?? 0.25))
      const budget = (this.controller.wheelFrictionSlip(i) ?? 1) * load
      const side = Math.abs(this.controller.wheelSideImpulse(i) ?? 0) / dt
      /*
       * WHAT THE SIDE FORCE LEAVES — with a floor. See `driveShare`: at the limit the circle leaves
       * nothing, and a car that cannot accelerate while it corners is a car that feels broken long
       * before it feels realistic.
       */
      const circle = Math.sqrt(Math.max(0, budget * budget - side * side))
      const room = Math.max(circle, budget * (p.driveShare ?? 0.33))
      const got = clamp(want, -room, room)
      demanded += Math.abs(want)
      delivered += Math.abs(got)
      this.controller.setWheelEngineForce(i, got)
    }
    st.wheelslip = demanded > 1 ? clamp(1 - delivered / demanded, 0, 1) : 0

    /* brakes. Rapier's wheel brake is an impulse cap, so it is a force × dt; rolling resistance
     * rides in on the same channel, which is why a car with the throttle shut slows down at all. */
    const braking = reversing ? 0 : this.input.brake * p.brakePerKg * mass
    const rolling = this.input.throttle > 0.02 ? 0 : p.rollingPerKg * mass
    const perWheel = ((braking + rolling) * dt) / 4
    const hand = this.input.handbrake ? (p.handbrakePerKg * mass * dt) / 2 : 0
    this.controller.setWheelBrake(FL, perWheel)
    this.controller.setWheelBrake(FR, perWheel)
    this.controller.setWheelBrake(RL, perWheel + hand)
    this.controller.setWheelBrake(RR, perWheel + hand)

    /* the handbrake also lets the rear go sideways. `driftHold` is the share of the rear's lateral
     * stiffness that is TAKEN AWAY, so 0.75 means the back end keeps a quarter of its bite. */
    if (this.input.handbrake) {
      this.controller.setWheelSideFrictionStiffness(RL, p.sideStiffness * (1 - p.driftHold))
      this.controller.setWheelSideFrictionStiffness(RR, p.sideStiffness * (1 - p.driftHold))
    } else {
      this.controller.setWheelSideFrictionStiffness(RL, p.sideStiffness)
      this.controller.setWheelSideFrictionStiffness(RR, p.sideStiffness)
    }

    // THE SUSPENSION AND TYRE FORCES. Everything above only set numbers; this is what applies them,
    // and it writes the chassis velocity directly — so every assist below has to come AFTER it or
    // it is overwritten by a physical model that was never asked.
    this.controller.updateVehicle(dt, undefined, this.wheelFilter)

    let grounded = 0
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) grounded++
    const wasAir = st.airborne
    st.grounded = grounded
    st.airborne = grounded === 0
    if (st.airborne) st.airTime += dt
    else st.airTime = 0
    if (st.airborne && !wasAir && Math.abs(vF) > 6) st.event = 'launch'
    if (!st.airborne && wasAir) {
      st.event = 'land'
      // A landing harder than the profile forgives is a crash. Measured on the velocity the body
      // had BEFORE the suspension ate it, which is why it is read here and not from the contact.
      if (-lin.y > p.landingTolerance) {
        st.event = 'crash'
        st.damage = Math.min(1, st.damage + 0.35)
      }
    }

    body.linvel(lin)
    body.angvel(ang)

    /* ---- the assist layer: everything that makes a profile a GAME ------------------------- */

    if (!st.airborne && p.yawAssist > 0 && Math.abs(vF) > 0.5) {
      // What the wheel is asking for, as a yaw rate, exactly as the hand-written model computes it.
      const ramp = clamp(Math.abs(vF) / p.steerFullSpeed, 0, 1)
      let demand = this.input.steer * p.steerRate * authority * ramp * Math.sign(vF || 1)
      if (this.input.handbrake && Math.abs(vF) > 3) demand += this.input.steer * p.driftYaw
      // The Stunts rule: what the tyres can hold is grip/|v|, and asking for more turns you LESS.
      const mu = (p.gripFront + p.gripRear) * 0.5
      const limit = (mu * 9.81) / Math.max(1, Math.abs(vF))
      const held = p.yawGripLimited > 0 ? clamp(demand, -limit, limit) : demand
      st.slip = clamp((Math.abs(demand) - limit) / (limit + 1e-6), 0, 1)
      // Blend the body's yaw about ITS OWN up axis, not the world's — on a banked road or a kerb
      // those are different, and using world Y is how a car on camber slowly rolls itself over.
      const spin = ang.x * up.x + ang.y * up.y + ang.z * up.z
      // `held` is in the app's sense (+ = turning right); rotation about the body's up axis is the
      // opposite. Same inversion as the wheel angle above — see that comment.
      const add = (-held - spin) * p.yawAssist
      ang.x += up.x * add
      ang.y += up.y * add
      ang.z += up.z * add
      body.setAngvel(ang, true)
    } else if (!st.airborne) {
      st.slip = 0
    }

    // A slide bleeds off: the velocity turns toward the nose. This is the other half of an arcade
    // car — imposed yaw with no slide decay is a car that spins while travelling in a straight line.
    if (!st.airborne && p.slideDecay > 0) {
      const hold = this.input.handbrake ? p.driftHold : 0
      const k = 1 - Math.exp(-p.slideDecay * (1 - hold) * dt)
      lin.x -= rgt.x * vS * k
      lin.y -= rgt.y * vS * k
      lin.z -= rgt.z * vS * k
      body.setLinvel(lin, true)
    }

    // Air control. Rush's whole character is here: pitch and roll authority while airborne, and an
    // `airDamping` low enough that what you set spinning stays spinning.
    if (st.airborne) {
      const pitchIn = this.input.pitch ?? this.input.throttle - this.input.brake
      ang.x += rgt.x * pitchIn * p.airPitch * dt + fwd.x * -this.input.steer * p.airRoll * dt + up.x * this.input.steer * p.airYaw * dt
      ang.y += rgt.y * pitchIn * p.airPitch * dt + fwd.y * -this.input.steer * p.airRoll * dt + up.y * this.input.steer * p.airYaw * dt
      ang.z += rgt.z * pitchIn * p.airPitch * dt + fwd.z * -this.input.steer * p.airRoll * dt + up.z * this.input.steer * p.airYaw * dt
      const damp = Math.exp(-p.airDamping * dt)
      ang.x *= damp
      ang.y *= damp
      ang.z *= damp
      body.setAngvel(ang, true)
    } else {
      // Anti-roll bar and roll resistance. `up.y` is the cosine of the lean, so `rgt.y` is its sine
      // — the roll angle without a trig call. An arcade profile damps the roll axis outright, which
      // is the honest way to say "this car does not end up on its roof".
      if (p.antiRollPerKg > 0) {
        const roll = Math.asin(clamp(rgt.y, -1, 1))
        const t = -p.antiRollPerKg * mass * roll * dt
        body.applyTorqueImpulse({ x: fwd.x * t, y: fwd.y * t, z: fwd.z * t }, true)
      }
      if (p.rollResist > 0) {
        const about = ang.x * fwd.x + ang.y * fwd.y + ang.z * fwd.z
        const cut = about * p.rollResist
        ang.x -= fwd.x * cut
        ang.y -= fwd.y * cut
        ang.z -= fwd.z * cut
        body.setAngvel(ang, true)
      }
    }

    // Aero. Drag always; downforce only while there are wheels to press down — a wing on a car in
    // mid-air pushing it groundward is a cheat that reads as a car falling unnaturally fast.
    //
    // IMPULSES, NOT FORCES, and this is a Rapier trap worth the paragraph. `addForce` is PERSISTENT:
    // it adds to an accumulator that keeps being applied every step until something calls
    // `resetForces`. It is not Bullet's per-step force. Applying 142 N of drag with `addForce` once
    // per step at 120 Hz therefore builds 17 kN of drag per second, which measured as a car that
    // accelerated to 13 m/s at full throttle and then slowed to a stop still at full throttle —
    // exactly like a gearbox problem, and nothing like the aero bug it was. Force × dt as an
    // impulse is the same physics and cannot accumulate.
    if (speed > 0.5) {
      const d = -p.dragPerKg * mass * speed * dt
      body.applyImpulse({ x: lin.x * d, y: lin.y * d, z: lin.z * d }, true)
      if (p.downforcePerKg > 0 && !st.airborne) {
        const f = -p.downforcePerKg * mass * speed * speed * dt
        body.applyImpulse({ x: up.x * f, y: up.y * f, z: up.z * f }, true)
      }
    }

    st.wheelSpin += (vF / this.spec.wheelRadius) * dt
  }

  /* ---- damage ------------------------------------------------------------------------------ */

  /**
   * Hold the car onto a surface that is not the ground: the inside of a loop, a banked corkscrew.
   *
   * WHY A RAY-CAST VEHICLE NEEDS THIS AT ALL. Each wheel casts a ray along the CHASSIS' own down
   * axis, so a car whose body is level cannot feel a road that has stood up in front of it: the ray
   * points at the field, not at the track. Left alone the car drives straight through a loop, which
   * is exactly what it did once the body stopped colliding with it (Rich, 2026-09-29: *"the car just
   * drove right through the loop"*). Align the body with the surface and the rays point INTO it, the
   * suspension loads, and the wheels carry the car round — upside down included, which is the whole
   * trick and is how every arcade racer has ever drawn a loop.
   *
   * TWO PARTS, AND BOTH ARE NEEDED:
   *
   *   ALIGN — turn the chassis so its up matches the surface's. A torque impulse about the axis
   *   between the two, damped by however fast it is already turning that way, so it settles rather
   *   than oscillates.
   *
   *   PULL — extra gravity along the surface's DOWN. Without it the car needs enough speed to hold
   *   itself on by centripetal force alone, which for a forty-metre loop is 20 m/s at the top and
   *   more than any suspension can take at the bottom. With it, a loop is drivable at the speed the
   *   track was drawn for.
   *
   * `strength` fades both off at the edges of the assist's reach, so leaving a fixture hands the car
   * back to ordinary gravity rather than dropping it.
   */
  stick(up: { x: number; y: number; z: number }, dt: number, opts: { strength?: number; align?: number; pull?: number } = {}): void {
    const k = Math.max(0, Math.min(1, opts.strength ?? 1))
    if (k <= 0 || dt <= 0) return
    const R = rapier()
    const len = Math.hypot(up.x, up.y, up.z)
    if (!(len > 1e-6)) return
    const tx = up.x / len
    const ty = up.y / len
    const tz = up.z / len

    // the body's own up, from its rotation
    const q = this.body.rotation()
    const u = rotate(q, 0, 1, 0)

    /*
     * THE AXIS TO TURN ABOUT is u × target, whose length is the sine of the angle between them, and
     * whose direction is the right-hand axis of the shorter rotation. Past 90° the sine falls again,
     * so the angle comes from atan2 of the two — otherwise a car that is very nearly upside down
     * corrects more and more weakly the more wrong it is.
     */
    const ax = u.y * tz - u.z * ty
    const ay = u.z * tx - u.x * tz
    const az = u.x * ty - u.y * tx
    const sin = Math.hypot(ax, ay, az)
    const cos = u.x * tx + u.y * ty + u.z * tz
    const angle = Math.atan2(sin, cos)

    /*
     * THE ALIGNMENT ONLY APPLIES WHERE THE WHEELS CANNOT DO IT.
     *
     * A car with its tyres on the road is already turned by the road: that is what a suspension is.
     * Applying a turning torque as well does not rotate the car — the tyres hold it — so the whole
     * of it goes into dragging them sideways, and the drag stops the car. Measured on the loop's
     * entry with the scenery cleared away: all four wheels down, the chassis touching NOTHING, and
     * 29.8 m/s scrubbed off in a second and a half. Two g of braking out of an assist that was
     * supposed to help.
     *
     * So it fades out as the wheels find the ground and comes back the moment they leave it, which
     * is where a ray-cast car genuinely cannot turn itself: in the air, and on the way over the top
     * of a loop.
     */
    let grounded = 0
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) grounded++
    const airborne = 1 - grounded / 4
    const authority = AIR_ALIGN_FLOOR + (1 - AIR_ALIGN_FLOOR) * airborne

    if (sin > 1e-6) {
      const nx = ax / sin
      const ny = ay / sin
      const nz = az / sin
      const w = this.body.angvel()
      const along = w.x * nx + w.y * ny + w.z * nz
      const gain = (opts.align ?? 6) * k * authority
      // proportional to the error, damped by the rate: a spring, in the axis that matters
      const impulse = (angle * gain - along * gain * 0.35) * this.spec.massKg * dt
      this.body.applyTorqueImpulse({ x: nx * impulse, y: ny * impulse, z: nz * impulse }, true)
    }

    // and the pull, along the surface's down
    const pull = (opts.pull ?? 12) * k * this.spec.massKg * dt
    this.body.applyImpulse({ x: -tx * pull, y: -ty * pull, z: -tz * pull }, true)
    void R
  }

  /**
   * Impacts on this chassis become damage.
   *
   * The scale: a 1400 kg car stopping dead from 10 m/s delivers 14,000 N·s, and that should be a
   * bad crash but not a write-off. So the divisor is a few times that and the accumulation is
   * capped at 1. Nothing here decides what damage MEANS — that is the game's, through `state`.
   */
  private onImpact(im: { a: Collider; b: Collider; impulse: number }) {
    if (im.a.handle !== this.collider.handle && im.b.handle !== this.collider.handle) return
    const d = im.impulse / (this.spec.massKg * 40)
    if (d < 0.005) return
    this.state.damage = Math.min(1, this.state.damage + d)
    if (this.state.event === 'none') this.state.event = d > 0.08 ? 'crash' : 'bump'
  }

  /* ---- reading it back --------------------------------------------------------------------- */

  /**
   * Where a wheel is and how it is turned, for the renderer. World space, interpolated nowhere —
   * the wheel hangs off the chassis, so draw it in the chassis' interpolated frame.
   */
  wheel(i: number, out: { x: number; y: number; z: number; suspension: number; contact: boolean }): void {
    const c = this.controller.wheelChassisConnectionPointCs(i, tmp)
    const len = this.controller.wheelSuspensionLength(i) ?? this.profile.suspensionRest
    out.x = c?.x ?? 0
    out.y = (c?.y ?? 0) - len
    out.z = c?.z ?? 0
    out.suspension = len
    out.contact = this.controller.wheelIsInContact(i)
  }

  free() {
    for (const d of this.detach) d()
    this.detach.length = 0
    this.phys.untrack(this.body)
    this.phys.world.removeVehicleController(this.controller)
    this.phys.world.removeRigidBody(this.body)
  }
}

/**
 * Principal moments of inertia of a solid box, per axis.
 *
 * Rapier will happily compute these from the collider's density, and for a car it gets them wrong
 * in a way you can feel: a uniform box the size of a car is far too willing to pitch, because a
 * real car's mass is at its floor and its ends are empty. Setting them explicitly alongside the
 * centre of mass is what makes a profile's `antiRoll` and `airPitch` mean the same thing from one
 * car to the next.
 */
/**
 * How much of the alignment still applies with all four wheels down.
 *
 * Not zero: a little keeps the car settled onto a surface whose angle is changing under it. Not
 * much: any more and the torque fights the tyres, which is a brake.
 */
const AIR_ALIGN_FLOOR = 0.12

/** Rotate (x, y, z) by a quaternion. Written out because this is the only place that needs it. */
function rotate(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number): { x: number; y: number; z: number } {
  const ix = q.w * x + q.y * z - q.z * y
  const iy = q.w * y + q.z * x - q.x * z
  const iz = q.w * z + q.x * y - q.y * x
  const iw = -q.x * x - q.y * y - q.z * z
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  }
}

/**
 * The chassis collider.
 *
 * WHY A SLED AND NOT A BOX. Rich, 2026-09-29, on the loop: *"if that includes shaping the physical
 * shape of the car for the physics engine like an offroad suv with skidplates to prevent chunking
 * the road, let's do it."* It does. A loop's entry is a concave trough and the springs bottom out
 * under five g, so the body meets the ribbon — and a flat-bottomed box meets a rising surface with
 * its front bottom EDGE, which digs in. Cutting the underside back at each end (the approach and
 * departure angles of an off-road truck) and rounding every corner means the body meets the road
 * with a curve that rides up it, the way a skid plate is meant to, and the convex hull has no edge
 * for a tessellated surface to catch.
 *
 * The hull is eight points on top and eight underneath, inset by the corner radius per metre of
 * height, then rounded. It is still convex, so it costs what a box costs.
 */
function chassisShape(R: ReturnType<typeof rapier>, s: VehicleSpec) {
  if (s.shape !== 'sled') return R.ColliderDesc.cuboid(s.halfLength, s.halfHeight, s.halfWidth)
  const r = s.skidRadius ?? 0.18
  const hl = s.halfLength - r
  const hh = s.halfHeight - r
  const hw = s.halfWidth - r
  // the bottom is drawn in by the full height's worth of rake at each end, and a little across
  const rake = Math.min(hl * 0.35, s.halfHeight * 1.2)
  const tuck = Math.min(hw * 0.3, s.halfHeight * 0.4)
  const pts: number[] = []
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      pts.push(sx * hl, hh, sz * hw)
      pts.push(sx * (hl - rake), -hh, sz * (hw - tuck))
      // a waist, so the sides stay vertical down to the sill and only the belly tucks in
      pts.push(sx * hl, -hh * 0.2, sz * hw)
    }
  }
  const hull = R.ColliderDesc.roundConvexHull(new Float32Array(pts), r)
  if (!hull) throw new Error('vehicle: the sled hull is degenerate — halfLength/halfHeight/halfWidth must all exceed skidRadius')
  return hull
}

function boxInertia(mass: number, l: number, h: number, w: number): { x: number; y: number; z: number } {
  const k = mass / 12
  return { x: k * (h * h + w * w), y: k * (l * l + w * w), z: k * (l * l + h * h) }
}
