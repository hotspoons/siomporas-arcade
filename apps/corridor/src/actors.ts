// Everything in the world that does something: people, animals, vehicles, and whatever is hostile.
//
// Rich, 2026-09-27: "we need an abstraction for humans, animals, and enemies — enemies will come
// into play later and they can take any form... And vehicles!"
//
// THAT LAST CLAUSE IS THE ARGUMENT AGAINST A CLASS HIERARCHY. If an enemy can take any form then
// `class Enemy` is wrong on the first day: a hostile is a driver in a car, a dog, a thing on a
// roof, a helicopter. In an inheritance tree that is a combinatorial explosion of subclasses or an
// `isEnemy` flag smeared through all of them. Here hostility is a COMPONENT added to whatever is
// already there, and the code that hunts you queries for it without knowing what it is attached to.
//
// WHY bitECS, decided 2026-09-27. koota (ISC) was adopted first on a licence argument; Rich then
// said the framework ships Apache-2.0, which settles it — MPL-2.0 is file-level copyleft and
// explicitly permits combining into a Larger Work under other terms, so bitECS inside an
// Apache-2.0 release is fine and we owe modifications to bitECS's own files only (see NOTICE).
// With that objection gone, the measurement decides, and it is not close. Same workload, same
// machine, same Node — spawn N, step every one, then a narrow query over the hostiles:
//
//                        koota           bitECS
//      5,000 actors     0.33 ms/frame    0.009 ms      37x
//     20,000 actors     1.52 ms          0.025 ms      61x
//     50,000 actors     3.20 ms          0.062 ms      52x
//    200,000 actors    13.74 ms          0.242 ms      57x
//
// 20,000 actors go from 9% of a 16.7 ms frame to 0.1%. And bitECS brings relations, prefabs,
// hierarchy and serialisation, every one of which this design wants: a driver IS IN a vehicle, a
// taxi IS A traffic car, a trailer hangs off a truck, and multiplayer later means one
// authoritative simulation serialising to N controllers.
//
// STRUCTURE OF ARRAYS. A component is one TypedArray per field, indexed by entity id. That is
// what makes it fast and it is also the constraint: `MAX_ACTORS` is a real ceiling, and ids are
// recycled rather than growing, which was checked before building on it — twenty rounds of
// churning nine hundred entities left the highest id at 1000. Do NOT reach for `getId()` to index
// these: that unpacks a versioned index we do not enable, and returns 0 for id 1000.

import { createRelation, withAutoRemoveSubject } from 'bitecs'

/**
 * The ceiling. Every component below allocates this many slots, so it is memory, not a limit that
 * can be raised at runtime: about 2 MB for the set here. An open world's traffic is thousands;
 * this is room for sixty-five of those.
 */
export const MAX_ACTORS = 65536

const f32 = () => new Float32Array(MAX_ACTORS)
const u16 = () => new Uint16Array(MAX_ACTORS)
const u8 = () => new Uint8Array(MAX_ACTORS)

/* ---- where something is, and what it is doing ------------------------------------------------ */

/**
 * Position and facing in SITE metres — x east, y north, matching the bake and `placements.json`,
 * NOT three's world axes. The renderer converts once, at the edge (`z = -y`), because every datum
 * this app has ever loaded is in the site frame and a second convention inside the simulation is
 * how something ends up mirrored across a road.
 */
export const Transform = { x: f32(), y: f32(), z: f32(), yaw: f32() }

/** Metres per second, same frame as Transform. */
export const Velocity = { x: f32(), y: f32(), z: f32() }

/* ---- what something IS ----------------------------------------------------------------------- */

/**
 * A person. This says nothing about whether they are a pedestrian, a driver or a threat — those
 * are separate components, because the same person stops being one and starts being another
 * without becoming a different object.
 */
export const Human = { kind: u8() }

/** An animal. `species` is an index into SPECIES until something needs more. */
export const SPECIES = ['dog', 'deer', 'bird', 'cat', 'cow'] as const
export const Animal = { species: u8() }

/**
 * A vehicle: the SIMULATION's idea of one, the numbers a traffic model needs. Not the player's
 * car, which is `car.ts` and has a suspension, a gearbox and a tyre model. A traffic vehicle the
 * player takes over should become that one WITHOUT changing entity — remove `Autonomous`, attach
 * the controller — which is the join to design for rather than against.
 */
