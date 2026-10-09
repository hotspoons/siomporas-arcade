// The test rig: the car drives the spine on its own and shoots the traffic, for as long as asked.
//
// Rich, 2026-10-08: *"add rigging to the car to drive it along the outer loop in the middle and
// launch missiles constantly without physics interacting with the hero car (make it blast traffic
// cars) on a continual basis so you can recreate the kind of worst case scenarios"*. A probe on the
// bridge starts it (`apex.rig.start()`), samples the frame while it runs, and stops it; the same
// drive, the same jam, the same blasts every time, so two builds can be held against each other.
//
// NOTHING HERE TOUCHES THE CAR DIRECTLY. The rig writes the same `CarInput` the keys and the pad
// write (throttle, brake, steer), on the frame after `main.ts` has read them, so the car being
// driven is exactly the car Rich drives, through the same physics. The only liberties are a
// teleport back onto the road when it has been knocked off (`place`, the same call R uses) and the
// blast exclusion `main.ts` applies while the rig is on, so a missile landing under the bonnet does
// not put the rig's own car in the air.
//
// The path is the spine in travel order; whether that order IS the travel direction is measured
// against the traffic beside it at start, never assumed (`reversed` in the stats says what it found).
import * as THREE from 'three'
import * as T from '../../tuning'
import type { CarInput, DrivableCar } from '../vehicle/car'

export interface RigOpts {
  /** m/s to hold on the straights; bends slow it (default `RIG_SPEED_MPS`) */
  speed?: number
  /** seconds between missiles; 0 = never fire (default `RIG_FIRE_EVERY_S`) */
  fireEvery?: number
  /** metres off the spine, + right of travel (default `RIG_LANE_M`) */
  lane?: number
  /** drive the spine backwards from its stored order; default: whichever way the traffic goes */
  reverse?: boolean
  /** metres along the path to start at (default: where the car is, projected onto it) */
  startS?: number
  /** keep the missile blasts off the rig's own car (default true) */
  shield?: boolean
}

export interface RigHost {
  /** the path in WORLD x,z (east, south), in the spine's stored order, or null when there is no site */
  path(): [number, number][] | null
  car(): DrivableCar | null
  /** put the car in the seat if it is not; the rig does nothing without a car */
  ensureDriving(): void
  /** the traffic cars within `r` of a point: world x,z and yaw in the car's own convention (atan2(dz, dx)) */
  trafficNear(x: number, z: number, r: number): { x: number; z: number; yaw: number }[]
  /** the nearest traffic car ahead of the player within `r` metres, as a world point, or null */
  targetAhead(from: THREE.Vector3, forward: THREE.Vector3, r: number): THREE.Vector3 | null
  /** fire a missile from the car's bonnet, along the nose or at `dir` */
  fire(dir?: THREE.Vector3): boolean
  /** make the player's car a ghost to traffic and props (the ground still holds it), or solid again */
  ghost?: (on: boolean) => void
}

export interface RigStats {
  on: boolean
  seconds: number
  /** metres driven along the path */
  distance: number
  laps: number
  /** metres along the path now */
  s: number
  speed: number
  fired: number
  /** times the car was put back on the road: off the path, stuck or upside down */
  resets: number
  reversed: boolean
  /** the widest the car has strayed from its lane, metres */
  maxOff: number
  lane: number
  targetSpeed: number
  shield: boolean
}

/** A car's yaw from its forward vector, the convention `startPose` places with. */
function yawOf(dx: number, dz: number): number {
  return Math.atan2(dz, dx)
}

export class TestRig {
  on = false
  shield = true
  private pts: { x: number; z: number }[] = []
  private cum: number[] = [0]
  private total = 0
  private s = 0
  private speed = 0
  private fireEvery = 0
  private lane = 0
  private reversed = false
  private sinceFire = 0
  private stuckFor = 0
  private flippedFor = 0
  private seconds = 0
  private distance = 0
  private laps = 0
  private fired = 0
  private resets = 0
  private maxOff = 0
  private targetSpeed = 0
  private readonly up = new THREE.Vector3(0, 1, 0)
  private readonly tmpUp = new THREE.Vector3()
  private readonly host: RigHost

  constructor(host: RigHost) {
    this.host = host
  }

