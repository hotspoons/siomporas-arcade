// The run: player physics on the segment road, traffic, checkpoints with time
// extension, forks at stage ends, tumbles and bumps. Deterministic.

import { Rng } from '@apex/engine/math/Rng'
import { clamp, expApproach } from '@apex/engine/math/scalar'
import { EventQueue } from './Events'
import type { InputFrame } from './InputFrame'
import { Stage, type StageDesc, type Theme } from './Road'
import { Snapshot, type RunPhase } from './Snapshot'
import { routeLength, STAGE_BY_ID, THEMES } from './Stages'
import * as T from './Tuning'

export const TRAFFIC_KINDS = ['sedan', 'sedanSports', 'suv', 'van', 'truck', 'taxi', 'police', 'delivery'] as const

interface Car {
  z: number
  x: number
  speed: number
  kind: number
  /** Target lane the car drifts toward. */
  lane: number
  passed: boolean
  /** +1 same way as you, -1 head-on, 0 crossing the road at an intersection. */
  dir: 1 | -1 | 0
  /** Crossers: which way across (+1 = left→right) and the intersection's z. */
  side: number
  crossZ: number
}

/** Sprite hit half-widths in road widths, by kind family; anything unlisted uses the default. */
const HIT_HALF_WIDTH: Record<string, number> = { palm: 0.08, palmTall: 0.08, pine: 0.1, pineTall: 0.1, pineRound: 0.12, oak: 0.14, tree: 0.14, bush: 0.12, bushLarge: 0.16, rock: 0.14, rockTall: 0.12, stoneTall: 0.1, cactus: 0.07, cactusTall: 0.07, billboard: 0.3, billboardLow: 0.3, lightpost: 0.04, lightpostTall: 0.04, barrier: 0.2, banner: 0.06, grandstand: 0.6, tent: 0.3, pitsOffice: 0.5, stump: 0.08, flower: 0, diner: 0.55, motel: 0.85, gas: 0.7, tower: 0.4, tower2: 0.4, signCoast: 0.36, signDrive: 0.36, signBay: 0.36, arch: 0 }

export class Sim {
  readonly events = new EventQueue()
  readonly rng: Rng
  stage!: Stage
  route: string[] = []
  stageIndex = 0
  z = 0
  x = 0
  speed = 0
  gear: 0 | 1 = 1
  time = 0
  tickCount = 0
  timeLeft = T.TIME_START
  score = 0
  phase: RunPhase = 'driving'
  turbo = 1
  turboTimer = 0
  crashTimer = 0
  steerVisual = 0
  curveAccum = 0
  offroad = false
  checkpointFlash = 0
  wreck = false
  wipersOn = false
  lightsOn = false
  /** Airborne over a crest: height above the road and vertical speed. */
  airborne = false
  airY = 0
  private vy = 0
  private slopePrev = 0
  private segPrev = -1
  theme!: Theme
  readonly startId: string
  private readonly cars: Car[] = []
  private readonly crossers: Car[] = []
  private readonly seed: number
  private stageDesc!: StageDesc

  constructor(seed: number, startId = 'A') {
    this.seed = seed
    this.startId = STAGE_BY_ID[startId] ? startId : 'A'
    this.rng = new Rng(seed)
    for (let i = 0; i < T.TRAFFIC_COUNT; i++) this.cars.push({ z: 0, x: 0, speed: 0, kind: 0, lane: 0, passed: false, dir: 1, side: 1, crossZ: 0 })
    for (let i = 0; i < T.CROSSER_COUNT; i++) this.crossers.push({ z: -1e9, x: 9, speed: 0, kind: 0, lane: 0, passed: true, dir: 0, side: 1, crossZ: 0 })
    this.reset()
  }

  reset(): void {
    this.rng.reseed(this.seed)
    this.route = []
    this.stageIndex = 0
    this.z = 0
    this.x = 0
    this.speed = 0
    this.gear = 1
    this.time = 0
    this.tickCount = 0
    this.timeLeft = T.TIME_START
    this.score = 0
    this.phase = 'driving'
    this.turbo = 1
    this.turboTimer = 0
    this.crashTimer = 0
    this.steerVisual = 0
    this.curveAccum = 0
    this.offroad = false
    this.checkpointFlash = 0
    this.wreck = false
    this.wipersOn = false
    this.lightsOn = false
    this.airborne = false
    this.airY = 0
    this.vy = 0
    this.events.clear()
    this.loadStage(this.startId)
  }

