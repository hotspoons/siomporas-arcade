// Traffic: a fixed pool of agents (hostiles and pickups) living in track space,
// kept sorted by s for the broadphase, spawned deterministically from
// (seed, cell) so the same course always throws the same things at you.

import { EventQueue } from '../Events'
import { hash2, Rng } from '../Rng'
import { SimSnapshot, TRAFFIC_KIND_CODES, type TrafficKindCode } from '../SimSnapshot'
import { DESPAWN_BEHIND, MAX_PROJECTILES, MAX_TRAFFIC, SPAWN_CELL, SPAWN_LEAD, SPINNER_RATE, TRAFFIC_MAX_RANGE, TRAIN_CARS, TRAIN_CAR_LENGTH } from '../Tuning'
import { angleDelta, clamp, expApproach, TAU, wrapAngle } from '../math/scalar'
import { Vec3 } from '../math/Vec3'
import type { TrafficKind } from '../track/SegmentDesc'
import { Track } from '../track/Track'
import { makeFrame } from '../track/TrackSpline'
import type { SimWorld } from '../SimWorld'

export const KIND_INDEX: Record<TrafficKindCode, number> = Object.fromEntries(
  TRAFFIC_KIND_CODES.map((k, i) => [k, i]),
) as Record<TrafficKindCode, number>

interface KindDef {
  hp: number
  /** Collision radius, metres. */
  r: number
  /** Height off the wall. */
  hover: number
  hostile: boolean
  destructible: boolean
  /** Base forward speed along the track, m/s. */
  speed: number
}

export const KIND_DEFS: Record<TrafficKindCode, KindDef> = {
  DRONE: { hp: 20, r: 2.6, hover: 3.5, hostile: true, destructible: true, speed: 140 },
  BLOCKER: { hp: 70, r: 4.6, hover: 2.4, hostile: true, destructible: true, speed: 0 },
  MINE: { hp: 10, r: 2.2, hover: 3.2, hostile: true, destructible: true, speed: 0 },
  INTERCEPTOR: { hp: 45, r: 2.8, hover: 4.5, hostile: true, destructible: true, speed: 0 },
  ARMORED: { hp: 220, r: 3.8, hover: 3.0, hostile: true, destructible: true, speed: 190 },
  GATE_BOSS: { hp: 650, r: 6.5, hover: 8, hostile: true, destructible: true, speed: 0 },
  TRAIN: { hp: 1e9, r: 3.4, hover: 3.0, hostile: true, destructible: false, speed: 205 },
  LIGHTBIKE: { hp: 1e9, r: 1.7, hover: 1.4, hostile: true, destructible: false, speed: 0 },
  HAULER: { hp: 150, r: 4.4, hover: 3.2, hostile: true, destructible: true, speed: 110 },
  SWARM: { hp: 8, r: 1.5, hover: 4.2, hostile: true, destructible: true, speed: 150 },
  TURRET: { hp: 55, r: 2.4, hover: 1.8, hostile: true, destructible: true, speed: 0 },
  SPINNER: { hp: 1e9, r: 2.5, hover: 2.5, hostile: true, destructible: false, speed: 0 },
  POD_SHOCK: { hp: 1, r: 3.2, hover: 3.2, hostile: false, destructible: false, speed: 0 },
  POD_SHIELD: { hp: 1, r: 3.2, hover: 3.2, hostile: false, destructible: false, speed: 0 },
  RING: { hp: 1, r: 7, hover: 0, hostile: false, destructible: false, speed: 0 },
}

const DEFAULT_MIX: Record<TrafficKind, number> = {
  DRONE: 5,
  BLOCKER: 3,
  MINE: 3,
  INTERCEPTOR: 0,
  ARMORED: 0,
  GATE_BOSS: 0,
  TRAIN: 0,
  LIGHTBIKE: 0,
  HAULER: 0,
  SWARM: 0,
  TURRET: 0,
  SPINNER: 0,
}
/** Light-cycles hold this far ahead and weave. */
const LIGHTBIKE_HOLD_DISTANCE = 150
const TURRET_FIRE_PERIOD = 2.0
const TURRET_RANGE = 650
const MIX_KEYS = Object.keys(DEFAULT_MIX) as TrafficKind[]

