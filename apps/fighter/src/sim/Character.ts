// Characters are data. This file reads `../data/chars/*.json` and `../data/system.json` into the
// `Move` shape the simulation runs on, filling in everything a config left unsaid from the system
// defaults for that strength of attack.
//
// Why JSON and not code: the whole argument of the 2D layer is that a roster of twelve was
// affordable in 1991 because a character was a table of numbers. Keeping the table in a file that
// is not code means the numbers can be argued about, diffed and — later — fed back from a tuning
// panel, without anyone touching the state machine. The research notes in `../../research/` are
// written against the same field names.
//
// Per-strength variants: a special lists one set of numbers and, optionally, `strengths` with
// overrides keyed `lp`/`mp`/`hp` (or `lk`/`mk`/`hk`). Each strength becomes its own Move, ids
// `hadouken-lp`, `hadouken-mp`, `hadouken-hp`, so the rest of the sim never knows a special has
// versions — it just has three moves that happen to share a motion.

import systemJson from '../data/system.json'
import ryu from '../data/chars/ryu.json'
import zangief from '../data/chars/zangief.json'
import blanka from '../data/chars/blanka.json'
import chunli from '../data/chars/chunli.json'
import kestrel from '../data/chars/kestrel.json'
import bollard from '../data/chars/bollard.json'
import candela from '../data/chars/candela.json'
import { Button, type ButtonMask } from './Motion'
import {
  box, fromTuple, type Box, type BoxTuple, type Height, type MotionName, type Move, type MoveKind, type Stance,
  type Strength,
} from './Moves'

// --- what the files look like ---------------------------------------------------------------

interface ByStrength<T> {
  readonly light: T
  readonly medium: T
  readonly heavy: T
}

export interface SystemConfig {
  readonly fps: number
  readonly screen: readonly [number, number]
  readonly floorScreenY: number
  readonly health: number
  readonly roundSeconds: number
  readonly roundsToWin: number
  readonly introFrames: number
  readonly koFrames: number
  readonly stageHalf: number
  readonly maxSpread: number
  readonly gravity: number
  readonly prejumpFrames: number
  readonly landingFrames: number
  /** Landing after an air attack costs more than an empty jump's landing. */
  readonly airAttackLandingFrames: number
  readonly hitstop: ByStrength<number>
  /** The defender freezes this many frames longer than the attacker on contact. */
  readonly defenderFreezeExtra: number
  readonly hitstun: ByStrength<number>
  readonly blockstun: ByStrength<number>
  readonly pushback: { readonly hit: number; readonly block: number; readonly mediumHit: number; readonly mediumBlock: number; readonly heavyHit: number; readonly heavyBlock: number }
  readonly chipFraction: number
  readonly comboScaling: boolean
  readonly knockdownFrames: number
  readonly wakeupInvuln: number
  /**
   * Dizzy points per hit, and how long the meter stays alive after each: the machine did not decay
   * the meter, it started a timer on every hit and cleared the whole meter when the timer ran out.
   */
  readonly stun: { readonly light: number; readonly medium: number; readonly heavy: number; readonly special: number; readonly timer: { readonly light: number; readonly medium: number; readonly heavy: number; readonly sweep: number; readonly special: number }; readonly dizzyFrames: number }
  /** The round clock ticks once every this many frames — 40 on the machine, so 99 is 66 real seconds. */
  readonly timerFramesPerTick: number
  readonly throw: { readonly hold: number; readonly knockdown: boolean; readonly meter: number }
  readonly meter: { readonly hit: number; readonly block: number; readonly whiffSpecial: number; readonly max: number }
}

/** One normal or special as the JSON writes it. Everything optional falls back to the system. */
interface MoveJson {
  readonly name?: string
  readonly anim?: string
  readonly startup: number
  readonly active: number
  readonly recovery: number
  readonly damage: number
  readonly height?: Height
  readonly hitbox?: BoxTuple
  readonly hitstun?: number
  readonly blockstun?: number
  readonly hitstop?: number
  readonly stun?: number
  readonly pushHit?: number
  readonly pushBlock?: number
  readonly knockdown?: boolean
  readonly cancel?: boolean
  readonly chain?: boolean
  readonly meter?: number
  readonly invuln?: readonly [number, number]
  readonly projectileInvuln?: boolean
  readonly chip?: number
  readonly projectile?: { speed: number; damage: number; hitstun: number; blockstun: number; at: BoxTuple; anim?: string }
  readonly rise?: { vy: number; vx: number }
  readonly travel?: { vx: number }
  readonly bounce?: { vx: number; vy: number }
  readonly hits?: number
  readonly rehit?: number
  readonly untilLand?: boolean
  readonly range?: number
  readonly hold?: number
}