  private loadStage(id: string): void {
    const desc = STAGE_BY_ID[id]
    this.stageDesc = desc
    this.theme = THEMES[desc.theme]
    this.stage = new Stage(desc, this.theme, this.seed * 31 + this.route.length * 7 + id.charCodeAt(0))
    this.route.push(id)
    this.z = 0
    this.airborne = false
    this.airY = 0
    this.vy = 0
    this.segPrev = -1
    this.slopePrev = 0
    for (const c of this.cars) this.spawnCar(c, this.rng.range(40, T.TRAFFIC_SPAWN_AHEAD * 3) * T.SEG_LENGTH)
    for (const c of this.crossers) this.spawnCrosser(c)
  }

  private spawnCar(c: Car, z: number): void {
    c.z = z
    // Head-on traffic keeps to the far side of the crown; yours keeps right.
    c.dir = this.rng.next() < (this.theme.oncoming ?? 0) ? -1 : 1
    c.lane = c.dir < 0 ? [-0.62, -0.25][this.rng.int(2)] : this.theme.oncoming ? [0.25, 0.62][this.rng.int(2)] : [-0.62, -0.2, 0.2, 0.62][this.rng.int(4)]
    c.x = c.lane
    c.speed = this.rng.range(T.TRAFFIC_MIN_SPEED, T.TRAFFIC_MAX_SPEED)
    c.kind = this.rng.int(TRAFFIC_KINDS.length)
    c.passed = z < this.z
  }

  /** Park a crosser on the next intersection ahead (or nowhere when the theme has none). */
  private spawnCrosser(c: Car): void {
    const ahead = this.stage.crossings.filter((i) => i * T.SEG_LENGTH > this.z + 60)
    if (!ahead.length) {
      c.z = -1e9
      c.x = 9
      return
    }
    const i = ahead[this.rng.int(Math.min(2, ahead.length))]
    c.crossZ = i * T.SEG_LENGTH + T.SEG_LENGTH / 2
    c.z = c.crossZ
    c.side = this.rng.next() < 0.5 ? 1 : -1
    // Start off-screen on one shoulder, with a random hold before rolling out.
    c.x = -c.side * (3.2 + this.rng.range(0, 6))
    c.speed = T.CROSSER_SPEED * this.rng.range(0.8, 1.25)
    c.kind = this.rng.int(TRAFFIC_KINDS.length)
    c.dir = 0
    c.passed = false
  }

  private isFinished(): boolean {
    return (this.phase as RunPhase) === 'finished'
  }

  get maxSpeed(): number {
    return (this.gear === 1 ? T.MAX_SPEED_HI : T.MAX_SPEED_LO) + (this.turboTimer > 0 ? T.TURBO_TOP : 0)
  }

  tick(dt: number, input: InputFrame, out: Snapshot): void {
    if (this.phase === 'driving' || this.phase === 'crashed') {
      this.time += dt
      this.tickCount++
      this.timeLeft -= dt
      if (this.checkpointFlash > 0) this.checkpointFlash -= dt
      if (this.phase === 'crashed') this.tickCrash(dt)
      else this.tickDrive(dt, input)
      this.tickTraffic(dt)
      if (this.timeLeft <= 0 && !this.isFinished()) {
        this.timeLeft = 0
        this.phase = 'timeout'
        this.events.push('timeout')
      }
    }
    this.write(out)
  }

