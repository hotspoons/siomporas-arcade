// The car. Three regimes:
//  - track: on a lane, state is (s, lateral, speed, heading offset, lateral velocity).
//    The path is followed; the player fights centrifugal force with steering and
//    grip; banking helps; loops stick only with enough speed (normal force).
//  - air: ballistic in world space; lands on any lane surface or the ground.
//  - ground: flat grass in world space; rejoin a ground-level lane by driving onto it.
// Hand-rolled, allocation-free, deterministic.

import { clamp, expApproach, smoothstep, wrapAngle } from '@apex/engine/math/scalar'
import { Vec3 } from '@apex/engine/math/Vec3'
import type { CarSpec } from './CarSpec'
import type { InputFrame } from './InputFrame'
import { makeLaneFrame, type LaneFrame, type LaneHit } from './PathTable'
import type { Lane, Track } from './Track'
import {
  AIR_GLITCH_ACCEL,
  AIR_GLITCH_THRESHOLD,
  BANK_HOLD,
  SLIDE_DECAY,
  TUBE_RAMP,
  BUMP_BOUNCE,
  PILLAR_SIDE,
  PILLAR_SPACING,
  CAR_HALF_WIDTH,
  CAR_RIDE,
  CRASH_IMPACT_SPEED,
  CURB_SLOW,
  CURB_WIDTH,
  DRAG_AERO,
  DRAG_ROLLING,
  FALL_LIMIT,
  GRASS_DRAG,
  GRASS_GRIP_SCALE,
  GRASS_STEER,
  GRASS_TRACTION,
  TUBE_RADIUS,
  GRAVITY,
  GRIP_LATERAL,
  HEADING_MAX,
  LAND_MIN_ALIGN,
  LAND_TOLERANCE,
  ROAD_HALF_WIDTH,
  STEER_FULL_SPEED,
  STEER_HIGH_SPEED_FACTOR,
  STEER_RATE,
} from './Tuning'
import type { CarMode } from './Snapshot'

