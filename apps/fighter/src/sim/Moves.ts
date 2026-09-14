// The shape of a move, and the geometry a move is made of. The numbers themselves live in
// `../data/chars/*.json` — this file is the type they are read into and nothing more.
//
// Everything a move does is three numbers and a rectangle: how long before it hits, how long it
// hits for, how long you are stuck afterwards, and where the hit lands. The numbers are 60Hz and
// read the way the genre writes them — `3/2/6` is three frames of startup, two active, six
// recovery. Distances are arcade pixels: the 1991 machine drew 384×224 and every hitbox, walk speed
// and stage width here is in those pixels, because that is the unit the reference data comes in.
//
// ADVANTAGE is not stored. It falls out: the defender is stuck for `blockstun` frames while the
// attacker still owes `active - 1 + recovery` frames from the moment of contact. If you want a move
// to be plus, shorten its recovery; there is no separate dial and there should not be.

/** A rectangle in the fighter's own space: origin at the feet, +x forward, +y up, facing right. */
export interface Box {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 })

/** `[x0, y0, x1, y1]` as the JSON writes it. */
export type BoxTuple = readonly [number, number, number, number]
export const fromTuple = (t: BoxTuple): Box => box(t[0], t[1], t[2], t[3])

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

/** Light, medium or heavy — decides hitstun, blockstun and hitstop unless the move says otherwise. */
export type Strength = 'light' | 'medium' | 'heavy'

/**
 * How a move connects. A `strike` is a hitbox; a `projectile` spawns something that carries the
 * hitbox away; a `throw` and a `command-throw` grab — the difference being that a normal throw is
 * only attempted when in range and otherwise gives you the normal, while a command throw always
 * comes out and whiffs, expensively.
 */
export type MoveKind = 'strike' | 'projectile' | 'throw' | 'command-throw'

/** How a special is asked for. Matched in `Fighter.specialFor`, in the order the character lists them. */
export type MotionName =
  | 'qcf' | 'qcb' | 'dp' | 'rdp' | 'hcf' | 'hcb'
  | '360' | 'charge-back' | 'charge-down'
  | 'ppp' | 'kkk' | 'mash-p' | 'mash-k'

export interface Projectile {
  readonly speed: number
  readonly damage: number
  readonly hitstun: number
  readonly blockstun: number
  /** Spawn offset from the fighter's origin, and the fireball's own box. */
  readonly at: Box
  /** Sprite animation for it, if the art has one. */
  readonly anim?: string
}

export interface Move {
  readonly id: string
  readonly name: string
  readonly kind: MoveKind
  readonly stance: Stance
  readonly strength: Strength
  readonly startup: number
  readonly active: number
  readonly recovery: number
  readonly damage: number
  readonly hitstun: number
  readonly blockstun: number
  readonly hitstop: number
  /** Dizzy points added on hit. */
  readonly stun: number
  readonly height: Height
  readonly hitbox: Box
  /** How far the two are shoved apart, on hit and on block. */
  readonly pushHit: number
  readonly pushBlock: number
  readonly knockdown: boolean
  /** Special-cancellable: a normal that can be interrupted into a special on hit or block. */
  readonly cancel: boolean
  /** Chainable into another light. */
  readonly chain: boolean
  /** Meter for landing it, and a quarter of that for throwing it into the air. */
  readonly meter: number
  /** Frames (inclusive, 1-based) during which the fighter cannot be hit at all. */
  readonly invuln?: readonly [number, number]
  /** Fireballs pass through it (the lariat, the flywheel). */
  readonly projectileInvuln: boolean
  /** Specials only: chip damage on block. Normals do none. */
  readonly chip: number
  readonly projectile?: Projectile
  /** Leaves the ground. Applied on the first frame. */
  readonly rise?: { readonly vy: number; readonly vx: number }
  /** Moves forward under its own power while active — a roll, a spinning kick. */
  readonly travel?: { readonly vx: number }
  /** On contact, the attacker is thrown back — Blanka's ball off a guard. */
  readonly bounce?: { readonly vx: number; readonly vy: number }
  /** A multi-hit move re-arms its hitbox this many frames after connecting, up to `hits` times. */
  readonly hits: number
  readonly rehit: number
  /** An air move stays out until it lands; `active` is a maximum rather than a schedule. */
  readonly untilLand: boolean
  /** Grabs: how close the feet have to be, and how long the victim is held before the damage. */
  readonly range: number
  readonly hold: number
  /** Which sprite animation draws it. */
  readonly anim: string
  /** Specials only: the motion that asks for it, and which button group. */
  readonly motion?: MotionName
  readonly button?: 'P' | 'K'
}

export const totalFrames = (m: Move): number => m.startup + m.active + m.recovery

/** Frame advantage on block, positive meaning the attacker recovers first. */
export const blockAdvantage = (m: Move): number => m.blockstun - (m.active - 1 + m.recovery)
export const hitAdvantage = (m: Move): number => m.hitstun - (m.active - 1 + m.recovery)

/** Frame-local check: is the move's hitbox live on this tick? `f` counts ticks since it began. */
export function activeOn(m: Move, f: number): boolean {
  return f >= m.startup - 1 && f < m.startup - 1 + m.active
}
