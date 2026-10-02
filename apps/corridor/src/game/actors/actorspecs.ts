// What a person, an animal or an enemy IS, as a document.
//
// docs/corridor/PLAN-VEHICLES-ACTORS.md, from Rich: "For actors we should have rigged models with
// their own properties like run and climb speed, fly speed if they are magical, and some basic
// things like health capacity and damage ability for combat."
//
// WHY NOT `actors.ts`. That name is taken, by the ECS — components, relations and the named queries
// everything in the world is made of. This file is the other half of the same subject and they must
// not be confused: `actors.ts` is what a running thing IS AT RUNTIME (a Float32Array slot per
// field), and this is what an ASSET SAYS ABOUT ITSELF, edited in a form, stored beside the model,
// long before any entity exists. The mapping between them is `toSpawnOpts` at the bottom, and it is
// deliberately the only place the two meet.
//
// THE SAME THREE RULES AS `vehicles.ts`, for the same reasons:
//
//   the MODEL   a rigged mesh in the catalog. Two characters may share one.
//   the RIG     which bone is the right hand. A fact about the MODEL (`AssetItem.rig`).
//   the ACTOR   how fast it runs, how much it can take, what it hits you with. A fact about the
//               CHARACTER — so a guard and a civilian can be the same mesh and behave nothing alike.
//
// AND THE SAME DISCIPLINE: no DOM, no THREE, no Rapier. Types, defaults, validation and the
// arithmetic that turns "78 kg, 1.82 m" into limbs a ragdoll can be built from — so all of it can be
// checked in a test rather than discovered by shoving somebody down a hill.
import { HUMANOID_MASS, RAGDOLL_HUMANOID } from '@apex/engine/physics/ragdoll'

/* ---- the document ---------------------------------------------------------------------------- */

/** How it gets about. Every speed in metres per second, because every other speed in this repo is. */
export interface ActorMove {
  walk_ms: number
  run_ms: number
  /** up a ladder or a wall. 0 = cannot climb */
  climb_ms: number
  /** 0 = cannot fly. Magical things say otherwise */
  fly_ms: number
  /** initial vertical speed of a jump, m/s. 0 = cannot jump */
  jump_ms: number
  /** how fast it can turn on the spot, degrees per second */
  turn_deg_s: number
}

/** What it is made of, and what happens when something hits it. */
export interface ActorBody {
  health: number
  /** 0…1: the share of incoming damage that never lands */
  armour: number
  /** kg. For the ragdoll, and for what happens when a car hits it */
  mass: number
  /**
   * m, standing. The ragdoll's proportions are fractions of this, so it is not decoration: a 1.2 m
   * character and a 2.1 m one fold differently and land differently.
   */
  height: number
  ragdoll: boolean
}

/** What it can do to you. */
export interface ActorCombat {
  /** per hit, unarmed */
  damage: number
  /** seconds between attacks */
  attack_s: number
  reach_m: number
  /** ids in the asset library, resolved against `kind === 'weapon'` items */
  weapons: string[]
}

export interface ActorDoc {
  move: ActorMove
  body: ActorBody
  combat: ActorCombat
  /** take bone roles from the asset's own rig binding */
  rig: { from_asset: boolean }
}

/* ---- defaults, per class ---------------------------------------------------------------------- */

/**
 * Sensible numbers per class of actor.
 *
 * The walking and running speeds are the ones the rest of this app already uses — `Walking.speed`
 * defaults to 1.4 m/s in `actorworld.ts` and `WALK_SPEED` in the tuning panel is 3.2 for "a brisk
 * walk" — so a pedestrian placed from the library moves at the speed the traffic model already
 * assumes rather than at a second opinion.
 */