export type CarEvent = 'none' | 'launch' | 'land' | 'crash' | 'offroad' | 'onroad' | 'lost' | 'curb' | 'bump'


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
  /**
   * Speedlock (the Stunts vmax glitch): armed when you take off near vmax with the
   * throttle down, and held — in the air, on the road, on the grass — for as long as
   * you keep the throttle pinned. Let off and it is gone.
   */
  airGlitch = false
  /** Rear-end slide (handbrake / tunnel wall gravity), m/s lateral on top of the heading's own drift. */
  private slide = 0

  private readonly frame = makeLaneFrame()
  private readonly scratch = makeLaneFrame()
  private readonly hit: LaneHit = { s: 0, x: 0, h: 0, over: 0 }
  private readonly vA = new Vec3()
  private readonly vB = new Vec3()
  private readonly nearby: Lane[] = []
  /** Vertical speed the ground under us had last tick (grass over hills). */
  private groundVy = 0
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
  resumeInPlace(keepSpeed = 0): void {
    const keep = Math.abs(this.speed) * keepSpeed
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
      this.speed = keep
      this.heading = 0
      this.lateralVel = 0
      this.slide = 0
      this.vel.set(0, 0, 0)
      this.airGlitch = false
      this.updatePose()
      return
    }
    this.mode = 'ground'
    this.pos.y = this.track.groundHeight(this.pos.x, this.pos.z) + CAR_RIDE
    this.yaw = Math.atan2(-this.forward.z, this.forward.x)
    this.forward.set(Math.cos(this.yaw), 0, Math.sin(this.yaw))
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
    this.slide = 0
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
    // Grass barely slows a straight line, but the tyres can't put much power or braking down.
    const traction = grassDrag > 0 ? GRASS_TRACTION : 1
    let a = input.throttle * spec.accel * Math.max(0.15, 1 - ratio * ratio) * traction
    if (v > 0.5) a -= input.brake * spec.brake * traction
    else if (input.brake > 0) a -= input.brake * spec.accel * 0.6 * traction // reverse
    a -= Math.sign(v) * (DRAG_ROLLING + DRAG_AERO * v * v + grassDrag)
    if (input.handbrake) a -= Math.sign(v) * spec.brake * 0.6 * traction
    a += gTan
    this.speed = v + a * dt
    if (Math.abs(this.speed) < 0.05 && input.throttle === 0 && input.brake === 0) this.speed = 0
    this.speedlock(dt, input)
  }

  /** Speedlock: with the glitch armed and the throttle down, nothing slows you below vmax. */
  private speedlock(dt: number, input: InputFrame): void {
    if (!this.airGlitch) return
    if (input.throttle <= 0.5) {
      this.airGlitch = false
      return
    }
    const top = this.spec.topSpeed
    if (this.speed < top) this.speed = Math.min(top, this.speed + AIR_GLITCH_ACCEL * dt)
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

    // An open-world car on a surface, not a bead on a wire. The car keeps its own heading:
    // as the path bends under it the offset from the tangent grows unless you steer with
    // it, and where it points is where it goes. Steering asks for a yaw rate; the tyres
    // deliver what grip allows (banking gravity helps or hurts), and no more.
    const tube = lane.profile === 'tube'
    const wallA = tube ? this.lateral / TUBE_RADIUS : 0
    const wallW = tube ? this.tubeWall(lane, this.s) : 1
    const grip = GRIP_LATERAL * spec.grip * (this.onGrass ? GRASS_GRIP_SCALE : 1) * (input.handbrake ? 0.55 : 1)
    const authority = spec.agility * (1 - (1 - STEER_HIGH_SPEED_FACTOR) * clamp((Math.abs(v) - STEER_FULL_SPEED) / (spec.topSpeed - STEER_FULL_SPEED), 0, 1))
    // Yaw the wheel asks for; nothing turns at a standstill.
    const yawDemand = input.steer * STEER_RATE * authority * clamp(Math.abs(v) / STEER_FULL_SPEED, 0, 1) * Math.sign(v || 1)
    // Banking / corkscrew gravity across the road: the tyres hold only BANK_HOLD of it; the rest
    // slides the car down the surface, and you steer into the hill to hold your line (Stunts).
    const bankG = tube ? 0 : gRight
    const held = bankG * BANK_HOLD
    const need = v * yawDemand - held
    const tyreF = clamp(need, -grip, grip)
    const yawRate = Math.abs(v) > 0.5 ? (tyreF + held) / v : 0
    if (!tube) this.slide += bankG * (1 - BANK_HOLD) * dt
    this.slip = clamp((Math.abs(need) - grip) / (grip + 1e-6), 0, 1)
    this.heading += (yawRate - f.kRight * v) * dt
    // Handbrake: the rear lets go — you rotate past what grip allows and slide outward.
    if (input.handbrake && Math.abs(v) > 3) {
      this.heading += (yawDemand - yawRate) * 0.7 * dt
      this.slide -= (yawDemand - yawRate) * Math.abs(v) * 0.35 * dt
      this.slip = 1
    }
    // Tunnel wall: gravity along the wall drags you back down toward the floor.
    if (tube) this.slide += -GRAVITY * Math.sin(wallA) * Math.max(0.2, f.up.y) * wallW * dt
    else this.slide = expApproach(this.slide, 0, SLIDE_DECAY, dt)
    if (tube) this.slide = expApproach(this.slide, 0, 1.2, dt)
    this.lateralVel = v * Math.sin(this.heading) + this.slide
    this.lateral += this.lateralVel * dt
    this.s += v * Math.cos(this.heading) * dt

    // Pointing too far off the road: on a ground-level lane you simply leave it (open
    // world, no invisible rails); anywhere else the edge will take care of you.
    if (Math.abs(this.heading) > HEADING_MAX) {
      const groundLevel = !tube && lane.baseY <= 0 && f.pos.y - lane.baseY < 1.5 && f.up.y > 0.7
      if (groundLevel) {
        this.toGround(f)
        return
      }
      this.heading = clamp(this.heading, -HEADING_MAX, HEADING_MAX)
    }

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
        // Half-pipe: ride the wall up to well past horizontal, then scrape the roof. At the
        // mouths the wall is still rising from curb height, so there you just run off the side.
        const maxArc = this.tubeMaxArc(lane, this.s)
        if (Math.abs(this.lateral) > maxArc) {
          if (wallW < 0.5) {
            this.toGround(f)
            return
          }
          this.lateral = Math.sign(this.lateral) * maxArc
          this.slide *= -0.3
          this.heading *= 0.5
          this.speed -= CURB_SLOW * dt * 4
          this.event = 'curb'
        }
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

    // Lane end → next lane (split: choose by side). A jump lip launches you at the far side.
    if (this.s >= lane.table.length) {
      const over = this.s - lane.table.length
      const next = this.chooseNext(lane)
      if (!next || lane.gap) {
        this.launch(f)
        return
      }
      // Leaving a tunnel wall for flat road: drop back onto the tarmac.
      if (lane.profile === 'tube' && next.profile !== 'tube') {
        this.lateral = clamp(this.lateral, -ROAD_HALF_WIDTH * 0.9, ROAD_HALF_WIDTH * 0.9)
        this.lateralVel *= 0.3
      }
      this.lane = next
      this.s = over
      // Lateral offset is relative to each lane's own centreline; splits diverge smoothly.
    } else if (this.s < 0) {
      // Reversing off the start of a lane: back into whichever lane feeds it.
      const prev = this.choosePrev(lane)
      if (!prev) {
        this.s = 0
        this.speed = Math.max(0, this.speed)
        return
      }
      if (lane.profile === 'tube' && prev.profile !== 'tube') {
        this.lateral = clamp(this.lateral, -ROAD_HALF_WIDTH * 0.9, ROAD_HALF_WIDTH * 0.9)
        this.lateralVel *= 0.3
      }
      this.s += prev.table.length
      this.lane = prev
    }
  }

  private choosePrev(lane: Lane): Lane | null {
    if (lane.prev.length === 0) return null
    if (lane.prev.length === 1) return lane.prev[0]
    // A join seen backwards is a split: compare where each feeder sits a little way back.
    let best: Lane | null = null
    let bestScore = -Infinity
    const f0 = lane.table.frameAt(0, this.frame)
    for (const p of lane.prev) {
      p.table.frameAt(Math.max(0, p.table.length - 20), this.scratch)
      this.vA.copy(this.scratch.pos).sub(f0.pos)
      const side = this.vA.dot(f0.right)
      const intent = this.lateral - this.heading * 8
      const score = -Math.abs(side - intent)
      if (score > bestScore) {
        bestScore = score
        best = p
      }
    }
    return best
  }

  /** 0 at a tunnel mouth rising to 1 inside: how much of the wall is there. */
  private tubeWall(lane: Lane, s: number): number {
    const len = lane.table.length
    return smoothstep(0, TUBE_RAMP, s) * smoothstep(0, TUBE_RAMP, len - s)
  }

  /** Arc length up the wall you can occupy here (curb at the mouths, past horizontal inside). */
  private tubeMaxArc(lane: Lane, s: number): number {
    const w = this.tubeWall(lane, s)
    return ROAD_HALF_WIDTH + CURB_WIDTH + (TUBE_RADIUS * 2.2 - ROAD_HALF_WIDTH - CURB_WIDTH) * w
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
    // World velocity: along the heading (which already carries the lateral drift) plus any rear-end slide.
    this.vA.copy(f.tan).rotateAxis(f.up, -this.heading)
    this.vel.copy(this.vA).scale(this.speed).addScaled(f.right, this.slide)
    this.pos.copy(f.pos).addScaled(f.right, this.lateral).addScaled(f.up, CAR_RIDE)
    this.forward.copy(this.vA)
    this.up.copy(f.up)
    this.airGlitch = this.speed >= this.spec.topSpeed * AIR_GLITCH_THRESHOLD
    this.event = 'launch'
  }

  private toGround(f: LaneFrame): void {
    this.mode = 'ground'
    // Keep the slide: world velocity is the heading direction plus the lateral drift,
    // so leaving a curve carries you off it instead of stopping you at the kerb.
    this.vA.copy(f.tan).rotateAxis(f.up, -this.heading).scale(this.speed).addScaled(f.right, this.slide)
    this.vA.y = 0
    const sp = this.vA.length()
    if (sp > 0.5) {
      // Reversing: the velocity points backwards, the nose the other way.
      const dir = this.speed < 0 ? -1 : 1
      this.yaw = Math.atan2(this.vA.z * dir, this.vA.x * dir)
      this.speed = dir * sp
    } else this.yaw = Math.atan2(f.tan.z, f.tan.x)
    this.pos.copy(f.pos).addScaled(f.right, this.lateral)
    this.pos.y = this.track.groundHeight(this.pos.x, this.pos.z) + CAR_RIDE
    this.groundVy = 0
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
    // Ground (the landscape). Speedlocked landings never wreck you (the glitch is a gift).
    const gh = this.track.groundHeight(this.pos.x, this.pos.z)
    if (this.pos.y <= gh + CAR_RIDE && this.vel.y < 0) {
      if (this.up.y < LAND_MIN_ALIGN || (-this.vel.y > CRASH_IMPACT_SPEED && !this.airGlitch)) {
        this.event = 'crash'
        return
      }
      this.pos.y = gh + CAR_RIDE
      this.groundVy = 0
      this.mode = 'ground'
      this.yaw = Math.atan2(this.forward.z, this.forward.x)
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
        if (lane.profile === 'tube') {
          // Inside the tube: catch the car on whatever part of the wall it reaches.
          const r = Math.hypot(h.x, h.h - TUBE_RADIUS)
          if (r < TUBE_RADIUS - CAR_RIDE - 1.5 || r > TUBE_RADIUS + 2) continue
          const a = Math.atan2(h.x, TUBE_RADIUS - h.h)
          if (Math.abs(a) * TUBE_RADIUS > this.tubeMaxArc(lane, h.s)) continue
          this.landOn(lane, h.s, a * TUBE_RADIUS, this.scratch)
          return
        }
        if (Math.abs(h.x) > ROAD_HALF_WIDTH + CURB_WIDTH) continue
        const into = this.vel.dot(this.scratch.up)
        if (h.h > CAR_RIDE + LAND_TOLERANCE || h.h < CAR_RIDE - 2.5 || into > 0) continue
        if (this.up.dot(this.scratch.up) < LAND_MIN_ALIGN || (-into > CRASH_IMPACT_SPEED && !this.airGlitch)) {
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
    this.slide = 0
    // Heading from the car's forward projected into the surface plane.
    this.vA.copy(this.forward).projectOntoPlane(f.up).normalize()
    this.heading = clamp(wrapAngle(Math.atan2(this.vA.dot(f.right), this.vA.dot(f.tan))), -HEADING_MAX, HEADING_MAX)
    this.onGrass = false
    this.event = 'land'
  }

  private tickGround(dt: number, input: InputFrame): void {
    // Landscape slope along the nose: downhill pulls, uphill drags.
    const gAhead = this.track.groundHeight(this.pos.x + this.forward.x * 2, this.pos.z + this.forward.z * 2)
    const gBehind = this.track.groundHeight(this.pos.x - this.forward.x * 2, this.pos.z - this.forward.z * 2)
    const slope = (gAhead - gBehind) / 4
    this.longitudinal(dt, input, -GRAVITY * slope / Math.hypot(1, slope), GRASS_DRAG)
    const v = this.speed
    const authority = 1 - (1 - STEER_HIGH_SPEED_FACTOR) * clamp((Math.abs(v) - STEER_FULL_SPEED) / (this.spec.topSpeed - STEER_FULL_SPEED), 0, 1)
    // forward = (cos yaw, 0, sin yaw); right = forward × up = +z at yaw 0, so steering right increases yaw.
    this.yaw += input.steer * STEER_RATE * GRASS_STEER * authority * dt * Math.sign(v || 1)
    this.forward.set(Math.cos(this.yaw), 0, Math.sin(this.yaw))
    this.up.set(0, 1, 0)
    const px = this.pos.x
    const pz = this.pos.z
    const prevY = this.pos.y
    this.pos.addScaled(this.forward, v * dt)
    const gh = this.track.groundHeight(this.pos.x, this.pos.z)
    // Over a crest the ground falls away faster than gravity can follow: airborne, Stunts style.
    const groundVy = dt > 0 ? (gh + CAR_RIDE - prevY) / dt : 0
    if (this.track.heights && Math.abs(v) > 12 && groundVy < this.groundVy - GRAVITY * dt * 1.5 && this.groundVy > -2) {
      this.mode = 'air'
      this.airTime = 0
      this.vel.copy(this.forward).scale(v)
      this.vel.y = this.groundVy
      this.pos.y = prevY
      this.airGlitch = Math.abs(v) >= this.spec.topSpeed * AIR_GLITCH_THRESHOLD
      this.event = 'launch'
      return
    }
    this.groundVy = groundVy
    this.pos.y = gh + CAR_RIDE
    // Ride the slope: up follows the local ground normal.
    const gx = (this.track.groundHeight(this.pos.x + 1.5, this.pos.z) - this.track.groundHeight(this.pos.x - 1.5, this.pos.z)) / 3
    const gz = (this.track.groundHeight(this.pos.x, this.pos.z + 1.5) - this.track.groundHeight(this.pos.x, this.pos.z - 1.5)) / 3
    this.up.set(-gx, 1, -gz).normalize()
    this.forward.projectOntoPlane(this.up).normalize()
    this.slip = 0
    const lanes = this.track.lanesNear(this.pos, this.nearby)
    // Water: the car is gone.
    if (this.track.isWater(this.pos.x, this.pos.z)) {
      this.event = 'crash'
      return
    }
    // Structures in the way: elevated slabs at bumper height, banked berms, tunnel skins, pillars, scenery.
    if (this.hitsStructure(lanes) || this.hitsScenery()) {
      this.pos.x = px
      this.pos.z = pz
      if (Math.abs(v) > CRASH_IMPACT_SPEED) {
        this.event = 'crash'
        return
      }
      this.speed = -v * BUMP_BOUNCE
      this.event = 'bump'
      return
    }
    // Back onto a ground-level road (or up a berm's low edge)?
    for (const lane of lanes) {
      if (lane.baseY > 0) continue
      lane.table.project(this.pos, this.scratch, this.hit)
      const h = this.hit
      if (!this.scratch.surface || h.over > 0.5 || Math.abs(h.x) > ROAD_HALF_WIDTH || Math.abs(h.h) > 1.2) continue
      if (this.scratch.up.y < 0.75) continue
      // Only rejoin a lane you are roughly driving along, never one you're crossing.
      if (this.forward.dot(this.scratch.tan) * Math.sign(v || 1) < 0.5) continue
      this.vel.copy(this.forward).scale(v)
      this.landOn(lane, h.s, h.x, this.scratch)
      this.event = 'onroad'
      return
    }
  }

  /**
   * Grass-mode collision against track structures near the car. The car is a box from the
   * grass to ~1.2 m; a lane's slab blocks it when the surface passes through that band, a
   * banked or tilted lane is solid below its surface (an embankment), a tunnel's skin blocks
   * from outside, and elevated road stands on pillars.
   */
  private hitsStructure(lanes: Lane[]): boolean {
    for (const lane of lanes) {
      lane.table.project(this.pos, this.scratch, this.hit)
      const h = this.hit
      const f = this.scratch
      if (!f.surface || h.over > 0.5) continue
      const ax = Math.abs(h.x)
      if (lane.profile === 'tube') {
        // Outside the half-pipe skin (the road itself is entered through the mouth, via rejoin).
        if (ax > ROAD_HALF_WIDTH && ax < TUBE_RADIUS + 1 && Math.abs(h.h) < 4 && this.tubeWall(lane, h.s) > 0.3) return true
        continue
      }
      if (ax <= ROAD_HALF_WIDTH + CURB_WIDTH) {
        // Surface above the bumper line: a slab you'd hit, or a berm you'd drive into.
        const tilted = f.up.y < 0.95
        if (h.h < 0.3 && (tilted ? h.h > -6 : h.h > -1.4)) return true
        // A slab far above is a bridge — drive under it, minding the pillars below.
      }
      const clearance = f.pos.y - 0.4
      if (clearance >= 1.5 && f.up.y >= 0.7 && ax < PILLAR_SIDE + 3) {
        const k = Math.round((h.s - PILLAR_SPACING / 2) / PILLAR_SPACING)
        const sP = PILLAR_SPACING / 2 + k * PILLAR_SPACING
        if (sP > 0 && sP < lane.table.length) {
          lane.table.frameAt(sP, f)
          if (f.pos.y - 0.4 >= 1.5 && f.up.y >= 0.7 && f.surface) {
            for (const side of [-PILLAR_SIDE, PILLAR_SIDE]) {
              const dx = this.pos.x - (f.pos.x + f.right.x * side)
              const dz = this.pos.z - (f.pos.z + f.right.z * side)
              if (dx * dx + dz * dz < 1.6 * 1.6) return true
            }
          }
        }
      }
    }
    return false
  }

  /** Scenery solids (trees, buildings, pumps) as boxes grown by the car's half width. */
  private hitsScenery(): boolean {
    const m = CAR_HALF_WIDTH
    for (const s of this.track.solids) {
      if (Math.abs(this.pos.x - s.x) < s.hw + m && Math.abs(this.pos.z - s.z) < s.hh + m) return true
    }
    return false
  }

  private updatePose(): void {
    if (this.mode === 'track' && this.lane) {
      const f = this.lane.table.frameAt(this.s, this.frame)
      if (this.lane.profile === 'tube') {
        // On the tube wall: lateral is arc length; up is the inward normal.
        const a = this.lateral / TUBE_RADIUS
        this.up.copy(f.right).scale(-Math.sin(a)).addScaled(f.up, Math.cos(a))
        this.pos.copy(f.pos).addScaled(f.right, Math.sin(a) * TUBE_RADIUS).addScaled(f.up, TUBE_RADIUS - Math.cos(a) * TUBE_RADIUS).addScaled(this.up, CAR_RIDE)
        this.forward.copy(f.tan).rotateAxis(this.up, -this.heading)
        this.right.cross(this.forward, this.up).normalize()
        return
      }
      this.pos.copy(f.pos).addScaled(f.right, this.lateral).addScaled(f.up, CAR_RIDE)
      this.up.copy(f.up)
      this.forward.copy(f.tan).rotateAxis(f.up, -this.heading)
      this.right.cross(this.forward, this.up).normalize()
    } else if (this.mode === 'ground') {
      this.right.cross(this.forward, this.up).normalize()
    } else {
      this.right.cross(this.forward, this.up).normalize()
    }
  }

  /** Surface height above ground at the car, for pillars/camera. */
  get frameRef(): LaneFrame {
    return this.frame
  }
}
