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
import { arcFromOut, edgeOf, makeAcross, outEdgeOf, sectionAt, sectionAtOut, type Bank } from './bank'
import { makeLaneFrame, type LaneFrame, type LaneHit } from './PathTable'
import type { Lane, Track } from './Track'
import {
  AIR_GLITCH_ACCEL,
  AIR_GLITCH_THRESHOLD,
  BANK_HOLD,
  ROCKET_CHANCE,
  ROCKET_MIN_SPEED,
  ROCKET_SLOPE,
  ROCKET_SPEED,
  SLIDE_DECAY,
  TUBE_RAMP,
  BUMP_BOUNCE,
  PILLAR_SIDE,
  PILLAR_SPACING,
  CAR_HALF_WIDTH,
  CAR_RIDE,
  CLIMB_SLOPE,
  CLIMB_STEP,
  CRASH_IMPACT_SPEED,
  DECK_CLEARANCE,
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
  BANK_GRIP,
  LOAD_MAX,
  LAND_TOLERANCE,
  PATH_STEP,
  ROAD_HALF_WIDTH,
  STEER_FULL_SPEED,
  STEER_HIGH_SPEED_FACTOR,
  STEER_RATE,
} from './Tuning'
import type { CarMode } from './Snapshot'


export type CarEvent = 'none' | 'launch' | 'land' | 'crash' | 'offroad' | 'onroad' | 'lost' | 'curb' | 'bump' | 'rocket'


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
  /** What the last crash was: shown on the HUD so nothing is ever an invisible wall. */
  crashCause = ''

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
  /** The rocket jump is armed (experiments) and, while airborne, whether this flight is one. */
  rocketsEnabled = true
  rocket = false
  /** Ticks, for the deterministic dice the rocket jump rolls at a seam. */
  private ticks = 0

  private readonly frame = makeLaneFrame()
  private readonly scratch = makeLaneFrame()
  private readonly hit: LaneHit = { s: 0, x: 0, h: 0, over: 0 }
  private readonly vA = new Vec3()
  private readonly vB = new Vec3()
  /** A second set, for sampling the surface under a wheel without disturbing a projection in progress. */
  private readonly probeFrame = makeLaneFrame()
  private readonly probeHit: LaneHit = { s: 0, x: 0, h: 0, over: 0 }
  private readonly probePos = new Vec3()
  /** Where across the surface the car is, once the speedbowl wall past the road's edge is accounted for. */
  private readonly section = makeAcross()
  private readonly probeSection = makeAcross()
  private readonly edgeSection = makeAcross()
  /** The landscape height under the car last tick: what the airborne test watches, decks aside. */
  private terrainY = 0
  /**
   * What each side's wheels were standing on last tick. A wheel rides up onto something from where
   * *it* is, not from where the middle of the car is: on a bank steep enough to matter the outside
   * wheels are the better part of a metre above the body, and measuring their step from the body's
   * height is what makes a car climbing a bank suddenly decide the bank is too tall to climb.
   */
  private wheelL = 0
  private wheelR = 0
  /** Whether what the wheels were on last tick was a road deck rather than the landscape. */
  private onDeck = false
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
  resumeInPlace(keepSpeed = 0, advance = 0): void {
    const keep = Math.abs(this.speed) * keepSpeed
    const lanes = this.track.lanesNear(this.pos, this.nearby)
    for (let lane of lanes) {
      lane.table.project(this.pos, this.scratch, this.hit)
      const h = this.hit
      if (!this.scratch.surface || h.over > 0.5 || Math.abs(h.x) > ROAD_HALF_WIDTH + CURB_WIDTH) continue
      if (h.h < -2 || h.h > 3) continue
      // Repeated crashes on the same spot: resume a little further along the road each time.
      let s = h.s + advance
      for (let guard = 0; s > lane.table.length && lane.next[0] && guard < 8; guard++) {
        s -= lane.table.length
        lane = lane.next[0]
      }
      this.mode = 'track'
      this.lane = lane
      this.s = Math.min(s, lane.table.length)
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
    this.yaw = Math.atan2(this.forward.z, this.forward.x)
    this.forward.set(Math.cos(this.yaw), 0, Math.sin(this.yaw))
    if (advance) this.pos.addScaled(this.forward, advance)
    this.pos.y = this.track.groundHeight(this.pos.x, this.pos.z) + CAR_RIDE
    this.up.set(0, 1, 0)
    this.speed = 0
    this.vel.set(0, 0, 0)
    this.onGrass = true
    this.airGlitch = false
    this.updatePose()
  }

  /**
   * Manual recover: right the car and back it out of whatever it is in.
   *
   * Righting the car where it stands is no use for the thing people press this for — wedged under a
   * building, or nose-first into a wall — so every press also steps back the way you came, and keeps
   * stepping while the spot it lands on is still inside something solid.
   */
  recover(back: number): void {
    this.resumeInPlace()
    this.stepBack(back)
    // On the road there is nothing to be inside; off it, walk out of the scenery.
    for (let i = 0; i < 6 && this.mode === 'ground' && this.wedged(); i++) this.stepBack(back * 0.6)
  }

  /** Move back along the way the car is pointing (or back down the lane it is on). */
  private stepBack(d: number): void {
    if (this.mode === 'track' && this.lane) {
      this.s = Math.max(0, this.s - d)
      this.updatePose()
      return
    }
    this.pos.addScaled(this.forward, -d)
    this.pos.y = this.track.groundHeight(this.pos.x, this.pos.z) + CAR_RIDE
    this.updatePose()
  }

  /** Is this spot inside a solid? Only meaningful off the road, where the scenery is. */
  private wedged(): boolean {
    return Boolean(this.hitsScenery() || this.hitsStructure(this.track.lanesNear(this.pos, this.nearby)))
  }

  /** Stand on the grass at a world point, facing +x. */
  placeOnGrass(x: number, z: number): void {
    this.mode = 'ground'
    this.lane = null
    this.pos.set(x, this.track.groundHeight(x, z) + CAR_RIDE, z)
    this.yaw = 0
    this.forward.set(1, 0, 0)
    this.up.set(0, 1, 0)
    this.speed = 0
    this.vel.set(0, 0, 0)
    this.onGrass = true
    this.event = 'none'
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
    this.ticks++
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
    if (!this.lane) {
      this.placeOnGrass(this.pos.x, this.pos.z)
      return
    }
    const lane = this.lane
    const f = lane.table.frameAt(this.s, this.frame)
    const spec = this.spec
    // Gravity along the path (loops slow you going up) and along right (banking).
    const gTan = -GRAVITY * f.tan.y
    // The surface under the car, which on a speedbowl is not the deck's own plane: past the road's
    // edge the wall keeps curving, so the way gravity falls across it — and how hard the corner
    // presses the car into it — depend on how far up the wall the car is sitting.
    const sec = sectionAt(lane.bank, f.right.y, this.lateral, this.section)
    const wallCos = Math.cos(sec.a)
    const wallSin = Math.sin(sec.a)
    const surfRightY = f.right.y * wallCos + f.up.y * wallSin
    const surfUpY = f.up.y * wallCos - f.right.y * wallSin
    const gRight = -GRAVITY * surfRightY
    this.longitudinal(dt, input, gTan, this.onGrass ? GRASS_DRAG : 0)
    const v = this.speed

    // An open-world car on a surface, not a bead on a wire. The car keeps its own heading:
    // as the path bends under it the offset from the tangent grows unless you steer with
    // it, and where it points is where it goes. Steering asks for a yaw rate; the tyres
    // deliver what grip allows (banking gravity helps or hurts), and no more.
    const tube = lane.profile === 'tube'
    const wallA = tube ? this.lateral / TUBE_RADIUS : 0
    const wallW = tube ? this.tubeWall(lane, this.s) : 1
    // What the surface under the car is worth. A flat road gives the tyres one car's weight and that
    // is the whole budget, which is why a corner used to run out at the same speed however steeply it
    // was banked — the banking only ever added the little that BANK_HOLD carried. Steepness now pays:
    // the corner presses the car into the surface and the tyres hold more for it, so the way to carry
    // more speed through a bowl is to climb it. Capped, because tyres do not scale for ever.
    // The floor only keeps the division finite at dead vertical; put it any higher and it quietly
    // caps the steepest part of a wall, which is the part that is supposed to pay.
    const upright = Math.max(0.08, Math.abs(surfUpY))
    const load = clamp(Math.abs(surfUpY) + (BANK_GRIP * Math.abs(surfRightY)) / upright, 0.2, LOAD_MAX)
    const grip = GRIP_LATERAL * spec.grip * (tube ? 1 : load) * (this.onGrass ? GRASS_GRIP_SCALE : 1) * (input.handbrake ? 0.55 : 1)
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
    // Tunnel wall: gravity along the wall drags you back down toward the floor — least at the bottom
    // and at the very top (where it pulls you off the ceiling instead; see the stick check below).
    if (tube) this.slide += -GRAVITY * Math.sin(wallA) * Math.max(0.2, f.up.y) * wallW * dt
    else this.slide = expApproach(this.slide, 0, SLIDE_DECAY, dt)
    if (tube) this.slide = expApproach(this.slide, 0, 1.2, dt)
    this.lateralVel = v * Math.sin(this.heading) + this.slide
    this.lateral += this.lateralVel * dt
    this.s += v * Math.cos(this.heading) * dt
    // Inside the tube `lateral` is arc length; wrap it so a full lap of the wall is one continuous ride.
    if (tube) {
      const circ = 2 * Math.PI * TUBE_RADIUS
      this.lateral = ((((this.lateral + circ / 2) % circ) + circ) % circ) - circ / 2
    }

    // Pointing too far off the road: on a ground-level lane you simply leave it (open
    // world, no invisible rails); anywhere else the edge will take care of you.
    if (Math.abs(this.heading) > HEADING_MAX) {
      // On a hillside the road is high above sea level but still on the ground: measure against the land.
      const groundLevel = !tube && f.pos.y - this.track.groundHeight(f.pos.x, f.pos.z) < 1.5 && f.up.y > 0.5
      if (groundLevel) {
        this.toGround(f)
        return
      }
      this.heading = clamp(this.heading, -HEADING_MAX, HEADING_MAX)
    }

    // Normal force: leave the surface over crests or when too slow in a loop.
    const normal = v * v * f.kUp + GRAVITY * surfUpY
    if (!f.surface || normal < 0) {
      this.launch(f)
      return
    }

    // On the upper half of a tube the wall is above you: you hang there only while you are travelling
    // round it fast enough (lateralVel² / R against the part of gravity pulling you off). Otherwise you
    // drop off the wall and fall back to the floor — no invisible ceiling, no bounce.
    if (tube && wallW > 0.5) {
      const a = this.lateral / TUBE_RADIUS
      const pull = -Math.cos(a) * GRAVITY * Math.max(0.2, f.up.y) // > 0 past horizontal
      if (pull > 0 && (this.lateralVel * this.lateralVel) / TUBE_RADIUS < pull) {
        this.launchFromWall()
        return
      }
    }

    // Edges. On a banked piece the far side of the road is the top of its wall, which is road all
    // the way up: the curb and the grass are only where the deck actually stops.
    const deckEdge = edgeOf(lane.bank, f.right.y, this.lateral)
    const edge = deckEdge + CURB_WIDTH
    if (Math.abs(this.lateral) > deckEdge) {
      if (lane.profile === 'tube') {
        // At a mouth the wall is still rising from curb height, so running past it puts you on the
        // grass; inside the bore there is no edge at all — the arc wrapped above.
        const maxArc = this.tubeMaxArc(lane, this.s)
        if (wallW < 0.5 && Math.abs(this.lateral) > maxArc) {
          this.toGround(f)
          return
        }
      } else if (Math.abs(this.lateral) > edge) {
        const elevated = f.pos.y - this.track.groundHeight(f.pos.x, f.pos.z) > 1.5 || f.up.y < 0.7
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
      // A crest can fall on the seam between two pieces, where neither lane carries the curvature. Compare
      // the slopes across the joint: if the road drops away faster than gravity can hold you, you fly.
      const drop = (f.tan.y - next.table.frameAt(0, this.scratch).tan.y) / PATH_STEP
      if (drop > 0 && v * v * drop > GRAVITY * f.up.y) {
        this.lane = next
        this.s = over
        this.launch(next.table.frameAt(over, this.frame))
        return
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
    return (lane.mouthIn === false ? 1 : smoothstep(0, TUBE_RAMP, s)) * (lane.mouthOut === false ? 1 : smoothstep(0, TUBE_RAMP, len - s))
  }

  /** Arc length up the wall you can occupy here: the whole bore inside, only the curb at a mouth. */
  private tubeMaxArc(lane: Lane, s: number): number {
    const w = this.tubeWall(lane, s)
    const full = Math.PI * TUBE_RADIUS
    return ROAD_HALF_WIDTH + CURB_WIDTH + (full - ROAD_HALF_WIDTH - CURB_WIDTH) * w
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
    // Stunts' jump bug: leave a ramp, a lip or a crest at the top of the rev range and gravity
    // occasionally goes insane instead, throwing the car straight up.
    const fast = this.airGlitch || Math.abs(this.speed) >= this.spec.topSpeed * ROCKET_MIN_SPEED
    // Sloped, crested, or the lip of a jump (where the surface has run out) — the places the original
    // tripped over. A flat kerb or an embankment edge is not enough.
    const sloped = !f.surface || Math.abs(f.kUp) > 0.0008 || 1 - f.up.y > ROCKET_SLOPE
    if (this.rocketsEnabled && fast && sloped && this.dice() < ROCKET_CHANCE) {
      this.vel.y = ROCKET_SPEED
      this.rocket = true
      this.airGlitch = true
      this.event = 'rocket'
    }
  }

  /** Fall off a tunnel wall: keep the pose we are already in and turn the wall motion into world velocity. */
  /** A deterministic 0..1 per tick: the same run always rockets in the same places. */
  private dice(): number {
    let h = (this.ticks * 2654435761) ^ 0x9e3779b9
    h = Math.imul(h ^ (h >>> 15), 2246822519)
    h = Math.imul(h ^ (h >>> 13), 3266489917)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }

  private launchFromWall(): void {
    this.mode = 'air'
    this.airTime = 0
    this.updatePose()
    this.vel.copy(this.forward).scale(this.speed).addScaled(this.right, this.lateralVel)
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
      this.crashCause = 'fell off the world'
      this.event = 'crash'
      return
    }
    // Ground (the landscape). Speedlocked landings never wreck you (the glitch is a gift).
    const gh = this.track.groundHeight(this.pos.x, this.pos.z)
    if (this.pos.y <= gh + CAR_RIDE && this.vel.y < 0) {
      if ((this.up.y < LAND_MIN_ALIGN && !this.rocket) || (-this.vel.y > CRASH_IMPACT_SPEED && !this.airGlitch && !this.rocket)) {
        this.crashCause = this.up.y < LAND_MIN_ALIGN ? 'landed upside down' : `landed too hard · ${(-this.vel.y).toFixed(0)} m/s`
        this.event = 'crash'
        return
      }
      this.pos.y = gh + CAR_RIDE
      this.groundVy = 0
      this.mode = 'ground'
      this.rocket = false
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
          // Inside the tube: catch the car on whatever part of the wall it reaches, ceiling included.
          const r = Math.hypot(h.x, h.h - TUBE_RADIUS)
          if (r < TUBE_RADIUS - CAR_RIDE - 1.5 || r > TUBE_RADIUS + 2) continue
          const a = Math.atan2(h.x, TUBE_RADIUS - h.h)
          if (Math.abs(a) * TUBE_RADIUS > this.tubeMaxArc(lane, h.s)) continue
          this.landOn(lane, h.s, a * TUBE_RADIUS, this.scratch, a)
          return
        }
        if (Math.abs(h.x) > ROAD_HALF_WIDTH + CURB_WIDTH) continue
        const into = this.vel.dot(this.scratch.up)
        if (h.h > CAR_RIDE + LAND_TOLERANCE || h.h < CAR_RIDE - 2.5 || into > 0) continue
        if ((this.up.dot(this.scratch.up) < LAND_MIN_ALIGN && !this.rocket) || (-into > CRASH_IMPACT_SPEED && !this.airGlitch && !this.rocket)) {
          this.crashCause = this.up.dot(this.scratch.up) < LAND_MIN_ALIGN ? 'landed upside down on the road' : `landed too hard on the road · ${(-into).toFixed(0)} m/s`
          this.event = 'crash'
          return
        }
        // Aligned with the lane: land on it and drive it. Crossing it: settle onto the surface and
        // keep going the way you were going. Snapping a car that is crossing a road into the road's
        // own direction — which is what landing does, heading clamped and all — is the thing that
        // makes a seam throw you sideways.
        if (Math.abs(this.forward.dot(this.scratch.tan)) < 0.5) {
          this.pos.y = this.scratch.pos.y + h.x * this.scratch.right.y + CAR_RIDE
          this.mode = 'ground'
          this.rocket = false
          this.terrainY = this.pos.y - CAR_RIDE
          this.yaw = Math.atan2(this.forward.z, this.forward.x)
          this.speed = Math.hypot(this.vel.x, this.vel.z)
          this.onGrass = true
          this.event = 'land'
          return
        }
        this.landOn(lane, h.s, h.x, this.scratch)
        return
      }
    }
  }

  private landOn(lane: Lane, s: number, x: number, f: LaneFrame, wallA?: number): void {
    this.rocket = false
    this.mode = 'track'
    this.lane = lane
    this.s = clamp(s, 0, lane.table.length)
    this.lateral = arcFromOut(lane.bank, f.right.y, x, this.probeSection)
    this.speed = this.vel.dot(f.tan)
    // On a tube wall the sideways direction is the wall's tangent, not the floor's right.
    if (wallA !== undefined) {
      this.vB.copy(f.right).scale(Math.cos(wallA)).addScaled(f.up, Math.sin(wallA))
      this.lateralVel = this.vel.dot(this.vB)
      this.slide = this.lateralVel
    } else {
      this.lateralVel = this.vel.dot(f.right)
      this.slide = 0
    }
    // Heading from the car's forward projected into the surface plane.
    this.vA.copy(this.forward).projectOntoPlane(wallA !== undefined ? this.up : f.up).normalize()
    this.heading = clamp(wrapAngle(Math.atan2(this.vA.dot(wallA !== undefined ? this.vB : f.right), this.vA.dot(f.tan))), -HEADING_MAX, HEADING_MAX)
    this.onGrass = false
    this.event = 'land'
  }

  /**
   * The top of whatever a wheel is standing on at a point: the landscape, or a road deck built over
   * it when the deck is close enough above to ride up onto. `refY` is the surface the car is on now,
   * which is what makes a kerb a kerb and a wall a wall — a step the car could climb becomes the
   * surface, a step it could not is left to the structure test.
   */
  private tookDeck = false

  private topAt(x: number, z: number, refY: number, lanes: Lane[]): number {
    let y = this.track.groundHeight(x, z)
    this.probePos.set(x, refY, z)
    for (const lane of lanes) {
      if (lane.profile === 'tube') continue
      lane.table.project(this.probePos, this.probeFrame, this.probeHit)
      const f = this.probeFrame
      const h = this.probeHit
      if (!f.surface || h.over > 0.5 || Math.abs(h.x) > outEdgeOf(lane.bank, f.right.y, h.x) + CURB_WIDTH) continue
      const sec = sectionAtOut(lane.bank, f.right.y, h.x, this.probeSection)
      const deck = f.pos.y + h.x * f.right.y + sec.lift * f.up.y
      if (deck > y && deck - refY <= CLIMB_STEP) {
        y = deck
        this.tookDeck = true
      }
    }
    return y
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
    // What the wheels are on, sampled under each of them rather than at a single point under the
    // middle of the car. At the edge of an embankment that is the whole difference: the outside
    // wheels are up on the deck and the inside ones are still on the grass, so the car leans across
    // the seam and rides up it, instead of the world switching from one surface to the other
    // underneath it.
    const lanes = this.track.lanesNear(this.pos, this.nearby)
    const ref = prevY - CAR_RIDE
    const rx = -this.forward.z
    const rz = this.forward.x
    // Held within a car's half-width of the body, so a stale value cannot survive a fall or a
    // landing and pull the car back up onto something it has left.
    const spread = CAR_HALF_WIDTH * 1.2
    const refL = clamp(this.wheelL, ref - spread, ref + spread)
    const refR = clamp(this.wheelR, ref - spread, ref + spread)
    this.tookDeck = false
    const yL = this.topAt(this.pos.x - rx * CAR_HALF_WIDTH, this.pos.z - rz * CAR_HALF_WIDTH, refL, lanes)
    const yR = this.topAt(this.pos.x + rx * CAR_HALF_WIDTH, this.pos.z + rz * CAR_HALF_WIDTH, refR, lanes)
    this.wheelL = yL
    this.wheelR = yR
    const yF = this.topAt(this.pos.x + this.forward.x * 1.5, this.pos.z + this.forward.z * 1.5, ref, lanes)
    const yB = this.topAt(this.pos.x - this.forward.x * 1.5, this.pos.z - this.forward.z * 1.5, ref, lanes)
    // The body rides on the two of them, rising no faster than the ground it is covering — a kerb is
    // ridden up, not teleported onto, and standing still you climb nothing. The *difference* between
    // the two is left alone, because that difference is the lean: cap each wheel instead and a car
    // straddling a seam sits dead level.
    const gh = Math.min((yL + yR) / 2, ref + Math.abs(v) * dt * CLIMB_SLOPE + 0.05)
    // Over a crest the ground falls away faster than gravity can follow: airborne, Stunts style. It
    // watches the landscape and not what the wheels are on, or the lip of every kerb would throw the
    // car into the air.
    // Off the side of a deck the surface does not slope away, it stops: the car should fall off it
    // rather than be set down on the landscape a metre and a half below, which is how it ended up
    // parked inside the bank it had just been driving on.
    if (this.onDeck && prevY - CAR_RIDE - gh > 0.3) {
      this.mode = 'air'
      this.airTime = 0
      this.vel.copy(this.forward).scale(v)
      this.vel.y = 0
      this.pos.y = prevY
      this.onDeck = false
      this.airGlitch = false
      this.event = 'launch'
      return
    }
    this.onDeck = this.tookDeck
    const terrain = this.track.groundHeight(this.pos.x, this.pos.z)
    const groundVy = dt > 0 ? (terrain - this.terrainY) / dt : 0
    this.terrainY = terrain
    if (this.track.heights && Math.abs(v) > 12 && groundVy < this.groundVy - GRAVITY * dt * 1.5 && this.groundVy > -2) {
      this.mode = 'air'
      this.airTime = 0
      this.vel.copy(this.forward).scale(v)
      this.vel.y = this.groundVy
      this.pos.y = prevY
      this.terrainY = prevY - CAR_RIDE
      this.airGlitch = Math.abs(v) >= this.spec.topSpeed * AIR_GLITCH_THRESHOLD
      this.event = 'launch'
      return
    }
    this.groundVy = groundVy
    this.pos.y = gh + CAR_RIDE
    // Lie on the plane through those four contacts: leaning away from the side that is higher and
    // pitched by what is under the nose and the tail.
    const roll = (yR - yL) / (2 * CAR_HALF_WIDTH)
    const pitch = (yF - yB) / 3
    this.up.set(-(rx * roll + this.forward.x * pitch), 1, -(rz * roll + this.forward.z * pitch)).normalize()
    this.forward.projectOntoPlane(this.up).normalize()
    this.slip = 0
    // Water: the car is gone.
    if (this.track.isWater(this.pos.x, this.pos.z)) {
      this.crashCause = 'into the water'
      this.event = 'crash'
      return
    }
    // Structures in the way: elevated slabs at bumper height, banked berms, tunnel skins, pillars, scenery.
    const hit = this.hitsStructure(lanes) || this.hitsScenery()
    if (hit) {
      this.pos.x = px
      this.pos.z = pz
      if (Math.abs(v) > CRASH_IMPACT_SPEED) {
        this.crashCause = `hit ${hit}`
        this.event = 'crash'
        return
      }
      // Leaning on it rather than running into it: stop, and stop saying so. A car held against a
      // wall by the throttle should sit there, not chatter a bump sixty times a second.
      if (Math.abs(v) < 3) {
        this.speed = 0
        return
      }
      this.speed = -v * BUMP_BOUNCE
      this.event = 'bump'
      return
    }
    // Back onto a ground-level road (or up a berm's low edge)?
    for (const lane of lanes) {
      lane.table.project(this.pos, this.scratch, this.hit)
      const h = this.hit
      // Out to the curb, the same width the car is allowed to use once it is on the road: rejoining
      // only inside the white line leaves a metre of drivable deck you get shoved off.
      if (!this.scratch.surface || h.over > 0.5 || Math.abs(h.x) > ROAD_HALF_WIDTH + CURB_WIDTH || Math.abs(h.h) > 1.2) continue
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
   * What is in the way right now, and how far above the car it is — the same test the sim uses, run on
   * demand so a report of "I crash into nothing here" can say what the nothing is. Empty when clear.
   */
  probeBlocking(): string {
    const lanes = this.track.lanesNear(this.pos, this.nearby)
    const what = this.hitsStructure(lanes) || this.hitsScenery()
    if (!what) return ''
    let detail = ''
    for (const lane of lanes) {
      lane.table.project(this.pos, this.scratch, this.hit)
      const f = this.scratch
      if (!f.surface || this.hit.over > 0.5) continue
      const { across, rise, inside } = this.deckAgainst(f, this.hit, lane.bank)
      if (!inside) continue
      const type = this.track.data.pieces[lane.pieceIndex]?.type ?? `link (lane ${lane.id})`
      detail = ` — ${type} piece ${lane.pieceIndex}, ${rise >= 0 ? 'up' : 'down'} ${Math.abs(rise).toFixed(2)} m, ${across.toFixed(2)} m across`
      break
    }
    return what + detail
  }

  /**
   * Where a lane's deck is in relation to the car, measured where the deck actually is rather than in
   * its own leaning frame.
   *
   * `across` is the footprint looking down — how far to the side of the deck's centre line the car
   * stands, in ground metres, since a banked deck covers less ground than it is wide. `inside` is
   * whether the car's box overlaps that footprint at all.
   *
   * `rise` is how far the deck stands above the car *at the car's own lateral offset*, clamped to the
   * deck's edge so the surface is never extrapolated out over the grass. That clamp is the whole
   * point: a bank's centre line can be a metre up while the edge you are standing beside is half a
   * metre down, and measuring against the centre line reports a road overhead that is really under
   * your wheels.
   */
  private deckAgainst(f: LaneFrame, h: LaneHit, bank?: Bank): { across: number; rise: number; inside: boolean; grounded: boolean } {
    const edge = outEdgeOf(bank, f.right.y, h.x) + CURB_WIDTH
    const lean = Math.hypot(f.right.x, f.right.z)
    const dx = this.pos.x - f.pos.x
    const dz = this.pos.z - f.pos.z
    const across = lean > 1e-3 ? Math.abs((dx * f.right.x + dz * f.right.z) / lean) : Math.hypot(dx, dz)
    const at = clamp(h.x, -edge, edge)
    const sec = sectionAtOut(bank, f.right.y, at, this.probeSection)
    const deckY = f.pos.y + at * f.right.y + sec.lift * f.up.y
    // How far the deck actually reaches over the ground on this side, wall included: a wall standing
    // near enough vertical is nine metres of surface and three metres of footprint, and it is the
    // footprint a car beside it has to be measured against.
    const rim = sectionAtOut(bank, f.right.y, Math.sign(h.x || 1) * edge, this.edgeSection)
    const rimX = rim.out * f.right.x + rim.lift * f.up.x
    const rimZ = rim.out * f.right.z + rim.lift * f.up.z
    const reach = Math.max(Math.hypot(rimX, rimZ), edge * Math.max(lean, 0.3))
    // Measure from the highest thing the car is actually standing on, not from the middle of it.
    // Straddling the edge of a bank the outside wheels are up on the deck while the body's centre is
    // still below it — being half parked on something is not the same as being under it — and the
    // bound keeps a stale wheel from claiming a contact the car has long since left.
    const contact = Math.min(Math.max(this.wheelL, this.wheelR) + CAR_RIDE, this.pos.y + CAR_HALF_WIDTH * 1.2)
    // Whether this thing comes down to the ground where you are standing. A berm's low edge is in the
    // earth and everything under it is earth too; a bridge's edges are both up in the air and you
    // drive under it. Without the distinction a bank is a wall you can drive through, or an elevated
    // road is solid to the ground.
    const grounded = f.pos.y - Math.abs(f.right.y) * ROAD_HALF_WIDTH - this.pos.y < CLIMB_STEP
    return { across, rise: deckY - Math.max(this.pos.y, contact), inside: across <= reach + CAR_HALF_WIDTH, grounded }
  }

  /**
   * Grass-mode collision against track structures near the car. The car is a box from the
   * grass to ~1.2 m; a lane's slab blocks it when the surface passes through that band, a
   * banked or tilted lane is solid below its surface (an embankment), a tunnel's skin blocks
   * from outside, and elevated road stands on pillars.
   */
  private hitsStructure(lanes: Lane[]): string {
    for (const lane of lanes) {
      lane.table.project(this.pos, this.scratch, this.hit)
      const h = this.hit
      const f = this.scratch
      if (!f.surface || h.over > 0.5) continue
      const ax = Math.abs(h.x)
      if (lane.profile === 'tube') {
        // The tube's skin is a ring of radius TUBE_RADIUS about an axis that high above the floor: at car
        // height it sits only a little outside the road edge, and it flares away above you. Hit it when
        // the roof line would cross the ring from outside; beside the tunnel you drive clear under the flare.
        if (this.tubeWall(lane, h.s) > 0.3 && Math.abs(h.h) < 3) {
          const roof = Math.max(0.2, h.h + 1.1)
          const skinAtRoof = Math.sqrt(Math.max(0, TUBE_RADIUS * TUBE_RADIUS - (TUBE_RADIUS - roof) ** 2))
          if (ax > ROAD_HALF_WIDTH * 0.9 && ax < skinAtRoof + CAR_HALF_WIDTH) return 'the tunnel wall'
        }
        continue
      }
      const { rise, inside, grounded } = this.deckAgainst(f, h, lane.bank)
      // A wall when the deck stands over the car and reaches the ground beside it — the earth of a
      // berm, the side of a ramp — and, when it does not reach the ground, only up to the height a
      // bonnet fits under. Above that it is a bridge to drive beneath.
      if (inside && rise > CLIMB_STEP && (grounded || rise < DECK_CLEARANCE))
        return f.up.y < 0.95 ? 'the embankment' : `the underside of the ${this.track.data.pieces[lane.pieceIndex]?.type ?? 'road'}`
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
              if (dx * dx + dz * dz < 1.6 * 1.6) return 'a pillar'
            }
          }
        }
      }
    }
    return ''
  }

  /** Scenery solids (trees, buildings, pumps) as boxes grown by the car's half width. */
  private hitsScenery(): string {
    const m = CAR_HALF_WIDTH
    for (const s of this.track.solids) {
      if (Math.abs(this.pos.x - s.x) >= s.hw + m || Math.abs(this.pos.z - s.z) >= s.hh + m) continue
      // A solid stands on the ground where it is planted, and it is only in the way while the car is
      // beside it: over the roof of it, or well under its floor, there is nothing there to hit.
      const base = this.track.groundHeight(s.x, s.z)
      if (this.pos.y > base + s.height || this.pos.y < base - 4) continue
      return s.kind === 'trunk' ? 'a tree' : s.kind === 'wall' ? 'a building' : s.kind === 'post' ? 'a canopy post' : 'a fuel pump'
    }
    return ''
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
      // Past the road's edge a banked piece curves on up into its wall; inside the road this is the
      // flat deck and the section is a no-op.
      const sec = sectionAt(this.lane.bank, f.right.y, this.lateral, this.section)
      if (sec.a !== 0) {
        this.up.copy(f.right).scale(-Math.sin(sec.a)).addScaled(f.up, Math.cos(sec.a)).normalize()
        this.pos.copy(f.pos).addScaled(f.right, sec.out).addScaled(f.up, sec.lift).addScaled(this.up, CAR_RIDE)
      } else {
        this.up.copy(f.up)
        this.pos.copy(f.pos).addScaled(f.right, this.lateral).addScaled(f.up, CAR_RIDE)
      }
      this.forward.copy(f.tan).rotateAxis(this.up, -this.heading)
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