  /** Start driving. Returns false when there is no site or no car to drive. */
  start(opts: RigOpts = {}): boolean {
    const raw = this.host.path()
    if (!raw || raw.length < 2) return false
    this.host.ensureDriving()
    const car = this.host.car()
    if (!car) return false
    this.speed = opts.speed ?? T.RIG_SPEED_MPS
    this.fireEvery = opts.fireEvery ?? T.RIG_FIRE_EVERY_S
    this.lane = opts.lane ?? T.RIG_LANE_M
    this.shield = opts.shield ?? true
    this.setPath(raw.map(([x, z]) => ({ x, z })))
    // which way does this road go? The spine is stored in the bake's order, and the traffic
    // beside it drives the real direction: count the cars facing along it against those facing
    // back. `reverse` overrides; with no traffic to ask the stored order stands.
    this.reversed = opts.reverse ?? this.trafficRunsBackward(car)
    if (this.reversed) this.setPath([...this.pts].reverse())
    this.seconds = 0
    this.distance = 0
    this.laps = 0
    this.fired = 0
    this.resets = 0
    this.maxOff = 0
    this.sinceFire = 0
    this.stuckFor = 0
    this.flippedFor = 0
    this.s = opts.startS ?? this.nearestS(car.pos.x, car.pos.z, null)
    this.placeAt(car, this.s)
    this.on = true
    if (this.shield) this.host.ghost?.(true)
    return true
  }

  stop(): void {
    this.on = false
    this.host.ghost?.(false)
  }

  stats(): RigStats {
    const car = this.host.car()
    return {
      on: this.on,
      seconds: +this.seconds.toFixed(1),
      distance: Math.round(this.distance),
      laps: this.laps,
      s: Math.round(this.s),
      speed: +(car?.speed ?? 0).toFixed(1),
      fired: this.fired,
      resets: this.resets,
      reversed: this.reversed,
      maxOff: +this.maxOff.toFixed(1),
      lane: this.lane,
      targetSpeed: +this.targetSpeed.toFixed(1),
      shield: this.shield,
    }
  }

  /**
   * Write this frame's pedals and wheel. Called by the frame loop after the keys and pad have
   * been read, so the rig's input is the one the car ticks on.
   */
  drive(car: DrivableCar, input: CarInput, dt: number): void {
    if (!this.on || this.pts.length < 2) return
    this.seconds += dt
    const prevS = this.s
    this.s = this.nearestS(car.pos.x, car.pos.z, this.s)
    const advanced = this.s - prevS
    if (advanced > 0 && advanced < 200) this.distance += advanced
    // the lane point under the car, and how far it has strayed from it
    const here = this.at(this.s)
    const off = Math.hypot(car.pos.x - here.x, car.pos.z - here.z)
    if (off > this.maxOff) this.maxOff = off
    // the end of the road: the Beltway's spine is open, from one Potomac bridge to the other, so a
    // lap is a jump back to the start of it
    if (this.total - this.s < 40) {
      this.laps++
      this.s = 0
      this.placeAt(car, 0)
      return
    }
    // off the road, stuck, or on its roof: back onto the lane a little further along
    const sp = Math.abs(car.speed)
    this.stuckFor = sp < 0.6 && this.seconds > 2 ? this.stuckFor + dt : 0
    this.tmpUp.copy(this.up).applyQuaternion(car.mesh.quaternion)
    this.flippedFor = this.tmpUp.y < 0.3 ? this.flippedFor + dt : 0
    if (off > 30 || this.stuckFor > 3 || this.flippedFor > 2) {
      this.resets++
      this.stuckFor = 0
      this.flippedFor = 0
      this.s = Math.min(this.total - 60, this.s + 6)
      this.placeAt(car, this.s)
      return
    }
    // pure pursuit: aim at a point down the lane, further the faster the car goes — about a
    // second and a half ahead, which at 175 mph is 120 m
    const look = THREE.MathUtils.clamp(sp * 1.6, 10, 140)
    const tgt = this.at(Math.min(this.total, this.s + look))
    const tx = tgt.x - car.pos.x, tz = tgt.z - car.pos.z
    const fx = car.forward.x, fz = car.forward.z
    const fl = Math.hypot(fx, fz) || 1
    const dot = (fx * tx + fz * tz) / fl
    // positive = the target is to the right of the nose (+steer turns right: yaw grows toward +z)
    const crossY = (fx * tz - fz * tx) / fl
    const err = Math.atan2(crossY, dot)
    input.steer = THREE.MathUtils.clamp(err * 1.8, -1, 1)
    // the bend ahead sets the speed: the heading change over the next three seconds of road
    const horizon = Math.max(100, sp * 3)
    const a = this.at(Math.min(this.total, this.s + 20))
    const b = this.at(Math.min(this.total, this.s + horizon))
    const turn = Math.abs(Math.atan2(a.dx * b.dz - a.dz * b.dx, a.dx * b.dx + a.dz * b.dz))
    this.targetSpeed = this.speed * (turn > 0.5 ? 0.45 : turn > 0.25 ? 0.65 : turn > 0.12 ? 0.85 : 1)
    const want = this.targetSpeed
    if (sp < want - 0.5) {
      input.throttle = THREE.MathUtils.clamp((want - sp) / 4 + 0.25, 0, 1)
      input.brake = 0
    } else if (sp > want + 2.5) {
      input.throttle = 0
      input.brake = THREE.MathUtils.clamp((sp - want) / 8, 0.15, 1)
    } else {
      input.throttle = 0.15
      input.brake = 0
    }
    input.handbrake = false
  }

