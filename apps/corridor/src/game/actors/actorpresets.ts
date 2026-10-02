// A dozen actors to start from, the same idea as `vehiclepresets.ts`.
//
// Rich, 2026-09-29: *"The same concept will apply to actors and weapons as well."* — so: a preset is
// a whole `ActorDoc` with a name and a line saying when to reach for it, and nothing in it names a
// model. A preset is the BEHAVIOUR; the visual is chosen separately and the two meet in a build.
//
// WHERE THE NUMBERS COME FROM. Speeds are real ones, because they are the numbers a person can
// check against something they have seen: a brisk walk is 1.4 m/s, a fit person sprints at about 8,
// a greyhound at 17, a deer at 13, a pigeon flies at 14. Health and damage are game numbers and
// cannot be derived from anything — the scale is set by the pedestrian at 100 hp, and everything
// else is placed against that so the derived readouts (hits to kill, seconds to kill) fall where
// somebody would expect.
//
// MASS AND HEIGHT ARE NOT DECORATION. `toRagdollLimbs` builds the ragdoll out of them, so a 22 kg
// dog and a 90 kg deer fold and land differently, and a car that hits one at 30 mph does a
// different thing. The bird has `ragdoll: false` on purpose: a 0.4 kg body with 0.25 m limbs is
// below the size where the solver behaves, and it should fall as one piece.

import type { ActorDoc } from './actorspecs'

export interface ActorPreset {
  id: string
  name: string
  /** one line for the picker: what this is and when to reach for it */
  note: string
  /** which catalog classes it suits, for sorting the picker when a visual is already chosen */
  suits: string[]
  doc: ActorDoc
}

function make(
  move: ActorDoc['move'],
  body: ActorDoc['body'],
  combat: ActorDoc['combat'],
): ActorDoc {
  return { move, body, combat, rig: { from_asset: true } }
}