export const Vehicle = { lengthM: f32(), widthM: f32(), speed: f32(), maxSpeed: f32() }

/** What draws it: an index into the catalog's asset list, and a scale. 0 means nothing yet. */
export const Visual = { asset: u16(), scale: f32() }

/**
 * An engine, as SOUND wants it. `rpm` and `pedal` are the only two numbers that decide what a
 * combustion engine sounds like at any instant, so they are the whole interface: whoever owns the
 * car writes them, and `enginesound.ts` reads them and makes a noise. Nothing here knows whether
 * the car is the player's, traffic, or something hostile.
 *
 * `voice` is which simulated engine is speaking for this entity, 1-based, 0 for none. It is not a
 * flag and there will not be many: a full engine-sim voice costs a real slice of a core (measured
 * — packages/enginesim/scripts/measure.mjs), so the player gets one and traffic will get recorded
 * samples driven off these same two fields. Writing rpm and pedal for a traffic car is free and
 * correct whether or not anything is listening, which is why the component is not reserved for
 * whatever happens to be voiced.
 */
export const Engine = { rpm: f32(), pedal: f32(), gear: u8(), voice: u8() }

/* ---- what something is DOING ----------------------------------------------------------------- */

/** Driven by the simulation rather than by a person. Remove it to hand something to a player. */
export const Autonomous = {}

/** On a road: `chain` indexes the site's chains, `s` is metres along it. The traffic model's state. */
export const OnRoad = { chain: u16(), s: f32(), lane: u8(), dir: u8() }

/** Walking somewhere: a target in site metres, and how fast. */
export const Walking = { toX: f32(), toY: f32(), speed: f32() }

/* ---- how something relates to you ------------------------------------------------------------ */

/**
 * HOSTILITY IS A COMPONENT, NOT A TYPE, and this is the whole design in one line.
 *
 * An enemy can take any form, so this attaches to a human, an animal, a vehicle, or to something
 * not invented yet. Everything that hunts queries `Hostile` and never asks what it is attached to;
 * everything that becomes hostile gains a component rather than being replaced.
 */
export const Hostile = { faction: u8(), aggression: f32() }

/** The one the player is. */
export const Player = {}

/** Can be hurt, and is not simply gone when it is. */
export const Health = { hp: u16(), max: u16() }

/** Marked for removal at the end of the step, so no system deletes out from under another. */
export const Doomed = { why: u8() }

/* ---- relations, which are the thing a component cannot say ------------------------------------ */

/**
 * `DrivenBy` — a vehicle and the person in it, as a RELATION rather than an id in a field.
 *
 * The point over a field holding an entity id: when the driver is destroyed the relation goes
 * with them, instead of leaving the car steered by a dangling reference to somebody who stopped
 * existing. That bug shows up once, in front of somebody.
 *
 * PLAIN, NOT `withAutoRemoveSubject`. That flag destroys the SUBJECT when the TARGET dies — I had
 * it backwards and the test caught it: shooting the driver deleted the car. A car whose driver is
 * gone is an empty car, which is a thing that should sit there.
 */
export const DrivenBy = createRelation()

/** `MemberOf` — which faction, gang or herd something belongs to, as an entity of its own. */
export const MemberOf = createRelation()

/**
 * `AttachedTo` — a trailer on a truck, a turret on a roof.
 *
 * This one DOES want `withAutoRemoveSubject`: destroy the truck and the trailer goes with it,
 * because a trailer hanging in the air where a truck used to be is not a state worth having.
 */
export const AttachedTo = createRelation(withAutoRemoveSubject)

/* ---- the sets other code asks for ------------------------------------------------------------ */

/**
 * Named queries, so a caller says what it wants rather than how to find it.
 *
 * None of them mention a KIND. "The things that can hurt you" is `[Hostile, Transform]` — it does
 * not care that half of them are cars and half are dogs.
 */
export const SETS = {
  /** anything with a place in the world */
  placed: [Transform],
  /** anything moving under its own power this frame */
  moving: [Transform, Velocity],
  /** traffic: vehicles the simulation drives */
  traffic: [Vehicle, Transform, Autonomous],
  /** people on foot */
  pedestrians: [Human, Walking, Transform],
  /** the things that can hurt you, whatever shape they are */
  threats: [Hostile, Transform],
  /** everything drawable, which is not the same as everything placed */
  drawable: [Transform, Visual],
  /** anything with a running engine, voiced or not */
  engines: [Engine, Transform],
}
