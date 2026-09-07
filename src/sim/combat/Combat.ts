// Weapons, shield bookkeeping, player-vs-traffic collision, score and combo.
// The laser is hitscan with a soft auto-aim cone; the shockwave clears the
// screen; collisions are swept in (s, lateral) so nothing tunnels at 500 m/s.

import { EventQueue } from '../Events'
import type { InputFrame } from '../InputFrame'
import { SimSnapshot, TRAFFIC_KIND_CODES, type TrafficKindCode } from '../SimSnapshot'
import {
  COLLISION_SHIELD_COST,
  COLLISION_SPEED_KEEP,
  COLLISION_INVULN,
  COMBO_MAX,
  COMBO_STEP,
  ENEMY_SHOT_SHIELD_COST,
  KILL_STREAK_FOR_CHARGE,
  KILL_STREAK_WINDOW,
  LASER_AIM_CONE,
  LASER_COOL_PER_SEC,
  LASER_DPS,
  LASER_HEAT_MAX,
  LASER_HEAT_PER_SEC,
  LASER_OVERHEAT_LOCK,
  LASER_RANGE,
  SCORE_PER_KILL,
  SCORE_RING,
  SHIELD_MAX,
  SHIELD_POD_RESTORE,
  SHOCKWAVE_INVULN,
  SHOCKWAVE_MAX_CHARGES,
  SHOCKWAVE_RADIUS,
  SHOCKWAVE_START_CHARGES,
  SHOCK_BIKE_SHOVE,
  SPINNER_HALF_ARC,
  TRAIN_CARS,
  TRAIN_CAR_LENGTH,
  VEHICLE_HALF_LENGTH,
  VEHICLE_HALF_WIDTH,
  VEHICLE_HOVER,
} from '../Tuning'
import { angleDelta, clamp } from '../math/scalar'
import { Vec3 } from '../math/Vec3'
import { Track } from '../track/Track'
import { makeFrame } from '../track/TrackSpline'
import { KIND_DEFS, Traffic, type Agent } from '../traffic/Traffic'
import type { SimWorld } from '../SimWorld'

/** Slow-motion the sim asks presentation for after a shockwave. */
const SHOCK_SLOWMO_SCALE = 0.35
const SHOCK_SLOWMO_TIME = 0.4
/** Boss damage from a shockwave (they are not cleared outright). */
const SHOCK_BOSS_DAMAGE = 180
/** Where the beam ends when nothing is targeted: this far along the track. */
const LASER_IDLE_REACH = 240
/** Beam origin: roof-mounted, so above the craft's belly. */
const LASER_MOUNT_HEIGHT = VEHICLE_HOVER + 1.2

export class Combat {
  heat = 0
  lockTimer = 0
  charges = SHOCKWAVE_START_CHARGES
  streak = 0
  streakTimer = 0
  kills = 0
  shockAge = -1
  slowmoTimer = 0
  private prevS = 0
  private prevTheta = 0
  private firing = false
  private hit = false
  private target: Agent | null = null
  private readonly beamFrom = new Vec3()
  private readonly beamTo = new Vec3()
  private readonly shockOrigin = new Vec3()
  private readonly frame = makeFrame()
  private readonly vA = new Vec3()
  private readonly track: Track
  private readonly traffic: Traffic
  private readonly events: EventQueue

  constructor(track: Track, traffic: Traffic, events: EventQueue) {
    this.track = track
    this.traffic = traffic
    this.events = events
  }

  reset(): void {
    this.heat = 0
    this.lockTimer = 0
    this.charges = SHOCKWAVE_START_CHARGES
    this.streak = 0
    this.streakTimer = 0
    this.kills = 0
    this.shockAge = -1
    this.slowmoTimer = 0
    this.prevS = 0
    this.prevTheta = 0
    this.firing = false
    this.hit = false
    this.target = null
  }

  get combo(): number {
    return Math.min(COMBO_MAX, 1 + this.streak * COMBO_STEP)
  }

  enemyShotCost(): number {
    return ENEMY_SHOT_SHIELD_COST
  }

  tick(dt: number, input: InputFrame, world: SimWorld): void {
    const v = world.vehicle
    this.coast(dt)
    if (this.streakTimer > 0) {
      this.streakTimer -= dt
      if (this.streakTimer <= 0) this.streak = 0
    }
    this.collide(world)
    this.laser(dt, input, world)
    if (input.shockwave) this.shockwave(world)
    this.prevS = v.s
    this.prevTheta = v.theta
  }

  /** Timers that keep running while dead/finished so VFX wind down. */
  coast(dt: number): void {
    if (this.shockAge >= 0) this.shockAge += dt
    if (this.shockAge > 3) this.shockAge = -1
    if (this.slowmoTimer > 0) this.slowmoTimer = Math.max(0, this.slowmoTimer - dt)
  }

