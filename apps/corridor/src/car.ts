// The car: stuntin's sim (apps/stuntin/src/sim/Car.ts) ported to drive anywhere on the corridor
// strip. There are no lanes here — the road is part of the ground — so the track regime's lateral
// model runs in world space, and the ground and air regimes are kept as they are.
//
//   longitudinal   throttle/brake vs rolling + aero drag, slope gravity along the nose; off the
//                  pavement adds drag and cuts traction (stuntin `longitudinal`)
//   steering       the wheel asks for a yaw rate (T.CAR_STEER_RATE × authority, which falls with
//                  speed, × a low-speed ramp); the tyres deliver what grip allows and no more, so
//                  above the grip limit the radius is v²/grip whatever you do with the wheel; a
//                  slide is never *added* by cornering — the car just turns less (stuntin `tickTrack`)
//   handbrake      the rear lets go: a share of the refused yaw goes through anyway and the car
//                  slides OUTWARD — velocity left of the nose in a right-hand drift — so counter-
//                  steering straightens it (stuntin, sign and all)
//   cross-slope    gravity across the car: the tyres hold T.CAR_BANK_HOLD of it, the rest slides
//                  the car downhill; a bank pays a little grip (T.CAR_BANK_GRIP)
//   slide          a world-space sideways velocity (stuntin's is along the lane's right, which on a
//                  straight is the same thing) that bleeds off at T.CAR_SLIDE_DECAY
//   pose           four wheel samples on the ground give roll and pitch; ride height T.CAR_RIDE
//   air            when the ground falls away faster than gravity the car is airborne: ballistic,
//                  no air control, lands on whatever is below; a hard landing wrecks it (stops it —
//                  there is no replay here). Speedlock and rocket jumps are in, switched off by default.
//   trees          circle vs trunk: push out, keep T.CAR_BUMP_BOUNCE of the speed reversed
//
// Deterministic, allocation-free in the hot path, metres and seconds. Every number is a knob on the
// F6 panel's car tab (src/tuning.ts), defaults = stuntin's Tuning.ts and the Kestrel S9 spec.
import * as THREE from 'three'
import { clamp, expApproach } from '@apex/engine/math/scalar'
import * as T from './tuning'

export interface CarInput {
  throttle: number
  brake: number
  steer: number
  handbrake: boolean
}

export interface Surface {
  /** ground height (world y) at world x,z, or null off the data */
  heightAt: (x: number, z: number) => number | null
  /** signed distance to the nearest pavement edge, negative on the pavement */
  edgeDistance: (x: number, z: number) => number
  /** trees within r metres of world x,z: [x, z, trunkRadius][] */
  treesNear: (x: number, z: number, r: number) => [number, number, number][]
}

export type CarEvent = 'none' | 'bump' | 'launch' | 'land' | 'crash' | 'rocket'

// body geometry (the mesh is built from these; the sim uses the half width for wheel spread and
// trunk collisions). The length lives in the silhouette profile in buildMesh, which is 4.4 m nose
// to tail — change it there.
const CAR_HALF_WIDTH = 0.95

export class Car {
  pos = new THREE.Vector3()
  /** heading, rad; forward = (cos yaw, 0, sin yaw), so steering right increases it */
  yaw = 0
  /** ground slope under the body: rise per metre along the nose (+ nose up) and across (+ right side up) */
  pitch = 0
  roll = 0
  /** m/s along the nose on the ground; the flight speed in the air */
  speed = 0
  /** how far past what the tyres hold the corner is asking, 0..1 (1 with the handbrake on) */
  slip = 0
  wheelSpin = 0
  onGrass = false
  mode: 'ground' | 'air' = 'ground'
  /** speedlock armed (took off near top speed with the throttle down and it is still down) */
  airGlitch = false
  /** this flight is a rocket jump */
  rocket = false
  event: CarEvent = 'none'
  readonly forward = new THREE.Vector3(1, 0, 0)
  /** unit vector out of the driver's right window; the cockpit camera leans along it */
  readonly right = new THREE.Vector3(0, 0, 1)
  /** world-space sideways velocity: the rear letting go, or gravity across a slope */
  private slideX = 0
  private slideZ = 0
  /** world velocity while airborne */
  private readonly vel = new THREE.Vector3()
  /** vertical speed of the contact point, and where it would be by now had the ground not carried it */
  private vy = 0
  private hover = 0
  private airTime = 0
  private ticks = 0
  private steerVisual = 0
  mesh: THREE.Group
  private wheels: THREE.Mesh[] = []
  /** dash, pillars and wheel: drawn only from inside (setCockpit) */
  private interior: THREE.Group | null = null
  private shell: THREE.Object3D[] = []
  private steeringWheel: THREE.Object3D | null = null
  private surface: Surface

