// Frame data. This file is the game.
//
// Everything a move does is three numbers and a rectangle: how long before it hits, how long it
// hits for, how long you are stuck afterwards, and where the hit lands. Change nothing else in the
// project and the game plays completely differently.
//
// The numbers below are 60Hz and read the way the genre writes them — `3/2/6` is three frames of
// startup, two active, six recovery. They are deliberately close to the 1991 originals: a jab that
// starts in three frames and leaves you plus-two on block, a roundhouse that starts in eleven and
// loses badly if it whiffs. Nothing here is balanced yet; it is *shaped*, which matters more early.
//
// ADVANTAGE is not stored. It falls out: the defender is stuck for `blockstun` frames while the
// attacker still owes `active - 1 + recovery` frames from the moment of contact. Jab on block is
// 10 - (2 - 1 + 6) = +3. If you want a move to be plus, shorten its recovery; there is no separate
// dial and there should not be.

/** A rectangle in the fighter's own space: origin at the feet, +x forward, +y up, facing right. */
export interface Box {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 })

/** Mirror a local box by facing and translate to world space. */
export function worldBox(b: Box, x: number, y: number, facing: number): Box {
  const a = x + b.x0 * facing
  const c = x + b.x1 * facing
  return { x0: Math.min(a, c), y0: y + b.y0, x1: Math.max(a, c), y1: y + b.y1 }
}

export function overlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

/** What a guard has to be doing to stop it. `mid` is stopped by either. */
export type Height = 'mid' | 'low' | 'overhead'

export type Stance = 'stand' | 'crouch' | 'air'

export interface Projectile {
  readonly speed: number
  readonly damage: number
  readonly hitstun: number
  readonly blockstun: number
  /** Spawn offset from the fighter's origin, and the fireball's own box. */
  readonly at: Box
}

export interface Move {
  readonly id: string
  readonly name: string
  readonly stance: Stance
  readonly startup: number
  readonly active: number
  readonly recovery: number
  readonly damage: number
  readonly hitstun: number
  readonly blockstun: number
  readonly height: Height
  readonly hitbox: Box
  /** How far the two are shoved apart, on hit and on block. */
  readonly pushHit: number
  readonly pushBlock: number
  readonly knockdown?: boolean
  /** Special-cancellable: a normal that can be interrupted into a special on hit or block. */
  readonly cancel?: boolean
  /** Chainable into another light. */
  readonly chain?: boolean
  /** Meter for landing it, and a quarter of that for throwing it into the air. */
  readonly meter: number
  /** Frames (inclusive, 1-based) during which the fighter cannot be hit at all. */
  readonly invuln?: readonly [number, number]
  /** Specials only: chip damage on block. Normals do none. */
  readonly chip?: number
  readonly projectile?: Projectile
  /** An uppercut leaves the ground. Applied on the first frame. */
  readonly rise?: { readonly vy: number; readonly vx: number }
  /** An air move stays out until it lands; `active` is a maximum rather than a schedule. */
  readonly untilLand?: boolean
}

export const totalFrames = (m: Move): number => m.startup + m.active + m.recovery

/** Frame advantage on block, positive meaning the attacker recovers first. */
export const blockAdvantage = (m: Move): number => m.blockstun - (m.active - 1 + m.recovery)
export const hitAdvantage = (m: Move): number => m.hitstun - (m.active - 1 + m.recovery)

const NORMAL = { meter: 6, pushHit: 5, pushBlock: 7 } as const

/**
 * The shared moveset. Every character has these eighteen-ish and differs by reach, speed and the
 * two specials — which is exactly how the originals did it, and why a roster of twelve was ever
 * affordable. Per-character scaling lives in `Character` below.
 */
