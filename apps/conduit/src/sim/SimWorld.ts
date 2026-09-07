// The deterministic game: owns the track, the craft, traffic, weapons, the
// clock and the score, and advances all of it one fixed step at a time. Reads
// an InputFrame, writes a SimSnapshot, pushes SimEvents. No three.js, no
// Math.random, no allocation after construction.

import { EventQueue } from './Events'
import { type InputFrame } from './InputFrame'
import { Rng } from '@apex/engine/math/Rng'
import { SimSnapshot, type RunPhase } from './SimSnapshot'
import {
  SPEED_MIN,
  SCORE_BOOST_PER_SEC,
  SCORE_TIME_LEFT_PER_SEC,
  OFFTRACK_TIME_PENALTY,
  SHIELD_GATE_RESTORE,
  SPINOUT_SPEED_KEEP,
  SPINOUT_TIME,
  SHIELD_MAX,
  SHIELD_REGEN_PER_SEC,
  TIMER_GATE_BONUS,
  TIMER_START,
} from './Tuning'
import { angleDelta } from '@apex/engine/math/scalar'
import { Vec3 } from '@apex/engine/math/Vec3'
import { Vehicle } from './player/Vehicle'
import { Track } from './track/Track'
import { makeFrame } from './track/TrackSpline'
import { Combat } from './combat/Combat'
import { Traffic } from './traffic/Traffic'

/** Per-run knobs presentation may set (VR comfort presets). Default = spec. */
export interface SimParams {
  /** Scales SPEED_MAX / SPEED_BOOST_MAX. */
  speedScale: number
  /** Scales LASER_AIM_CONE. */
  aimConeScale: number
}

export class SimWorld {
  readonly params: SimParams = { speedScale: 1, aimConeScale: 1 }
  readonly track: Track
  readonly vehicle = new Vehicle()
  readonly rng: Rng
  readonly events = new EventQueue()
  readonly combat: Combat
  readonly traffic: Traffic

  time = 0
  tickCount = 0
  phase: RunPhase = 'running'
  timer = TIMER_START
  score = 0
  shield = SHIELD_MAX
  invuln = 0
  gatesPassed = 0
  private nextGate = 0
  private boostCursor = 0
  private wasOnBoost = false
  private ringCursor = 0
  private readonly ringTaken: Uint8Array
  private readonly frame = makeFrame()
  private readonly vA = new Vec3()
  private readonly vB = new Vec3()

  constructor(track: Track, seed: number) {
    this.track = track
    this.rng = new Rng(seed)
    this.ringTaken = new Uint8Array(track.rings.length)
    this.traffic = new Traffic(track, seed, this.events)
    this.combat = new Combat(this.track, this.traffic, this.events)
    this.timer = track.course.timerStart ?? TIMER_START
    this.reset(seed)
  }

  reset(seed: number): void {
    this.rng.reseed(seed)
    this.vehicle.reset()
    this.time = 0
    this.tickCount = 0
    this.phase = 'running'
    this.timer = this.track.course.timerStart ?? TIMER_START
    this.score = 0
    this.shield = SHIELD_MAX
    this.invuln = 0
    this.gatesPassed = 0
    this.nextGate = 0
    this.boostCursor = 0
    this.wasOnBoost = false
    this.ringCursor = 0
    this.ringTaken.fill(0)
    this.events.clear()
    this.traffic.reset(seed)
    this.combat.reset()
  }

