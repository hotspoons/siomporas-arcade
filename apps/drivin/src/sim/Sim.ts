// The run: a car on a track, lap timing, crash → replay → respawn.

import { Vec3 } from '@apex/engine/math/Vec3'
import type { CarSpec } from './CarSpec'
import { Car } from './Car'
import { EventQueue } from './Events'
import type { InputFrame } from './InputFrame'
import { Snapshot, type RunPhase } from './Snapshot'
import type { Lane, Track } from './Track'
import { CRASH_TIME_PENALTY, REPLAY_PLAY_SECONDS, REPLAY_SECONDS, RESPAWN_SPEED, SIM_HZ } from './Tuning'

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
  /** Start of the lane before the current one: the respawn point with a run-up. */
  private respawnLane: Lane | null = null
  private currentLaneStart: Lane | null = null
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
    this.reset()
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
    const start = this.track.startLane
    if (start) {
      this.car.placeOn(start, 4)
      this.respawnLane = start
      this.currentLaneStart = start
      this.prevLane = start
    }
  }

  tick(dt: number, input: InputFrame, out: Snapshot): void {
    const car = this.car
    if (this.phase === 'driving') {
      this.time += dt
      this.tickCount++
      this.lapTime += dt
      if (input.reset) this.respawn(false)
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
      // Lap: entering the start lane from its predecessor.
      if (car.mode === 'track' && car.lane && car.lane !== this.prevLane) {
        // Respawn one lane back from wherever you get into trouble.
        if (this.prevLane && this.prevLane.next.includes(car.lane)) {
          this.respawnLane = this.currentLaneStart
          this.currentLaneStart = car.lane
        }
        if (car.lane.isStart && car.lane === this.track.startLane) {
          // A lap is the start line crossed from the piece before it — not a
          // shortcut across the grass.
          const legit = this.prevLane !== null && this.prevLane.next.includes(car.lane)
          if (this.lapArmed && legit) {
            this.laps++
            this.lastLap = this.lapTime
            if (this.bestLap === 0 || this.lastLap < this.bestLap) this.bestLap = this.lastLap
            this.lapTime = 0
            this.events.push('lap', car.pos, this.laps)
            if (this.targetLaps > 0 && this.laps >= this.targetLaps) this.phase = 'finished'
          }
        } else {
          this.lapArmed = true
        }
        this.prevLane = car.lane
      }
      // Wandered off into the void on grass.
      if (car.mode === 'ground' && !this.nearAnyLane()) {
        this.events.push('lost', car.pos)
        this.respawn(true)
      }
    } else if (this.phase === 'replay') {
      this.replayTime += dt
      if (this.replayTime >= REPLAY_PLAY_SECONDS) {
        this.events.push('replay_end', null)
        this.respawn(true)
        this.phase = 'driving'
      }
    }
    this.write(out)
  }

  private nearAnyLane(): boolean {
    const c = this.car.pos
    for (const lane of this.track.lanes) {
      const t = lane.table
      if (c.x > t.minX - 60 && c.x < t.maxX + 60 && c.z > t.minZ - 60 && c.z < t.maxZ + 60) return true
    }
    return false
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

  private respawn(fromCrash: boolean): void {
    const lane = this.respawnLane ?? this.track.startLane
    if (!lane) return
    this.car.placeOn(lane, 2, RESPAWN_SPEED)
    this.prevLane = lane
    this.currentLaneStart = lane
    this.events.push('respawn', this.car.pos, fromCrash ? 1 : 0)
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
    // Fake gearbox for the engine note and HUD.
    const ratio = Math.abs(c.speed) / this.spec.topSpeed
    h.gear = Math.min(6, 1 + Math.floor(ratio * 6))
    h.rpm = ((ratio * 6) % 1) * 0.7 + 0.3
  }
}