  // ---------------------------------------------------------------------------

  private collide(world: SimWorld): void {
    const v = world.vehicle
    if (v.airborne) {
      this.prevS = v.s
      return
    }
    const traffic = this.traffic
    const s0 = Math.min(this.prevS, v.s) - VEHICLE_HALF_LENGTH
    const s1 = Math.max(this.prevS, v.s) + VEHICLE_HALF_LENGTH
    const radius = this.track.frameAt(v.s, v.branch, this.frame).radius
    const margin = 8
    let i = traffic.lowerBound(s0 - margin)
    for (; i < traffic.orderCount; i++) {
      const a = traffic.agents[traffic.order[i]]
      if (a.s > s1 + margin) break
      if (a.branch !== v.branch) continue
      const kind = TRAFFIC_KIND_CODES[a.kind]
      // Swept capsule: the craft's path this tick in (s, lateral) space.
      const y0 = angleDelta(a.theta, this.prevTheta) * radius
      const y1 = angleDelta(a.theta, v.theta) * radius
      let hit = false
      if (kind === 'TRAIN') {
        // One agent, TRAIN_CARS bodies trailing behind the head.
        for (let k = 0; k < TRAIN_CARS && !hit; k++) {
          const cs = a.s - k * TRAIN_CAR_LENGTH
          hit = segmentPointDistance(this.prevS - VEHICLE_HALF_LENGTH, y0, v.s + VEHICLE_HALF_LENGTH, y1, cs, 0) <= a.r + VEHICLE_HALF_WIDTH
        }
      } else if (kind === 'SPINNER') {
        // A bar sweeping around the tube: thin along s, wide in theta.
        const ds = Math.abs(a.s - v.s)
        hit = ds < 3 + VEHICLE_HALF_LENGTH && Math.abs(y1) < SPINNER_HALF_ARC * radius + VEHICLE_HALF_WIDTH
      } else {
        hit = segmentPointDistance(this.prevS - VEHICLE_HALF_LENGTH, y0, v.s + VEHICLE_HALF_LENGTH, y1, a.s, 0) <= a.r + VEHICLE_HALF_WIDTH
      }
      if (!hit) continue
      const def = KIND_DEFS[kind]
      if (!def.hostile) {
        this.pickup(kind, a, world)
        continue
      }
      // Hostile contact. Slow, spin, cost shield — never stop.
      const spinDir = angleDelta(a.theta, v.theta) >= 0 ? 1 : -1
      if (world.invuln <= 0) {
        world.damage(COLLISION_SHIELD_COST, a.pos, 'collision')
        if (world.phase !== 'running') return
        v.applyCollision(COLLISION_SPEED_KEEP, spinDir)
        world.invuln = Math.max(world.invuln, COLLISION_INVULN)
      }
      if (kind === 'ARMORED' || kind === 'GATE_BOSS') {
        traffic.damage(a, 30, world, false)
      } else if (def.destructible) {
        traffic.kill(a, world, false)
      }
      // Trains, light-cycles and spinners shrug it off.
    }
  }

  private pickup(kind: TrafficKindCode, a: Agent, world: SimWorld): void {
    if (kind === 'POD_SHOCK') {
      this.charges = Math.min(SHOCKWAVE_MAX_CHARGES, this.charges + 1)
      this.events.push('pickup', a.pos, 0)
    } else if (kind === 'POD_SHIELD') {
      world.shield = Math.min(SHIELD_MAX, world.shield + SHIELD_POD_RESTORE)
      this.events.push('pickup', a.pos, 1)
    }
    this.traffic.consume(a)
  }

