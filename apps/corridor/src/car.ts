// The car: stuntin's free-ground regime (apps/stuntin/src/sim/Car.ts `tickGround` + `longitudinal`
// + the track regime's lateral model), ported to drive anywhere on the corridor strip.
//
//   longitudinal   throttle/brake vs rolling + aero drag, slope gravity along the nose; grass
//                  (off the pavement) adds drag and cuts traction
//   steering       yaw rate = steer × STEER_RATE × authority (falls with speed) × low-speed ramp
//   grip           the lateral acceleration the turn demands beyond GRIP_LATERAL becomes slide,
//                  which decays at SLIDE_DECAY; the handbrake cuts grip and adds slide
//   pose           four wheel samples on the ground give roll and pitch; ride height 0.35 m
//   trees          circle vs trunk: push out, keep BUMP_BOUNCE of the speed reversed
//
// Deterministic, allocation-free in the hot path, metres and seconds. Numbers are stuntin's
// Tuning.ts defaults and the Kestrel S9 spec so it feels like the same car.
import * as THREE from 'three'

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

// stuntin Tuning.ts / CarSpec 'Kestrel S9'
const GRAVITY = 9.81
const CAR_RIDE = 0.35
const CAR_HALF_WIDTH = 0.95
const CAR_HALF_LENGTH = 2.2
const TOP_SPEED = 82
const ACCEL = 11
const BRAKE = 24
const STEER_FULL_SPEED = 12
const STEER_HIGH_SPEED_FACTOR = 0.35
const STEER_RATE = 2.4
const GRIP_LATERAL = 22
const SLIDE_DECAY = 2
const DRAG_ROLLING = 0.5
const DRAG_AERO = 0.0006
const GRASS_DRAG = 0.4
const GRASS_GRIP_SCALE = 0.35
const GRASS_TRACTION = 0.75
const GRASS_STEER = 0.6
const BUMP_BOUNCE = 0.25
const CLIMB_SLOPE = 1.5

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

export class Car {
  pos = new THREE.Vector3()
  yaw = 0
  pitch = 0
  roll = 0
  speed = 0
  slide = 0
  wheelSpin = 0
  onGrass = false
  event: 'none' | 'bump' = 'none'
  readonly forward = new THREE.Vector3(1, 0, 0)
  private readonly right = new THREE.Vector3()
  mesh: THREE.Group
  private wheels: THREE.Mesh[] = []
  private surface: Surface

  constructor(surface: Surface) {
    this.surface = surface
    this.mesh = this.buildMesh()
  }

  place(x: number, z: number, yaw: number) {
    this.pos.set(x, (this.surface.heightAt(x, z) ?? 0) + CAR_RIDE, z)
    this.yaw = yaw
    this.speed = 0
    this.slide = 0
    this.pitch = this.roll = 0
  }

  private ground(x: number, z: number, fallback: number) {
    return this.surface.heightAt(x, z) ?? fallback
  }

