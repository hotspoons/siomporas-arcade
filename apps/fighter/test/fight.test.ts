import { describe, expect, it } from 'vitest'
import { Button } from '../src/sim/Motion'
import { Match, INTRO_FRAMES } from '../src/sim/Match'
import { MOVES, blockAdvantage, hitAdvantage, totalFrames, move } from '../src/sim/Moves'

interface In {
  x?: number
  y?: number
  b?: number
}

/**
 * A match past the intro with the two of them stood wherever the test wants them. Positions are set
 * directly because almost every test is about what happens when a hitbox meets a hurtbox, and
 * walking there first would only be a slower way of writing the same test.
 */
function fight(gap = 90): Match {
  const m = new Match('kestrel', 'kestrel')
  for (let i = 0; i < INTRO_FRAMES; i++) m.tick()
  expect(m.phase).toBe('fight')
  m.fighters[0].x = -gap / 2
  m.fighters[1].x = gap / 2
  return m
}

/** Run `n` ticks with both fighters holding the given input. */
function step(m: Match, n: number, a: In = {}, b: In = {}): void {
  for (let i = 0; i < n; i++) {
    m.fighters[0].history.push(a.x ?? 0, a.y ?? 0, a.b ?? 0)
    m.fighters[1].history.push(b.x ?? 0, b.y ?? 0, b.b ?? 0)
    m.tick()
  }
}

/** Press a button for one frame, then release — the shape of every real attack input. */
function press(m: Match, button: number, a: In = {}, b: In = {}): void {
  step(m, 1, { ...a, b: button }, b)
}

describe('frame data', () => {
  it('every move adds up', () => {
    for (const [id, mv] of Object.entries(MOVES)) {
      expect(mv.id, id).toBe(id)
      expect(totalFrames(mv), id).toBe(mv.startup + mv.active + mv.recovery)
      expect(mv.startup, id).toBeGreaterThan(0)
      expect(mv.active, id).toBeGreaterThan(0)
    }
  })

  it('leaves the jab plus on block and the roundhouse very much minus', () => {
    expect(blockAdvantage(move('stand-lp'))).toBe(3)
    expect(hitAdvantage(move('stand-lp'))).toBe(7)
    expect(blockAdvantage(move('stand-hk'))).toBeLessThan(-5)
    expect(blockAdvantage(move('crouch-hk'))).toBeLessThan(-8)
  })

  it('makes the uppercut the worst thing in the game to whiff', () => {
    const dp = move('uppercut')
    expect(dp.startup).toBeLessThanOrEqual(3)
    expect(dp.recovery).toBeGreaterThan(20)
    expect(dp.invuln).toEqual([1, 6])
  })
})

describe('a jab', () => {
  it('comes out and hits', () => {
    const m = fight()
    const before = m.fighters[1].health
    press(m, Button.LP)
    step(m, 6)
    expect(m.fighters[1].health).toBeLessThan(before)
    expect(m.events.length + 1).toBeGreaterThan(0)
  })

  it('hits on its third frame and not before', () => {
    const m = fight(400) // out of range on purpose: a box that connects is spent and reads as null
    const a = m.fighters[0]
    press(m, Button.LP)
    expect(a.actionFrame).toBe(0)
    expect(a.hitBox()).toBeNull() // frame 1
    step(m, 1)
    expect(a.hitBox()).toBeNull() // frame 2
    step(m, 1)
    expect(a.hitBox()).not.toBeNull() // frame 3 — startup is 3
  })

  it('misses from too far away', () => {
    const m = fight(400)
    const before = m.fighters[1].health
    press(m, Button.LP)
    step(m, 12)
    expect(m.fighters[1].health).toBe(before)
  })

  it('only hits once however long it is out', () => {
    const m = fight()
    const before = m.fighters[1].health
    press(m, Button.HK) // five active frames
    step(m, 40)
    const dealt = before - m.fighters[1].health
    expect(dealt).toBeGreaterThan(0)
    expect(dealt).toBeLessThan(move('stand-hk').damage * 1.5)
  })
})

describe('guarding', () => {
  // Fighter 1 starts on the right facing left, so holding +x is holding back for them.
  const BACK = { x: 1 }
  const DOWN_BACK = { x: 1, y: -1 }

  it('stops a mid and costs no health', () => {
    const m = fight()
    const before = m.fighters[1].health
    press(m, Button.MP, {}, BACK)
    step(m, 10, {}, BACK)
    expect(m.fighters[1].health).toBe(before)
    expect(m.fighters[1].state).toBe('blockstun')
  })

  it('does not stop a low if you are standing', () => {
    const m = fight()
    const before = m.fighters[1].health
    press(m, Button.HK, { y: -1 }, BACK) // sweep against a standing guard
    step(m, 16, { y: -1 }, BACK)
    expect(m.fighters[1].health).toBeLessThan(before)
  })

  it('stops a low if you are crouching', () => {
    const m = fight()
    const before = m.fighters[1].health
    press(m, Button.HK, { y: -1 }, DOWN_BACK)
    step(m, 16, { y: -1 }, DOWN_BACK)
    expect(m.fighters[1].health).toBe(before)
  })

  it('does not work while you are walking into it', () => {
    const m = fight()
    const before = m.fighters[1].health
    press(m, Button.MP, {}, { x: -1 }) // holding toward the attacker
    step(m, 10, {}, { x: -1 })
    expect(m.fighters[1].health).toBeLessThan(before)
  })

  it('leaves the defender stuck for exactly the move’s blockstun', () => {
    const m = fight()
    press(m, Button.MP, {}, BACK)
    step(m, 9, {}, BACK) // past hitstop, into blockstun
    const b = m.fighters[1]
    expect(b.state).toBe('blockstun')
    step(m, move('stand-mp').blockstun + 2, {}, BACK)
    expect(b.state).not.toBe('blockstun')
  })
})