export const ACTOR_TEMPLATES: Record<string, ActorDoc> = {
  pedestrian: actor({ walk_ms: 1.4, run_ms: 3.6, climb_ms: 0, fly_ms: 0, jump_ms: 2.6, turn_deg_s: 360 }, { health: 100, armour: 0, mass: 78, height: 1.75, ragdoll: true }, { damage: 4, attack_s: 1.2, reach_m: 1.0, weapons: [] }),
  character: actor({ walk_ms: 1.6, run_ms: 5.2, climb_ms: 1.1, fly_ms: 0, jump_ms: 4.0, turn_deg_s: 540 }, { health: 100, armour: 0, mass: 78, height: 1.8, ragdoll: true }, { damage: 12, attack_s: 0.7, reach_m: 1.6, weapons: [] }),
  hostile: actor({ walk_ms: 1.5, run_ms: 4.8, climb_ms: 0.9, fly_ms: 0, jump_ms: 3.4, turn_deg_s: 480 }, { health: 120, armour: 0.1, mass: 86, height: 1.85, ragdoll: true }, { damage: 18, attack_s: 0.9, reach_m: 1.5, weapons: [] }),
  dog: actor({ walk_ms: 1.2, run_ms: 9.0, climb_ms: 0, fly_ms: 0, jump_ms: 3.0, turn_deg_s: 720 }, { health: 40, armour: 0, mass: 22, height: 0.6, ragdoll: true }, { damage: 9, attack_s: 0.8, reach_m: 0.6, weapons: [] }),
  deer: actor({ walk_ms: 1.4, run_ms: 13.0, climb_ms: 0, fly_ms: 0, jump_ms: 5.0, turn_deg_s: 540 }, { health: 60, armour: 0, mass: 90, height: 1.4, ragdoll: true }, { damage: 6, attack_s: 1.5, reach_m: 0.9, weapons: [] }),
  bird: actor({ walk_ms: 0.4, run_ms: 1.0, climb_ms: 0, fly_ms: 14.0, jump_ms: 1.0, turn_deg_s: 900 }, { health: 5, armour: 0, mass: 0.4, height: 0.25, ragdoll: false }, { damage: 1, attack_s: 1.0, reach_m: 0.2, weapons: [] }),
}

function actor(move: ActorMove, body: ActorBody, combat: ActorCombat): ActorDoc {
  return { move, body, combat, rig: { from_asset: true } }
}

/** The starting points on offer, for a "begin from" picker. Keys of `ACTOR_TEMPLATES`. */
export const ACTOR_TEMPLATE_IDS = Object.keys(ACTOR_TEMPLATES)

/**
 * The CATALOG CLASSES that get an actor document — the asset library's own words (`KINDS` in
 * `src/ui/assets.ts`), not ours, for the same reason as `VEHICLE_CLASSES`.
 *
 * `character` is not in the library's standard list yet; it is accepted here because the library
 * merges in whatever classes are already in use, so the first person to make one gets a document
 * rather than a shrug.
 */
export const ACTOR_CLASSES = ['pedestrian', 'animal', 'character']

/** Which template a catalog class starts from. A starting point the form calls a default. */
const CLASS_TEMPLATE: Record<string, string> = { pedestrian: 'pedestrian', animal: 'dog', character: 'character' }

/** A fresh document for a class or a template id, deep-copied so editing one does not edit the table. */
export function defaultActor(kind: string): ActorDoc {
  const id = CLASS_TEMPLATE[kind] ?? kind
  return structuredClone(ACTOR_TEMPLATES[id] ?? ACTOR_TEMPLATES.pedestrian)
}

/* ---- validation -------------------------------------------------------------------------------- */

