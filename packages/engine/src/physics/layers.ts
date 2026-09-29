// Who collides with what, as one table.
//
// Rapier packs interaction groups into a u32: the high 16 bits are what a collider IS
// (membership), the low 16 are what it WANTS TO TOUCH (filter). A pair interacts only if each
// one's membership is in the other's filter — the test is symmetric, so a mask that is generous
// in one direction and mean in the other silently does nothing.
//
// THE REASON THIS IS A TABLE AND NOT A PILE OF HEX LITERALS AT THE CALL SITES: every one of these
// masks is a game rule ("debris does not stop the car", "a missile passes through a pedestrian's
// hitbox but not their body"), and a rule spelled as `0x000f0007` at the place it happens to be
// needed is a rule nobody can find, let alone change. When something falls through the world or a
// rocket detonates on thin air, this file is the first place to look and should be the only one.
//
// WHAT IS NOT IN HERE: solver groups. Rapier keeps a second mask deciding which pairs generate
// contact FORCES as opposed to which generate contact EVENTS. Everything here sets both the same
// way; the one case that will want them apart — a sensor volume that reports a hit without
// pushing — is a sensor, which is a different flag entirely.

/** A world role. One bit each; there is room for sixteen and eleven are spoken for. */
export const LAYER = {
  /** the ground: heightfield tiles, the road surface, anything you drive ON */
  terrain: 1 << 0,
  /** immovable built world: building shells, retaining walls, kerbs, bridge decks */
  structure: 1 << 1,
  /** fixed until it is not: signs, poles, lights, hydrants, trunks. Breakables live here */
  prop: 1 << 2,
  /** a vehicle's chassis */
  vehicle: 1 << 3,
  /** wheels, where a game gives them real colliders instead of rays */
  wheel: 1 << 4,
  /** loose junk: wreckage, broken props, thrown cargo. Cheap, plentiful, and in nobody's way */
  debris: 1 << 5,
  /** a character's body — a capsule while they walk, a chain of limbs once they do not */
  character: 1 << 6,
  /** ragdoll limbs, kept apart from `character` so a limb can ignore its own body's capsule */
  limb: 1 << 7,
  /** missiles, grenades, anything in flight that wants to hit things and not be hit back */
  projectile: 1 << 8,
  /** trigger volumes; sensors, so they never push */
  trigger: 1 << 9,
  /** water surfaces: queried for buoyancy, never solid */
  water: 1 << 10,
} as const

export type Layer = keyof typeof LAYER

/** Everything. Useful as a starting point to subtract from, and as the query default. */
export const ALL_LAYERS = 0xffff

/**
 * What each role touches.
 *
 * Read a row as "a X collides with …". The asymmetries are the interesting part:
 *
 *  - **debris does not touch debris.** A hundred pieces of a wrecked bonnet resolving against each
 *    other is the whole frame budget and reads, on screen, as a pile of junk vibrating. They land
 *    on the world and on each other's *absence*, which looks the same and costs nothing.
 *  - **debris does not touch the vehicle.** You drive through your own wreckage. The alternative
 *    is a car that trips over the bumper it just lost, at speed, in front of the camera.
 *  - **projectiles do not touch each other or debris**, so a salvo does not detonate in the tube.
 *  - **triggers touch only what a game asks about** — vehicles, characters, projectiles. A trigger
 *    that also watches debris fires its cutscene when a hubcap rolls through it.
 *  - **limbs ignore `character`**, so a ragdoll does not fight the walking capsule it came from;
 *    the capsule is removed at the moment the ragdoll appears, and this makes the overlap during
 *    that one step harmless rather than explosive.
 */
const TOUCHES: Record<Layer, Layer[]> = {
  terrain: ['vehicle', 'wheel', 'debris', 'character', 'limb', 'projectile', 'prop', 'structure'],
  structure: ['vehicle', 'wheel', 'debris', 'character', 'limb', 'projectile', 'prop'],
  prop: ['terrain', 'structure', 'vehicle', 'wheel', 'debris', 'character', 'limb', 'projectile'],
  vehicle: ['terrain', 'structure', 'prop', 'vehicle', 'character', 'limb', 'projectile', 'trigger'],
  wheel: ['terrain', 'structure', 'prop'],
  debris: ['terrain', 'structure', 'prop', 'character', 'limb'],
  character: ['terrain', 'structure', 'prop', 'vehicle', 'debris', 'projectile', 'trigger'],
  limb: ['terrain', 'structure', 'prop', 'vehicle', 'debris', 'limb', 'projectile'],
  projectile: ['terrain', 'structure', 'prop', 'vehicle', 'character', 'limb', 'trigger'],
  trigger: ['vehicle', 'character', 'projectile'],
  water: ['vehicle', 'character', 'debris', 'projectile'],
}

function mask(of: Layer[]): number {
  let m = 0
  for (const l of of) m |= LAYER[l]
  return m
}

/** The packed interaction group for a role, membership and filter in one u32. */
export function groups(layer: Layer): number {
  return ((LAYER[layer] << 16) | mask(TOUCHES[layer])) >>> 0
}

/**
 * A group for a query (a ray, a shape cast, an explosion's sphere): "I am anything, and I am asking
 * about these."
 *
 * MEMBERSHIP IS EVERYTHING, NOT NOTHING, and this is the trap in Rapier's filtering. The test is
 * `(mine & theirs.filter) && (theirs.membership & my.filter)` — BOTH halves — so a query that
 * claims to be nothing passes the first half against nobody and silently hits NOTHING AT ALL. A
 * wheel ray that matches no ground is a car that falls through the world with no error anywhere,
 * which is exactly the kind of quiet nothing this repo has been bitten by before. So a query is a
 * member of every layer, and says what it wants in the filter half, where it belongs.
 *
 * The corollary: a collider whose own filter is empty can never be found by a query. That is why
 * `water` — a sensor that pushes nothing — still lists what it notionally interacts with.
 */
export function queryGroups(...layers: Layer[]): number {
  return ((ALL_LAYERS << 16) | mask(layers)) >>> 0
}

/** Pre-built query masks for the three questions almost every game asks. */
export const QUERY = {
  /** what a wheel ray or a footstep should stand on */
  ground: queryGroups('terrain', 'structure', 'prop'),
  /** what stops a bullet or blocks line of sight for an explosion */
  solid: queryGroups('terrain', 'structure', 'prop', 'vehicle'),
  /** what an explosion should throw */
  blast: queryGroups('vehicle', 'debris', 'character', 'limb', 'prop', 'projectile'),
} as const

/** Does this packed group claim the given layer as its membership? For asserting a collider's role. */
export function isLayer(packed: number, layer: Layer): boolean {
  return ((packed >>> 16) & LAYER[layer]) !== 0
}
