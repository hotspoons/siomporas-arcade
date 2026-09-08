// The run: a car on a track, lap timing, crash → replay → respawn.

import { Vec3 } from '@apex/engine/math/Vec3'
import type { CarSpec } from './CarSpec'
import { Car } from './Car'
import { EventQueue } from './Events'
import type { InputFrame } from './InputFrame'
import { Snapshot, type RunPhase } from './Snapshot'
import type { Lane, Track } from './Track'
import { AIR_REV_RATE, CELL, CRASH_TIME_PENALTY, RESET_PENALTY, RESUME_ADVANCE, REPLAY_PLAY_SECONDS, REPLAY_SECONDS, SEGMENT_PENALTY, SIM_HZ } from './Tuning'

const REPLAY_FRAMES = REPLAY_SECONDS * SIM_HZ

export class Sim {
  readonly track: Track
  readonly spec: CarSpec
  readonly car: Car
  readonly events = new EventQueue()
  time = 0
  tickCount = 0
  phase: RunPhase = 'driving'
  laps = 0
  lapTime = 0
  lastLap = 0
  bestLap = 0
  crashes = 0
  /** Why the last crash happened (see Car.crashCause). */
  crashCause = ''
  /** Experiments: when false a would-be crash is forgiven — you're set back on your wheels and keep some speed. */
  crashesEnabled = true
  /** Consecutive crashes without a clean stretch of driving: each one resumes RESUME_ADVANCE further on. */
  private crashStreak = 0
  private sinceCrash = 0
  /** Airborne engine: with the throttle down the revs climb through the gears with no load, and reset on landing. */
  private airRpm = 0
  private airGear = 1
  private airborneRevving = false
  /** Laps to drive; 0 = free run. */
  targetLaps: number
  private lapArmed = false
  private prevLane: Lane | null = null
  /** Lanes a lap must visit (the main route, minus split alternatives) and what this lap has covered. */
  private readonly required: Lane[] = []
  private readonly visited = new Set<number>()
  lastPenalty = 0
  // Replay ring: pos(3) + forward(3) + up(3) per tick.
  private readonly ring = new Float32Array(REPLAY_FRAMES * 9)
  private ringHead = 0
  private ringCount = 0
  private replayTime = 0
  private readonly replayCam = new Vec3()
  private readonly replayLook = new Vec3()
  private readonly vA = new Vec3()

  constructor(track: Track, spec: CarSpec, targetLaps = 3) {
    this.track = track
    this.spec = spec
    this.targetLaps = targetLaps
    this.car = new Car(track, spec)
    this.computeRequired()
    this.reset()
  }

  /** Main-route lanes, excluding anything inside a split/join alternative. */
  private computeRequired(): void {
    this.required.length = 0
    const start = this.track.startLane
    if (!start) return
    // Lanes on any branch of a split are optional; find them by walking each alternative to its rejoin.
    const optional = new Set<number>()
    let lane: Lane | undefined = start
    const seen = new Set<number>()
    while (lane && !seen.has(lane.id)) {
      seen.add(lane.id)
      if (lane.next.length === 2) {
        const mainWalk = new Set<number>()
        let a: Lane | undefined = lane.next[0]
        for (let i = 0; a && i < 64; i++) {
          mainWalk.add(a.id)
          a = a.next[0]
        }
        let b: Lane | undefined = lane.next[1]
        const branch: number[] = []
        for (let i = 0; b && i < 64 && !mainWalk.has(b.id); i++) {
          branch.push(b.id)
          b = b.next[0]
        }
        // Everything on the main side up to the rejoin is optional too.
        if (b) {
          let m: Lane | undefined = lane.next[0]
          while (m && m !== b) {
            optional.add(m.id)
            m = m.next[0]
          }
          for (const id of branch) optional.add(id)
        }
      }
      lane = lane.next[0]
    }
    lane = start
    seen.clear()
    while (lane && !seen.has(lane.id)) {
      seen.add(lane.id)
      if (!optional.has(lane.id)) this.required.push(lane)
      lane = lane.next[0]
    }
  }

  reset(): void {
    this.time = 0
    this.tickCount = 0
    this.phase = 'driving'
    this.laps = 0
    this.lapTime = 0
    this.lastLap = 0
    this.bestLap = 0
    this.crashes = 0
    this.lapArmed = false
    this.ringCount = 0
    this.ringHead = 0
    this.events.clear()
    this.visited.clear()
    this.lastPenalty = 0
    const start = this.track.startLane
    if (start) {
      this.car.placeOn(start, 4)
      this.prevLane = start
    } else {
      // No start piece (an unfinished track in the editor's preview): stand on the grass in the middle.
      this.car.placeOnGrass((this.track.data.size * CELL) / 2, (this.track.data.size * CELL) / 2)
      this.prevLane = null
    }
  }