/** The dozen. People first, then animals, because that is the order somebody scans them in. */
export const ACTOR_PRESETS: ActorPreset[] = [
  {
    id: 'passer-by',
    name: 'Passer-by',
    note: 'Walks, does not fight, falls over convincingly. The crowd.',
    suits: ['pedestrian'],
    doc: make(
      { walk_ms: 1.4, run_ms: 3.6, climb_ms: 0, fly_ms: 0, jump_ms: 2.6, turn_deg_s: 360 },
      { health: 100, armour: 0, mass: 78, height: 1.75, ragdoll: true },
      { damage: 4, attack_s: 1.2, reach_m: 1.0, weapons: [] },
    ),
  },
  {
    id: 'jogger',
    name: 'Jogger',
    note: 'Keeps going at a pace, turns quickly, never in your way for long.',
    suits: ['pedestrian'],
    doc: make(
      { walk_ms: 1.6, run_ms: 5.0, climb_ms: 0, fly_ms: 0, jump_ms: 3.0, turn_deg_s: 480 },
      { health: 100, armour: 0, mass: 70, height: 1.74, ragdoll: true },
      { damage: 4, attack_s: 1.2, reach_m: 1.0, weapons: [] },
    ),
  },
  {
    id: 'player-character',
    name: 'Player character',
    note: 'What you drive the camera with on foot: fast, climbs, jumps a fence.',
    suits: ['character', 'pedestrian'],
    doc: make(
      { walk_ms: 1.7, run_ms: 6.4, climb_ms: 1.4, fly_ms: 0, jump_ms: 4.4, turn_deg_s: 720 },
      { health: 140, armour: 0.1, mass: 80, height: 1.82, ragdoll: true },
      { damage: 14, attack_s: 0.6, reach_m: 1.6, weapons: [] },
    ),
  },
  {
    id: 'sprinter',
    name: 'Sprinter',
    note: 'Eight metres a second and a long jump. For a chase you are meant to lose.',
    suits: ['character'],
    doc: make(
      { walk_ms: 1.8, run_ms: 8.2, climb_ms: 1.2, fly_ms: 0, jump_ms: 5.0, turn_deg_s: 600 },
      { health: 110, armour: 0, mass: 74, height: 1.86, ragdoll: true },
      { damage: 10, attack_s: 0.7, reach_m: 1.5, weapons: [] },
    ),
  },
  {
    id: 'thug',
    name: 'Thug',
    note: 'Hits hard, takes a beating, will not outrun a car.',
    suits: ['character', 'pedestrian'],
    doc: make(
      { walk_ms: 1.5, run_ms: 4.6, climb_ms: 0.9, fly_ms: 0, jump_ms: 3.2, turn_deg_s: 420 },
      { health: 160, armour: 0.15, mass: 96, height: 1.88, ragdoll: true },
      { damage: 22, attack_s: 0.9, reach_m: 1.6, weapons: [] },
    ),
  },
  {
    id: 'guard',
    name: 'Guard',
    note: 'Armoured, steady, meant to be shot at rather than chased.',
    suits: ['character'],
    doc: make(
      { walk_ms: 1.4, run_ms: 4.2, climb_ms: 0.8, fly_ms: 0, jump_ms: 2.8, turn_deg_s: 360 },
      { health: 200, armour: 0.35, mass: 102, height: 1.85, ragdoll: true },
      { damage: 16, attack_s: 0.8, reach_m: 1.5, weapons: [] },
    ),
  },
  {
    id: 'brute',
    name: 'Brute',
    note: 'Two and a bit metres, slow, and one hit is most of your health.',
    suits: ['character'],
    doc: make(
      { walk_ms: 1.2, run_ms: 3.6, climb_ms: 0, fly_ms: 0, jump_ms: 2.2, turn_deg_s: 240 },
      { health: 420, armour: 0.45, mass: 190, height: 2.25, ragdoll: true },
      { damage: 48, attack_s: 1.6, reach_m: 2.2, weapons: [] },
    ),
  },
  {
    id: 'child',
    name: 'Child',
    note: 'Small, light and quick to turn. Changes what a collision means.',
    suits: ['pedestrian', 'character'],
    doc: make(
      { walk_ms: 1.1, run_ms: 3.8, climb_ms: 1.0, fly_ms: 0, jump_ms: 2.4, turn_deg_s: 600 },
      { health: 60, armour: 0, mass: 28, height: 1.25, ragdoll: true },
      { damage: 2, attack_s: 1.2, reach_m: 0.7, weapons: [] },
    ),
  },
  {
    id: 'dog',
    name: 'Dog',
    note: 'Faster than you over the first fifty metres, and low enough to go under things.',
    suits: ['animal'],
    doc: make(
      { walk_ms: 1.2, run_ms: 9.0, climb_ms: 0, fly_ms: 0, jump_ms: 3.0, turn_deg_s: 720 },
      { health: 40, armour: 0, mass: 22, height: 0.6, ragdoll: true },
      { damage: 9, attack_s: 0.8, reach_m: 0.6, weapons: [] },
    ),
  },
  {
    id: 'deer',
    name: 'Deer',
    note: 'Ninety kilograms at thirteen metres a second. The one that ends a run.',
    suits: ['animal'],
    doc: make(
      { walk_ms: 1.4, run_ms: 13.0, climb_ms: 0, fly_ms: 0, jump_ms: 5.0, turn_deg_s: 540 },
      { health: 60, armour: 0, mass: 90, height: 1.4, ragdoll: true },
      { damage: 6, attack_s: 1.5, reach_m: 0.9, weapons: [] },
    ),
  },
  {
    id: 'cat',
    name: 'Cat',
    note: 'Climbs, turns on the spot, and is never where you last saw it.',
    suits: ['animal'],
    doc: make(
      { walk_ms: 0.9, run_ms: 11.0, climb_ms: 2.2, fly_ms: 0, jump_ms: 4.6, turn_deg_s: 900 },
      { health: 18, armour: 0, mass: 4.5, height: 0.3, ragdoll: true },
      { damage: 3, attack_s: 0.5, reach_m: 0.3, weapons: [] },
    ),
  },
  {
    id: 'bird',
    name: 'Bird',
    note: 'Flies, weighs nothing, and does NOT ragdoll — a 0.25 m limb is below where the solver behaves.',
    suits: ['animal'],
    doc: make(
      { walk_ms: 0.4, run_ms: 1.0, climb_ms: 0, fly_ms: 14.0, jump_ms: 1.0, turn_deg_s: 900 },
      { health: 5, armour: 0, mass: 0.4, height: 0.25, ragdoll: false },
      { damage: 1, attack_s: 1.0, reach_m: 0.2, weapons: [] },
    ),
  },
]

export const ACTOR_PRESET_IDS = ACTOR_PRESETS.map((p) => p.id)

/** A fresh copy of one, or null. Never hand out the module's own object. */
export function actorPresetDoc(id: string): ActorDoc | null {
  const p = ACTOR_PRESETS.find((x) => x.id === id)
  return p ? structuredClone(p.doc) : null
}

export function actorPreset(id: string): ActorPreset | null {
  return ACTOR_PRESETS.find((x) => x.id === id) ?? null
}

/**
 * The presets, the ones that suit this catalog class first.
 *
 * Sorted, not filtered: the class of the model is evidence about what somebody is making, not a
 * rule about it. Somebody building a hostile out of a deer model should find the thug further down
 * the list, not find that the list has decided for them.
 */
export function actorPresetsFor(kind: string | null | undefined): ActorPreset[] {
  if (!kind) return ACTOR_PRESETS
  const fits = ACTOR_PRESETS.filter((p) => p.suits.includes(kind))
  const rest = ACTOR_PRESETS.filter((p) => !p.suits.includes(kind))
  return [...fits, ...rest]
}