/** Interceptor / boss fire cadence, seconds. */
const INTERCEPTOR_FIRE_PERIOD = 1.6
const BOSS_FIRE_PERIOD = 0.9
/** How far ahead of the player an interceptor tries to hold. */
const INTERCEPTOR_HOLD_DISTANCE = 260
const BOSS_HOLD_DISTANCE = 320
/** Projectile speed relative to the player, m/s (toward the player). */
const PROJECTILE_CLOSING_SPEED = 260
const PROJECTILE_HIT_S = 4.5
const PROJECTILE_HIT_LATERAL = 2.6
/** Radius within which a dying mine detonates its neighbours. */
const MINE_CHAIN_RADIUS = 16
const MINE_CHAIN_DELAY = 0.08

export class Agent {
  active = false
  id = 0
  kind = 0
  s = 0
  theta = 0
  speed = 0
  thetaVel = 0
  hp = 1
  hpMax = 1
  r = 1
  hover = 1
  branch = 0
  timer = 0
  anim = 0
  flash = 99
  /** Pending chain-detonation fuse for mines; <0 = none. */
  fuse = -1
  /** Behaviour anchor (spawn theta for weavers, formation phase for swarms). */
  theta0 = 0
  phase = 0
  readonly pos = new Vec3()
}

class Projectile {
  active = false
  s = 0
  theta = 0
  /** Speed along s, absolute m/s (player-relative closing applied per tick). */
  vs = 0
  branch = 0
  readonly pos = new Vec3()
}

export class Traffic {
  readonly agents: Agent[] = []
  /** Indices of active agents sorted by s. */
  readonly order = new Int32Array(MAX_TRAFFIC)
  orderCount = 0
  readonly projectiles: Projectile[] = []

  private readonly track: Track
  private readonly events: EventQueue
  private readonly rng: Rng
  private seed: number
  private nextId = 1
  private spawnedCell = -1
  private pickupCursor = 0
  private bossCursor = 0
  private readonly frame = makeFrame()
  private readonly vA = new Vec3()
  private readonly weights = new Float32Array(MIX_KEYS.length)

  constructor(track: Track, seed: number, events: EventQueue) {
    this.track = track
    this.events = events
    this.seed = seed
    this.rng = new Rng(seed ^ 0x51ed)
    for (let i = 0; i < MAX_TRAFFIC; i++) this.agents.push(new Agent())
    for (let i = 0; i < MAX_PROJECTILES; i++) this.projectiles.push(new Projectile())
  }

  reset(seed: number): void {
    this.seed = seed
    this.rng.reseed(seed ^ 0x51ed)
    for (const a of this.agents) a.active = false
    for (const p of this.projectiles) p.active = false
    this.orderCount = 0
    this.nextId = 1
    this.spawnedCell = -1
    this.pickupCursor = 0
    this.bossCursor = 0
  }

  // ---------------------------------------------------------------------------

  tick(dt: number, world: SimWorld): void {
    const v = world.vehicle
    this.spawnAhead(v.s)
    this.updateAgents(dt, world)
    this.updateProjectiles(dt, world)
    this.sortOrder()
  }

