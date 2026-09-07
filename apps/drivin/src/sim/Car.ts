// The car. Three regimes:
//  - track: on a lane, state is (s, lateral, speed, heading offset, lateral velocity).
//    The path is followed; the player fights centrifugal force with steering and
//    grip; banking helps; loops stick only with enough speed (normal force).
//  - air: ballistic in world space; lands on any lane surface or the ground.
//  - ground: flat grass in world space; rejoin a ground-level lane by driving onto it.
// Hand-rolled, allocation-free, deterministic.

import { clamp, expApproach, wrapAngle } from '@apex/engine/math/scalar'
import { Vec3 } from '@apex/engine/math/Vec3'
import type { CarSpec } from './CarSpec'
import type { InputFrame } from './InputFrame'
import { makeLaneFrame, type LaneFrame, type LaneHit } from './PathTable'
import type { Lane, Track } from './Track'
import {
  AIR_GLITCH_ACCEL,
  AIR_GLITCH_THRESHOLD,
  ALIGN_RATE,
  CAR_RIDE,
  CRASH_IMPACT_SPEED,
  CURB_SLOW,
  CURB_WIDTH,
  DRAG_AERO,
  DRAG_ROLLING,
  FALL_LIMIT,
  GRASS_DRAG,
  GRASS_GRIP_SCALE,
  GRAVITY,
  GRIP_LATERAL,
  HEADING_MAX,
  LAND_MIN_ALIGN,
  LAND_TOLERANCE,
  ROAD_HALF_WIDTH,
  STEER_FULL_SPEED,
  STEER_HIGH_SPEED_FACTOR,
} from './Tuning'
import type { CarMode } from './Snapshot'

export type CarEvent = 'none' | 'launch' | 'land' | 'crash' | 'offroad' | 'onroad' | 'lost' | 'curb'

/** Steering rate at full lock, rad/s of heading change at low speed. */
const STEER_RATE = 2.4
/** Lateral velocity the tyres can correct per second per m/s of mismatch. */
const TYRE_STIFFNESS = 6

export class Car {
  mode: CarMode = 'track'
  lane: Lane | null = null
  s = 0
  lateral = 0
  speed = 0
  /** Heading offset from the path tangent (rad, + = right). */
  heading = 0
  /** Lateral velocity relative to the path, m/s (+ right). */
  lateralVel = 0
  slip = 0
  onGrass = false
  wheelSpin = 0
  steerVisual = 0
  event: CarEvent = 'none'

  // world pose (valid after tick)
  readonly pos = new Vec3()
  readonly forward = new Vec3(1, 0, 0)
  readonly up = new Vec3(0, 1, 0)
  readonly right = new Vec3(0, 0, -1)
  // air / ground state
  readonly vel = new Vec3()
  yaw = 0
  /** Armed when you took off near vmax with the throttle down; see AIR_GLITCH_THRESHOLD. */
  airGlitch = false

  private readonly frame = makeLaneFrame()
  private readonly scratch = makeLaneFrame()
  private readonly hit: LaneHit = { s: 0, x: 0, h: 0, over: 0 }
  private readonly vA = new Vec3()
  private readonly vB = new Vec3()
  private readonly nearby: Lane[] = []
  private readonly spec: CarSpec
  private readonly track: Track
  private airTime = 0

  constructor(track: Track, spec: CarSpec) {
    this.track = track
    this.spec = spec
  }

  /**
   * Put the car back on its wheels where it is: on the lane surface beneath it
   * if there is one, else on the grass. Never teleports.
   */
  resumeInPlace(): void {
    const lanes = this.track.lanesNear(this.pos, this.nearby)
    for (const lane of lanes) {
      lane.table.project(this.pos, this.scratch, this.hit)
      const h = this.hit
      if (!this.scratch.surface || h.over > 0.5 || Math.abs(h.x) > ROAD_HALF_WIDTH + CURB_WIDTH) continue
      if (h.h < -2 || h.h > 3) continue
      this.mode = 'track'
      this.lane = lane
      this.s = h.s
      this.lateral = clamp(h.x, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH)
      this.speed = 0
      this.heading = 0
      this.lateralVel = 0
      this.vel.set(0, 0, 0)
      this.airGlitch = false
      this.updatePose()
      return
    }
    this.mode = 'ground'
    this.pos.y = CAR_RIDE
    this.yaw = Math.atan2(-this.forward.z, this.forward.x)
    this.forward.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    this.up.set(0, 1, 0)
    this.speed = 0
    this.vel.set(0, 0, 0)
    this.onGrass = true
    this.airGlitch = false
    this.updatePose()
  }