  constructor(surface: Surface) {
    this.surface = surface
    this.mesh = this.buildMesh()
  }

  /** Sideways speed across the car, m/s (+ right): the HUD's "sliding". */
  get slide(): number {
    return this.slideX * this.right.x + this.slideZ * this.right.z
  }

  place(x: number, z: number, yaw: number) {
    const g = this.surface.heightAt(x, z) ?? 0
    this.pos.set(x, g + T.CAR_RIDE, z)
    this.yaw = yaw
    this.forward.set(Math.cos(yaw), 0, Math.sin(yaw))
    this.right.set(-this.forward.z, 0, this.forward.x)
    this.speed = 0
    this.slideX = this.slideZ = 0
    this.vel.set(0, 0, 0)
    this.vy = 0
    this.hover = g
    this.pitch = this.roll = 0
    this.slip = 0
    this.mode = 'ground'
    this.airGlitch = false
    this.rocket = false
    this.event = 'none'
    this.updateMesh()
  }

  /**
   * Manual recover, stuntin's rule: right the car where it stands and BACK IT OUT of whatever it
   * is in, keeping the heading. R used to teleport to the photo station — "car reset in driving
   * mode should follow the stuntin' rules - back you out a bunch, not reset to home" (Rich,
   * 2026-09-26). Every press steps back `back` metres the way you came, and keeps stepping while
   * the spot it lands on still has a tree in it, up to six more times, so one press gets you out
   * of a copse rather than into the next trunk.
   */
  recover(back: number) {
    const yaw = this.yaw
    const step = (d: number) => {
      const x = this.pos.x - this.forward.x * d
      const z = this.pos.z - this.forward.z * d
      this.place(x, z, yaw)
    }
    step(back)
    for (let i = 0; i < 6 && this.surface.treesNear(this.pos.x, this.pos.z, 2.5).length; i++) step(back * 0.6)
  }

  private ground(x: number, z: number, fallback: number) {
    return this.surface.heightAt(x, z) ?? fallback
  }

  tick(dt: number, input: CarInput) {
    this.event = 'none'
    this.ticks++
    if (this.mode === 'air') this.tickAir(dt, input)
    else this.tickGround(dt, input)
    this.wheelSpin += (this.speed / 0.34) * dt
    this.steerVisual = expApproach(this.steerVisual, input.steer * 0.45, T.CAR_STEER_VISUAL_RATE, dt)
    this.updateMesh()
  }

  // ---------------------------------------------------------------------------

  private longitudinal(dt: number, input: CarInput, gTan: number, grassDrag: number) {
    const v = this.speed
    const ratio = clamp(Math.abs(v) / T.CAR_TOP_SPEED, 0, 1)
    // Grass barely slows a straight line, but the tyres can't put much power or braking down.
    const traction = grassDrag > 0 ? T.CAR_GRASS_TRACTION : 1
    let a = input.throttle * T.CAR_ACCEL * Math.max(0.15, 1 - ratio * ratio) * traction
    if (v > 0.5) a -= input.brake * T.CAR_BRAKE * traction
    else if (input.brake > 0) a -= input.brake * T.CAR_ACCEL * T.CAR_REVERSE_ACCEL * traction // reverse
    a -= Math.sign(v) * (T.CAR_DRAG_ROLLING + T.CAR_DRAG_AERO * v * v + grassDrag)
    if (input.handbrake) a -= Math.sign(v) * T.CAR_BRAKE * T.CAR_HANDBRAKE_BRAKE * traction
    a += gTan
    this.speed = v + a * dt
    if (Math.abs(this.speed) < 0.05 && input.throttle === 0 && input.brake === 0) this.speed = 0
    this.speedlock(dt, input)
  }