  private spawnAhead(playerS: number): void {
    const track = this.track
    // Hand-placed pickups and bosses first: they must never lose a slot to filler.
    const pickups = track.pickups
    while (this.pickupCursor < pickups.length && pickups[this.pickupCursor].s < playerS + SPAWN_LEAD) {
      const p = pickups[this.pickupCursor++]
      this.spawn(p.pickup, p.s, p.theta, 0)
    }
    const bosses = track.bosses
    while (this.bossCursor < bosses.length && bosses[this.bossCursor] < playerS + SPAWN_LEAD) {
      const s = bosses[this.bossCursor++]
      const a = this.spawn('GATE_BOSS', s, 0, 0)
      if (a) this.events.push('boss_spawn', a.pos)
    }
    const lastCell = Math.floor((playerS + SPAWN_LEAD) / SPAWN_CELL)
    const leadCells = Math.ceil(SPAWN_LEAD / SPAWN_CELL)
    // First tick, or a teleport: only ever fill the lead window, never the whole course.
    if (this.spawnedCell < 0 || lastCell - this.spawnedCell > leadCells + 4) this.spawnedCell = Math.max(this.spawnedCell, lastCell - leadCells + 2)
    while (this.spawnedCell < lastCell) {
      this.spawnedCell++
      const cell = this.spawnedCell
      const s = cell * SPAWN_CELL + SPAWN_CELL * 0.5
      if (s >= track.length - 60) continue
      const seg = track.segmentAt(s)
      if (seg.type === 'GAP' || seg.type === 'GATE') continue
      const h = hash2(this.seed, cell)
      const roll = (h & 0xffff) / 65536
      const roll2 = ((h >>> 16) & 0xffff) / 65536
      const arc = this.track.frameAt(s, 0, this.frame).arc
      const spread = Math.min(arc - 0.25, Math.PI)
      // Pickups: rare, independent of difficulty so easy stretches still feed you.
      if (roll2 < 0.035) {
        const kind: TrafficKindCode = roll2 < 0.012 ? 'POD_SHOCK' : 'POD_SHIELD'
        this.spawn(kind, s, (roll * 2 - 1) * spread, 0)
        continue
      }
      if (seg.difficulty <= 0 || roll > seg.difficulty * 0.92) continue
      const mix = seg.mix ?? DEFAULT_MIX
      const weights = this.weights
      let total = 0
      for (let k = 0; k < MIX_KEYS.length; k++) {
        weights[k] = mix[MIX_KEYS[k]] ?? 0
        total += weights[k]
      }
      if (total <= 0) continue
      let pick = roll2 * total
      let ki = 0
      for (; ki < MIX_KEYS.length - 1; ki++) {
        pick -= weights[ki]
        if (pick < 0) break
      }
      const kind = MIX_KEYS[ki]
      const theta = (((h >>> 8) & 0xffff) / 65536) * 2 * spread - spread
      if (kind === 'MINE') {
        // Mines come in clusters.
        const count = 3 + (h % 3)
        for (let i = 0; i < count; i++) {
          const hh = hash2(h, i)
          this.spawn('MINE', s + ((hh & 0xff) / 255 - 0.5) * 22, theta + (((hh >>> 8) & 0xff) / 255 - 0.5) * 0.7, 0)
        }
      } else if (kind === 'BLOCKER') {
        this.spawn('BLOCKER', s, theta * 0.5, 0)
      } else if (kind === 'SWARM') {
        for (let i = 0; i < 4; i++) {
          const a = this.spawn('SWARM', s + i * 6, theta, 0)
          if (a) a.phase = (i * Math.PI) / 2
        }
      } else if (kind === 'TRAIN') {
        const a = this.spawn('TRAIN', s, theta * 0.6, 0)
        if (a) this.events.push('train', a.pos)
      } else {
        this.spawn(kind, s, theta, 0)
      }
      // Splits: mirror onto branch 1 so both routes have traffic.
      if (seg.type === 'SPLIT') this.spawn(kind === 'MINE' ? 'DRONE' : kind, s, -theta, 1)
    }
  }

  spawn(kind: TrafficKindCode, s: number, theta: number, branch: number): Agent | null {
    let a: Agent | null = null
    for (const cand of this.agents) {
      if (!cand.active) {
        a = cand
        break
      }
    }
    if (!a) return null
    const def = KIND_DEFS[kind]
    a.active = true
    a.id = this.nextId++
    a.kind = KIND_INDEX[kind]
    a.s = s
    a.theta = wrapAngle(theta)
    a.speed = def.speed
    a.thetaVel = 0
    a.hp = def.hp
    a.hpMax = def.hp
    a.r = def.r
    a.hover = def.hover
    a.branch = branch
    a.timer = this.rng.range(0, 1)
    a.anim = this.rng.range(0, TAU)
    a.flash = 99
    a.fuse = -1
    a.theta0 = a.theta
    a.phase = 0
    this.placeAgent(a)
    return a
  }

  private placeAgent(a: Agent): void {
    this.track.surfacePoint(a.s, a.theta, a.hover, a.branch, a.pos)
  }

