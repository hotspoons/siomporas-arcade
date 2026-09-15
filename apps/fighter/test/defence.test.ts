import { afterEach, describe, expect, it } from 'vitest'
import { Match } from '../src/sim/Match'
import { Button } from '../src/sim/Motion'
import { RULES, SYSTEM, setDefence, setJump } from '../src/sim/Character'
import { Cpu } from '../src/sim/Cpu'

// Every test leaves the rules as it found them: this is global state on purpose — the whole point
// is switching schools mid-session — and a test that forgets would poison every test after it.
afterEach(() => setDefence(SYSTEM.defence.mode))

/**
 * Tick a fresh match past its round intro. Nobody can move for `introFrames`, so a test that starts
 * swinging immediately measures eighty frames of two men standing to attention.
 */
function started(p1 = 'ryu', p2 = 'ryu'): Match {
  const m = new Match(p1, p2)
  while (m.phase !== 'fight') {
    for (const f of m.fighters) f.history.push(0, 0, 0)
    m.tick()
  }
  return m
}

/**
 * Walk the two fighters together and have player one throw a heavy punch, with player two holding
 * `hold` and `buttons` throughout. Returns how much health player two lost.
 */
function exchange(hold: { x: number; y: number }, buttons = 0): number {
  const m = started()
  const [a, b] = m.fighters
  // Close enough that a standing heavy will reach.
  a.x = -30
  b.x = 30
  const before = b.health
  for (let f = 0; f < 90; f++) {
    a.history.push(0, 0, f === 10 ? Button.HP : 0)
    b.history.push(hold.x, hold.y, buttons)
    m.tick()
  }
  return before - b.health
}

describe('the three schools of defence', () => {
  it('Street Fighter: holding away blocks, standing still does not', () => {
    setDefence('hold-away')
    expect(exchange({ x: 0, y: 0 })).toBeGreaterThan(0)
    expect(exchange({ x: 1, y: 0 })).toBe(0)
  })

  it('Tekken: standing still blocks by itself', () => {
    setDefence('auto-standing')
    expect(exchange({ x: 0, y: 0 })).toBe(0)
  })

  it('Virtua Fighter: the button blocks, and nothing else does', () => {
    setDefence('guard-button')
    expect(exchange({ x: 0, y: 0 })).toBeGreaterThan(0)
    expect(exchange({ x: 1, y: 0 })).toBeGreaterThan(0)
    expect(exchange({ x: 0, y: 0 }, Button.G)).toBe(0)
  })

  it('Virtua Fighter roots you: holding guard stops you walking at all', () => {
    setDefence('guard-button')
    const m = started()
    const [a] = m.fighters
    const x0 = a.x
    for (let f = 0; f < 60; f++) {
      a.history.push(-1, 0, Button.G)
      m.fighters[1].history.push(0, 0, 0)
      m.tick()
    }
    expect(a.x).toBe(x0)
  })

  it('and without the guard button held, the same input walks', () => {
    setDefence('guard-button')
    const m = started()
    const [a] = m.fighters
    const x0 = a.x
    for (let f = 0; f < 60; f++) {
      a.history.push(-1, 0, 0)
      m.fighters[1].history.push(0, 0, 0)
      m.tick()
    }
    expect(a.x).not.toBe(x0)
  })

  it('leaves the configured school in force by default', () => {
    expect(RULES.defence).toBe(SYSTEM.defence.mode)
    expect(SYSTEM.defence.mode).toBe('hold-away')
  })
})

describe('the machine plays by the same rules', () => {
  it('guards with the button when that is what guarding means', () => {
    setDefence('guard-button')
    const cpu = new Cpu('guard')
    const m = started()
    const [a, b] = m.fighters
    const f = cpu.decide(b, a)
    expect(f.buttons & Button.G).toBeTruthy()
  })

  it('and holds away when that is what guarding means', () => {
    setDefence('hold-away')
    const cpu = new Cpu('guard')
    const m = started()
    const [a, b] = m.fighters
    const f = cpu.decide(b, a)
    expect(f.buttons & Button.G).toBeFalsy()
    expect(f.x).toBeLessThan(0)
  })
})

describe('the two schools of jumping', () => {
  afterEach(() => setJump(SYSTEM.jump.mode))

  /** How high the fighter gets, holding up for `holdFrames` of the prejump. */
  function apex(holdFrames: number): number {
    const m = started()
    const [a, b] = m.fighters
    let high = 0
    for (let f = 0; f < 120; f++) {
      a.history.push(0, f < holdFrames ? 1 : 0, 0)
      b.history.push(0, 0, 0)
      m.tick()
      if (a.y > high) high = a.y
    }
    return high
  }

  it('Street Fighter gives one arc however briefly you press up', () => {
    setJump('fixed')
    expect(apex(1)).toBeCloseTo(apex(40), 5)
  })

  it('Virtua Fighter gives a hop for a tap and a full jump for a hold', () => {
    setJump('by-hold')
    const hop = apex(1)
    const full = apex(40)
    expect(hop).toBeGreaterThan(0)
    expect(hop).toBeLessThan(full)
    // Under one gravity the height goes as the square of the launch, so a 0.44 launch is about a
    // fifth of the height — which is what makes a hop a different move rather than a smaller jump.
    expect(hop / full).toBeCloseTo(SYSTEM.jump.hopFactor ** 2, 1)
  })

  it('and the full jump is exactly the fixed one', () => {
    setJump('fixed')
    const fixed = apex(40)
    setJump('by-hold')
    expect(apex(40)).toBeCloseTo(fixed, 5)
  })
})