  /** Place on a lane, optionally rolling. */
  placeOn(lane: Lane, s: number, speed = 0): void {
    this.mode = 'track'
    this.lane = lane
    this.s = s
    this.lateral = 0
    this.speed = speed
    this.heading = 0
    this.lateralVel = 0
    this.slip = 0
    this.onGrass = false
    this.vel.set(0, 0, 0)
    this.event = 'none'
    this.updatePose()
  }

  tick(dt: number, input: InputFrame): void {
    this.event = 'none'
    switch (this.mode) {
      case 'track':
        this.tickTrack(dt, input)
        break
      case 'air':
        this.tickAir(dt, input)
        break
      case 'ground':
        this.tickGround(dt, input)
        break
    }
    this.wheelSpin += (this.speed / 0.34) * dt
    this.steerVisual = expApproach(this.steerVisual, input.steer * 0.45, 12, dt)
    this.updatePose()
  }

  // ---------------------------------------------------------------------------

  private longitudinal(dt: number, input: InputFrame, gTan: number, grassDrag: number): void {
    const spec = this.spec
    const v = this.speed
    const ratio = clamp(Math.abs(v) / spec.topSpeed, 0, 1)
    let a = input.throttle * spec.accel * Math.max(0.15, 1 - ratio * ratio)
    if (v > 0.5) a -= input.brake * spec.brake
    else if (input.brake > 0) a -= input.brake * spec.accel * 0.6 // reverse
    a -= Math.sign(v) * (DRAG_ROLLING + DRAG_AERO * v * v + grassDrag)
    if (input.handbrake) a -= Math.sign(v) * spec.brake * 0.6
    a += gTan
    this.speed = v + a * dt
    if (Math.abs(this.speed) < 0.05 && input.throttle === 0 && input.brake === 0) this.speed = 0
  }

  private tickTrack(dt: number, input: InputFrame): void {
    const lane = this.lane!
    const f = lane.table.frameAt(this.s, this.frame)
    const spec = this.spec
    // Gravity along the path (loops slow you going up) and along right (banking).
    const gTan = -GRAVITY * f.tan.y
    const gRight = -GRAVITY * f.right.y
    this.longitudinal(dt, input, gTan, this.onGrass ? GRASS_DRAG : 0)
    const v = this.speed

    // Steering: heading offset from the tangent, with authority falling with speed.
    const authority = spec.agility * (1 - (1 - STEER_HIGH_SPEED_FACTOR) * clamp((Math.abs(v) - STEER_FULL_SPEED) / (spec.topSpeed - STEER_FULL_SPEED), 0, 1))
    this.heading += input.steer * STEER_RATE * authority * dt
    const align = input.handbrake ? ALIGN_RATE * 0.3 : ALIGN_RATE
    this.heading = expApproach(this.heading, 0, align * clamp(Math.abs(v) / 8, 0.2, 1), dt)
    this.heading = clamp(this.heading, -HEADING_MAX, HEADING_MAX)

    // Lateral dynamics in the path frame: centrifugal force from the path's own
    // curvature, gravity from banking, and tyres pulling lateral velocity toward
    // what the heading asks for — limited by grip.
    const grip = GRIP_LATERAL * spec.grip * (this.onGrass ? GRASS_GRIP_SCALE : 1) * (input.handbrake ? 0.55 : 1)
    const centrifugal = -v * v * f.kRight
    const wanted = v * Math.sin(this.heading)
    const tyre = clamp((wanted - this.lateralVel) * TYRE_STIFFNESS, -grip, grip)
    this.lateralVel += (centrifugal + gRight + tyre) * dt
    this.slip = clamp(Math.abs(wanted - this.lateralVel) / 6, 0, 1)
    this.lateral += this.lateralVel * dt
    this.s += v * Math.cos(this.heading) * dt

    // Normal force: leave the surface over crests or when too slow in a loop.
    const normal = v * v * f.kUp + GRAVITY * f.up.y
    if (!f.surface || normal < 0) {
      this.launch(f)
      return
    }

    // Edges.
    const edge = ROAD_HALF_WIDTH + CURB_WIDTH
    if (Math.abs(this.lateral) > ROAD_HALF_WIDTH) {
      if (lane.profile === 'tube') {
        // Tunnel walls: bounce back in.
        this.lateral = Math.sign(this.lateral) * ROAD_HALF_WIDTH
        this.lateralVel *= -0.35
        this.speed -= CURB_SLOW * dt * 4
        this.event = 'curb'
      } else if (Math.abs(this.lateral) > edge) {
        const elevated = f.pos.y - lane.baseY > 1.5 || lane.baseY > 0 || f.up.y < 0.7
        if (elevated) {
          this.launch(f)
          return
        }
        // Ground-level road: onto the grass in world space.
        this.toGround(f)
        return
      } else {
        // On the curb: rumble.
        this.speed -= Math.sign(this.speed) * CURB_SLOW * dt
        if ((Math.floor(this.s) & 1) === 0) this.event = 'curb'
      }
    }

    // Lane end → next lane (split: choose by side).
    if (this.s >= lane.table.length) {
      const over = this.s - lane.table.length
      const next = this.chooseNext(lane)
      if (!next) {
        this.launch(f)
        return
      }
      this.lane = next
      this.s = over
      // Lateral offset is relative to each lane's own centreline; splits diverge smoothly.
    } else if (this.s < 0) {
      this.s = 0
      this.speed = Math.max(0, this.speed)
    }
  }