  private tickDrive(dt: number, input: InputFrame): void {
    const seg = this.stage.segmentAt(this.z)
    // Gear and turbo.
    if (input.gear) {
      this.gear = this.gear === 1 ? 0 : 1
      this.events.push('gear', this.gear)
    }
    if (input.turbo && this.turbo >= 1 && this.turboTimer <= 0) {
      this.turboTimer = T.TURBO_TIME
      this.turbo = 0
      this.events.push('turbo')
    }
    if (this.turboTimer > 0) this.turboTimer -= dt
    else this.turbo = Math.min(1, this.turbo + dt / T.TURBO_RECHARGE)
    // Manual switches, arcade style: nothing comes on by itself.
    if (input.wipers) {
      this.wipersOn = !this.wipersOn
      this.events.push('wipers', this.wipersOn ? 1 : 0)
    }
    if (input.lights) {
      this.lightsOn = !this.lightsOn
      this.events.push('lights', this.lightsOn ? 1 : 0)
    }

    // Longitudinal.
    const max = this.maxSpeed
    const accel = (this.gear === 1 ? T.ACCEL_HI : T.ACCEL_LO) + (this.turboTimer > 0 ? T.TURBO_ACCEL : 0)
    const air = this.airborne
    if (air) this.speed -= 1.5 * dt // wheels off the ground: no drive, a little drag
    else if (input.throttle > 0) this.speed += accel * input.throttle * (1 - 0.6 * (this.speed / max) ** 2) * dt
    else this.speed -= T.COAST_DECEL * dt
    if (input.brake > 0 && !air) this.speed -= T.BRAKE_DECEL * input.brake * dt
    // In the fork zone the road splits into two carriageways FORK_SPREAD apart (renderer draws
    // them at ±fork × FORK_SPREAD); "on the road" means on one of them, and the widening
    // median nudges you onto whichever side you lean to.
    const forkC = seg.fork >= 0 ? seg.fork * T.FORK_SPREAD : 0
    const centre = forkC ? Math.sign(this.x || 1) * forkC : 0
    if (forkC && Math.abs(this.x) < forkC) this.x = expApproach(this.x, centre, 3 * seg.fork, dt)
    const wasOff = this.offroad
    this.offroad = Math.abs(this.x - centre) > (forkC ? 1.3 : 1)
    if (this.offroad && !air && this.speed > T.OFFROAD_MAX_SPEED) this.speed -= T.OFFROAD_DECEL * dt
    if (this.offroad !== wasOff) this.events.push(this.offroad ? 'offroad' : 'onroad')
    this.speed = clamp(this.speed, 0, max)

    // Lateral: steering scales with speed; curves push you outward. Neither applies in the air.
    const sp = this.speed / T.MAX_SPEED_HI
    if (!air) {
      this.x += input.steer * T.STEER_RATE * sp * dt
      // Banked turns carry you round: the banking cancels part of the push.
      this.x -= seg.curve * sp * sp * T.CENTRIFUGAL * (1 - (this.theme.bank ?? 0) * T.BANK_ASSIST) * dt
    }
    this.x = clamp(this.x, -2.4 - forkC, 2.4 + forkC)
    this.steerVisual = expApproach(this.steerVisual, input.steer, 10, dt)
    this.curveAccum += seg.curve * sp * dt * 60

    // Advance.
    const prevZ = this.z
    this.z += this.speed * dt
    this.score += (this.z - prevZ) * T.SCORE_PER_METRE
    this.tickHills(dt)

    // Roadside collisions on the segments we crossed.
    if (this.speed > 2) {
      const i0 = Math.floor(prevZ / T.SEG_LENGTH)
      const i1 = Math.floor(this.z / T.SEG_LENGTH)
      for (let i = i0; i <= i1 && i < this.stage.segments.length; i++) {
        for (const sp2 of this.stage.segments[i].sprites) {
          if (!sp2.collide) continue
          const hw = (HIT_HALF_WIDTH[sp2.kind] ?? 0.12) * sp2.scale
          if (Math.abs(this.x - sp2.offset) < hw + T.CAR_HALF_WIDTH_ROAD) {
            this.crash(false)
            return
          }
        }
      }
    }

    // Stage end.
    if (this.z >= this.stage.metres) {
      const next = this.stageDesc.next
      if (next.length === 0) {
        this.phase = 'finished'
        this.score += this.timeLeft * T.SCORE_TIME_BONUS
        this.events.push('finish')
        return
      }
      const id = next.length === 2 ? (this.x < 0 ? next[0] : next[1]) : next[0]
      if (next.length === 2) {
        this.events.push('fork', this.x < 0 ? -1 : 1)
        // Re-centre on the chosen carriageway (they sit ±FORK_SPREAD from the old centreline).
        this.x = clamp(this.x + (this.x < 0 ? T.FORK_SPREAD : -T.FORK_SPREAD), -1, 1)
      }
      this.stageIndex++
      this.loadStage(id)
      this.timeLeft += T.TIME_CHECKPOINT
      this.checkpointFlash = 2
      this.events.push('checkpoint', this.stageIndex)
    }
  }