  /** Fire when due: at the nearest car ahead if there is one, else down the nose. */
  tickFire(dt: number): void {
    if (!this.on || this.fireEvery <= 0) return
    this.sinceFire += dt
    if (this.sinceFire < this.fireEvery) return
    this.sinceFire = 0
    const car = this.host.car()
    if (!car) return
    const at = this.host.targetAhead(car.pos, car.forward, 160)
    let dir: THREE.Vector3 | undefined
    if (at) {
      // from the bonnet (where `fireMissile` launches), at the car's middle, so the ball lands on it
      const from = car.pos.clone().addScaledVector(car.forward, 2.6).add(new THREE.Vector3(0, 0.15, 0))
      dir = at.clone().sub(from)
      dir.y += 0.6
      if (dir.lengthSq() < 1) dir = undefined
      else dir.normalize()
    }
    if (this.host.fire(dir)) this.fired++
  }

  // --- the path --------------------------------------------------------------------------------

  private setPath(pts: { x: number; z: number }[]): void {
    this.pts = pts
    this.cum = [0]
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z))
    this.total = this.cum[this.cum.length - 1]
  }

  private at(s: number): { x: number; z: number; dx: number; dz: number } {
    const c = Math.max(0, Math.min(this.total, s))
    let lo = 0, hi = this.cum.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (this.cum[mid] <= c) lo = mid
      else hi = mid
    }
    const a = this.pts[lo], b = this.pts[Math.min(lo + 1, this.pts.length - 1)]
    const seg = Math.max(1e-6, this.cum[lo + 1] - this.cum[lo])
    const t = Math.max(0, Math.min(1, (c - this.cum[lo]) / seg))
    let dx = b.x - a.x, dz = b.z - a.z
    const len = Math.hypot(dx, dz) || 1
    dx /= len
    dz /= len
    // the lane: right of travel is (-dz, dx) with x east, z south, y up
    const x = a.x + (b.x - a.x) * t - dz * this.lane
    const z = a.z + (b.z - a.z) * t + dx * this.lane
    return { x, z, dx, dz }
  }

  /**
   * The arc-length of the nearest point on the path. With a previous answer, only the stretch
   * around it is searched (the car cannot jump a kilometre a frame); without one, the whole path.
   */
  private nearestS(x: number, z: number, near: number | null): number {
    let i0 = 0, i1 = this.pts.length - 2
    if (near !== null) {
      i0 = Math.max(0, this.indexAt(near - 80))
      i1 = Math.min(this.pts.length - 2, this.indexAt(near + 300) + 1)
    }
    let best = near ?? 0, bestD = Infinity
    for (let j = i0; j <= i1; j++) {
      const a = this.pts[j], b = this.pts[j + 1]
      const dx = b.x - a.x, dz = b.z - a.z
      const L2 = dx * dx + dz * dz
      const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2))
      const px = a.x + t * dx, pz = a.z + t * dz
      const d = (px - x) ** 2 + (pz - z) ** 2
      if (d < bestD) { bestD = d; best = this.cum[j] + t * Math.sqrt(L2) }
    }
    return best
  }

  private indexAt(s: number): number {
    const c = Math.max(0, Math.min(this.total, s))
    let lo = 0, hi = this.cum.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (this.cum[mid] <= c) lo = mid
      else hi = mid
    }
    return lo
  }

  private placeAt(car: DrivableCar, s: number): void {
    const p = this.at(s)
    car.place(p.x, p.z, yawOf(p.dx, p.dz))
  }

  /** Do the traffic cars within sight of the player face against the path's stored order? */
  private trafficRunsBackward(car: DrivableCar): boolean {
    let along = 0, against = 0
    for (const c of this.host.trafficNear(car.pos.x, car.pos.z, 400)) {
      const j = this.indexAt(this.nearestS(c.x, c.z, null))
      const a = this.pts[j], b = this.pts[Math.min(j + 1, this.pts.length - 1)]
      const dx = b.x - a.x, dz = b.z - a.z
      // only cars ON this road: within a carriageway of the line
      const len = Math.hypot(dx, dz)
      if (len < 1e-3) continue
      const off = Math.abs((c.x - a.x) * dz - (c.z - a.z) * dx) / len
      if (off > 14) continue
      const d = Math.cos(c.yaw) * dx + Math.sin(c.yaw) * dz
      if (d > 0) along++
      else against++
    }
    return against > along
  }
}
