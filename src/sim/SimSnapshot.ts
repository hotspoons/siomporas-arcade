// The POD the renderer, HUD and audio read. Pre-allocated once, written by
// SimWorld at the end of every tick, double-buffered by the loop so the render
// can interpolate between the previous and current tick. Nothing in here is a
// reference into live sim objects — it is a copy, by design.

import { MAX_PROJECTILES, MAX_TRAFFIC } from './Tuning'
import { Vec3 } from './math/Vec3'

export type RunPhase = 'running' | 'crashed' | 'timeout' | 'finished'

export interface VehicleSnap {
  pos: Vec3
  forward: Vec3
  up: Vec3
  right: Vec3
  s: number
  theta: number
  speed: number
  bank: number
  spin: number
  airborne: boolean
  branch: number
  onBoost: boolean
  scraping: boolean
  radius: number
  /** Geometry half-angle at s (π = closed tube). */
  arc: number
  thetaVel: number
}

export interface HudSnap {
  shield: number
  heat: number
  heatLocked: boolean
  charges: number
  timer: number
  score: number
  combo: number
  gatesPassed: number
  gatesTotal: number
  progress: number
  invuln: number
  kills: number
}

/** Kind codes shared with the render layer; see TRAFFIC_KIND_CODES. */
export const TRAFFIC_KIND_CODES = ['DRONE', 'BLOCKER', 'MINE', 'INTERCEPTOR', 'ARMORED', 'GATE_BOSS', 'POD_SHOCK', 'POD_SHIELD', 'RING'] as const
export type TrafficKindCode = (typeof TRAFFIC_KIND_CODES)[number]

export class SimSnapshot {
  time = 0
  tick = 0
  phase: RunPhase = 'running'
  readonly vehicle: VehicleSnap = {
    pos: new Vec3(),
    forward: new Vec3(0, 0, 1),
    up: new Vec3(0, 1, 0),
    right: new Vec3(1, 0, 0),
    s: 0,
    theta: 0,
    speed: 0,
    bank: 0,
    spin: 0,
    airborne: false,
    branch: 0,
    onBoost: false,
    scraping: false,
    radius: 14,
    arc: Math.PI,
    thetaVel: 0,
  }
  readonly hud: HudSnap = {
    shield: 100,
    heat: 0,
    heatLocked: false,
    charges: 3,
    timer: 60,
    score: 0,
    combo: 1,
    gatesPassed: 0,
    gatesTotal: 0,
    progress: 0,
    invuln: 0,
    kills: 0,
  }

  // Traffic: slot-indexed so prev/curr line up for interpolation.
  trafficCount = 0
  readonly trafficActive = new Uint8Array(MAX_TRAFFIC)
  readonly trafficId = new Int32Array(MAX_TRAFFIC)
  readonly trafficKind = new Uint8Array(MAX_TRAFFIC)
  readonly trafficPos = new Float32Array(MAX_TRAFFIC * 3)
  readonly trafficUp = new Float32Array(MAX_TRAFFIC * 3)
  readonly trafficFwd = new Float32Array(MAX_TRAFFIC * 3)
  readonly trafficHp = new Float32Array(MAX_TRAFFIC)
  /** Per-agent phase for idle animation. */
  readonly trafficAnim = new Float32Array(MAX_TRAFFIC)
  /** Seconds since last hit (for hit flash), large when never hit. */
  readonly trafficFlash = new Float32Array(MAX_TRAFFIC)

  readonly projActive = new Uint8Array(MAX_PROJECTILES)
  readonly projPos = new Float32Array(MAX_PROJECTILES * 3)

  // Laser beam this tick.
  laserFiring = false
  laserHit = false
  readonly laserFrom = new Vec3()
  readonly laserTo = new Vec3()
  /** Slot of the agent being hit, -1 otherwise. */
  laserTarget = -1

  // Shockwave: seconds since trigger (negative = none), origin.
  shockAge = -1
  readonly shockOrigin = new Vec3()

  /** Slow-motion factor requested by the sim (1 = realtime). Presentation only. */
  timeScale = 1
}
