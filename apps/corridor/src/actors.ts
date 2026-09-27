// Everything in the world that does something: people, animals, vehicles, and whatever is hostile.
//
// Rich, 2026-09-27: "we need an abstraction for humans, animals, and enemies — enemies will come
// into play later and they can take any form... And vehicles!"
//
// THAT LAST SENTENCE IS THE ARGUMENT AGAINST A CLASS HIERARCHY. If an enemy can take any form
// then `class Enemy` is wrong on the first day: a hostile is a driver in a car, a dog, a thing on
// the roof, a helicopter. In an inheritance tree that is either a combinatorial explosion of
// subclasses or an `isEnemy` flag smeared across all of them. Here, hostility is a TRAIT you add
// to whatever is already there — `world.spawn(...vehicle, Hostile)` — and the code that hunts you
// queries for it without knowing or caring what it is attached to.
//
// WHY koota, chosen 2026-09-27 against bitECS, miniplex and becsy:
//
//   koota     0.6.6, ISC, no dependencies, published 2026-04, 86 releases — and it is pmndrs,
//             the org behind react-three-fiber and drei, so it is the three.js ecosystem's own.
//   bitECS    0.4.0, MPL-2.0. The performance benchmark and a fine library, but MPL is weak
//             copyleft and Rich asked for a liberal licence; ISC is the more liberal answer.
//   miniplex  2.0.0, MIT, but last published 2023-07 and it pulls three dependencies.
//   becsy     0.15.5, MIT, last published 2023-07, 5.7 MB unpacked.
//
// Measured here before adopting, rather than taken from a README (Node 22, this devcontainer,
// one system stepping every actor's position plus a narrow query over the hostiles):
//
//      5,000 actors    0.33 ms/frame     2% of a 16.7 ms frame
//     20,000 actors    1.52 ms/frame     9%
//     50,000 actors    3.20 ms/frame    19%
//    200,000 actors   13.74 ms/frame    82%   — the ceiling, and far past anything we need
//
// A narrow query (hostile vehicles, 134 of 20,000) costs 0.032 ms, which is the number that
// matters most: most systems run over a handful of the world, not all of it.

import { trait } from 'koota'

/* ---- where something is, and what it is doing ------------------------------------------------ */

/**
 * Position and facing in SITE metres — x east, y north, matching the bake and `placements.json`,
 * NOT three's world axes. The renderer converts once, at the edge (`z = -y`), because every
 * datum this app has ever loaded is in the site frame and a second convention inside the
 * simulation is how a thing ends up mirrored across a road.
 */
export const Transform = trait({ x: 0, y: 0, z: 0, yaw: 0 })

/** Metres per second, same frame as Transform. */
export const Velocity = trait({ x: 0, y: 0, z: 0 })

/* ---- what something IS ----------------------------------------------------------------------- */

/**
 * A person. `Human` says nothing about whether they are a pedestrian, a driver or a threat —
 * those are separate traits, because the same person can stop being one and start being another
 * without becoming a different object.
 */
export const Human = trait({ name: '' })

/** An animal. `species` is free text until something needs to branch on it. */
export const Animal = trait({ species: 'dog' })

/**
 * A vehicle. This is the SIMULATION's idea of one — the numbers a traffic model needs — and not
 * the player's car, which is `car.ts` and has a real suspension, a gearbox and a tyre model.
 * A traffic vehicle that the player takes over should become the one without changing entity:
 * remove `Autonomous`, attach the controller. That is the join to design for and not against.
 */
export const Vehicle = trait({ lengthM: 4.4, widthM: 1.8, speed: 0, maxSpeed: 25, asset: '' })

/** What draws it. Empty means nothing is drawn yet, which is a legitimate state during a spawn. */
export const Visual = trait({ asset: '', scale: 1 })

/* ---- what something is DOING ----------------------------------------------------------------- */

/** Driven by the simulation rather than by a person. Remove it to hand something to a player. */
export const Autonomous = trait()

/** On a road, at `s` metres along chain `chain`, in lane `lane`. The traffic model's own state. */
export const OnRoad = trait({ chain: '', s: 0, lane: 0, dir: 1 })

/** Walking somewhere: a target in site metres, and how fast. */
export const Walking = trait({ toX: 0, toY: 0, speed: 1.4 })

/* ---- how something relates to you ------------------------------------------------------------ */

/**
 * HOSTILITY IS A TRAIT, NOT A TYPE, and this is the whole design in one line.
 *
 * An enemy can take any form, so `Hostile` attaches to a human, an animal, a vehicle, or to
 * something that has not been invented yet. Everything that hunts queries `Hostile` and never
 * asks what it is attached to; everything that becomes hostile does so by gaining a trait rather
 * than by being replaced.
 */
export const Hostile = trait({ faction: 'enemy', aggression: 1 })

/** The one the player is. Exactly one entity should have it; `theirs()` asserts that rather than assuming it. */
export const Player = trait()

/** Can be hurt, and is not simply gone when it is. */
export const Health = trait({ hp: 100, max: 100 })

/** Marked for removal at the end of the step, so a system never deletes out from under another. */
export const Doomed = trait({ why: '' })

/* ---- the sets other code asks for ------------------------------------------------------------ */

/**
 * Named queries, so a caller says what it wants rather than how to find it.
 *
 * Every one of these is a list of traits, and the point is that none of them mention a KIND. "The
 * things that can hurt you" is `[Hostile, Transform]` — it does not care that half of them are
 * cars and half are dogs.
 */
export const SETS = {
  /** anything with a place in the world: what the renderer draws and what the camera can see */
  placed: [Transform] as const,
  /** anything that moves under its own power this frame */
  moving: [Transform, Velocity] as const,
  /** traffic: vehicles the simulation drives */
  traffic: [Vehicle, Transform, Autonomous] as const,
  /** people on foot */
  pedestrians: [Human, Walking, Transform] as const,
  /** the things that can hurt you, whatever shape they are */
  threats: [Hostile, Transform] as const,
  /** everything drawable, which is not the same as everything placed */
  drawable: [Transform, Visual] as const,
}