interface SpecialJson extends MoveJson {
  readonly id: string
  readonly motion: MotionName
  readonly button: 'P' | 'K'
  readonly type: 'strike' | 'projectile' | 'command-throw'
  readonly strengths?: Partial<Record<'lp' | 'mp' | 'hp' | 'lk' | 'mk' | 'hk', Partial<MoveJson>>>
}

export interface CharacterJson {
  readonly id: string
  readonly name: string
  /** Directory under /assets/crown/chars/ holding the atlas. */
  readonly art: string
  readonly colors: { readonly body: string; readonly trim: string }
  readonly health: number
  readonly walkFwd: number
  readonly walkBack: number
  readonly jump: { readonly vy: number; readonly vx: number; readonly gravity: number; readonly prejump?: number }
  readonly bodyHalf: number
  readonly hurt: { readonly stand: BoxTuple; readonly crouch: BoxTuple; readonly air: BoxTuple }
  readonly dizzyResist: number
  readonly throw: { readonly range: number; readonly damage: number; readonly hold?: number; readonly anim?: string; readonly name?: string }
  readonly normals: Readonly<Record<string, MoveJson>>
  readonly specials: readonly SpecialJson[]
}

// --- what the sim gets -----------------------------------------------------------------------

export interface Character {
  readonly id: string
  readonly name: string
  readonly art: string
  readonly body: string
  readonly trim: string
  readonly health: number
  readonly walkFwd: number
  readonly walkBack: number
  readonly jumpVy: number
  readonly jumpVx: number
  readonly gravity: number
  readonly prejump: number
  readonly bodyHalf: number
  readonly hurt: Readonly<Record<Stance, Box>>
  readonly dizzyResist: number
  /** Every move by id: normals under their stance-button name, specials as `<id>-<lp|mp|hp>`. */
  readonly moves: Readonly<Record<string, Move>>
  /** The forward-or-back + medium/heavy grab. */
  readonly throw: Move
  /** Specials in the order they are checked — the order in the file, dragon punch first. */
  readonly specials: readonly Move[]
}

export const SYSTEM: SystemConfig = systemJson as unknown as SystemConfig

const STRENGTH_OF: Record<string, Strength> = { lp: 'light', mp: 'medium', hp: 'heavy', lk: 'light', mk: 'medium', hk: 'heavy' }

/** `stand-mp` → medium. Specials name their strength by the button that threw them. */
export function strengthOf(id: string): Strength {
  const tail = id.slice(id.lastIndexOf('-') + 1)
  return STRENGTH_OF[tail] ?? 'medium'
}

export const BUTTON_OF: Record<'lp' | 'mp' | 'hp' | 'lk' | 'mk' | 'hk', ButtonMask> = {
  lp: Button.LP, mp: Button.MP, hp: Button.HP, lk: Button.LK, mk: Button.MK, hk: Button.HK,
}

const stanceOf = (id: string): Stance => (id.startsWith('crouch') ? 'crouch' : id.startsWith('air') ? 'air' : 'stand')

function buildMove(id: string, j: MoveJson, kind: MoveKind, stance: Stance, strength: Strength, special: boolean): Move {
  const s = SYSTEM
  const hb = j.hitbox ? fromTuple(j.hitbox) : box(0, 0, 0, 0)
  const push = strength === 'heavy' ? [s.pushback.heavyHit, s.pushback.heavyBlock] : strength === 'medium' ? [s.pushback.mediumHit, s.pushback.mediumBlock] : [s.pushback.hit, s.pushback.block]
  return {
    id,
    name: j.name ?? id,
    kind,
    stance,
    strength,
    startup: j.startup,
    active: j.active,
    recovery: j.recovery,
    damage: j.damage,
    hitstun: j.hitstun ?? s.hitstun[strength],
    blockstun: j.blockstun ?? s.blockstun[strength],
    hitstop: j.hitstop ?? s.hitstop[strength],
    stun: j.stun ?? (special ? s.stun.special : s.stun[strength]),
    height: j.height ?? 'mid',
    hitbox: hb,
    pushHit: j.pushHit ?? push[0],
    pushBlock: j.pushBlock ?? push[1],
    knockdown: j.knockdown ?? false,
    cancel: j.cancel ?? false,
    chain: j.chain ?? false,
    meter: j.meter ?? (special ? s.meter.hit * 2 : s.meter.hit),
    invuln: j.invuln,
    projectileInvuln: j.projectileInvuln ?? false,
    chip: j.chip ?? (special ? Math.round(j.damage * s.chipFraction) : 0),
    projectile: j.projectile ? { ...j.projectile, at: fromTuple(j.projectile.at) } : undefined,
    rise: j.rise,
    travel: j.travel,
    bounce: j.bounce,
    hits: j.hits ?? 1,
    rehit: j.rehit ?? 0,
    untilLand: j.untilLand ?? false,
    range: j.range ?? 0,
    hold: j.hold ?? s.throw.hold,
    anim: j.anim ?? id,
  }
}