  private laser(dt: number, input: InputFrame, world: SimWorld): void {
    const v = world.vehicle
    this.hit = false
    this.target = null
    if (this.lockTimer > 0) {
      this.lockTimer -= dt
      this.heat = Math.max(0, this.heat - LASER_COOL_PER_SEC * dt)
      this.firing = false
      return
    }
    this.firing = input.fire && !v.airborne
    if (!this.firing) {
      this.heat = Math.max(0, this.heat - LASER_COOL_PER_SEC * dt)
      return
    }
    this.heat += LASER_HEAT_PER_SEC * dt
    if (this.heat >= LASER_HEAT_MAX) {
      this.heat = LASER_HEAT_MAX
      this.lockTimer = LASER_OVERHEAT_LOCK
      this.firing = false
      this.events.push('overheat', v.pos)
      return
    }
    // Beam origin on the roof.
    const f = this.track.frameAt(v.s, v.branch, this.frame)
    Track.surfaceFromFrame(f, v.theta, LASER_MOUNT_HEIGHT, this.beamFrom, this.vA)
    const radius = f.radius
    // Auto-aim: nearest hostile inside the cone ahead.
    const traffic = this.traffic
    let best: Agent | null = null
    let bestDist = Infinity
    for (let i = traffic.lowerBound(v.s + 2); i < traffic.orderCount; i++) {
      const a = traffic.agents[traffic.order[i]]
      const dx = a.s - v.s
      if (dx > LASER_RANGE) break
      if (a.branch !== v.branch) continue
      const kind = TRAFFIC_KIND_CODES[a.kind]
      const def = KIND_DEFS[kind]
      // Auto-aim only wants things it can actually hurt.
      if (!def.hostile || !def.destructible) continue
      const lateral = Math.abs(angleDelta(v.theta, a.theta)) * radius
      // Generous near, tighter far: cone plus the target's own radius.
      const angle = Math.atan2(Math.max(0, lateral - a.r), dx)
      if (angle > LASER_AIM_CONE * world.params.aimConeScale) continue
      if (dx < bestDist) {
        bestDist = dx
        best = a
      }
    }
    if (best) {
      this.target = best
      this.hit = true
      this.beamTo.copy(best.pos)
      this.traffic.damage(best, LASER_DPS * dt, world, true)
      if ((world.tickCount & 3) === 0) this.events.push('shot_fired', best.pos, 1)
    } else {
      this.track.surfacePoint(v.s + LASER_IDLE_REACH, v.theta, LASER_MOUNT_HEIGHT + 2, v.branch, this.beamTo)
      if ((world.tickCount & 7) === 0) this.events.push('shot_fired', this.beamTo, 0)
    }
  }

  private shockwave(world: SimWorld): void {
    if (this.charges <= 0) return
    this.charges--
    const v = world.vehicle
    this.shockAge = 0
    this.shockOrigin.copy(v.pos)
    this.slowmoTimer = SHOCK_SLOWMO_TIME
    world.invuln = Math.max(world.invuln, SHOCKWAVE_INVULN)
    const traffic = this.traffic
    // Iterate a copy of the window: kills mutate `active` but not `order` mid-tick.
    const start = traffic.lowerBound(v.s - 30)
    for (let i = start; i < traffic.orderCount; i++) {
      const a = traffic.agents[traffic.order[i]]
      if (!a.active) continue
      if (a.s > v.s + SHOCKWAVE_RADIUS) break
      const kind = TRAFFIC_KIND_CODES[a.kind]
      if (!KIND_DEFS[kind].hostile) continue
      if (kind === 'GATE_BOSS') traffic.damage(a, SHOCK_BOSS_DAMAGE, world, true)
      else if (kind === 'LIGHTBIKE') a.s += SHOCK_BIKE_SHOVE
      else if (KIND_DEFS[kind].destructible) traffic.kill(a, world, true)
    }
    for (const p of traffic.projectiles) p.active = false
    this.events.push('shockwave', v.pos)
  }

  onKill(kind: TrafficKindCode, world: SimWorld): void {
    this.kills++
    this.streak++
    this.streakTimer = KILL_STREAK_WINDOW
    const base = SCORE_PER_KILL[kind] ?? 100
    world.score += base * this.combo
    if (this.streak > 1 && this.streak % 4 === 0) this.events.push('combo', world.vehicle.pos, this.streak)
    if (this.streak % KILL_STREAK_FOR_CHARGE === 0 && this.charges < SHOCKWAVE_MAX_CHARGES) {
      this.charges++
      this.events.push('charge_earned', world.vehicle.pos)
    }
  }

  awardRing(world: SimWorld): void {
    world.score += SCORE_RING * this.combo
  }

  writeSnapshot(out: SimSnapshot): void {
    const h = out.hud
    h.heat = this.heat
    h.heatLocked = this.lockTimer > 0
    h.charges = this.charges
    h.combo = this.combo
    h.kills = this.kills
    out.laserFiring = this.firing
    out.laserHit = this.hit
    out.laserFrom.copy(this.beamFrom)
    out.laserTo.copy(this.beamTo)
    out.laserTarget = this.target ? this.traffic.agents.indexOf(this.target) : -1
    out.shockAge = this.shockAge
    out.shockOrigin.copy(this.shockOrigin)
    out.timeScale = this.slowmoTimer > 0 ? SHOCK_SLOWMO_SCALE : 1
  }
}

/** Distance from point (px, py) to the segment (ax, ay)-(bx, by). */
function segmentPointDistance(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = 0
  if (len2 > 1e-9) t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1)
  const cx = ax + dx * t - px
  const cy = ay + dy * t - py
  return Math.sqrt(cx * cx + cy * cy)
}