  tick(dt: number, input: InputFrame, out: Snapshot): void {
    const car = this.car
    if (this.phase === 'driving') {
      this.time += dt
      this.tickCount++
      this.lapTime += dt
      if (input.reset) {
        // Manual recover: back on your wheels, right here.
        this.car.resumeInPlace()
        this.events.push('respawn', this.car.pos, 0)
      }
      car.tick(dt, input)
      this.sinceCrash += dt
      if (this.sinceCrash > 4) this.crashStreak = 0
      this.recordPose()
      this.tickAirRevs(dt, input)
      switch (car.event) {
        case 'crash':
          this.crash()
          break
        case 'launch':
          this.events.push('launch', car.pos)
          break
        case 'land':
          this.events.push('land', car.pos, car.speed)
          break
        case 'offroad':
          this.events.push('offroad', car.pos)
          break
        case 'onroad':
          this.events.push('onroad', car.pos)
          break
        case 'curb':
          this.events.push('curb', car.pos)
          break
        case 'bump':
          this.events.push('bump', car.pos, Math.abs(car.speed))
          break
        default:
          break
      }
      // Segments visited this lap; laps complete at the start line however you got there,
      // and every required segment you skipped costs SEGMENT_PENALTY.
      if (car.mode === 'track' && car.lane) this.visited.add(car.lane.id)
      if (car.mode === 'track' && car.lane && car.lane !== this.prevLane) {
        // Crossing the line forwards; reversing onto the start piece from the far end doesn't count.
        if (car.lane.isStart && car.lane === this.track.startLane && car.speed > 0 && car.s < car.lane.table.length * 0.5) {
          if (this.lapArmed) {
            let missed = 0
            for (const r of this.required) if (!this.visited.has(r.id) && r !== car.lane) missed++
            const penalty = missed * SEGMENT_PENALTY
            this.laps++
            this.lastPenalty = penalty
            this.lastLap = this.lapTime + penalty
            if (this.bestLap === 0 || this.lastLap < this.bestLap) this.bestLap = this.lastLap
            this.lapTime = 0
            this.visited.clear()
            this.visited.add(car.lane.id)
            this.events.push('lap', car.pos, this.laps)
            if (missed > 0) this.events.push('penalty', car.pos, missed)
            if (this.targetLaps > 0 && this.laps >= this.targetLaps) this.phase = 'finished'
          }
        } else {
          this.lapArmed = true
        }
        this.prevLane = car.lane
      }
    } else if (this.phase === 'replay') {
      // Reset skips the replay: back to the road where the footage began, stopped, for a time penalty.
      if (input.reset) {
        this.resetToReplayStart()
        this.write(out)
        return
      }
      this.replayTime += dt
      if (this.replayTime >= REPLAY_PLAY_SECONDS) {
        this.events.push('replay_end', null)
        // No teleport: you continue from where you came to rest — or a little further on if you keep
        // crashing right there, so a bad spot can't trap you.
        this.car.resumeInPlace(0, RESUME_ADVANCE * Math.max(0, this.crashStreak - 1))
        this.prevLane = this.car.lane
        this.events.push('respawn', this.car.pos, 1)
        this.phase = 'driving'
      }
    }
    this.write(out)
  }

  /**
   * Skip the crash replay: put the car back on the road at the pose the replay opens on (a few seconds
   * before the incident), stopped, and charge RESET_PENALTY seconds for the privilege.
   */
  private resetToReplayStart(): void {
    if (this.ringCount > 0) {
      const framesBack = Math.min(Math.round(REPLAY_PLAY_SECONDS * SIM_HZ), this.ringCount - 1)
      const idx = (((this.ringHead - 1 - framesBack) % REPLAY_FRAMES) + REPLAY_FRAMES) % REPLAY_FRAMES
      const k = idx * 9
      const c = this.car
      c.pos.set(this.ring[k], this.ring[k + 1], this.ring[k + 2])
      c.forward.set(this.ring[k + 3], this.ring[k + 4], this.ring[k + 5])
      c.up.set(this.ring[k + 6], this.ring[k + 7], this.ring[k + 8])
      c.vel.set(0, 0, 0)
    }
    this.car.resumeInPlace()
    this.lapTime += RESET_PENALTY
    this.crashStreak = 0
    this.sinceCrash = 0
    this.ringCount = 0
    this.prevLane = this.car.lane
    this.events.push('replay_end', null)
    this.events.push('respawn', this.car.pos, 2)
    this.phase = 'driving'
  }

  private recordPose(): void {
    const c = this.car
    const k = this.ringHead * 9
    this.ring[k] = c.pos.x
    this.ring[k + 1] = c.pos.y
    this.ring[k + 2] = c.pos.z
    this.ring[k + 3] = c.forward.x
    this.ring[k + 4] = c.forward.y
    this.ring[k + 5] = c.forward.z
    this.ring[k + 6] = c.up.x
    this.ring[k + 7] = c.up.y
    this.ring[k + 8] = c.up.z
    this.ringHead = (this.ringHead + 1) % REPLAY_FRAMES
    if (this.ringCount < REPLAY_FRAMES) this.ringCount++
  }