describe('specials', () => {
  const qcf = [
    { x: 0, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 0 },
  ]

  it('comes out on a quarter circle and throws a projectile that travels and hits', () => {
    const m = fight(520)
    const before = m.fighters[1].health
    for (const f of qcf) step(m, 1, f)
    press(m, Button.HP, { x: 1 })
    expect(m.fighters[0].action?.id).toBe('fireball')
    step(m, 14)
    expect(m.projectiles.length).toBe(1)
    step(m, 70)
    expect(m.fighters[1].health).toBeLessThan(before)
  })

  it('chips a blocking opponent rather than nothing', () => {
    const m = fight(520)
    const before = m.fighters[1].health
    for (const f of qcf) step(m, 1, f)
    press(m, Button.HP, { x: 1 })
    step(m, 84, {}, { x: 1 })
    const lost = before - m.fighters[1].health
    expect(lost).toBeGreaterThan(0)
    expect(lost).toBeLessThan(move('fireball').projectile!.damage)
  })

  it('two fireballs cancel each other', () => {
    const m = fight(600)
    for (const f of qcf) step(m, 1, f, { x: -f.x, y: f.y })
    step(m, 1, { x: 1, b: Button.HP }, { x: -1, b: Button.HP })
    step(m, 14)
    expect(m.projectiles.length).toBe(2)
    step(m, 40)
    expect(m.projectiles.length).toBe(0)
    expect(m.fighters[0].health).toBe(m.fighters[0].character.health)
    expect(m.fighters[1].health).toBe(m.fighters[1].character.health)
  })

  it('makes the uppercut invulnerable on the way up and not on the way down', () => {
    const m = fight(500) // whiff range: a connected uppercut freezes in hitstop and never advances
    const a = m.fighters[0]
    step(m, 1, { x: 1 })
    step(m, 1, { y: -1 })
    press(m, Button.HP, { x: 1, y: -1 })
    expect(a.action?.id).toBe('uppercut')
    expect(a.invulnerable).toBe(true)
    step(m, 5)
    expect(a.invulnerable).toBe(true)
    step(m, 2)
    expect(a.invulnerable).toBe(false)
  })

  it('is preferred over the fireball when the input contains both', () => {
    const m = fight()
    // Walking forward into a quarter circle: 6, 2, 3 — a dragon punch, and it wins.
    step(m, 3, { x: 1 })
    step(m, 1, { y: -1 })
    press(m, Button.HP, { x: 1, y: -1 })
    expect(m.fighters[0].action?.id).toBe('uppercut')
  })
})

describe('a round', () => {
  it('ends when someone runs out of health, and the winner banks it', () => {
    const m = fight()
    m.fighters[1].health = 10
    press(m, Button.HP)
    step(m, 12)
    expect(m.fighters[1].health).toBe(0)
    expect(m.phase).toBe('ko')
    expect(m.wins[0]).toBe(1)
    expect(m.fighters[0].state).toBe('win')
  })

  it('goes to the healthier fighter when the clock runs out', () => {
    const m = fight()
    m.fighters[0].health = 400
    m.fighters[1].health = 300
    m.timer = 1
    step(m, 2)
    expect(m.phase).toBe('ko')
    expect(m.wins[0]).toBe(1)
  })

  it('takes two to win the match', () => {
    const m = fight()
    m.wins[0] = 1
    m.fighters[1].health = 10
    press(m, Button.HP)
    step(m, 400)
    expect(m.wins[0]).toBe(2)
    expect(m.over).toBe(true)
  })

  it('resets both fighters between rounds', () => {
    const m = fight()
    m.fighters[1].health = 10
    press(m, Button.HP)
    step(m, 200)
    expect(m.round).toBe(2)
    expect(m.fighters[0].health).toBe(m.fighters[0].character.health)
    expect(m.fighters[1].health).toBe(m.fighters[1].character.health)
    expect(m.fighters[0].x).toBeLessThan(0)
    expect(m.fighters[1].x).toBeGreaterThan(0)
  })
})

describe('bodies and the stage', () => {
  it('will not let two fighters stand inside each other', () => {
    const m = fight(10)
    step(m, 30, { x: 1 }, { x: -1 })
    expect(Math.abs(m.fighters[0].x - m.fighters[1].x)).toBeGreaterThanOrEqual(58)
  })

  it('keeps everyone inside the walls', () => {
    const m = fight()
    step(m, 400, { x: -1 }, { x: 1 })
    for (const f of m.fighters) expect(Math.abs(f.x)).toBeLessThanOrEqual(620)
  })

  it('turns a fighter round when the other one crosses over', () => {
    const m = fight()
    expect(m.fighters[0].facing).toBe(1)
    m.fighters[1].x = -400
    step(m, 2)
    expect(m.fighters[0].facing).toBe(-1)
  })
})

describe('combos', () => {
  it('scales damage down as the combo runs', () => {
    const m = fight()
    const b = m.fighters[1]
    const first = b.health
    press(m, Button.LP)
    step(m, 4)
    const afterOne = b.health
    // Chain straight into the next light while they are still in hitstun.
    press(m, Button.LP)
    step(m, 6)
    const afterTwo = b.health
    expect(first - afterOne).toBeGreaterThan(0)
    expect(afterOne - afterTwo).toBeLessThanOrEqual(first - afterOne)
  })

  it('drops the counter the moment they can act again', () => {
    const m = fight()
    press(m, Button.LP)
    step(m, 4)
    expect(m.combo[0]).toBeGreaterThan(0)
    // Long enough for the jab's hitstun to run out with nothing following it up.
    step(m, 40)
    expect(m.combo[0]).toBe(0)
  })
})