  /** Speedlock: with the glitch armed and the throttle down, nothing slows you below vmax. */
  private speedlock(dt: number, input: CarInput) {
    if (!this.airGlitch) return
    if (input.throttle <= 0.5) {
      this.airGlitch = false
      return
    }
    const top = T.CAR_TOP_SPEED
    if (this.speed < top) this.speed = Math.min(top, this.speed + T.CAR_AIR_GLITCH_ACCEL * dt)
  }

  private tickGround(dt: number, input: CarInput) {
    const f = this.forward
    f.set(Math.cos(this.yaw), 0, Math.sin(this.yaw))
    this.right.set(-f.z, 0, f.x)
    const ref = this.pos.y - T.CAR_RIDE
    // pavement or grass, under the middle of the car
    this.onGrass = this.surface.edgeDistance(this.pos.x, this.pos.z) > T.CAR_GRASS_EDGE
    // slope along the nose: downhill pulls, uphill drags
    const gAhead = this.ground(this.pos.x + f.x * 2, this.pos.z + f.z * 2, ref)
    const gBehind = this.ground(this.pos.x - f.x * 2, this.pos.z - f.z * 2, ref)
    const slope = (gAhead - gBehind) / 4
    this.longitudinal(dt, input, (-T.CAR_GRAVITY * slope) / Math.hypot(1, slope), this.onGrass ? T.CAR_GRASS_DRAG : 0)
    const v = this.speed

    // The surface the car stands on, from last tick's wheel contacts: how much of gravity presses
    // the car into it (grip), and how much pulls it across (a bank, a cambered verge).
    const surfUpY = 1 / Math.sqrt(1 + this.roll * this.roll + this.pitch * this.pitch)
    const surfRightY = this.roll / Math.hypot(1, this.roll)
    const gRight = -T.CAR_GRAVITY * surfRightY
    const upright = Math.max(0.08, surfUpY)
    const load = clamp(surfUpY + (T.CAR_BANK_GRIP * Math.abs(surfRightY)) / upright, 0.2, T.CAR_LOAD_MAX)
    const grip = T.CAR_GRIP_LATERAL * T.CAR_GRIP_MULT * load * (this.onGrass ? T.CAR_GRASS_GRIP_SCALE : 1) * (input.handbrake ? T.CAR_HANDBRAKE_GRIP : 1)
    const authority = T.CAR_AGILITY * (1 - (1 - T.CAR_STEER_HIGH_SPEED_FACTOR) * clamp((Math.abs(v) - T.CAR_STEER_FULL_SPEED) / (T.CAR_TOP_SPEED - T.CAR_STEER_FULL_SPEED), 0, 1))
    // Yaw the wheel asks for; nothing turns at a standstill.
    const yawDemand = input.steer * T.CAR_STEER_RATE * (this.onGrass ? T.CAR_GRASS_STEER : 1) * authority * clamp(Math.abs(v) / T.CAR_STEER_FULL_SPEED, 0, 1) * Math.sign(v || 1)
    // Cross-slope gravity: the tyres hold only CAR_BANK_HOLD of it; the rest slides the car down the
    // surface, and you steer into the hill to hold your line (Stunts).
    const held = gRight * T.CAR_BANK_HOLD
    const need = v * yawDemand - held
    const tyreF = clamp(need, -grip, grip)
    const yawRate = Math.abs(v) > 0.5 ? (tyreF + held) / v : 0
    this.slip = clamp((Math.abs(need) - grip) / (grip + 1e-6), 0, 1)
    let dYaw = yawRate * dt
    let across = gRight * (1 - T.CAR_BANK_HOLD) * dt
    // Handbrake: the rear lets go — you rotate past what grip allows and slide outward.
    if (input.handbrake && Math.abs(v) > T.CAR_HANDBRAKE_MIN_SPEED) {
      const refused = yawDemand - yawRate
      dYaw += refused * T.CAR_HANDBRAKE_ROTATE * dt
      across -= refused * Math.abs(v) * T.CAR_HANDBRAKE_SLIDE * dt
      this.slip = 1
    }
    this.slideX += across * this.right.x
    this.slideZ += across * this.right.z
    this.slideX = expApproach(this.slideX, 0, T.CAR_SLIDE_DECAY, dt)
    this.slideZ = expApproach(this.slideZ, 0, T.CAR_SLIDE_DECAY, dt)
    this.yaw += dYaw
    f.set(Math.cos(this.yaw), 0, Math.sin(this.yaw))
    this.right.set(-f.z, 0, f.x)

    // move: where the nose points at the speed, plus the slide
    this.pos.x += (f.x * v + this.slideX) * dt
    this.pos.z += (f.z * v + this.slideZ) * dt

    // trees: circle vs trunk, push out, bounce
    for (const [tx, tz, tr] of this.surface.treesNear(this.pos.x, this.pos.z, 4)) {
      const dx = this.pos.x - tx, dz = this.pos.z - tz
      const d = Math.hypot(dx, dz)
      const minD = CAR_HALF_WIDTH + tr
      if (d < minD && d > 1e-4) {
        this.pos.x = tx + (dx / d) * minD
        this.pos.z = tz + (dz / d) * minD
        if (Math.abs(this.speed) > 1) {
          this.speed = -this.speed * T.CAR_BUMP_BOUNCE
          this.event = 'bump'
        }
        this.slideX = this.slideZ = 0
      }
    }

    // pose from four wheel contacts; the body rises no faster than the ground it is covering, so a
    // kerb is ridden up rather than teleported onto
    const yL = this.ground(this.pos.x - this.right.x * CAR_HALF_WIDTH, this.pos.z - this.right.z * CAR_HALF_WIDTH, ref)
    const yR = this.ground(this.pos.x + this.right.x * CAR_HALF_WIDTH, this.pos.z + this.right.z * CAR_HALF_WIDTH, ref)
    const yF = this.ground(this.pos.x + f.x * 1.5, this.pos.z + f.z * 1.5, ref)
    const yB = this.ground(this.pos.x - f.x * 1.5, this.pos.z - f.z * 1.5, ref)
    const gh = Math.min((yL + yR) / 2, ref + Math.abs(v) * dt * T.CAR_CLIMB_SLOPE + 0.05)
    this.roll = (yR - yL) / (2 * CAR_HALF_WIDTH)
    this.pitch = (yF - yB) / 3

    // Over a crest the ground falls away faster than gravity can follow: airborne, Stunts style.
    // `hover` is where the contact point would be had nothing carried it since it last touched; while
    // the ground is at or above it the ground carries the car (and sets its vertical speed), and once
    // the ground is CAR_LAUNCH_GAP below it the car is in the air. Stuntin tests one tick's change in the
    // ground's vertical speed; on a lidar strip interpolated between stations that fires at every seam,
    // so here the same condition is integrated instead — a slope break has to keep falling away.
    // `hover` is integrated ballistically and clamped into [ref - 0.01, ref + GAP + 0.01]. Because
    // `ref` is last tick's ground and `pos.y` is rewritten to the ground every tick, the floor only
    // bites while the car is ON the ground; once the ground starts falling away hover sits above it
    // and the gap accumulates across the crest as intended. Measured at Chesterfield's Hawkins Road
    // brow, the clamp costs about 1 mph of launch threshold against a free integration (83 vs 84 at
    // GAP 0.2, 77 vs 78 at 0.1) — it makes launching very slightly harder, and nothing else.
    this.hover = clamp(this.hover + this.vy * dt, ref - 0.01, ref + T.CAR_LAUNCH_GAP + 0.01)
    // CAR_CREST_GAIN > 1 lets the car hold its line over a crest longer than gravity really allows,
    // which is the arcade knob for "this brow should throw the car". It scales only the separation
    // test; the flight itself (tickAir) always uses real gravity.
    this.vy -= (T.CAR_GRAVITY / Math.max(0.05, T.CAR_CREST_GAIN)) * dt
    if (this.hover <= gh + 1e-4 || Math.abs(v) <= T.CAR_LAUNCH_MIN_SPEED) {
      // The contact point's vertical speed while the ground carries the car, and — via launch() —
      // the vertical speed the car leaves a crest with. Reading it as one tick's change in sampled
      // height, (gh - ref)/dt, makes it the height field's derivative DIVIDED BY dt: at 30 m/s a
      // tick is 0.25 m, so a 0.42 m step in the DTM becomes vy = 50 m/s and a 128 m ballistic arc.
      // That is what threw the car 101 m up at Bowie s≈2524, where the baked road profile drops 5 m
      // into an undetected underpass (probes/corridor-groundstep.mjs).
      // A car following the ground at speed v rises at v × (slope along the nose), and `pitch` has
      // just measured that slope over a 3 m base — the car's own length, which is the shortest
      // wavelength a car can actually follow. Take vy from that geometry, so a step in the data is a
      // bump and only a sustained ramp is a jump; CAR_LAUNCH_MAX_RISE then caps what any ramp can
      // impart, because a suspension cannot throw a car harder than that however steep the data is.
      const rise = v * this.pitch
      this.vy = clamp(rise, -T.CAR_LAUNCH_MAX_RISE, T.CAR_LAUNCH_MAX_RISE)
      this.hover = gh
    } else if (this.hover - gh > T.CAR_LAUNCH_GAP) {
      this.launch(v)
      return
    }
    this.pos.y = gh + T.CAR_RIDE
  }

