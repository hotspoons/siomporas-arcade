// What a weapon IS, as a document — and the arithmetic a designer actually balances against.
//
// docs/corridor/PLAN-VEHICLES-ACTORS.md §3, from Rich: "We'll need a weapons system too and be able
// to pull in weapons from the asset library."
//
// PULL FROM THE LIBRARY, NEVER DUPLICATE. A weapon is an ordinary catalog asset — a model, class
// `weapon` — plus this document stored beside it, exactly the way a vehicle's dynamics are. An
// actor's `combat.weapons` holds IDS, so arming somebody is naming a thing that exists rather than
// describing one again in a second place where the two can drift.
//
// THE FIELDS ARE THE SPEC; THE FUNCTIONS ARE THE DESIGN. `rate_per_s` and `magazine` are what the
// weapon is made of, but nobody balances a fight in those terms — they balance it in "how long does
// a magazine last", "what is the damage per second once you count reloading", "how big is the cone
// at thirty metres", "how far does the shot drop". Every one of those is arithmetic over the spec,
// so it lives here beside it and is checked in a test rather than discovered in play.
//
// NO DOM, NO THREE, NO RAPIER — same discipline as `vehicles.ts` and `actorspecs.ts`. The one place
// the physics engine appears is `impulse`, which is a number in N·s handed to `explode`/`applyImpulse`
// by whoever fires the thing.

/** How it does its damage. The four behave differently enough that the validator cares. */
export type WeaponKind = 'ballistic' | 'melee' | 'thrown' | 'beam'

export interface WeaponAudio {
  fire?: string
  reload?: string
}

export interface WeaponDoc {
  kind: WeaponKind
  /** per hit */
  damage: number
  /** hits per second while the trigger is held */
  rate_per_s: number
  /** rounds before a reload. 0 = never reloads (melee, beam) */
  magazine: number
  reload_s: number
  /**
   * m/s of the projectile. **0 means HITSCAN** — the hit is resolved instantly along a ray, with no
   * travel time and no drop. That single zero changes what half the other fields mean, which is why
   * the validator checks the combinations rather than each number alone.
   */
  muzzle_ms: number
  /** half-angle of the cone, degrees. 0 = perfectly accurate */
  spread_deg: number
  /** 0…1, how much the aim is thrown upward by firing */
  recoil: number
  /** m, past which it does nothing */
  range_m: number
  /** N·s delivered into the physics world on a hit — the seam with the engine */
  impulse: number
  /** which bone role it hangs off, from the holder's rig binding */
  attach: string
  audio: WeaponAudio
}

/* ---- templates ---------------------------------------------------------------------------------- */

/**
 * Starting points, one per kind plus the obvious variants.
 *
 * As with vehicles and actors these are DEFAULTS the form says are defaults, not claims. They exist
 * because a form full of zeroes is a form nobody fills in, and because `muzzle_ms` left at zero
 * quietly turns a rifle into a hitscan weapon.
 */
export const WEAPON_TEMPLATES: Record<string, WeaponDoc> = {
  pistol: { kind: 'ballistic', damage: 24, rate_per_s: 4, magazine: 15, reload_s: 1.8, muzzle_ms: 380, spread_deg: 1.2, recoil: 0.35, range_m: 60, impulse: 120, attach: 'hand_r', audio: {} },
  rifle: { kind: 'ballistic', damage: 34, rate_per_s: 9, magazine: 30, reload_s: 2.4, muzzle_ms: 880, spread_deg: 0.6, recoil: 0.5, range_m: 200, impulse: 260, attach: 'hand_r', audio: {} },
  shotgun: { kind: 'ballistic', damage: 68, rate_per_s: 1.2, magazine: 6, reload_s: 3.2, muzzle_ms: 420, spread_deg: 7, recoil: 0.8, range_m: 25, impulse: 900, attach: 'hand_r', audio: {} },
  crowbar: { kind: 'melee', damage: 28, rate_per_s: 1.4, magazine: 0, reload_s: 0, muzzle_ms: 0, spread_deg: 0, recoil: 0.1, range_m: 1.6, impulse: 400, attach: 'hand_r', audio: {} },
  grenade: { kind: 'thrown', damage: 120, rate_per_s: 0.5, magazine: 4, reload_s: 1.0, muzzle_ms: 18, spread_deg: 0, recoil: 0, range_m: 30, impulse: 4000, attach: 'hand_r', audio: {} },
  laser: { kind: 'beam', damage: 8, rate_per_s: 20, magazine: 0, reload_s: 0, muzzle_ms: 0, spread_deg: 0, recoil: 0, range_m: 150, impulse: 0, attach: 'hand_r', audio: {} },
}