  /**
   * Crests. The road is piecewise-linear in height; where the slope drops from one
   * segment to the next the car would need speed² × curvature of downward acceleration
   * to stay on it. Past AIR_LAUNCH_G gs the wheels leave the ground and you fly a
   * ballistic arc until the road comes back up under you.
   */
  private tickHills(dt: number): void {
    const seg = this.stage.segmentAt(this.z)
    const slope = (seg.y1 - seg.y0) / T.SEG_LENGTH
    // Real road only: the runway and the stage seam are flat by construction and must never launch.
    const real = !seg.runway && seg.index < this.stage.length - 1
    if (!this.airborne && real && this.segPrev >= 0 && seg.index !== this.segPrev && this.speed > T.AIR_MIN_SPEED) {
      const kappa = (slope - this.slopePrev) / T.SEG_LENGTH
      if (-kappa * this.speed * this.speed > 9.8 * T.AIR_LAUNCH_G) {
        this.airborne = true
        this.vy = this.speed * this.slopePrev + T.AIR_KICK
        this.airY = 0
        this.events.push('launch', this.speed)
      }
    }
    if (this.airborne) {
      this.vy -= T.AIR_GRAVITY * dt
      // Height above the road: our vertical speed against the road's own rise/fall under us.
      this.airY += (this.vy - slope * this.speed) * dt
      if (this.airY <= 0) {
        this.airY = 0
        this.airborne = false
        this.events.push('land', Math.max(0, slope * this.speed - this.vy))
      }
    }
    this.segPrev = seg.index
    this.slopePrev = slope
  }

  private crash(wreck: boolean): void {
    if (!wreck && this.speed < T.CRASH_MIN_SPEED) {
      // Scrape: bounce back onto the road with a speed hit.
      this.speed *= 0.5
      this.x = clamp(this.x, -1, 1) * 0.9
      this.events.push('bump', 1)
      return
    }
    this.phase = 'crashed'
    this.wreck = wreck
    this.crashTimer = wreck ? T.WRECK_TIME : T.CRASH_TIME
    this.events.push(wreck ? 'wreck' : 'crash', this.speed)
  }

  private tickCrash(dt: number): void {
    this.crashTimer -= dt
    // Tumble to a stop, drifting back toward the road. A wreck rolls a long way.
    this.speed = Math.max(0, this.speed - (this.wreck ? 24 : 60) * dt)
    this.z += this.speed * dt * 0.5
    this.x = expApproach(this.x, clamp(this.x, -0.8, 0.8), 2, dt)
    if (this.crashTimer <= 0) {
      this.phase = 'driving'
      this.wreck = false
      this.speed = 0
      this.x = clamp(this.x, -0.8, 0.8)
    }
  }