  private launch(v: number) {
    this.mode = 'air'
    this.airTime = 0
    this.vel.set(this.forward.x * v + this.slideX, this.vy, this.forward.z * v + this.slideZ)
    this.pos.y = this.hover + T.CAR_RIDE
    this.slideX = this.slideZ = 0
    this.airGlitch = T.CAR_AIR_GLITCH > 0 && Math.abs(v) >= T.CAR_TOP_SPEED * T.CAR_AIR_GLITCH_THRESHOLD
    this.event = 'launch'
    // Stunts' jump bug: leave a crest at the top of the rev range and gravity occasionally goes
    // insane instead, throwing the car straight up.
    const fast = this.airGlitch || Math.abs(v) >= T.CAR_TOP_SPEED * T.CAR_ROCKET_MIN_SPEED
    if (T.CAR_ROCKETS > 0 && fast && this.dice() < T.CAR_ROCKET_CHANCE) {
      this.vel.y = T.CAR_ROCKET_SPEED
      this.rocket = true
      this.airGlitch = true
      this.event = 'rocket'
    }
  }

  /** A deterministic 0..1 per tick: the same run always rockets in the same places. */
  private dice(): number {
    let h = (this.ticks * 2654435761) ^ 0x9e3779b9
    h = Math.imul(h ^ (h >>> 15), 2246822519)
    h = Math.imul(h ^ (h >>> 13), 3266489917)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }

  private tickAir(dt: number, input: CarInput) {
    this.airTime += dt
    this.vel.y -= T.CAR_GRAVITY * dt
    this.pos.addScaledVector(this.vel, dt)
    // No air control: the car noses along its arc and its roll settles toward level, like a thrown
    // brick with good manners. The glitch: throttle held after a near-vmax take-off pins you to vmax.
    if (this.airGlitch && input.throttle > 0.5) {
      const hx = this.vel.x, hz = this.vel.z
      const h = Math.hypot(hx, hz)
      if (h > 1) {
        const target = T.CAR_TOP_SPEED
        const nh = h < target ? Math.min(target, h + T.CAR_AIR_GLITCH_ACCEL * dt) : h
        this.vel.x = (hx / h) * nh
        this.vel.z = (hz / h) * nh
      }
    } else if (input.throttle <= 0.5) {
      this.airGlitch = false
    }
    const hSpeed = Math.hypot(this.vel.x, this.vel.z)
    if (hSpeed > 1) this.pitch = expApproach(this.pitch, this.vel.y / hSpeed, T.CAR_AIR_NOSE_RATE, dt)
    this.roll = expApproach(this.roll, 0, T.CAR_AIR_ROLL_SETTLE, dt)
    this.speed = this.vel.length()

    // the ground (the road is part of it)
    const gh = this.ground(this.pos.x, this.pos.z, this.pos.y - T.CAR_RIDE)
    if (this.pos.y <= gh + T.CAR_RIDE && this.vel.y < 0) {
      const hard = -this.vel.y > T.CAR_CRASH_IMPACT_SPEED && !this.airGlitch && !this.rocket
      this.pos.y = gh + T.CAR_RIDE
      this.mode = 'ground'
      this.rocket = false
      this.hover = gh
      this.vy = 0
      this.speed = hSpeed
      this.slideX = this.slideZ = 0
      this.onGrass = this.surface.edgeDistance(this.pos.x, this.pos.z) > T.CAR_GRASS_EDGE
      if (hard) {
        // wrecked: no replay here, so the car simply stops where it hit
        this.speed = 0
        this.airGlitch = false
        this.event = 'crash'
      } else this.event = 'land'
    }
  }

