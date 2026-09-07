// Seeded xorshift128 — the ONLY source of randomness allowed under src/sim.
// Every run is reproducible from (courseId, seed), which is what makes ghost
// replays and "given this input tape the craft ends at s = X" tests possible.

export class Rng {
  private a = 0
  private b = 0
  private c = 0
  private d = 0

  constructor(seed: number) {
    this.reseed(seed)
  }

  reseed(seed: number): void {
    // splitmix-style expansion of a 32-bit seed into four non-zero words
    let s = seed >>> 0 || 0x9e3779b9
    const next = () => {
      s = (s + 0x6d2b79f5) >>> 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return (t ^ (t >>> 14)) >>> 0
    }
    this.a = next()
    this.b = next()
    this.c = next()
    this.d = next()
    if ((this.a | this.b | this.c | this.d) === 0) this.a = 1
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296
  }

  nextU32(): number {
    let t = this.d
    const s = this.a
    this.d = this.c
    this.c = this.b
    this.b = s
    t ^= t << 11
    t ^= t >>> 8
    this.a = (t ^ s ^ (s >>> 19)) >>> 0
    return this.a
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next()
  }

  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  /** Pick an index by weight; weights need not sum to 1. */
  weighted(weights: readonly number[]): number {
    let total = 0
    for (let i = 0; i < weights.length; i++) total += weights[i]
    let r = this.next() * total
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]
      if (r < 0) return i
    }
    return weights.length - 1
  }
}

/**
 * Stateless 32-bit hash of two integers, for "what spawns in cell N of seed S"
 * decisions that must not depend on the order the sim asked about them.
 */
export function hash2(a: number, b: number): number {
  let h = (a * 0x9e3779b1) ^ (b + 0x7f4a7c15)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}
