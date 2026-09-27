// The world the actors live in: one koota world, a fixed step, and the systems that run on it.
//
// SEPARATE FROM THE SCENE, on purpose. `scene.ts` owns three.js objects and is about drawing;
// this is about what things ARE and what they do, and it runs whether or not anything is drawn —
// which is what lets a probe step ten thousand vehicles headlessly, and what will let a server
// step them for several clients later without a renderer in the process.
//
// THE STEP IS FIXED. A simulation whose behaviour depends on the frame rate is one that behaves
// differently on Rich's machine and in a probe, and traffic is exactly the kind of system where
// that shows up as "it only jams on the slow laptop". The renderer calls `tick(realSeconds)` and
// this runs as many 20 ms steps as that buys, capped — the same shape as car.ts's 120 Hz loop and
// for the same reason.

import { createWorld, type Entity, type World } from 'koota'
import { Autonomous, Doomed, Health, Hostile, SETS, Transform, Vehicle, Velocity, Visual, Walking } from './actors'

/** 50 Hz: fine enough for traffic, coarse enough to be cheap, and a round number of milliseconds. */
export const STEP_S = 0.02
/** Never run more than this many steps for one frame — a stall must not become a burst. */
const MAX_STEPS = 5

export type System = (world: World, dt: number) => void

export class ActorWorld {
  readonly world: World = createWorld()
  private systems: { name: string; fn: System; ms: number }[] = []
  private carry = 0
  /** steps run, and what each system cost on the last one: what a probe and the HUD read */
  stats = { steps: 0, actors: 0, lastMs: 0, systems: {} as Record<string, number> }

  /** Systems run in the order they are added, which is the only ordering guarantee there is. */
  add(name: string, fn: System) {
    this.systems.push({ name, fn, ms: 0 })
    return this
  }

  /**
   * Advance by a real-time delta. Returns how many fixed steps were run.
   *
   * The leftover is CARRIED rather than dropped, so the simulation keeps real time over many
   * frames even though no single frame lands on a step boundary. Dropping it makes a world that
   * runs slightly slow for ever and nothing that says so.
   */
  tick(realSeconds: number): number {
    const t0 = performance.now()
    this.carry += Math.max(0, realSeconds)
    let n = 0
    while (this.carry >= STEP_S && n < MAX_STEPS) {
      this.carry -= STEP_S
      n++
      for (const s of this.systems) {
        const t = performance.now()
        s.fn(this.world, STEP_S)
        s.ms = performance.now() - t
      }
      this.reap()
    }
    // a long stall must not be paid back all at once; drop what is past the cap and say so in the
    // stats rather than silently running the world at double speed for a second
    if (this.carry >= STEP_S * MAX_STEPS) this.carry = 0
    this.stats.steps += n
    this.stats.actors = this.world.query(Transform).length
    this.stats.lastMs = performance.now() - t0
    for (const s of this.systems) this.stats.systems[s.name] = +s.ms.toFixed(3)
    return n
  }

  /**
   * Remove what asked to be removed, once, at the end of a step.
   *
   * Systems mark `Doomed` rather than destroying, because a system that deletes while another is
   * mid-query is the oldest bug in this shape of code.
   */
  private reap() {
    const dead = this.world.query(Doomed)
    if (!dead.length) return
    dead.forEach((e: Entity) => e.destroy())
  }

  /** Everything, gone. A level change is a new world, not a world with the old one's ghosts. */
  clear() {
    this.world.query(Transform).forEach((e: Entity) => e.destroy())
    this.stats.steps = 0
  }
}

/* ---- the systems every world wants ------------------------------------------------------------ */

/** Position follows velocity. The one system that runs over everything that moves. */
export const integrate: System = (world, dt) => {
  world.query(...SETS.moving).updateEach(([t, v]) => {
    t.x += v.x * dt
    t.y += v.y * dt
    t.z += v.z * dt
  })
}

/** Facing follows motion, for anything moving fast enough to have an opinion about it. */
export const face: System = (world) => {
  world.query(...SETS.moving).updateEach(([t, v]) => {
    const speed2 = v.x * v.x + v.y * v.y
    if (speed2 > 0.04) t.yaw = Math.atan2(v.x, v.y)
  })
}

/** Walkers steer toward their target and stop when they arrive. */
export const walk: System = (world) => {
  world.query(Walking, Transform, Velocity).updateEach(([w, t, v]) => {
    const dx = w.toX - t.x
    const dy = w.toY - t.y
    const d = Math.hypot(dx, dy)
    if (d < 0.5) {
      v.x = 0
      v.y = 0
      return
    }
    v.x = (dx / d) * w.speed
    v.y = (dy / d) * w.speed
  })
}

/** Nothing with no health left stays in the world. */
export const mortality: System = (world) => {
  world.query(Health).updateEach(([h], e) => {
    if (h.hp <= 0 && !e.has(Doomed)) e.add(Doomed({ why: 'hp' }))
  })
}

/* ---- spawning, in the vocabulary a level speaks ----------------------------------------------- */

export interface SpawnAt {
  x: number
  y: number
  yaw?: number
}

/** A vehicle the simulation drives. `hostile` is a trait added on top, not a different function. */
export function spawnVehicle(aw: ActorWorld, at: SpawnAt, opts: { asset?: string; maxSpeed?: number; hostile?: boolean } = {}): Entity {
  const e = aw.world.spawn(
    Transform({ x: at.x, y: at.y, yaw: at.yaw ?? 0 }),
    Velocity,
    Vehicle({ maxSpeed: opts.maxSpeed ?? 25, asset: opts.asset ?? '' }),
    Visual({ asset: opts.asset ?? '' }),
    Autonomous,
    Health,
  )
  if (opts.hostile) e.add(Hostile())
  return e
}

/** A person on foot, walking somewhere. */
export function spawnPedestrian(aw: ActorWorld, at: SpawnAt, to: { x: number; y: number }, opts: { hostile?: boolean; asset?: string } = {}): Entity {
  const e = aw.world.spawn(
    Transform({ x: at.x, y: at.y, yaw: at.yaw ?? 0 }),
    Velocity,
    Walking({ toX: to.x, toY: to.y }),
    Visual({ asset: opts.asset ?? '' }),
    Health,
  )
  if (opts.hostile) e.add(Hostile())
  return e
}
