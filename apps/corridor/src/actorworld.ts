// The world the actors live in: one bitECS world, a fixed step, and the systems that run on it.
//
// SEPARATE FROM THE SCENE, on purpose. `scene.ts` owns three.js objects and is about drawing; this
// is about what things ARE and what they do, and it runs whether or not anything is drawn — which
// is what lets a probe step ten thousand vehicles headlessly, and what will let a server step them
// for several clients later without a renderer in the process.
//
// THE STEP IS FIXED. A simulation whose behaviour depends on the frame rate behaves differently on
// Rich's machine and in a probe, and traffic is exactly where that shows up as "it only jams on
// the slow laptop". The renderer calls `tick(realSeconds)` and this runs as many 20 ms steps as
// that buys, capped — the same shape as car.ts's 120 Hz loop, for the same reason.

import { addComponent, addEntity, createWorld, entityExists, hasComponent, query, removeComponent, removeEntity, type World } from 'bitecs'
import { Armed, Autonomous, Doomed, Health, Hostile, Human, PHYS_MODE, Physical, SETS, Transform, Vehicle, Velocity, Visual, Walking, type PhysMode } from './actors'

/** 50 Hz: fine enough for traffic, cheap, and a round number of milliseconds. */
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
   * Advance by a real-time delta. Returns how many fixed steps ran.
   *
   * The leftover is CARRIED rather than dropped, so the simulation keeps real time across many
   * frames even though no single frame lands on a step boundary. Dropping it makes a world that
   * runs slightly slow for ever with nothing saying so.
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
    // a long stall is not paid back all at once: drop what is past the cap rather than run the
    // world at five times speed for a second
    if (this.carry >= STEP_S * MAX_STEPS) this.carry = 0
    this.stats.steps += n
    this.stats.actors = query(this.world, [Transform]).length
    this.stats.lastMs = performance.now() - t0
    for (const s of this.systems) this.stats.systems[s.name] = +s.ms.toFixed(3)
    return n
  }

  /**
   * Remove what asked to be removed, once, at the end of a step.
   *
   * Systems mark `Doomed` rather than destroying, because a system that deletes while another is
   * mid-query is the oldest bug in this shape of code. The list is copied before the loop for the
   * same reason: a query result is a live view.
   */
  private reap() {
    const dead = [...query(this.world, [Doomed])]
    for (const e of dead) removeEntity(this.world, e)
  }

  /** Everything, gone. A level change is a new world, not one with the old world's ghosts. */
  clear() {
    for (const e of [...query(this.world, [Transform])]) removeEntity(this.world, e)
    this.stats.steps = 0
  }

  /** Is this entity still real? Ids are recycled, so holding one across a step proves nothing. */
  alive(e: number) {
    return entityExists(this.world, e)
  }
}

/* ---- the systems every world wants ------------------------------------------------------------ */

/** Position follows velocity. The one system that runs over everything that moves. */
export const integrate: System = (world, dt) => {
  const ents = query(world, SETS.moving)
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i]
    Transform.x[e] += Velocity.x[e] * dt
    Transform.y[e] += Velocity.y[e] * dt
    Transform.z[e] += Velocity.z[e] * dt
  }
}

/** Facing follows motion, for anything moving fast enough to have an opinion about it. */
export const face: System = (world) => {
  const ents = query(world, SETS.moving)
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i]
    const vx = Velocity.x[e]
    const vy = Velocity.y[e]
    if (vx * vx + vy * vy > 0.04) Transform.yaw[e] = Math.atan2(vx, vy)
  }
}

/** Walkers steer toward their target and stop when they arrive. */
export const walk: System = (world) => {
  const ents = query(world, [Walking, Transform, Velocity])
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i]
    const dx = Walking.toX[e] - Transform.x[e]
    const dy = Walking.toY[e] - Transform.y[e]
    const d = Math.hypot(dx, dy)
    if (d < 0.5) {
      Velocity.x[e] = 0
      Velocity.y[e] = 0
      continue
    }
    Velocity.x[e] = (dx / d) * Walking.speed[e]
    Velocity.y[e] = (dy / d) * Walking.speed[e]
  }
}

/** Nothing with no health left stays in the world. */
export const mortality: System = (world) => {
  const ents = query(world, [Health])
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i]
    if (Health.hp[e] <= 0 && !hasComponent(world, e, Doomed)) addComponent(world, e, Doomed)
  }
}

/* ---- spawning, in the vocabulary a level speaks ----------------------------------------------- */

export interface SpawnAt {
  x: number
  y: number
  yaw?: number
}

/** A vehicle the simulation drives. `hostile` adds a component on top; it is not another function. */
export function spawnVehicle(aw: ActorWorld, at: SpawnAt, opts: { asset?: number; maxSpeed?: number; hostile?: boolean } = {}): number {
  const w = aw.world
  const e = addEntity(w)
  addComponent(w, e, Transform)
  addComponent(w, e, Velocity)
  addComponent(w, e, Vehicle)
  addComponent(w, e, Visual)
  addComponent(w, e, Autonomous)
  addComponent(w, e, Health)
  Transform.x[e] = at.x
  Transform.y[e] = at.y
  Transform.yaw[e] = at.yaw ?? 0
  Velocity.x[e] = 0
  Velocity.y[e] = 0
  Velocity.z[e] = 0
  Vehicle.lengthM[e] = 4.4
  Vehicle.widthM[e] = 1.8
  Vehicle.speed[e] = 0
  Vehicle.maxSpeed[e] = opts.maxSpeed ?? 25
  Visual.asset[e] = opts.asset ?? 0
  Visual.scale[e] = 1
  Health.hp[e] = 100
  Health.max[e] = 100
  if (opts.hostile) {
    addComponent(w, e, Hostile)
    Hostile.aggression[e] = 1
  }
  return e
}

