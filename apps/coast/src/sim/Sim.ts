// The run: player physics on the segment road, traffic, checkpoints with time
// extension, forks at stage ends, tumbles and bumps. Deterministic.

import { Rng } from '@apex/engine/math/Rng'
import { clamp, expApproach } from '@apex/engine/math/scalar'
import { EventQueue } from './Events'
import type { InputFrame } from './InputFrame'
import { Stage, type StageDesc } from './Road'
import { Snapshot, type RunPhase } from './Snapshot'
import { STAGE_BY_ID, THEMES } from './Stages'
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
}

/** Sprite hit half-widths in road widths, by kind family; anything unlisted uses the default. */
const HIT_HALF_WIDTH: Record<string, number> = { palm: 0.08, palmTall: 0.08, pine: 0.1, pineTall: 0.1, pineRound: 0.12, oak: 0.14, tree: 0.14, bush: 0.12, bushLarge: 0.16, rock: 0.14, rockTall: 0.12, stoneTall: 0.1, cactus: 0.07, cactusTall: 0.07, billboard: 0.3, billboardLow: 0.3, lightpost: 0.04, lightpostTall: 0.04, barrier: 0.2, banner: 0.06, grandstand: 0.6, tent: 0.3, pitsOffice: 0.5, stump: 0.08, flower: 0 }

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
  private readonly cars: Car[] = []
  private readonly seed: number
  private stageDesc!: StageDesc

  constructor(seed: number) {
    this.seed = seed
    this.rng = new Rng(seed)
    for (let i = 0; i < T.TRAFFIC_COUNT; i++) this.cars.push({ z: 0, x: 0, speed: 0, kind: 0, lane: 0, passed: false })
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
    this.events.clear()
    this.loadStage('A')
  }

  private loadStage(id: string): void {
    const desc = STAGE_BY_ID[id]
    this.stageDesc = desc
    this.stage = new Stage(desc, THEMES[desc.theme], this.seed * 31 + this.route.length * 7 + id.charCodeAt(0))
    this.route.push(id)
    this.z = 0
    for (const c of this.cars) this.spawnCar(c, this.rng.range(40, T.TRAFFIC_SPAWN_AHEAD * 3) * T.SEG_LENGTH)
  }

  private spawnCar(c: Car, z: number): void {
    c.z = z
    c.lane = [-0.62, -0.2, 0.2, 0.62][this.rng.int(4)]
    c.x = c.lane
    c.speed = this.rng.range(T.TRAFFIC_MIN_SPEED, T.TRAFFIC_MAX_SPEED)
    c.kind = this.rng.int(TRAFFIC_KINDS.length)
    c.passed = z < this.z
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

    // Longitudinal.
    const max = this.maxSpeed
    const accel = (this.gear === 1 ? T.ACCEL_HI : T.ACCEL_LO) + (this.turboTimer > 0 ? T.TURBO_ACCEL : 0)
    if (input.throttle > 0) this.speed += accel * input.throttle * (1 - 0.6 * (this.speed / max) ** 2) * dt
    else this.speed -= T.COAST_DECEL * dt
    if (input.brake > 0) this.speed -= T.BRAKE_DECEL * input.brake * dt
    const wasOff = this.offroad
    this.offroad = Math.abs(this.x) > 1
    if (this.offroad && this.speed > T.OFFROAD_MAX_SPEED) this.speed -= T.OFFROAD_DECEL * dt
    if (this.offroad !== wasOff) this.events.push(this.offroad ? 'offroad' : 'onroad')
    this.speed = clamp(this.speed, 0, max)

    // Lateral: steering scales with speed; curves push you outward.
    const sp = this.speed / T.MAX_SPEED_HI
    this.x += input.steer * T.STEER_RATE * sp * dt
    this.x -= seg.curve * sp * sp * T.CENTRIFUGAL * dt
    this.x = clamp(this.x, -2.4, 2.4)
    this.steerVisual = expApproach(this.steerVisual, input.steer, 10, dt)
    this.curveAccum += seg.curve * sp * dt * 60

    // Advance.
    const prevZ = this.z
    this.z += this.speed * dt
    this.score += (this.z - prevZ) * T.SCORE_PER_METRE

    // Roadside collisions on the segments we crossed.
    if (this.speed > 2) {
      const i0 = Math.floor(prevZ / T.SEG_LENGTH)
      const i1 = Math.floor(this.z / T.SEG_LENGTH)
      for (let i = i0; i <= i1 && i < this.stage.segments.length; i++) {
        for (const sp2 of this.stage.segments[i].sprites) {
          if (!sp2.collide) continue
          const hw = (HIT_HALF_WIDTH[sp2.kind] ?? 0.12) * sp2.scale
          if (Math.abs(this.x - sp2.offset) < hw + T.CAR_HALF_WIDTH_ROAD) {
            this.crash()
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
        // Re-centre on the chosen road.
        this.x = clamp(this.x + (this.x < 0 ? T.FORK_SPREAD / 2 : -T.FORK_SPREAD / 2), -1, 1)
      }
      this.stageIndex++
      this.loadStage(id)
      this.timeLeft += T.TIME_CHECKPOINT
      this.checkpointFlash = 2
      this.events.push('checkpoint', this.stageIndex)
    }
  }

  private crash(): void {
    if (this.speed < T.CRASH_MIN_SPEED) {
      // Scrape: bounce back onto the road with a speed hit.
      this.speed *= 0.5
      this.x = clamp(this.x, -1, 1) * 0.9
      this.events.push('bump', 1)
      return
    }
    this.phase = 'crashed'
    this.crashTimer = T.CRASH_TIME
    this.events.push('crash', this.speed)
  }

  private tickCrash(dt: number): void {
    this.crashTimer -= dt
    // Tumble to a stop, drifting back toward the road.
    this.speed = Math.max(0, this.speed - 60 * dt)
    this.z += this.speed * dt * 0.5
    this.x = expApproach(this.x, clamp(this.x, -0.8, 0.8), 2, dt)
    if (this.crashTimer <= 0) {
      this.phase = 'driving'
      this.speed = 0
      this.x = clamp(this.x, -0.8, 0.8)
    }
  }

  private tickTraffic(dt: number): void {
    const stageLen = this.stage.metres
    for (const c of this.cars) {
      c.z += c.speed * dt
      // Lane discipline with occasional changes.
      if (this.rng.next() < 0.002) c.lane = [-0.62, -0.2, 0.2, 0.62][this.rng.int(4)]
      c.x = expApproach(c.x, c.lane, 1.2, dt)
      // Recycle: far behind, or beyond the stage end.
      if (c.z < this.z - T.TRAFFIC_DESPAWN_BEHIND * T.SEG_LENGTH || c.z > stageLen + 200) {
        this.spawnCar(c, this.z + this.rng.range(T.TRAFFIC_SPAWN_MIN, T.TRAFFIC_SPAWN_AHEAD) * T.SEG_LENGTH)
        continue
      }
      // Passing.
      if (!c.passed && c.z < this.z) {
        c.passed = true
        this.score += T.SCORE_PER_PASS
        this.events.push('pass', c.kind)
      }
      // Collision: same place along the road and overlapping laterally.
      if (this.phase === 'driving' && Math.abs(c.z - this.z) < 4 && Math.abs(c.x - this.x) < T.CAR_HALF_WIDTH_ROAD * 2 && this.speed > c.speed) {
        this.speed = c.speed * T.BUMP_KEEP
        this.x += this.x < c.x ? -0.12 : 0.12
        c.z += 3
        this.events.push('bump', 0)
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
    out.crashT = this.phase === 'crashed' ? 1 - this.crashTimer / T.CRASH_TIME : 0
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
    h.stagesTotal = 3
    h.speedKmh = this.speed * 3.6
    h.checkpointFlash = this.checkpointFlash
    h.route = this.route.join(' › ')
    let n = 0
    for (const c of this.cars) {
      out.trafficZ[n] = c.z
      out.trafficX[n] = c.x
      out.trafficKind[n] = c.kind
      out.trafficSpeed[n] = c.speed
      n++
    }
    out.trafficCount = n
    const seg = this.stage.segmentAt(this.z)
    out.forkT = seg.fork
    out.forkSide = seg.fork >= 0 ? (this.x < 0 ? -1 : 1) : 0
  }
}
