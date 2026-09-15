// An opponent, so the game is playable by one person.
//
// It is not good and is not trying to be. What it does is exercise every mechanic — it walks,
// blocks, sweeps, throws, and uses whatever specials its character has — so that playing against it
// tells you whether the mechanics feel right, which is the only question this build has to answer.
//
// It plays through the same input history as a human, by pushing a *script* of input frames rather
// than a decision per tick. That is the only way to express a motion input: a fireball is not a
// choice, it is 2, 3, 6 and then a button, over four frames, and the parser must see all of it. It
// also means the CPU cannot do anything a player could not, which is the property worth having.
//
// It reads its own character's special list and builds a script for each motion, so Zangief's CPU
// spins a 360 next to you and Blanka's charges back and rolls, without this file knowing either of
// them by name.

import { RULES } from './Character'
import { Button, type ButtonMask } from './Motion'
import type { Fighter } from './Fighter'
import type { Move } from './Moves'

export type Difficulty = 'dummy' | 'guard' | 'easy' | 'hard'

interface Frame {
  x: number
  y: number
  buttons: ButtonMask
}

/** Deterministic, so a replay of a match is a replay of the match. */
class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0 || 1
  }
  next(): number {
    this.s ^= this.s << 13
    this.s ^= this.s >>> 17
    this.s ^= this.s << 5
    return ((this.s >>> 0) % 100000) / 100000
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length) % xs.length]
  }
}

const hold = (x: number, y = 0, buttons = 0): Frame => ({ x, y, buttons })
const rep = (n: number, f: Frame): Frame[] => Array.from({ length: n }, () => ({ ...f }))

const PUNCH_OF: Record<string, ButtonMask> = { lp: Button.LP, mp: Button.MP, hp: Button.HP, lk: Button.LK, mk: Button.MK, hk: Button.HK }
const buttonOf = (m: Move): ButtonMask => PUNCH_OF[m.id.slice(m.id.lastIndexOf('-') + 1)] ?? Button.HP

/**
 * Input scripts for each motion, written from the CPU's point of view: +x is toward the opponent.
 *
 * The sixteen frames of backing off before a quarter circle are not padding. A dragon punch is
 * checked before a quarter circle, and `6...236` contains one — so a CPU that walks forward and
 * then throws a fireball uppercuts instead, for exactly the reason a player does. Holding back
 * first clears the forward out of the dragon punch's window. It also happens to look like zoning.
 */
function scriptFor(m: Move): Frame[] | null {
  const b = buttonOf(m)
  switch (m.motion) {
    case 'qcf':
      return [...rep(16, hold(-1)), hold(0, -1), hold(0, -1), hold(1, -1), hold(1, -1), hold(1, 0, b)]
    case 'qcb':
      return [hold(0, -1), hold(0, -1), hold(-1, -1), hold(-1, -1), hold(-1, 0, b)]
    case 'dp':
      return [hold(1, 0), hold(0, -1), hold(1, -1), hold(1, -1, b), hold(1, 0)]
    case 'hcf':
      return [hold(-1), hold(-1, -1), hold(0, -1), hold(1, -1), hold(1, 0, b)]
    case '360':
      return [hold(1), hold(1, -1), hold(0, -1), hold(-1, -1), hold(-1), hold(-1, 1), hold(0, 1), hold(1, 1, b), hold(1, 0)]
    case 'charge-back':
      return [...rep(48, hold(-1)), hold(1, 0, b), hold(1, 0, b)]
    case 'charge-down':
      return [...rep(48, hold(0, -1)), hold(0, 1, b), hold(0, 1, b)]
    case 'ppp':
      return [hold(0, 0, Button.LP | Button.MP | Button.HP)]
    case 'kkk':
      return [hold(0, 0, Button.LK | Button.MK | Button.HK)]
    case 'mash-p':
      return [hold(0, 0, b), hold(0), hold(0, 0, b), hold(0), hold(0, 0, b), hold(0), hold(0, 0, b), hold(0), hold(0, 0, b)]
    default:
      return null
  }
}

export class Cpu {
  difficulty: Difficulty
  private readonly rng: Rng
  private queue: Frame[] = []
  private cooldown = 0

  constructor(difficulty: Difficulty = 'easy', seed = 12345) {
    this.difficulty = difficulty
    this.rng = new Rng(seed)
  }