/** A person on foot, walking somewhere. */
export function spawnPedestrian(aw: ActorWorld, at: SpawnAt, to: { x: number; y: number }, opts: { hostile?: boolean; asset?: number; speed?: number } = {}): number {
  const w = aw.world
  const e = addEntity(w)
  addComponent(w, e, Transform)
  addComponent(w, e, Velocity)
  addComponent(w, e, Human)
  addComponent(w, e, Walking)
  addComponent(w, e, Visual)
  addComponent(w, e, Health)
  Transform.x[e] = at.x
  Transform.y[e] = at.y
  Transform.yaw[e] = at.yaw ?? 0
  Velocity.x[e] = 0
  Velocity.y[e] = 0
  Walking.toX[e] = to.x
  Walking.toY[e] = to.y
  Walking.speed[e] = opts.speed ?? 1.4
  Visual.asset[e] = opts.asset ?? 0
  Visual.scale[e] = 1
  Health.hp[e] = 100
  Health.max[e] = 100
  if (opts.hostile) {
    addComponent(w, e, Hostile)
    Hostile.aggression[e] = 1
  }
  return e
}

/* ---- spawning from a DOCUMENT, which is what the asset library produces ------------------------ */

/**
 * Give an entity a place in the physics world.
 *
 * Separate from spawning because the two happen at different times: an entity exists as soon as a
 * population is planned, and it gets a body only once it is near enough to the player for one to be
 * worth having. `mode` moves over an entity's life — a traffic car is KINEMATIC until something
 * hits it and DYNAMIC afterwards — and this is the one place that says so.
 */
export function setPhysical(aw: ActorWorld, e: number, mode: PhysMode, opts: { mass?: number; handle?: number; layer?: number } = {}) {
  const w = aw.world
  if (!hasComponent(w, e, Physical)) addComponent(w, e, Physical)
  Physical.mode[e] = PHYS_MODE[mode]
  if (opts.mass !== undefined) Physical.mass[e] = opts.mass
  if (opts.handle !== undefined) Physical.handle[e] = opts.handle
  if (opts.layer !== undefined) Physical.layer[e] = opts.layer
}

/**
 * What an actor document describes, as an entity.
 *
 * THE DOCUMENT IS NOT IMPORTED HERE. This takes the handful of numbers it produces rather than an
 * `ActorDoc`, so `actorworld.ts` stays free of the authoring layer — the ECS is the runtime and a
 * document is a file somebody edits, and `toSpawnOpts` in `actorspecs.ts` is the one place that
 * converts between them. A world that could not be stepped without the asset library loaded would
 * be a world no test could step.
 */
export function spawnActor(
  aw: ActorWorld,
  at: SpawnAt,
  spec: { speed: number; health: number; hostile?: boolean; asset?: number; mass?: number },
  to: { x: number; y: number } = { x: at.x, y: at.y },
): number {
  const e = spawnPedestrian(aw, at, to, { speed: spec.speed, hostile: spec.hostile, asset: spec.asset })
  Health.hp[e] = spec.health
  Health.max[e] = spec.health
  if (spec.mass !== undefined) setPhysical(aw, e, 'none', { mass: spec.mass })
  return e
}

/**
 * Put a weapon in an entity's hand.
 *
 * `weapon` is an index into whatever string table the app keeps, never the asset id — a component
 * is a TypedArray per field. 0 is empty handed, so a table's slot 0 is never a weapon.
 */
export function arm(aw: ActorWorld, e: number, weapon: number, ammo: number) {
  const w = aw.world
  if (!hasComponent(w, e, Armed)) addComponent(w, e, Armed)
  Armed.weapon[e] = weapon
  Armed.ammo[e] = ammo
  Armed.cooldown[e] = 0
}

/**
 * Rates of fire, as one system.
 *
 * The whole of a weapon's timing: a cooldown counts down and nothing may fire while it is positive.
 * Here rather than in whatever fires, because there will be several things that fire — a player, a
 * hostile, a turret — and three copies of a countdown is three places for a weapon to be twice as
 * fast as it says.
 */
export const cooldowns: System = (world, dt) => {
  const ents = query(world, [Armed])
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i]
    if (Armed.cooldown[e] > 0) Armed.cooldown[e] = Math.max(0, Armed.cooldown[e] - dt)
  }
}

/** Hand a vehicle to a player: it stops being driven by the simulation and stays the same thing. */
export function takeOver(aw: ActorWorld, e: number, Player: Record<string, never>) {
  removeComponent(aw.world, e, Autonomous)
  addComponent(aw.world, e, Player)
}