  private crash(): void {
    this.crashStreak++
    this.sinceCrash = 0
    this.crashCause = this.car.crashCause
    if (!this.crashesEnabled) {
      this.car.resumeInPlace(0.6, RESUME_ADVANCE * Math.max(0, this.crashStreak - 1))
      this.events.push('land', this.car.pos, this.car.speed)
      return
    }
    this.crashes++
    this.lapTime += CRASH_TIME_PENALTY
    this.events.push('crash', this.car.pos, this.car.speed)
    this.phase = 'replay'
    this.replayTime = 0
    // Trackside camera: off to the side of the crash point, a little up.
    const c = this.car
    this.vA.set(-c.forward.z, 0, c.forward.x).normalize() // horizontal right of travel
    this.replayCam.copy(c.pos).addScaled(this.vA, 28).addScaled(c.forward, -12)
    this.replayCam.y = Math.max(c.pos.y + 6, 4)
    this.replayLook.copy(c.pos)
    this.events.push('replay_start', c.pos)
  }

  private write(out: Snapshot): void {
    const c = this.car
    out.time = this.time
    out.tick = this.tickCount
    out.phase = this.phase
    const s = out.car
    if (this.phase === 'replay' && this.ringCount > 0) {
      // Scrub the recorded poses: the replay covers the last REPLAY_PLAY_SECONDS.
      const framesBack = Math.max(0, Math.round((REPLAY_PLAY_SECONDS - this.replayTime) * SIM_HZ))
      const idx = ((this.ringHead - 1 - Math.min(framesBack, this.ringCount - 1)) % REPLAY_FRAMES + REPLAY_FRAMES) % REPLAY_FRAMES
      const k = idx * 9
      s.pos.set(this.ring[k], this.ring[k + 1], this.ring[k + 2])
      s.forward.set(this.ring[k + 3], this.ring[k + 4], this.ring[k + 5])
      s.up.set(this.ring[k + 6], this.ring[k + 7], this.ring[k + 8])
      out.replayT = this.replayTime / REPLAY_PLAY_SECONDS
    } else {
      s.pos.copy(c.pos)
      s.forward.copy(c.forward)
      s.up.copy(c.up)
    }
    out.replayCam.copy(this.replayCam)
    out.replayLook.copy(this.replayLook)
    s.speed = c.speed
    s.steer = c.steerVisual
    s.wheelSpin = c.wheelSpin
    s.mode = c.mode
    s.laneId = c.lane?.id ?? -1
    s.s = c.s
    s.lateral = c.lateral
    s.slip = c.slip
    s.onGrass = c.onGrass
    const h = out.hud
    h.speed = Math.abs(c.speed)
    h.lapTime = this.lapTime
    h.lastLap = this.lastLap
    h.bestLap = this.bestLap
    h.laps = this.laps
    h.crashes = this.crashes
    h.penalty = this.lastPenalty
    // Fake gearbox for the engine note and HUD.
    const ratio = Math.abs(c.speed) / this.spec.topSpeed
    if (this.airborneRevving) {
      h.gear = this.airGear
      h.rpm = this.airRpm
    } else {
      // Five gears, like everything short of a 959.
      h.gear = Math.min(5, 1 + Math.floor(ratio * 5))
      // Idle sits at ~800 of 8000; each gear runs the band from there to the limiter.
      h.rpm = Math.abs(c.speed) < 0.3 ? 0.1 : (Math.min(4.999, ratio * 5) % 1) * 0.75 + 0.22
    }
  }

  private tickAirRevs(dt: number, input: InputFrame): void {
    const c = this.car
    if (c.mode !== 'air') {
      this.airborneRevving = false
      return
    }
    if (!this.airborneRevving) {
      // Take over from the speed-derived note where it currently sits.
      const ratio = Math.abs(c.speed) / this.spec.topSpeed
      this.airGear = Math.min(5, 1 + Math.floor(ratio * 5))
      this.airRpm = (Math.min(4.999, ratio * 5) % 1) * 0.75 + 0.22
      this.airborneRevving = true
    }
    if (input.throttle > 0.1) {
      // No load on the wheels: the revs run away, shifting up until the last gear pins at the limiter.
      this.airRpm += input.throttle * AIR_REV_RATE * dt
      if (this.airRpm >= 1) {
        if (this.airGear < 5) {
          this.airGear++
          this.airRpm = 0.35
        } else this.airRpm = 1
      }
    } else {
      this.airRpm = Math.max(0.1, this.airRpm - AIR_REV_RATE * 0.6 * dt)
    }
  }
}