  private updateAgents(dt: number, world: SimWorld): void {
    const v = world.vehicle
    for (const a of this.agents) {
      if (!a.active) continue
      a.anim += dt
      a.flash += dt
      // Recycle: far behind, or far ahead (only possible after a shockwave clears space).
      const tail = a.kind === KIND_INDEX.TRAIN ? TRAIN_CARS * TRAIN_CAR_LENGTH : 0
      if (a.s + tail < v.s - DESPAWN_BEHIND || a.s > v.s + TRAFFIC_MAX_RANGE) {
        a.active = false
        continue
      }
      if (a.fuse >= 0) {
        a.fuse -= dt
        if (a.fuse < 0) {
          this.kill(a, world, false)
          continue
        }
      }
      const kind = TRAFFIC_KIND_CODES[a.kind]
      switch (kind) {
        case 'DRONE':
          a.s += a.speed * dt
          a.theta = wrapAngle(a.theta + Math.sin(a.anim * 1.7) * 0.9 * dt)
          break
        case 'ARMORED':
          a.s += a.speed * dt
          break
        case 'MINE':
          a.theta = wrapAngle(a.theta + Math.sin(a.anim * 0.8) * 0.15 * dt)
          break
        case 'INTERCEPTOR': {
          // Hold a distance ahead, match the player's theta with lag, fire back.
          const want = v.s + INTERCEPTOR_HOLD_DISTANCE
          a.speed = clamp(v.speed + (want - a.s) * 0.8, 60, 520)
          a.s += a.speed * dt
          const d = angleDelta(a.theta, v.theta)
          a.thetaVel = expApproach(a.thetaVel, clamp(d * 2.2, -2.2, 2.2), 4, dt)
          a.theta = wrapAngle(a.theta + a.thetaVel * dt)
          a.timer -= dt
          if (a.timer <= 0 && a.s - v.s < 500) {
            a.timer = INTERCEPTOR_FIRE_PERIOD
            this.fire(a, world)
          }
          break
        }
        case 'GATE_BOSS': {
          const want = v.s + BOSS_HOLD_DISTANCE
          a.speed = clamp(v.speed + (want - a.s) * 1.2, 0, 560)
          a.s += a.speed * dt
          a.theta = wrapAngle(Math.sin(a.anim * 0.9) * 1.1)
          a.timer -= dt
          if (a.timer <= 0) {
            a.timer = BOSS_FIRE_PERIOD
            this.fire(a, world)
            this.fire(a, world, 0.35)
            this.fire(a, world, -0.35)
          }
          break
        }
        case 'TRAIN':
          a.s += a.speed * dt
          break
        case 'HAULER':
          a.s += a.speed * dt
          a.theta = wrapAngle(a.theta0 + Math.sin(a.anim * 0.5) * 0.15)
          break
        case 'LIGHTBIKE': {
          // Indestructible, fast, weaving across the lane it was born in.
          const want = v.s + LIGHTBIKE_HOLD_DISTANCE
          a.speed = clamp(v.speed + (want - a.s) * 0.9, 80, 560)
          a.s += a.speed * dt
          a.theta = wrapAngle(a.theta0 + Math.sin(a.anim * 2.6) * 1.0)
          break
        }
        case 'SWARM':
          a.s += (a.speed + Math.sin(a.anim * 3 + a.phase) * 25) * dt
          a.theta = wrapAngle(a.theta0 + Math.sin(a.anim * 4 + a.phase) * 0.6)
          break
        case 'TURRET':
          a.timer -= dt
          if (a.timer <= 0 && a.s - v.s < TURRET_RANGE && a.s > v.s) {
            a.timer = TURRET_FIRE_PERIOD
            this.fire(a, world)
          }
          break
        case 'SPINNER':
          a.theta = wrapAngle(a.theta + SPINNER_RATE * dt)
          break
        default:
          break
      }
      // Keep the agent inside whatever profile it is over (spinners sweep the whole tube).
      const clampAngle = this.track.clampAt(a.s, a.branch)
      if (Number.isFinite(clampAngle) && kind !== 'SPINNER') a.theta = clamp(a.theta, -clampAngle + 0.05, clampAngle - 0.05)
      this.placeAgent(a)
    }
  }

  private fire(from: Agent, world: SimWorld, thetaOffset = 0): void {
    for (const p of this.projectiles) {
      if (p.active) continue
      p.active = true
      p.s = from.s - from.r
      p.theta = wrapAngle(world.vehicle.theta + thetaOffset + (world.vehicle.thetaVel * 0.25))
      p.vs = world.vehicle.speed - PROJECTILE_CLOSING_SPEED
      p.branch = from.branch
      this.track.surfacePoint(p.s, p.theta, 4, p.branch, p.pos)
      this.events.push('enemy_shot', from.pos)
      return
    }
  }

  private updateProjectiles(dt: number, world: SimWorld): void {
    const v = world.vehicle
    for (const p of this.projectiles) {
      if (!p.active) continue
      const sPrev = p.s
      p.s += p.vs * dt
      if (p.s < v.s - 30 || p.s > v.s + 900) {
        p.active = false
        continue
      }
      this.track.surfacePoint(p.s, p.theta, 4, p.branch, p.pos)
      if (v.airborne || v.branch !== p.branch) continue
      // Swept along s: the shot passed through the craft's s this tick?
      const lo = Math.min(sPrev, p.s) - PROJECTILE_HIT_S
      const hi = Math.max(sPrev, p.s) + PROJECTILE_HIT_S
      if (v.s >= lo && v.s <= hi) {
        const radius = this.track.frameAt(v.s, v.branch, this.frame).radius
        if (Math.abs(angleDelta(p.theta, v.theta)) * radius < PROJECTILE_HIT_LATERAL) {
          p.active = false
          world.damage(world.combat.enemyShotCost(), p.pos, 'shot')
        }
      }
    }
  }