  tick(dt: number, input: CarInput) {
    this.event = 'none'
    const f = this.forward
    f.set(Math.cos(this.yaw), 0, Math.sin(this.yaw))
    this.right.set(-f.z, 0, f.x)
    const ref = this.pos.y - CAR_RIDE
    // surface under the middle: pavement or grass
    this.onGrass = this.surface.edgeDistance(this.pos.x, this.pos.z) > 0.3
    // slope along the nose: downhill pulls, uphill drags (stuntin tickGround)
    const gAhead = this.ground(this.pos.x + f.x * 2, this.pos.z + f.z * 2, ref)
    const gBehind = this.ground(this.pos.x - f.x * 2, this.pos.z - f.z * 2, ref)
    const slope = (gAhead - gBehind) / 4
    this.longitudinal(dt, input, (-GRAVITY * slope) / Math.hypot(1, slope), this.onGrass ? GRASS_DRAG : 0)

    // steering + grip (stuntin track regime, without the lane frame)
    const v = this.speed
    const authority = 1 - (1 - STEER_HIGH_SPEED_FACTOR) * clamp((Math.abs(v) - STEER_FULL_SPEED) / (TOP_SPEED - STEER_FULL_SPEED), 0, 1)
    const yawDemand = input.steer * STEER_RATE * (this.onGrass ? GRASS_STEER : 1) * authority * clamp(Math.abs(v) / STEER_FULL_SPEED, 0, 1) * Math.sign(v || 1)
    const grip = GRIP_LATERAL * (this.onGrass ? GRASS_GRIP_SCALE : 1) * (input.handbrake ? 0.55 : 1)
    const latDemand = Math.abs(v * yawDemand) // centripetal acceleration the turn asks for
    let yawRate = yawDemand
    if (latDemand > grip) {
      // the tyres hold `grip` of it; the rest becomes slide, and the car turns less than asked
      const held = grip / latDemand
      yawRate = yawDemand * held
      this.slide += Math.sign(yawDemand) * (latDemand - grip) * dt
    }
    if (input.handbrake && Math.abs(v) > 3) this.slide += input.steer * 4 * dt
    this.slide *= Math.exp(-SLIDE_DECAY * dt)
    this.yaw += yawRate * dt
    f.set(Math.cos(this.yaw), 0, Math.sin(this.yaw))
    this.right.set(-f.z, 0, f.x)

    // move: forward speed plus sideways slide (sign: positive slide drifts to the right)
    this.pos.x += (f.x * v + this.right.x * this.slide) * dt
    this.pos.z += (f.z * v + this.right.z * this.slide) * dt

    // trees: circle vs trunk, push out, bounce (stuntin's BUMP_BOUNCE)
    for (const [tx, tz, tr] of this.surface.treesNear(this.pos.x, this.pos.z, 4)) {
      const dx = this.pos.x - tx, dz = this.pos.z - tz
      const d = Math.hypot(dx, dz)
      const minD = CAR_HALF_WIDTH + tr
      if (d < minD && d > 1e-4) {
        this.pos.x = tx + (dx / d) * minD
        this.pos.z = tz + (dz / d) * minD
        if (Math.abs(this.speed) > 1) {
          this.speed = -this.speed * BUMP_BOUNCE
          this.event = 'bump'
        }
        this.slide = 0
      }
    }

    // pose from four wheel contacts; rise no faster than the ground being covered
    const yL = this.ground(this.pos.x - this.right.x * CAR_HALF_WIDTH, this.pos.z - this.right.z * CAR_HALF_WIDTH, ref)
    const yR = this.ground(this.pos.x + this.right.x * CAR_HALF_WIDTH, this.pos.z + this.right.z * CAR_HALF_WIDTH, ref)
    const yF = this.ground(this.pos.x + f.x * 1.5, this.pos.z + f.z * 1.5, ref)
    const yB = this.ground(this.pos.x - f.x * 1.5, this.pos.z - f.z * 1.5, ref)
    const gh = Math.min((yL + yR) / 2, ref + Math.abs(v) * dt * CLIMB_SLOPE + 0.05)
    // no air regime yet: the car follows the ground down too (a crest just drops it)
    // compare ground to ground: `ref` is last frame's contact height (prevY minus the ride), so the
    // ride height is added exactly once — adding it to prevY as well lifted the car 10 cm a tick
    this.pos.y = Math.max(gh, ref - GRAVITY * dt * 3) + CAR_RIDE
    this.roll = (yR - yL) / (2 * CAR_HALF_WIDTH)
    this.pitch = (yF - yB) / 3
    this.wheelSpin += (this.speed / 0.34) * dt
    this.updateMesh(input.steer)
  }

  private longitudinal(dt: number, input: CarInput, gTan: number, grassDrag: number) {
    const v = this.speed
    const ratio = clamp(Math.abs(v) / TOP_SPEED, 0, 1)
    const traction = grassDrag > 0 ? GRASS_TRACTION : 1
    let a = input.throttle * ACCEL * Math.max(0.15, 1 - ratio * ratio) * traction
    if (v > 0.5) a -= input.brake * BRAKE * traction
    else if (input.brake > 0) a -= input.brake * ACCEL * 0.6 * traction // reverse
    a -= Math.sign(v) * (DRAG_ROLLING + DRAG_AERO * v * v + grassDrag)
    if (input.handbrake) a -= Math.sign(v) * BRAKE * 0.6 * traction
    a += gTan
    this.speed = v + a * dt
    if (Math.abs(this.speed) < 0.05 && input.throttle === 0 && input.brake === 0) this.speed = 0
  }

  /** A stand-in car: low wedge body, four wheels. Kestrel-ish proportions, 4.4 × 1.9 m. */
  private buildMesh(): THREE.Group {
    const g = new THREE.Group()
    const body = new THREE.Mesh(new THREE.BoxGeometry(CAR_HALF_LENGTH * 2, 0.55, CAR_HALF_WIDTH * 2), new THREE.MeshStandardMaterial({ color: 0xc8322a, roughness: 0.35, metalness: 0.3 }))
    body.position.y = 0.45
    g.add(body)
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.5, 1.5), new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.2, metalness: 0.5 }))
    cabin.position.set(-0.2, 0.95, 0)
    g.add(cabin)
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

  private updateMesh(steer: number) {
    this.mesh.position.copy(this.pos).y -= CAR_RIDE
    // yaw about Y (three: +yaw turns from +X toward -Z, our forward is (cos, 0, sin) so negate)
    this.mesh.rotation.set(0, -this.yaw, 0)
    this.mesh.rotateZ(-Math.atan(this.pitch))
    this.mesh.rotateX(Math.atan(this.roll))
    for (const [i, w] of this.wheels.entries()) {
      w.rotation.set(0, i < 2 ? -steer * 0.45 : 0, 0)
      w.rotateZ(-this.wheelSpin)
    }
  }
}