export const MOVES = {
  'stand-lp': {
    ...NORMAL, id: 'stand-lp', name: 'Jab', stance: 'stand',
    startup: 3, active: 2, recovery: 6, damage: 25, hitstun: 14, blockstun: 10,
    height: 'mid', hitbox: box(26, 118, 84, 158), chain: true, cancel: true, meter: 5,
  },
  'stand-mp': {
    ...NORMAL, id: 'stand-mp', name: 'Straight', stance: 'stand',
    startup: 6, active: 3, recovery: 11, damage: 45, hitstun: 17, blockstun: 13,
    height: 'mid', hitbox: box(26, 112, 102, 162), cancel: true,
  },
  'stand-hp': {
    ...NORMAL, id: 'stand-hp', name: 'Fierce', stance: 'stand',
    startup: 9, active: 4, recovery: 17, damage: 70, hitstun: 20, blockstun: 15,
    height: 'mid', hitbox: box(26, 106, 124, 170), cancel: true, pushHit: 9, pushBlock: 11, meter: 9,
  },
  'stand-lk': {
    ...NORMAL, id: 'stand-lk', name: 'Short', stance: 'stand',
    startup: 4, active: 3, recovery: 7, damage: 28, hitstun: 14, blockstun: 10,
    height: 'mid', hitbox: box(26, 58, 90, 102), chain: true, cancel: true, meter: 5,
  },
  'stand-mk': {
    ...NORMAL, id: 'stand-mk', name: 'Forward', stance: 'stand',
    startup: 7, active: 4, recovery: 12, damage: 48, hitstun: 17, blockstun: 13,
    height: 'mid', hitbox: box(26, 66, 112, 120), cancel: true,
  },
  'stand-hk': {
    ...NORMAL, id: 'stand-hk', name: 'Roundhouse', stance: 'stand',
    startup: 11, active: 5, recovery: 19, damage: 75, hitstun: 21, blockstun: 16,
    height: 'mid', hitbox: box(26, 88, 138, 172), pushHit: 11, pushBlock: 13, meter: 9,
  },

  'crouch-lp': {
    ...NORMAL, id: 'crouch-lp', name: 'Crouch jab', stance: 'crouch',
    startup: 3, active: 2, recovery: 7, damage: 22, hitstun: 13, blockstun: 10,
    height: 'mid', hitbox: box(26, 58, 82, 96), chain: true, cancel: true, meter: 5,
  },
  'crouch-lk': {
    ...NORMAL, id: 'crouch-lk', name: 'Crouch short', stance: 'crouch',
    startup: 4, active: 2, recovery: 8, damage: 24, hitstun: 13, blockstun: 9,
    height: 'low', hitbox: box(26, 6, 88, 46), chain: true, meter: 5,
  },
  'crouch-mp': {
    ...NORMAL, id: 'crouch-mp', name: 'Crouch strong', stance: 'crouch',
    startup: 6, active: 3, recovery: 13, damage: 44, hitstun: 17, blockstun: 12,
    height: 'mid', hitbox: box(26, 66, 100, 130), cancel: true,
  },
  'crouch-hk': {
    ...NORMAL, id: 'crouch-hk', name: 'Sweep', stance: 'crouch',
    startup: 10, active: 4, recovery: 22, damage: 65, hitstun: 24, blockstun: 15,
    height: 'low', hitbox: box(26, 2, 128, 48), knockdown: true, pushHit: 6, pushBlock: 12, meter: 9,
  },

  'air-lp': {
    ...NORMAL, id: 'air-lp', name: 'Air jab', stance: 'air',
    startup: 4, active: 10, recovery: 4, damage: 30, hitstun: 16, blockstun: 12,
    height: 'overhead', hitbox: box(22, 84, 84, 138), untilLand: true, meter: 5,
  },
  'air-hk': {
    ...NORMAL, id: 'air-hk', name: 'Jump kick', stance: 'air',
    startup: 7, active: 14, recovery: 5, damage: 72, hitstun: 20, blockstun: 15,
    height: 'overhead', hitbox: box(22, 34, 108, 110), untilLand: true, meter: 9,
  },

  // --- specials -----------------------------------------------------------------------------
  //
  // The fireball's own hitbox is empty: the fighter never hits anyone with it, the projectile does.
  // The uppercut is the opposite — six frames of total invulnerability on the way up, which is what
  // makes it the answer to everything and why its recovery is brutal.
  fireball: {
    ...NORMAL, id: 'fireball', name: 'Fireball', stance: 'stand',
    startup: 13, active: 1, recovery: 35, damage: 0, hitstun: 0, blockstun: 0,
    height: 'mid', hitbox: box(0, 0, 0, 0), meter: 8, chip: 0,
    projectile: { speed: 8, damage: 40, hitstun: 18, blockstun: 12, at: box(30, 74, 82, 122) },
  },
  uppercut: {
    ...NORMAL, id: 'uppercut', name: 'Uppercut', stance: 'stand',
    startup: 3, active: 14, recovery: 28, damage: 90, hitstun: 26, blockstun: 14,
    height: 'mid', hitbox: box(20, 96, 86, 196), knockdown: true, invuln: [1, 6],
    pushHit: 4, pushBlock: 10, meter: 12, chip: 8, rise: { vy: 13.5, vx: 2.2 },
  },
} as const satisfies Record<string, Move>

export type MoveId = keyof typeof MOVES

export const move = (id: MoveId): Move => MOVES[id]

/** Hurtboxes by stance. An attacking fighter keeps their stance's box — no shrinking hurtboxes. */
export const HURT: Record<Stance, Box> = {
  stand: box(-32, 0, 32, 190),
  crouch: box(-36, 0, 36, 122),
  air: box(-30, 24, 30, 168),
}

export interface Character {
  readonly id: string
  readonly name: string
  /** Placeholder-art colours: body, and the trim that marks the striking limb. */
  readonly body: string
  readonly trim: string
  readonly health: number
  readonly walkFwd: number
  readonly walkBack: number
  readonly jumpVy: number
  readonly jumpVx: number
  /** Multiplies every hitbox's forward reach. Kestrel is long; Bollard is not. */
  readonly reach: number
  readonly damageScale: number
}

/**
 * Two of the twelve, enough to feel the difference between archetypes. The rest arrive with their
 * art; the numbers are the only part that has to exist for them to be playable, which is the point
 * of keeping frame data out of the art pipeline entirely. See ROSTER.md.
 */
export const CHARACTERS: readonly Character[] = [
  {
    id: 'kestrel', name: 'KESTREL', body: '#1f6f6a', trim: '#e2703a',
    health: 1000, walkFwd: 2.4, walkBack: 1.9, jumpVy: 14.2, jumpVx: 4.6, reach: 1.06, damageScale: 1,
  },
  {
    id: 'bollard', name: 'BOLLARD', body: '#8a8f3a', trim: '#b4303a',
    health: 1220, walkFwd: 1.6, walkBack: 1.2, jumpVy: 13.0, jumpVx: 3.4, reach: 0.9, damageScale: 1.2,
  },
]

export const findCharacter = (id: string): Character => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0]

/** A move as this character throws it: reach and damage scaled, frames untouched. */
export function scaled(m: Move, c: Character): Move {
  if (c.reach === 1 && c.damageScale === 1) return m
  return {
    ...m,
    damage: Math.round(m.damage * c.damageScale),
    hitbox: box(m.hitbox.x0, m.hitbox.y0, Math.round(m.hitbox.x1 * c.reach), m.hitbox.y1),
  }
}