  private chooseNext(lane: Lane): Lane | null {
    if (lane.next.length === 0) return null
    if (lane.next.length === 1) return lane.next[0]
    // Compare each option's lateral position a little way in.
    let best: Lane | null = null
    let bestScore = -Infinity
    const f0 = lane.table.frameAt(lane.table.length, this.frame)
    for (const n of lane.next) {
      n.table.frameAt(Math.min(20, n.table.length), this.scratch)
      this.vA.copy(this.scratch.pos).sub(f0.pos)
      const side = this.vA.dot(f0.right)
      // Score: same sign as the car's lateral position / heading intent.
      const intent = this.lateral + this.heading * 8
      const score = -Math.abs(side - intent)
      if (score > bestScore) {
        bestScore = score
        best = n
      }
    }
    return best
  }

  private launch(f: LaneFrame): void {
    this.mode = 'air'
    this.airTime = 0
    // World velocity: along tangent (rotated by heading) plus lateral.
    this.vA.copy(f.tan).rotateAxis(f.up, this.heading)
    this.vel.copy(this.vA).scale(this.speed).addScaled(f.right, this.lateralVel)
    this.pos.copy(f.pos).addScaled(f.right, this.lateral).addScaled(f.up, CAR_RIDE)
    this.forward.copy(this.vA)
    this.up.copy(f.up)
    this.airGlitch = this.speed >= this.spec.topSpeed * AIR_GLITCH_THRESHOLD
    this.event = 'launch'
  }

  private toGround(f: LaneFrame): void {
    this.mode = 'ground'
    this.vA.copy(f.tan).rotateAxis(f.up, this.heading)
    this.yaw = Math.atan2(-this.vA.z, this.vA.x)
    this.pos.copy(f.pos).addScaled(f.right, this.lateral)
    this.pos.y = CAR_RIDE
    this.onGrass = true
    this.event = 'offroad'
  }