/** Nested override: `strengths.hp.rise.vy` replaces only that number. One level is all we need. */
function merge(base: MoveJson, over: Partial<MoveJson> | undefined): MoveJson {
  if (!over) return base
  const out: Record<string, unknown> = { ...base, ...over }
  for (const k of ['projectile', 'rise', 'travel', 'bounce'] as const) {
    const b = base[k]
    const o = over[k]
    if (b && o) out[k] = { ...b, ...o }
  }
  return out as unknown as MoveJson
}

export function buildCharacter(j: CharacterJson): Character {
  const moves: Record<string, Move> = {}
  for (const [id, m] of Object.entries(j.normals)) {
    moves[id] = buildMove(id, m, 'strike', stanceOf(id), strengthOf(id), false)
  }

  const specials: Move[] = []
  for (const sp of j.specials) {
    const keys = sp.button === 'P' ? (['lp', 'mp', 'hp'] as const) : (['lk', 'mk', 'hk'] as const)
    for (const k of keys) {
      const id = `${sp.id}-${k}`
      const kind: MoveKind = sp.type
      const merged = merge(sp, sp.strengths?.[k])
      const m: Move = {
        ...buildMove(id, merged, kind, 'stand', STRENGTH_OF[k], true),
        name: sp.name ?? sp.id,
        anim: sp.anim ?? sp.id,
        motion: sp.motion,
        button: sp.button,
      }
      moves[id] = m
      specials.push(m)
    }
  }

  const t = j.throw
  const thr: Move = {
    ...buildMove('throw', { startup: 1, active: 2, recovery: 8, damage: t.damage, name: t.name ?? 'Throw', anim: t.anim ?? 'throw' }, 'throw', 'stand', 'heavy', false),
    range: t.range,
    hold: t.hold ?? SYSTEM.throw.hold,
    knockdown: SYSTEM.throw.knockdown,
    meter: SYSTEM.throw.meter,
    stun: SYSTEM.stun.heavy,
  }
  moves.throw = thr

  return {
    id: j.id,
    name: j.name,
    art: j.art,
    body: j.colors.body,
    trim: j.colors.trim,
    health: j.health,
    walkFwd: j.walkFwd,
    walkBack: j.walkBack,
    jumpVy: j.jump.vy,
    jumpVx: j.jump.vx,
    gravity: j.jump.gravity,
    prejump: j.jump.prejump ?? SYSTEM.prejumpFrames,
    bodyHalf: j.bodyHalf,
    hurt: { stand: fromTuple(j.hurt.stand), crouch: fromTuple(j.hurt.crouch), air: fromTuple(j.hurt.air) },
    dizzyResist: j.dizzyResist,
    moves,
    throw: thr,
    specials,
  }
}

/**
 * The roster as it stands, in select-screen order: the four measured out of the arcade board that
 * the proof of concept was built around, then the three of our own that CONCRETE CROWN ships.
 *
 * The second three are the first three's measured numbers under our own names — written by
 * `scripts/fighter-crown-chars.mjs`, which explains why. They are here to be played and drawn
 * against while the art is generated; when a crown character has an atlas and numbers of her own,
 * the archetype she was copied from comes off this list.
 */
export const CHARACTERS: readonly Character[] = [ryu, zangief, blanka, chunli, kestrel, bollard, candela]
  .map((j) => buildCharacter(j as unknown as CharacterJson))

export const findCharacter = (id: string): Character => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0]