  /**
   * The input frame to push into this fighter's history this tick.
   *
   * The thinking is written in Street Fighter's dialect — "hold away" means "block" — because that
   * is the school the character data was measured in. Under another school the same intention needs
   * a different input, and translating it here rather than in the thinking keeps the CPU honest:
   * it still only ever presses things a player could press.
   */
  decide(me: Fighter, them: Fighter): Frame {
    const f = this.think(me, them)
    if (RULES.defence === 'guard-button' && f.x < 0) {
      // It wanted to block. On this board that is a button, and holding it roots you — which is
      // exactly the trade the board makes, so the CPU should pay it too.
      return { ...f, buttons: f.buttons | Button.G }
    }
    return f
  }

  private think(me: Fighter, them: Fighter): Frame {
    if (this.difficulty === 'dummy') return hold(0)
    if (this.difficulty === 'guard') return hold(-1)

    if (this.queue.length > 0) return this.queue.shift() as Frame
    if (this.cooldown > 0) {
      this.cooldown--
      return this.threatened(them) ? hold(-1, this.rng.chance(0.5) ? -1 : 0) : hold(0)
    }

    const hard = this.difficulty === 'hard'
    const gap = Math.abs(them.x - me.x)
    const toward = them.x > me.x ? 1 : -1
    const specials = me.character.specials
    const byMotion = (...ms: string[]): Move | undefined => specials.find((s) => ms.includes(s.motion ?? '') && s.id.endsWith('-hp') || ms.includes(s.motion ?? '') && s.id.endsWith('-hk'))
    const run = (m: Move | undefined, cooldown: number): Frame | null => {
      const s = m && scriptFor(m)
      if (!s) return null
      this.queue = s.map((f) => ({ ...f, x: f.x * toward }))
      this.cooldown = cooldown
      return this.queue.shift() as Frame
    }

    // They are above us and coming down. Anti-air, or get out of the way.
    if (them.y > 20 && gap < 110) {
      if (this.rng.chance(hard ? 0.7 : 0.35)) {
        const r = run(byMotion('dp', 'ppp', 'charge-down'), 24)
        if (r) return r
        return hold(0, 0, Button.HP) // a standing fierce is everyone's anti-air of last resort
      }
      return hold(-toward, -1)
    }

    // They are swinging at us and we are inside their range. Guard.
    if (this.threatened(them) && gap < 90) {
      this.cooldown = hard ? 2 : 8
      return hold(-toward, this.rng.chance(0.5) ? -1 : 0)
    }

    // A grappler next to a standing body has one idea.
    if (gap < 56 && them.grounded && this.rng.chance(hard ? 0.25 : 0.1)) {
      const r = run(byMotion('360'), 30)
      if (r) return r
      if (gap <= me.character.throw.range && this.rng.chance(0.5)) {
        this.cooldown = 20
        return hold(toward, 0, Button.HP)
      }
    }

    if (gap > 200) {
      if (this.rng.chance(hard ? 0.06 : 0.025)) {
        const r = run(byMotion('qcf', 'charge-back'), hard ? 30 : 70)
        if (r) return r
      }
      return hold(toward)
    }

    if (gap > 90) return this.rng.chance(0.08) ? hold(toward, -1) : hold(toward)

    // In range. Hit them with something.
    if (this.rng.chance(hard ? 0.3 : 0.14)) {
      const button = this.rng.pick([Button.LP, Button.LK, Button.MP, Button.MK, Button.HK, Button.HK, Button.HP])
      const low = button === Button.HK ? this.rng.chance(0.5) : this.rng.chance(0.3)
      this.cooldown = hard ? 10 : 26
      return hold(0, low ? -1 : 0, button)
    }
    if (this.rng.chance(0.03)) {
      const r = run(byMotion('mash-p', 'qcb', 'kkk'), 40)
      if (r) return r
    }
    if (this.rng.chance(0.04)) {
      this.cooldown = 40
      return hold(toward, 1) // jump in
    }
    return this.rng.chance(0.3) ? hold(-toward) : hold(toward)
  }

  /** Is the opponent mid-attack and therefore worth respecting? */
  private threatened(them: Fighter): boolean {
    return them.state === 'attack' || (them.state === 'air' && them.y > 10)
  }

  reset(): void {
    this.queue = []
    this.cooldown = 0
  }
}