  /** A stand-in car: low wedge body, four wheels. Kestrel-ish proportions, 4.4 × 1.9 m. */
  private buildMesh(): THREE.Group {
    const g = new THREE.Group()
    // The silhouette, as a side profile extruded across the car. A box reads as a box from every
    // angle; a profile with a bonnet line, a raked screen and a fastback costs the same draw call
    // and is a CAR from the chase camera, which is where it is looked at. Nose at +x.
    const side = new THREE.Shape()
    const prof: [number, number][] = [
      [2.16, 0.42], [2.2, 0.62], [1.98, 0.76], [1.5, 0.84], // nose, bonnet
      [0.92, 1.1], [0.3, 1.3], [-0.5, 1.31], [-1.12, 1.16], // screen, roof
      [-1.72, 0.84], [-2.08, 0.76], [-2.2, 0.6], [-2.2, 0.4], // fastback, tail
      [-1.75, 0.3], [-1.05, 0.26], [0.95, 0.26], [1.7, 0.3], // sills between the arches
    ]
    side.moveTo(prof[0][0], prof[0][1])
    for (const [x, y] of prof.slice(1)) side.lineTo(x, y)
    side.closePath()
    const bodyGeo = new THREE.ExtrudeGeometry(side, { depth: CAR_HALF_WIDTH * 2 - 0.16, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.05, bevelSegments: 2, curveSegments: 1 })
    bodyGeo.translate(0, 0, -(CAR_HALF_WIDTH - 0.08)) // extrusion runs along +z; centre it
    bodyGeo.computeVertexNormals()
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0xc8322a, roughness: 0.35, metalness: 0.3 }))
    g.add(body)
    // glasshouse: the same profile, slightly proud, in dark glass — screen, roof band and backlight
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x141922, roughness: 0.12, metalness: 0.6 })
    const cabin = new THREE.Group()
    for (const zz of [-1, 1]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 0.06), glassMat)
      win.position.set(-0.15, 1.12, zz * (CAR_HALF_WIDTH - 0.06))
      cabin.add(win)
    }
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 1.62), glassMat)
    screen.position.set(0.62, 1.22, 0)
    screen.rotation.z = 0.62
    cabin.add(screen)
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 1.66), glassMat)
    roof.position.set(-0.1, 1.33, 0)
    cabin.add(roof)
    g.add(cabin)
    // lamps, so which end is the front is never a question
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff3d0, emissive: 0xfff0c0, emissiveIntensity: 0.55, roughness: 0.3 })
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x8e1414, emissive: 0x8e1414, emissiveIntensity: 0.4, roughness: 0.4 })
    for (const zz of [-1, 1]) {
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.42), lampMat)
      head.position.set(2.14, 0.66, zz * 0.52)
      g.add(head)
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.38), tailMat)
      tail.position.set(-2.2, 0.66, zz * 0.56)
      g.add(tail)
    }
    // The view from the driver's seat. Mesh-local y is height above the wheel contact, so with
    // CAR_RIDE 0.35 and COCKPIT_EYE_UP 1.15 the eye sits at local (0.35, 1.50, COCKPIT_EYE_SIDE),
    // and everything here is placed relative to THAT. Hidden until setCockpit(true), when the body
    // shell is hidden instead so the eye is not sitting inside a solid box.
    // Everything here has to sit BEYOND the camera's 0.5 m near plane, or it is clipped away and
    // you see the road through your own dashboard. The eye is at local (0.35, 1.50), so the near
    // face of the dash starts at x = 0.93 — 0.58 m ahead — and its top at y = 1.33 is 0.17 m below
    // the eye, which at that distance is above the bottom edge of a 60-degree frame (0.33 m below).
    // It reaches down to the floor so nothing shows underneath it.
    const interior = new THREE.Group()
    interior.visible = false
    const dashMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.85, metalness: 0.05 })
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.78, 1.2, 2.0), dashMat)
    dash.position.set(1.32, 0.73, 0) // x 0.93..1.71, y 0.13..1.33
    interior.add(dash)
    const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 2.0), dashMat)
    cowl.position.set(1.95, 1.3, 0)
    cowl.rotation.z = -0.09 // the bonnet falling away ahead
    interior.add(cowl)
    const header = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 1.75), dashMat)
    header.position.set(1.0, 1.78, 0)
    interior.add(header)
    for (const zz of [-0.85, 0.85]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 0.14), dashMat)
      pillar.position.set(1.02, 1.5, zz)
      pillar.rotation.z = 0.26
      interior.add(pillar)
    }
    const wheelRim = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.026, 8, 24), new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.6 }))
    wheelRim.position.set(1.0, 1.24, T.COCKPIT_EYE_SIDE)
    wheelRim.rotation.y = Math.PI / 2
    wheelRim.rotation.x = 0.42 // raked toward the driver
    interior.add(wheelRim)
    this.steeringWheel = wheelRim
    this.interior = interior
    g.add(interior)
    this.shell = [body, cabin]

    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 16)
    wheelGeo.rotateX(Math.PI / 2)
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 })
    for (const [x, z] of [[1.4, -0.9], [1.4, 0.9], [-1.4, -0.9], [-1.4, 0.9]]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat)
      w.position.set(x, 0.34, z)
      g.add(w)
      this.wheels.push(w)
    }
    g.name = 'car'
    return g
  }

  /** Inside or outside: swap the body shell for the dash, pillars and wheel. */
  setCockpit(on: boolean) {
    if (!this.interior || this.interior.visible === on) return
    this.interior.visible = on
    for (const o of this.shell) o.visible = !on
  }

  private updateMesh() {
    this.mesh.position.copy(this.pos).y -= T.CAR_RIDE
    // yaw about Y (three: +yaw turns from +X toward -Z, our forward is (cos, 0, sin) so negate)
    this.mesh.rotation.set(0, -this.yaw, 0)
    this.mesh.rotateZ(-Math.atan(this.pitch))
    this.mesh.rotateX(Math.atan(this.roll))
    if (this.steeringWheel) this.steeringWheel.rotation.z = this.steerVisual * 2.6
    for (const [i, w] of this.wheels.entries()) {
      w.rotation.set(0, i < 2 ? -this.steerVisual : 0, 0)
      w.rotateZ(-this.wheelSpin)
    }
  }
}