export interface ActorReport {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Check a document. Every problem, not the first — the same contract as `validateVehicle` and
 * `validateEcs`.
 *
 * `weapons` is the set of ids the library actually has. Passing it is what turns "this guard's
 * pistol does not exist" from a thing discovered when somebody pulls the trigger into a line on
 * the form.
 */
export function validateActor(a: ActorDoc | null | undefined, opts: { weapons?: string[]; rigRoles?: string[] } = {}): ActorReport {
  const errors: string[] = []
  const warnings: string[] = []
  if (!a) return { ok: true, errors, warnings }

  const m = a.move
  const num = (v: number, name: string, { min = 0, max = Infinity, required = true } = {}) => {
    if (!Number.isFinite(v)) { errors.push(`${name} must be a number`); return false }
    if (v < min) { errors.push(`${name} must be at least ${min}`); return false }
    if (required && v === 0 && min > 0) { errors.push(`${name} must be more than zero`); return false }
    if (v > max) warnings.push(`${name} is ${v}, which is past anything that moves like that`)
    return true
  }
  num(m?.walk_ms, 'move.walk_ms', { min: 0, max: 5 })
  num(m?.run_ms, 'move.run_ms', { min: 0, max: 30 })
  num(m?.climb_ms, 'move.climb_ms', { min: 0, max: 8 })
  num(m?.fly_ms, 'move.fly_ms', { min: 0, max: 120 })
  num(m?.jump_ms, 'move.jump_ms', { min: 0, max: 15 })
  num(m?.turn_deg_s, 'move.turn_deg_s', { min: 0, max: 2000 })
  // The one that is a MISTAKE rather than a choice: a walk faster than a run means somebody has
  // filled the two fields in the wrong order, and nothing downstream would ever say so — the actor
  // would simply amble away from anything chasing it.
  if (m?.walk_ms > 0 && m?.run_ms > 0 && m.walk_ms > m.run_ms) errors.push(`move.walk_ms ${m.walk_ms} is faster than move.run_ms ${m.run_ms} — these are the wrong way round`)

  const b = a.body
  num(b?.health, 'body.health', { min: 1, max: 100000 })
  num(b?.mass, 'body.mass', { min: 0.01, max: 2000 })
  num(b?.height, 'body.height', { min: 0.05, max: 6 })
  if (!Number.isFinite(b?.armour) || b.armour < 0 || b.armour > 1) errors.push('body.armour must be between 0 and 1')
  else if (b.armour >= 1) warnings.push('body.armour 1 means nothing can ever hurt this')
  /*
   * Density, as the sanity check on the two numbers that are easiest to type wrong — a vehicle's
   * mass pasted into a person, or grams where kilograms were meant.
   *
   * ISOMETRIC, and that is the whole subtlety. The first cut used a fixed cross-section (a human's
   * 0.45 × 0.25 m shoulders) times the height, which is fine for people and libels everything else:
   * it called a perfectly ordinary 0.4 kg, 0.25 m bird "lighter than air", because a bird is not a
   * short human. Scaling all three dimensions with height instead puts every creature in the table —
   * bird, dog, deer, person — between 210 and 1600 kg/m³ of loose box, while a vehicle's mass typed
   * into a person lands above 20,000 and a gram-for-kilogram slip lands under 2.
   *
   * The band is wide on purpose. This is a check for a MISTAKE, not a biology lesson, and a warning
   * that fires on real animals is a warning people learn to ignore.
   */
  if (b?.mass > 0 && b?.height > 0) {
    const density = b.mass / Math.max(1e-6, b.height ** 3 * 0.0637)
    if (density > 6000) warnings.push(`${b.mass} kg at ${b.height} m is denser than stone — check the units`)
    if (density < 60) warnings.push(`${b.mass} kg at ${b.height} m is lighter than air — check the units`)
  }
  if (b?.ragdoll && b?.height > 0 && b.height < 0.2) warnings.push(`a ${b.height} m ragdoll has limbs smaller than its own joints; it will jitter`)

  const c = a.combat
  num(c?.damage, 'combat.damage', { min: 0, max: 10000, required: false })
  num(c?.attack_s, 'combat.attack_s', { min: 0.01, max: 60 })
  num(c?.reach_m, 'combat.reach_m', { min: 0, max: 20, required: false })
  if (!Array.isArray(c?.weapons)) errors.push('combat.weapons must be a list of asset ids')
  else if (opts.weapons) {
    for (const w of c.weapons) if (!opts.weapons.includes(w)) errors.push(`combat.weapons: there is no weapon asset ${JSON.stringify(w)}`)
  }
  if (c?.reach_m > 0 && b?.height > 0 && c.reach_m > b.height * 2) warnings.push(`combat.reach_m ${c.reach_m} is more than twice its own height`)

  if (a.rig?.from_asset && opts.rigRoles && !opts.rigRoles.length) {
    warnings.push('this asset has no rig binding, so nothing knows which bone is a hand — weapons will not attach')
  }
  return { ok: errors.length === 0, errors, warnings }
}

/* ---- the arithmetic ---------------------------------------------------------------------------- */

/**
 * How high it can jump, metres. Exact: `v² / 2g`.
 *
 * Here because `jump_ms` is a velocity and nobody thinks in velocities — a level designer placing a
 * ledge wants to know whether it can be reached, and the honest answer is arithmetic rather than a
 * playtest. The editor shows it beside the field.
 */
export function jumpHeight(a: ActorDoc, gravity = 9.81): number {
  return (a.move.jump_ms * a.move.jump_ms) / (2 * gravity)
}

/** How far it gets across a gap from a run, metres. Ballistic, flat ground, no air control. */
export function jumpDistance(a: ActorDoc, gravity = 9.81): number {
  return (2 * a.move.run_ms * a.move.jump_ms) / gravity
}

/**
 * Damage after armour, per hit and per second.
 *
 * `armour` is a fraction refused rather than a subtraction, because subtraction makes a heavily
 * armoured thing invulnerable to small hits and then wildly vulnerable one point later, which is a
 * cliff nobody tuning it can see.
 */
export function damageAfterArmour(incoming: number, a: ActorDoc): number {
  return Math.max(0, incoming * (1 - Math.min(1, Math.max(0, a.body.armour))))
}

/** Unarmed damage per second, for comparing two actors without doing it in your head. */
export function dps(a: ActorDoc): number {
  return a.combat.damage / Math.max(0.01, a.combat.attack_s)
}

/**
 * How many unarmed hits it takes for `attacker` to drop `target`, and how long that is.
 *
 * The number a fight is actually balanced on. Infinite when the attacker cannot get through the
 * armour at all, which is a state worth being able to see rather than a divide by zero.
 */
export function hitsToKill(attacker: ActorDoc, target: ActorDoc): { hits: number; seconds: number } {
  const per = damageAfterArmour(attacker.combat.damage, target)
  if (per <= 0) return { hits: Infinity, seconds: Infinity }
  const hits = Math.ceil(target.body.health / per)
  return { hits, seconds: (hits - 1) * attacker.combat.attack_s }
}

/**
 * The limbs a ragdoll is built from, for this actor, standing at a place.
 *
 * Proportions and masses come from the engine's humanoid table scaled to this document's height and
 * mass — so `Ragdoll.from(phys, toRagdollLimbs(doc, at, yaw))` produces a body that weighs what the
 * document said. The engine's `Ragdoll.humanoid` now takes a mass for the same reason; this is the
 * version that reads it off a document, and the one the spawn path uses.
 *
 * NOT for a rigged model. When there is a real rig, the limbs come from the BONES' current world
 * transforms at the instant of the handover — that is `Ragdoll.from`'s whole design and the reason
 * it takes a pose rather than a model. This is the placeholder, and the thing an animal uses, since
 * nothing here has a quadruped table yet.
 */
export function toRagdollLimbs(a: ActorDoc, at: { x: number; y: number; z: number }, yaw = 0) {
  const h = a.body.height
  const k = a.body.mass / HUMANOID_MASS
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const side: Record<string, number> = {
    upperArmL: -0.10, lowerArmL: -0.11, upperLegL: -0.055, lowerLegL: -0.055,
    upperArmR: 0.10, lowerArmR: 0.11, upperLegR: 0.055, lowerLegR: 0.055,
  }
  const place = (s: number, frac: number) => ({ x: at.x - sin * s * h, y: at.y + frac * h, z: at.z + cos * s * h })
  return RAGDOLL_HUMANOID.map((b) => ({
    name: b.name,
    parent: b.parent,
    from: place(side[b.name] ?? 0, b.y0),
    to: place(side[b.name] ?? 0, b.y1),
    radius: b.r * (h / 1.75),
    mass: b.m * k,
  }))
}

/* ---- the seam with the ECS --------------------------------------------------------------------- */

/**
 * What `spawnPedestrian` needs, from a document.
 *
 * THE ONLY PLACE THIS FILE AND `actors.ts` MEET, and it stays that way: a document is authoring and
 * an entity is runtime, and an editor form that wrote into a `Float32Array` would be a form that
 * could only be used while the world was running.
 *
 * `Health.hp` is a `Uint16Array`, so health is clamped to what that can hold rather than wrapping —
 * a 70,000 hp boss silently becoming a 4,464 hp one is exactly the kind of quiet nothing this repo
 * keeps finding.
 */
export function toSpawnOpts(a: ActorDoc, opts: { hostile?: boolean; asset?: number } = {}) {
  return {
    speed: a.move.walk_ms,
    health: Math.min(65535, Math.max(1, Math.round(a.body.health))),
    hostile: opts.hostile ?? false,
    asset: opts.asset ?? 0,
  }
}

/** A one-line summary for the list, in the words a person would use. */
export function describeActor(a: ActorDoc): string {
  const bits = [`${a.body.health} hp`, `${a.body.mass} kg`, `${a.move.run_ms} m/s run`]
  if (a.move.fly_ms > 0) bits.push(`${a.move.fly_ms} m/s flying`)
  if (a.move.climb_ms > 0) bits.push('climbs')
  bits.push(`${dps(a).toFixed(1)} dps`)
  if (a.combat.weapons.length) bits.push(`${a.combat.weapons.length} weapon${a.combat.weapons.length === 1 ? '' : 's'}`)
  if (!a.body.ragdoll) bits.push('no ragdoll')
  return bits.join(' · ')
}