  /** Insertion sort of active indices by s — nearly sorted every tick. */
  private sortOrder(): void {
    let n = 0
    for (let i = 0; i < this.agents.length; i++) if (this.agents[i].active) this.order[n++] = i
    this.orderCount = n
    const ag = this.agents
    for (let i = 1; i < n; i++) {
      const idx = this.order[i]
      const key = ag[idx].s
      let j = i - 1
      while (j >= 0 && ag[this.order[j]].s > key) {
        this.order[j + 1] = this.order[j]
        j--
      }
      this.order[j + 1] = idx
    }
  }

  /** First position in `order` whose s >= value. */
  lowerBound(sValue: number): number {
    let lo = 0
    let hi = this.orderCount
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.agents[this.order[mid]].s < sValue) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Apply damage; returns true if the agent died. */
  damage(a: Agent, amount: number, world: SimWorld, byPlayer: boolean): boolean {
    const def = KIND_DEFS[TRAFFIC_KIND_CODES[a.kind]]
    if (!def.destructible) return false
    a.hp -= amount
    a.flash = 0
    if (a.hp <= 0) {
      this.kill(a, world, byPlayer)
      return true
    }
    return false
  }

  kill(a: Agent, world: SimWorld, byPlayer: boolean): void {
    if (!a.active) return
    a.active = false
    const kind = TRAFFIC_KIND_CODES[a.kind]
    this.events.push('kill', a.pos, a.kind, byPlayer ? 1 : 0)
    if (kind === 'GATE_BOSS') this.events.push('boss_dead', a.pos)
    if (byPlayer) world.combat.onKill(kind, world)
    if (kind === 'HAULER') this.spawn('POD_SHIELD', a.s + 25, a.theta, a.branch)
    if (kind === 'MINE') {
      // Chain reaction: light the fuse on neighbours.
      for (const b of this.agents) {
        if (!b.active || b === a || b.fuse >= 0) continue
        if (TRAFFIC_KIND_CODES[b.kind] !== 'MINE') continue
        if (Math.abs(b.s - a.s) < MINE_CHAIN_RADIUS && a.pos.distanceTo(b.pos) < MINE_CHAIN_RADIUS) {
          b.fuse = MINE_CHAIN_DELAY
          // Credit the player for the chain.
          b.hp = byPlayer ? 0 : b.hp
        }
      }
    }
  }

  /** Remove a pickup silently after collection. */
  consume(a: Agent): void {
    a.active = false
  }

  writeSnapshot(out: SimSnapshot): void {
    let count = 0
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i]
      out.trafficActive[i] = a.active ? 1 : 0
      if (!a.active) continue
      count++
      out.trafficId[i] = a.id
      out.trafficKind[i] = a.kind
      out.trafficPos[i * 3] = a.pos.x
      out.trafficPos[i * 3 + 1] = a.pos.y
      out.trafficPos[i * 3 + 2] = a.pos.z
      out.trafficS[i] = a.s
      out.trafficTheta[i] = a.theta
      out.trafficBranch[i] = a.branch
      const f = this.track.frameAt(a.s, a.branch, this.frame)
      Track.radial(f, a.theta, this.vA)
      out.trafficUp[i * 3] = -this.vA.x
      out.trafficUp[i * 3 + 1] = -this.vA.y
      out.trafficUp[i * 3 + 2] = -this.vA.z
      out.trafficFwd[i * 3] = f.tan.x
      out.trafficFwd[i * 3 + 1] = f.tan.y
      out.trafficFwd[i * 3 + 2] = f.tan.z
      out.trafficHp[i] = a.hp / a.hpMax
      out.trafficAnim[i] = a.anim
      out.trafficFlash[i] = a.flash
    }
    out.trafficCount = count
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i]
      out.projActive[i] = p.active ? 1 : 0
      if (!p.active) continue
      out.projPos[i * 3] = p.pos.x
      out.projPos[i * 3 + 1] = p.pos.y
      out.projPos[i * 3 + 2] = p.pos.z
    }
  }
}