export const WEAPON_TEMPLATE_IDS = Object.keys(WEAPON_TEMPLATES)
export const WEAPON_KINDS: WeaponKind[] = ['ballistic', 'melee', 'thrown', 'beam']

/** The catalog class a weapon is filed under. One, and it is not in the library's standard list yet. */
export const WEAPON_CLASS = 'weapon'

export function defaultWeapon(template = 'pistol'): WeaponDoc {
  return structuredClone(WEAPON_TEMPLATES[template] ?? WEAPON_TEMPLATES.pistol)
}

/* ---- validation ---------------------------------------------------------------------------------- */

export interface WeaponReport {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Check a document — every problem, not the first.
 *
 * The interesting checks are the COMBINATIONS, because every field here is individually plausible
 * and it is the pairs that are nonsense: a melee weapon with a magazine, a hitscan weapon with a
 * range longer than anything can see, a beam with spread. Those are the ones that produce a weapon
 * which works and behaves like something nobody meant.
 */
export function validateWeapon(w: WeaponDoc | null | undefined, opts: { rigRoles?: string[] } = {}): WeaponReport {
  const errors: string[] = []
  const warnings: string[] = []
  if (!w) return { ok: true, errors, warnings }

  if (!WEAPON_KINDS.includes(w.kind)) errors.push(`kind ${JSON.stringify(w.kind)} must be one of ${WEAPON_KINDS.join(', ')}`)
  const num = (v: number, name: string, min: number, max: number) => {
    if (!Number.isFinite(v)) { errors.push(`${name} must be a number`); return }
    if (v < min) errors.push(`${name} must be at least ${min}`)
    else if (v > max) warnings.push(`${name} is ${v}, which is past anything sensible`)
  }
  num(w.damage, 'damage', 0, 100000)
  num(w.rate_per_s, 'rate_per_s', 0.01, 100)
  num(w.magazine, 'magazine', 0, 10000)
  num(w.reload_s, 'reload_s', 0, 60)
  num(w.muzzle_ms, 'muzzle_ms', 0, 3000)
  num(w.spread_deg, 'spread_deg', 0, 90)
  num(w.range_m, 'range_m', 0.1, 5000)
  num(w.impulse, 'impulse', 0, 1e6)
  if (!Number.isFinite(w.recoil) || w.recoil < 0 || w.recoil > 1) errors.push('recoil must be between 0 and 1')

  // ---- the combinations, which is where the real mistakes are
  if (w.kind === 'melee') {
    if (w.magazine > 0) errors.push('a melee weapon has no magazine')
    if (w.muzzle_ms > 0) errors.push('a melee weapon has no muzzle velocity')
    if (w.range_m > 5) warnings.push(`reach ${w.range_m} m is a long arm for a melee weapon`)
  }
  if (w.kind === 'beam') {
    if (w.spread_deg > 0) warnings.push('a beam with spread is a beam that misses — spread_deg is usually 0 here')
    if (w.magazine > 0 && w.reload_s === 0) warnings.push('a magazine with no reload time empties and refills instantly')
  }
  if (w.magazine > 0 && w.reload_s <= 0) warnings.push('a magazine with no reload time is a magazine that costs nothing')
  if (w.magazine === 0 && w.reload_s > 0) warnings.push('reload_s does nothing without a magazine')
  if (w.muzzle_ms === 0 && w.kind === 'ballistic') warnings.push('muzzle_ms 0 makes this HITSCAN — instant, no travel, no drop. Deliberate?')
  if (w.muzzle_ms > 0 && w.range_m / Math.max(1, w.muzzle_ms) > 3) {
    warnings.push(`a shot takes ${(w.range_m / w.muzzle_ms).toFixed(1)} s to reach maximum range — nothing will still be there`)
  }
  // Spread is a half-angle, so a wide one at a long range is a weapon that cannot hit a person
  // however well aimed. The check is in METRES, which is the thing somebody can picture.
  if (w.spread_deg > 0 && w.range_m > 0) {
    const at = spreadRadiusAt(w, w.range_m)
    if (at > 8) warnings.push(`the cone is ${at.toFixed(1)} m across at ${w.range_m} m — nothing can be hit at that range`)
  }
  if (opts.rigRoles && w.attach && !opts.rigRoles.includes(w.attach)) {
    warnings.push(`attach "${w.attach}" is not a bone role on the holder's rig (${opts.rigRoles.join(', ') || 'none bound'})`)
  }
  return { ok: errors.length === 0, errors, warnings }
}

/* ---- the arithmetic somebody balances against -------------------------------------------------- */

/** Damage per second while the trigger is held and the magazine lasts. */
export function burstDps(w: WeaponDoc): number {
  return w.damage * w.rate_per_s
}

/**
 * Damage per second once reloading is counted — the honest number.
 *
 * A shotgun with a six-round magazine and a 3.2 s reload does not do its burst DPS for more than
 * five seconds, and comparing two weapons on burst alone is how a weapon that looks balanced is not.
 * A weapon with no magazine sustains its burst rate for ever.
 */
export function sustainedDps(w: WeaponDoc): number {
  if (w.magazine <= 0) return burstDps(w)
  const firing = w.magazine / Math.max(0.01, w.rate_per_s)
  return (w.magazine * w.damage) / (firing + Math.max(0, w.reload_s))
}

/** How long a full magazine lasts, seconds. Infinite when there is no magazine. */
export function magazineSeconds(w: WeaponDoc): number {
  return w.magazine <= 0 ? Infinity : w.magazine / Math.max(0.01, w.rate_per_s)
}

/**
 * The radius of the spread cone at a distance, metres.
 *
 * `spread_deg` is a HALF-ANGLE, so this is `range × tan(spread)` — and it is the field a designer
 * actually thinks in: "does this hit a person at thirty metres" is a question about metres, not
 * degrees.
 */
export function spreadRadiusAt(w: WeaponDoc, range: number): number {
  return range * Math.tan((w.spread_deg * Math.PI) / 180)
}

/** How long a projectile takes to arrive, seconds. Zero for hitscan, which is the point of hitscan. */
export function flightTime(w: WeaponDoc, range: number): number {
  return w.muzzle_ms <= 0 ? 0 : range / w.muzzle_ms
}

/**
 * How far a shot falls over a distance, metres. Ballistic, no drag.
 *
 * `½gt²` with `t` from the muzzle speed. Zero for hitscan. It is here because it is the number that
 * decides whether a weapon needs the player to aim high, which is a design decision rather than an
 * emergent surprise — a 380 m/s pistol drops about a third of a metre at sixty.
 */
export function dropAt(w: WeaponDoc, range: number, gravity = 9.81): number {
  const t = flightTime(w, range)
  return 0.5 * gravity * t * t
}

/**
 * How many hits, and how long, to drop something with this much health and armour.
 *
 * Takes the numbers rather than an `ActorDoc` so `weapons.ts` does not depend on `actorspecs.ts` —
 * they are siblings, and a weapon that could not be reasoned about without a character is a weapon
 * you cannot balance on its own.
 */
export function shotsToKill(w: WeaponDoc, health: number, armour = 0): { hits: number; seconds: number } {
  const per = w.damage * (1 - Math.min(1, Math.max(0, armour)))
  if (per <= 0) return { hits: Infinity, seconds: Infinity }
  const hits = Math.ceil(health / per)
  // the gaps between shots, plus a reload for every magazine emptied along the way
  const gaps = (hits - 1) / Math.max(0.01, w.rate_per_s)
  const reloads = w.magazine > 0 ? Math.floor((hits - 1) / w.magazine) * Math.max(0, w.reload_s) : 0
  return { hits, seconds: gaps + reloads }
}

/** A one-line summary for the list. */
export function describeWeapon(w: WeaponDoc): string {
  const bits = [w.kind, `${w.damage} dmg`, `${sustainedDps(w).toFixed(0)} dps`]
  if (w.magazine > 0) bits.push(`${w.magazine} rounds`)
  bits.push(w.muzzle_ms > 0 ? `${w.muzzle_ms} m/s` : 'hitscan')
  bits.push(`${w.range_m} m`)
  if (w.impulse > 0) bits.push(`${w.impulse} N·s`)
  return bits.join(' · ')
}