  private tickAir(dt: number, input: InputFrame): void {
    this.airTime += dt
    this.vel.y -= GRAVITY * dt
    this.pos.addScaled(this.vel, dt)
    // No air control: the car noses along its arc and its roll settles toward
    // level, like a thrown brick with good manners. Landings are about speed
    // and angle, never about button timing.
    // The glitch: throttle held after a near-vmax take-off pins you back to vmax.
    if (this.airGlitch && input.throttle > 0.5) {
      const hx = this.vel.x
      const hz = this.vel.z
      const h = Math.hypot(hx, hz)
      if (h > 1) {
        const target = this.spec.topSpeed
        const nh = h < target ? Math.min(target, h + AIR_GLITCH_ACCEL * dt) : h
        this.vel.x = (hx / h) * nh
        this.vel.z = (hz / h) * nh
      }
    } else if (input.throttle <= 0.5) {
      this.airGlitch = false
    }
    if (this.speed > 1) {
      this.vA.copy(this.vel).normalize()
      this.forward.lerpVectors(this.forward, this.vA, Math.min(1, dt * 2.5)).normalize()
    }
    this.vB.set(0, 1, 0)
    this.up.lerpVectors(this.up, this.vB, Math.min(1, dt * 1.2))
    this.up.projectOntoPlane(this.forward).normalize()
    this.speed = this.vel.length()

    if (this.pos.y < FALL_LIMIT) {
      this.event = 'crash'
      return
    }
    // Ground plane.
    if (this.pos.y <= CAR_RIDE && this.vel.y < 0) {
      if (this.up.y < LAND_MIN_ALIGN || -this.vel.y > CRASH_IMPACT_SPEED) {
        this.event = 'crash'
        return
      }
      this.pos.y = CAR_RIDE
      this.mode = 'ground'
      this.yaw = Math.atan2(-this.forward.z, this.forward.x)
      this.speed = Math.hypot(this.vel.x, this.vel.z)
      this.onGrass = true
      this.event = 'land'
      return
    }
    // Lane surfaces nearby.
    if (this.airTime > 0.08) {
      const lanes = this.track.lanesNear(this.pos, this.nearby)
      for (const lane of lanes) {
        lane.table.project(this.pos, this.scratch, this.hit)
        const h = this.hit
        if (!this.scratch.surface || h.over > 0.5) continue
        if (Math.abs(h.x) > ROAD_HALF_WIDTH + CURB_WIDTH) continue
        const into = this.vel.dot(this.scratch.up)
        if (h.h > CAR_RIDE + LAND_TOLERANCE || h.h < CAR_RIDE - 2.5 || into > 0) continue
        if (this.up.dot(this.scratch.up) < LAND_MIN_ALIGN || -into > CRASH_IMPACT_SPEED) {
          this.event = 'crash'
          return
        }
        this.landOn(lane, h.s, h.x, this.scratch)
        return
      }
    }
  }

  private landOn(lane: Lane, s: number, x: number, f: LaneFrame): void {
    this.mode = 'track'
    this.lane = lane
    this.s = clamp(s, 0, lane.table.length)
    this.lateral = x
    this.speed = this.vel.dot(f.tan)
    this.lateralVel = this.vel.dot(f.right)
    // Heading from the car's forward projected into the surface plane.
    this.vA.copy(this.forward).projectOntoPlane(f.up).normalize()
    this.heading = clamp(wrapAngle(Math.atan2(this.vA.dot(f.right), this.vA.dot(f.tan))), -HEADING_MAX, HEADING_MAX)
    this.onGrass = false
    this.event = 'land'
  }

  private tickGround(dt: number, input: InputFrame): void {
    this.longitudinal(dt, input, 0, GRASS_DRAG)
    const v = this.speed
    const authority = 1 - (1 - STEER_HIGH_SPEED_FACTOR) * clamp((Math.abs(v) - STEER_FULL_SPEED) / (this.spec.topSpeed - STEER_FULL_SPEED), 0, 1)
    // forward = (cos yaw, 0, -sin yaw); right is -z, so steering right increases yaw.
    this.yaw += input.steer * STEER_RATE * authority * dt * Math.sign(v || 1)
    this.forward.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    this.pos.addScaled(this.forward, v * dt)
    this.pos.y = CAR_RIDE
    this.up.set(0, 1, 0)
    this.slip = 0
    // Back onto a ground-level road?
    const lanes = this.track.lanesNear(this.pos, this.nearby)
    for (const lane of lanes) {
      if (lane.baseY > 0) continue
      lane.table.project(this.pos, this.scratch, this.hit)
      const h = this.hit
      if (!this.scratch.surface || h.over > 0.5 || Math.abs(h.x) > ROAD_HALF_WIDTH || Math.abs(h.h) > 1.2) continue
      if (this.scratch.up.y < 0.9) continue
      // Only rejoin a lane you are roughly driving along, never one you're crossing.
      if (this.forward.dot(this.scratch.tan) * Math.sign(v || 1) < 0.5) continue
      this.vel.copy(this.forward).scale(v)
      this.landOn(lane, h.s, h.x, this.scratch)
      this.event = 'onroad'
      return
    }
  }

  private updatePose(): void {
    if (this.mode === 'track' && this.lane) {
      const f = this.lane.table.frameAt(this.s, this.frame)
      this.pos.copy(f.pos).addScaled(f.right, this.lateral).addScaled(f.up, CAR_RIDE)
      this.up.copy(f.up)
      this.forward.copy(f.tan).rotateAxis(f.up, this.heading)
      this.right.cross(this.up, this.forward).normalize()
    } else if (this.mode === 'ground') {
      this.right.cross(this.up, this.forward).normalize()
    } else {
      this.right.cross(this.up, this.forward).normalize()
    }
  }

  /** Surface height above ground at the car, for pillars/camera. */
  get frameRef(): LaneFrame {
    return this.frame
  }
}
