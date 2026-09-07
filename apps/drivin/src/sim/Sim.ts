// The run: a car on a track, lap timing, crash → replay → respawn.

import { Vec3 } from '@apex/engine/math/Vec3'
import type { CarSpec } from './CarSpec'
import { Car } from './Car'
import { EventQueue } from './Events'
import type { InputFrame } from './InputFrame'
import { Snapshot, type RunPhase } from './Snapshot'
import type { Lane, Track } from './Track'
import { CRASH_TIME_PENALTY, REPLAY_PLAY_SECONDS, REPLAY_SECONDS, SEGMENT_PENALTY, SIM_HZ } from './Tuning'

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
      this.recordPose()
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
        default:
          break
      }
      // Segments visited this lap; laps complete at the start line however you got there,
      // and every required segment you skipped costs SEGMENT_PENALTY.
      if (car.mode === 'track' && car.lane) this.visited.add(car.lane.id)
      if (car.mode === 'track' && car.lane && car.lane !== this.prevLane) {
        if (car.lane.isStart && car.lane === this.track.startLane) {
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
      this.replayTime += dt
      if (this.replayTime >= REPLAY_PLAY_SECONDS) {
        this.events.push('replay_end', null)
        // No teleport: you continue from where you came to rest.
        this.car.resumeInPlace()
        this.prevLane = this.car.lane
        this.events.push('respawn', this.car.pos, 1)
        this.phase = 'driving'
      }
    }
    this.write(out)
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
    h.gear = Math.min(6, 1 + Math.floor(ratio * 6))
    h.rpm = ((ratio * 6) % 1) * 0.7 + 0.3
  }
}
