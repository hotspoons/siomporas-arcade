// An opponent, so the game is playable by one person.
//
// It is not good and is not trying to be. What it does is exercise every mechanic — it walks,
// blocks, sweeps, throws fireballs and anti-airs — so that playing against it tells you whether the
// mechanics feel right, which is the only question the placeholder build is meant to answer.
//
// It plays through the same input history as a human, by pushing a *script* of input frames rather
// than a decision per tick. That is the only way to express a motion input: a fireball is not a
// choice, it is 2, 3, 6 and then a button, over four frames, and the parser must see all of it. It
// also means the CPU cannot do anything a player could not, which is the property worth having.

import { Button, type ButtonMask } from './Motion'
import type { Fighter } from './Fighter'

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

/** Numpad-ish helpers, written from the CPU's point of view: +1 is toward the opponent. */
function script(...frames: Frame[]): Frame[] {
  return frames
}

// Sixteen frames of backing off before the motion, and they are not padding. A dragon punch is
// checked before a quarter circle, and `6...236` contains one — so a CPU that walks forward and
// then throws a fireball uppercuts instead, for exactly the reason a player does. Holding back
// first clears the forward out of the dragon punch's window. It also happens to look like zoning.
const FIREBALL = (): Frame[] =>
  script(...Array.from({ length: 16 }, () => hold(-1)), hold(0, -1), hold(0, -1), hold(1, -1), hold(1, -1), hold(1, 0, Button.HP))
const UPPERCUT = (): Frame[] => script(hold(1, 0), hold(0, -1), hold(1, -1), hold(1, -1, Button.HP), hold(1, 0))

export class Cpu {
  difficulty: Difficulty
  private readonly rng: Rng
  private queue: Frame[] = []
  private cooldown = 0

  constructor(difficulty: Difficulty = 'easy', seed = 12345) {
    this.difficulty = difficulty
    this.rng = new Rng(seed)
  }

  /** The input frame to push into this fighter's history this tick. */
  decide(me: Fighter, them: Fighter): Frame {
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

    // They are above us and coming down. Anti-air, or get out of the way.
    if (them.y > 40 && gap < 220) {
      if (this.rng.chance(hard ? 0.7 : 0.35)) {
        this.queue = UPPERCUT().map((f) => ({ ...f, x: f.x * toward }))
        this.cooldown = 24
        return this.queue.shift() as Frame
      }
      return hold(-toward, -1)
    }

    // They are swinging at us and we are inside their range. Guard.
    if (this.threatened(them) && gap < 170) {
      this.cooldown = hard ? 2 : 8
      return hold(-toward, this.rng.chance(0.5) ? -1 : 0)
    }

    if (gap > 420) {
      if (this.rng.chance(hard ? 0.05 : 0.02)) {
        this.queue = FIREBALL().map((f) => ({ ...f, x: f.x * toward }))
        this.cooldown = hard ? 30 : 70
        return this.queue.shift() as Frame
      }
      return hold(toward)
    }

    if (gap > 165) return this.rng.chance(0.08) ? hold(toward, -1) : hold(toward)

    // In range. Hit them with something.
    if (this.rng.chance(hard ? 0.3 : 0.14)) {
      const button = this.rng.pick([Button.LP, Button.LK, Button.MP, Button.MK, Button.HK, Button.HK])
      const low = button === Button.HK ? this.rng.chance(0.5) : this.rng.chance(0.3)
      this.cooldown = hard ? 10 : 26
      return hold(0, low ? -1 : 0, button)
    }
    if (this.rng.chance(0.04)) {
      this.cooldown = 40
      return hold(toward, 1) // jump in
    }
    return this.rng.chance(0.3) ? hold(-toward) : hold(toward)
  }

  /** Is the opponent mid-attack and therefore worth respecting? */
  private threatened(them: Fighter): boolean {
    return them.state === 'attack' || (them.state === 'air' && them.y > 20)
  }

  reset(): void {
    this.queue = []
    this.cooldown = 0
  }
}