  tick(dt: number, input: InputFrame, out: SimSnapshot): void {
    const v = this.vehicle
    if (this.phase === 'running') {
      this.time += dt
      this.tickCount++
      this.timer -= dt
      if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt)

      // Boost strips: contact this tick.
      v.onBoost = !v.airborne && this.onBoostStrip(v.s, v.theta)
      if (v.onBoost && !this.wasOnBoost) this.events.push('boost_enter', v.pos)
      if (!v.onBoost && this.wasOnBoost) this.events.push('boost_exit', v.pos)
      this.wasOnBoost = v.onBoost
      if (v.onBoost) this.score += SCORE_BOOST_PER_SEC * dt

      v.tick(dt, input, this.track, this.params.speedScale, this.drainShieldBound)
      switch (v.event) {
        case 'launched':
          this.events.push('launch', v.pos)
          break
        case 'landed':
          this.events.push('land', v.pos, v.speed)
          break
        case 'fell':
          this.events.push('fall', v.pos)
          break
        case 'crashed':
          this.crash()
          break
      }
      if (v.scraping && (this.tickCount & 7) === 0) this.events.push('scrape', v.pos)

      // Passive shield regen.
      this.shield = Math.min(SHIELD_MAX, this.shield + SHIELD_REGEN_PER_SEC * dt)

      this.checkGates()
      this.checkRings()

      this.traffic.tick(dt, this)
      this.combat.tick(dt, input, this)

      if (this.phase === 'running') {
        if (v.s >= this.track.length) {
          this.phase = 'finished'
          this.score += Math.max(0, this.timer) * SCORE_TIME_LEFT_PER_SEC
          this.events.push('finish', v.pos)
        } else if (this.timer <= 0) {
          this.timer = 0
          this.phase = 'timeout'
          this.events.push('timeout', v.pos)
        }
      }
    } else {
      // Dead/finished: freeze gameplay, let presentation timers wind down.
      this.combat.coast(dt)
    }
    this.writeSnapshot(out)
  }

  /** Shield damage from any source. Zero shield + another hit = a spin-out, never a wreck. */
  damage(amount: number, pos: Vec3 | null, kind: 'collision' | 'shot' | 'scrape'): void {
    if (this.phase !== 'running') return
    if (this.invuln > 0 && kind !== 'scrape') return
    if (this.shield <= 0.5 && kind !== 'scrape') {
      this.spinOut(pos)
      return
    }
    this.shield = Math.max(0, this.shield - amount)
    if (kind !== 'scrape') this.events.push(kind === 'collision' ? 'collision' : 'hit', pos ?? this.vehicle.pos, amount)
  }

  private readonly drainShieldBound = (amount: number): void => {
    this.shield = Math.max(0, this.shield - amount)
  }

  readonly isRingTakenBound = (i: number): boolean => this.ringTaken[i] === 1

  /** The worst thing that can happen to you: a long spin and a lot of lost speed. */
  spinOut(pos: Vec3 | null): void {
    const v = this.vehicle
    v.speed = Math.max(SPEED_MIN * 0.6, v.speed * SPINOUT_SPEED_KEEP)
    v.spinTimer = SPINOUT_TIME
    v.spinDir = v.thetaVel >= 0 ? 1 : -1
    this.invuln = Math.max(this.invuln, SPINOUT_TIME + 0.4)
    this.events.push('spinout', pos ?? v.pos)
  }

  /** Leaving the track entirely (missed landing, fell off an edge): dropped back on it, minus a little time. */
  crash(): void {
    if (this.phase !== 'running') return
    this.vehicle.recoverOnTrack(this.track)
    this.timer = Math.max(0.5, this.timer - OFFTRACK_TIME_PENALTY)
    this.events.push('crash', this.vehicle.pos, OFFTRACK_TIME_PENALTY)
  }

  private onBoostStrip(s: number, theta: number): boolean {
    const boosts = this.track.boosts
    while (this.boostCursor < boosts.length && boosts[this.boostCursor].sEnd < s) this.boostCursor++
    for (let i = this.boostCursor; i < boosts.length; i++) {
      const b = boosts[i]
      if (b.sStart > s) break
      if (s >= b.sStart && s <= b.sEnd && Math.abs(angleDelta(b.theta, theta)) <= b.halfWidth) return true
    }
    return false
  }

  private checkGates(): void {
    const gates = this.track.gates
    while (this.nextGate < gates.length && this.vehicle.s >= gates[this.nextGate]) {
      this.nextGate++
      this.gatesPassed++
      this.timer += TIMER_GATE_BONUS
      this.shield = Math.min(SHIELD_MAX, this.shield + SHIELD_GATE_RESTORE)
      this.track.spline.positionAt(gates[this.nextGate - 1], this.vA)
      this.events.push('gate', this.vA, this.gatesPassed)
    }
  }

  private checkRings(): void {
    const rings = this.track.rings
    const v = this.vehicle
    while (this.ringCursor < rings.length && rings[this.ringCursor].s < v.s - 40) this.ringCursor++
    for (let i = this.ringCursor; i < rings.length; i++) {
      const r = rings[i]
      if (r.s > v.s + 40) break
      if (this.ringTaken[i]) continue
      if (Math.abs(r.s - v.s) < 6 && v.pos.distanceTo(r.pos) < r.radius) {
        this.ringTaken[i] = 1
        this.combat.awardRing(this)
        this.events.push('ring', r.pos)
      }
    }
  }

  isRingTaken(i: number): boolean {
    return this.ringTaken[i] === 1
  }

  private writeSnapshot(out: SimSnapshot): void {
    const v = this.vehicle
    out.time = this.time
    out.tick = this.tickCount
    out.phase = this.phase
    const vs = out.vehicle
    vs.pos.copy(v.pos)
    vs.forward.copy(v.forward)
    vs.up.copy(v.up)
    vs.right.copy(v.right)
    vs.s = v.s
    vs.theta = v.theta
    vs.speed = v.speed
    vs.bank = v.bank
    vs.spin = v.spinTimer
    vs.airborne = v.airborne
    vs.branch = v.branch
    vs.onBoost = v.onBoost
    vs.scraping = v.scraping
    vs.thetaVel = v.thetaVel
    const fr = this.track.frameAt(v.s, v.branch, this.frame)
    vs.radius = fr.radius
    vs.arc = fr.arc

    const h = out.hud
    h.shield = this.shield
    h.timer = this.timer
    h.score = Math.floor(this.score)
    h.gatesPassed = this.gatesPassed
    h.gatesTotal = this.track.gates.length
    h.progress = Math.min(1, v.s / this.track.length)
    h.invuln = this.invuln
    this.combat.writeSnapshot(out)
    this.traffic.writeSnapshot(out)
  }

  /** Scratch vector for systems that need one during a tick. */
  get scratch(): Vec3 {
    return this.vB
  }
}