  private tickTraffic(dt: number): void {
    const stageLen = this.stage.metres
    for (const c of this.cars) {
      c.z += c.dir * c.speed * dt
      // Lane discipline with occasional changes (head-on traffic stays on its side).
      if (this.rng.next() < 0.002) c.lane = c.dir < 0 ? [-0.62, -0.25][this.rng.int(2)] : this.theme.oncoming ? [0.25, 0.62][this.rng.int(2)] : [-0.62, -0.2, 0.2, 0.62][this.rng.int(4)]
      // Through the fork zone traffic follows its carriageway out to the side.
      const fk = this.stage.segmentAt(c.z).fork
      c.x = expApproach(c.x, fk >= 0 ? Math.sign(c.lane) * fk * T.FORK_SPREAD + c.lane : c.lane, 1.2, dt)
      // Recycle: far behind, or beyond the stage end.
      if (c.z < this.z - T.TRAFFIC_DESPAWN_BEHIND * T.SEG_LENGTH || c.z > stageLen + 200) {
        this.spawnCar(c, this.z + this.rng.range(T.TRAFFIC_SPAWN_MIN, T.TRAFFIC_SPAWN_AHEAD) * T.SEG_LENGTH)
        continue
      }
      // Passing (only traffic going your way counts; head-on just whooshes).
      if (!c.passed && c.z < this.z) {
        c.passed = true
        if (c.dir > 0) this.score += T.SCORE_PER_PASS
        this.events.push('pass', c.kind)
      }
      // Collision: same place along the road and overlapping laterally.
      if (this.phase === 'driving' && Math.abs(c.z - this.z) < 4 && Math.abs(c.x - this.x) < T.CAR_HALF_WIDTH_ROAD * 2) {
        if (c.dir < 0) {
          // Head-on: closing speed is the sum. Fast means a wreck; slow, a hard shove.
          if (this.speed + c.speed > T.WRECK_SPEED) this.crash(true)
          else {
            this.speed = 0
            this.x += this.x < c.x ? -0.2 : 0.2
            this.events.push('bump', 1)
          }
          c.z -= 6
        } else if (this.speed > c.speed) {
          if (this.speed - c.speed > T.REAREND_CRASH_SPEED) this.crash(false)
          else {
            this.speed = c.speed * T.BUMP_KEEP
            this.x += this.x < c.x ? -0.12 : 0.12
            this.events.push('bump', 0)
          }
          c.z += 3
        }
      }
    }
    // Crossers: roll across the intersection, park off the far shoulder, then take the next one.
    for (const c of this.crossers) {
      if (c.z < -1e8) continue
      if (c.crossZ < this.z - 30) {
        this.spawnCrosser(c)
        continue
      }
      c.x += c.side * c.speed * dt
      if (c.side * c.x > 3.4) {
        // Across; wait a beat off-road then come back the other way or move on.
        if (this.rng.next() < 0.01) {
          if (this.rng.next() < 0.5) {
            c.side = -c.side
            c.speed = T.CROSSER_SPEED * this.rng.range(0.8, 1.25)
          } else this.spawnCrosser(c)
        }
        continue
      }
      if (this.phase === 'driving' && Math.abs(c.crossZ - this.z) < 5 && Math.abs(c.x - this.x) < T.CAR_HALF_WIDTH_ROAD * 2.4) {
        if (this.speed > T.WRECK_SPEED * 0.8) this.crash(true)
        else {
          this.speed *= 0.3
          this.events.push('bump', 1)
        }
        c.x += c.side * 0.6
      }
    }
  }

  private write(out: Snapshot): void {
    out.time = this.time
    out.tick = this.tickCount
    out.phase = this.phase
    out.z = this.z
    out.x = this.x
    out.speed = this.speed
    out.maxSpeed = this.maxSpeed
    out.steer = this.steerVisual
    out.crashT = this.phase === 'crashed' ? 1 - this.crashTimer / (this.wreck ? T.WRECK_TIME : T.CRASH_TIME) : 0
    out.wreck = this.phase === 'crashed' && this.wreck
    out.wipersOn = this.wipersOn
    out.lightsOn = this.lightsOn
    out.airY = this.airY
    out.stageIndex = this.stageIndex
    out.stageId = this.stageDesc.id
    out.curveAccum = this.curveAccum
    const h = out.hud
    h.time = this.timeLeft
    h.score = Math.floor(this.score)
    h.gear = this.gear
    h.turbo = this.turbo
    h.turboActive = this.turboTimer > 0
    h.stage = this.stageIndex + 1
    h.stagesTotal = routeLength(this.startId)
    h.wipers = this.wipersOn
    h.lights = this.lightsOn
    h.speedKmh = this.speed * 3.6
    h.checkpointFlash = this.checkpointFlash
    h.route = this.route.join(' › ')
    let n = 0
    for (const c of this.cars) {
      out.trafficZ[n] = c.z
      out.trafficX[n] = c.x
      out.trafficKind[n] = c.kind
      out.trafficSpeed[n] = c.speed
      out.trafficYaw[n] = c.dir < 0 ? 180 : 0
      n++
    }
    for (const c of this.crossers) {
      if (c.z < -1e8 || Math.abs(c.x) > 3.6) continue
      out.trafficZ[n] = c.crossZ
      out.trafficX[n] = c.x
      out.trafficKind[n] = c.kind
      out.trafficSpeed[n] = 0
      out.trafficYaw[n] = c.side > 0 ? 90 : -90
      n++
    }
    out.trafficCount = n
    const seg = this.stage.segmentAt(this.z)
    out.forkT = seg.fork
    out.forkSide = seg.fork >= 0 ? (this.x < 0 ? -1 : 1) : 0
  }
}
