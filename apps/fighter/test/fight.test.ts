import { describe, expect, it } from 'vitest'
import { Button } from '../src/sim/Motion'
import { Match, INTRO_FRAMES } from '../src/sim/Match'
import { CHARACTERS, SYSTEM, findCharacter } from '../src/sim/Character'
import { blockAdvantage, hitAdvantage, totalFrames } from '../src/sim/Moves'

interface In {
  x?: number
  y?: number
  b?: number
}

const RYU = findCharacter('ryu')
const move = (id: string) => {
  const m = RYU.moves[id]
  if (!m) throw new Error(`no move ${id}`)
  return m
}

/**
 * A match past the intro with the two of them stood wherever the test wants them. Positions are set
 * directly because almost every test is about what happens when a hitbox meets a hurtbox, and
 * walking there first would only be a slower way of writing the same test.
 */
function fight(gap = 60, a = 'ryu', b = 'ryu'): Match {
  const m = new Match(a, b)
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

describe('the roster', () => {
  it('builds every character from their file, each with a full set of normals and specials', () => {
    // Not an exact list: two people adding a fighter each had to fix that line for the other's
    // addition inside an hour, and the churn was not buying any safety the checks below do not.
    const ids = CHARACTERS.map((c) => c.id)
    expect(ids.length).toBeGreaterThanOrEqual(4)
    expect(new Set(ids).size, 'no two fighters share an id').toBe(ids.length)
    for (const measured of ['ryu', 'zangief', 'blanka', 'chunli']) expect(ids).toContain(measured)
    for (const c of CHARACTERS) {
      for (const id of ['stand-lp', 'stand-hk', 'crouch-hk', 'air-hk']) expect(c.moves[id], `${c.id} ${id}`).toBeDefined()
      expect(c.specials.length, c.id).toBeGreaterThanOrEqual(6)
      expect(c.throw.range).toBeGreaterThan(0)
      expect(c.health).toBe(SYSTEM.health)
    }
  })

  it('every move adds up', () => {
    for (const c of CHARACTERS) {
      for (const [id, mv] of Object.entries(c.moves)) {
        expect(mv.id, id).toBe(id)
        expect(totalFrames(mv), id).toBe(mv.startup + mv.active + mv.recovery)
        expect(mv.startup, id).toBeGreaterThan(0)
        expect(mv.active, id).toBeGreaterThan(0)
        expect(mv.damage, id).toBeLessThanOrEqual(SYSTEM.health / 2)
      }
    }
  })

  it('gives each strength of a special its own numbers', () => {
    const lp = move('shoryuken-lp')
    const hp = move('shoryuken-hp')
    expect(hp.active).toBeGreaterThan(lp.active) // the fierce one stays up longer
    expect(hp.rise!.vy).toBeGreaterThan(lp.rise!.vy)
    expect(hp.startup).toBe(lp.startup) // untouched fields come from the base
    expect(move('hadouken-hp').projectile!.speed).toBeGreaterThan(move('hadouken-lp').projectile!.speed)
  })

  it('leaves the jab plus on block and the roundhouse very much minus', () => {
    expect(blockAdvantage(move('stand-lp'))).toBeGreaterThan(0)
    // On the machine block stun ran one frame longer than hit stun, so the two are within a frame.
    expect(Math.abs(hitAdvantage(move('stand-lp')) - blockAdvantage(move('stand-lp')))).toBeLessThanOrEqual(1)
    expect(blockAdvantage(move('stand-hk'))).toBeLessThan(0)
    expect(blockAdvantage(move('crouch-hk'))).toBeLessThan(-4)
  })

  it('makes the uppercut the worst thing in the game to whiff', () => {
    const dp = move('shoryuken-hp')
    expect(dp.startup).toBeLessThanOrEqual(4)
    expect(dp.recovery).toBeGreaterThan(20)
    expect(dp.invuln![0]).toBe(1)
  })

  it('has the piledriver as the single most damaging move', () => {
    const spd = findCharacter('zangief').moves['spd-hp']
    for (const c of CHARACTERS) for (const m of Object.values(c.moves)) expect(m.damage).toBeLessThanOrEqual(spd.damage)
    expect(spd.damage / SYSTEM.health).toBeGreaterThan(0.3)
  })
})

describe('a jab', () => {
  it('comes out and hits', () => {
    const m = fight()
    const before = m.fighters[1].health
    press(m, Button.LP)
    step(m, 6)
    expect(m.fighters[1].health).toBe(before - move('stand-lp').damage)
  })

  it('hits on its third frame and not before', () => {
    const m = fight(200) // out of range on purpose: a box that connects is spent and reads as null
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
    const m = fight(200)
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
    expect(before - m.fighters[1].health).toBe(move('stand-hk').damage)
  })

  it('becomes the close version when they are stood on top of you', () => {
    const m = fight(40)
    press(m, Button.HP)
    expect(m.fighters[0].action?.id).toBe('close-hp')
    const far = fight(70)
    press(far, Button.HP)
    expect(far.fighters[0].action?.id).toBe('stand-hp')
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
    step(m, move('stand-mp').startup + move('stand-mp').hitstop + 1, {}, BACK) // past hitstop, into blockstun
    const b = m.fighters[1]
    expect(b.state).toBe('blockstun')
    step(m, move('stand-mp').blockstun + 2, {}, BACK)
    expect(b.state).not.toBe('blockstun')
  })

  it('takes chip from a special and none from a normal', () => {
    const m = fight()
    const before = m.fighters[1].health
    press(m, Button.HP, {}, BACK)
    step(m, 60, {}, BACK) // the fierce owes 23 frames of recovery after a 14-frame freeze
    expect(m.fighters[1].health).toBe(before)
    m.fighters[1].x = m.fighters[0].x + 60
    step(m, 1, { x: 1 })
    step(m, 1, { y: -1 })
    press(m, Button.HP, { x: 1, y: -1 }, BACK)
    expect(m.fighters[0].action?.id).toBe('shoryuken-hp')
    step(m, 12, {}, BACK)
    expect(m.fighters[1].health).toBe(before - move('shoryuken-hp').chip)
  })
})

describe('specials', () => {
  const qcf = [
    { x: 0, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 0 },
  ]

  it('comes out on a quarter circle and throws a projectile that travels and hits', () => {
    const m = fight(300)
    const before = m.fighters[1].health
    for (const f of qcf) step(m, 1, f)
    press(m, Button.HP, { x: 1 })
    expect(m.fighters[0].action?.id).toBe('hadouken-hp')
    step(m, 12)
    expect(m.projectiles.length).toBe(1)
    step(m, 70)
    expect(m.fighters[1].health).toBe(before - move('hadouken-hp').projectile!.damage)
  })

  it('chips a blocking opponent rather than nothing', () => {
    const m = fight(300)
    const before = m.fighters[1].health
    for (const f of qcf) step(m, 1, f)
    press(m, Button.HP, { x: 1 })
    step(m, 84, {}, { x: 1 })
    const lost = before - m.fighters[1].health
    expect(lost).toBeGreaterThan(0)
    expect(lost).toBeLessThan(move('hadouken-hp').projectile!.damage)
  })

  it('two fireballs cancel each other', () => {
    const m = fight(300)
    for (const f of qcf) step(m, 1, f, { x: -f.x, y: f.y })
    step(m, 1, { x: 1, b: Button.HP }, { x: -1, b: Button.HP })
    step(m, 12)
    expect(m.projectiles.length).toBe(2)
    step(m, 40)
    expect(m.projectiles.length).toBe(0)
    expect(m.fighters[0].health).toBe(m.fighters[0].character.health)
    expect(m.fighters[1].health).toBe(m.fighters[1].character.health)
  })

  it('makes the uppercut invulnerable on the way up and not on the way down', () => {
    const m = fight(250) // whiff range: a connected uppercut freezes in hitstop and never advances
    const a = m.fighters[0]
    step(m, 1, { x: 1 })
    step(m, 1, { y: -1 })
    press(m, Button.HP, { x: 1, y: -1 })
    expect(a.action?.id).toBe('shoryuken-hp')
    expect(a.invulnerable).toBe(true)
    step(m, move('shoryuken-hp').invuln![1] - 2)
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
    expect(m.fighters[0].action?.id).toBe('shoryuken-hp')
  })

  it('goes through a lariat', () => {
    const m = fight(200, 'ryu', 'zangief')
    for (const f of qcf) step(m, 1, f)
    press(m, Button.HP, { x: 1 })
    step(m, 14)
    expect(m.projectiles.length).toBe(1)
    press(m, 0, {}, { b: Button.LP | Button.MP | Button.HP })
    expect(m.fighters[1].action?.id).toBe('lariat-hp')
    const before = m.fighters[1].health
    step(m, 60)
    expect(m.fighters[1].health).toBe(before)
  })

  it('rolls forward off a back charge, and bounces off a guard', () => {
    const m = fight(200, 'blanka', 'ryu')
    step(m, 50, { x: -1, y: -1 }, { x: 1, y: -1 }) // charge crouching, so she does not back off while she does
    press(m, Button.HP, { x: 1 }, { x: 1, y: -1 })
    const a = m.fighters[0]
    expect(a.action?.id).toBe('rolling-attack-hp')
    const x0 = a.x
    const before = m.fighters[1].health
    step(m, 60, {}, { x: 1, y: -1 })
    expect(a.x).toBeGreaterThan(x0 + 60)
    expect(m.fighters[1].health).toBe(before - a.character.moves['rolling-attack-hp'].chip) // guarded, chipped
    expect(a.y).toBeGreaterThan(0) // and she is bouncing away off the guard
  })
})

describe('throws', () => {
  it('grabs a standing opponent on forward and a heavy button, up close', () => {
    const m = fight(30)
    const before = m.fighters[1].health
    press(m, Button.HP, { x: 1 })
    expect(m.fighters[0].action?.id).toBe('throw')
    step(m, 2)
    expect(m.fighters[1].state).toBe('thrown')
    step(m, RYU.throw.hold + 4)
    expect(m.fighters[1].health).toBe(before - RYU.throw.damage)
    expect(m.fighters[1].state).toBe('hitstun') // on its way to the floor
  })

  it('gives you the normal instead when there is nobody to grab', () => {
    const m = fight(120)
    press(m, Button.HP, { x: 1 })
    expect(m.fighters[0].action?.id).toBe('stand-hp')
  })

  it('cannot grab someone who is in the air', () => {
    const m = fight(30)
    step(m, 1, {}, { y: 1 })
    step(m, 6, {}, { y: 1 })
    expect(m.fighters[1].state).toBe('air')
    press(m, Button.HP, { x: 1 })
    expect(m.fighters[0].action?.id).not.toBe('throw')
  })

  it('lets the piledriver come out on a 360 and whiff from range', () => {
    const m = fight(200, 'zangief', 'ryu')
    for (const [x, y] of [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]]) step(m, 1, { x, y })
    press(m, Button.HP, { x: 1, y: 1 })
    expect(m.fighters[0].action?.id).toBe('spd-hp')
    step(m, 3)
    expect(m.events.some((e) => e.kind === 'whiff') || m.fighters[1].state !== 'thrown').toBe(true)
    expect(m.fighters[0].state).toBe('attack') // paying for it
  })

  it('and lands it up close for the biggest number in the game', () => {
    const m = fight(36, 'zangief', 'ryu')
    for (const [x, y] of [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]]) step(m, 1, { x, y })
    const before = m.fighters[1].health
    press(m, Button.HP, { x: 1, y: 1 })
    expect(m.fighters[0].action?.id).toBe('spd-hp')
    step(m, 3)
    expect(m.fighters[1].state).toBe('thrown')
    const spd = findCharacter('zangief').moves['spd-hp']
    step(m, spd.hold + 4)
    expect(before - m.fighters[1].health).toBe(spd.damage)
  })
})

describe('dizzy', () => {
  it('fills up under a run of hits and leaves them helpless', () => {
    const m = fight()
    const b = m.fighters[1]
    let n = 0
    while (b.state !== 'dizzy' && n < 12) {
      b.x = m.fighters[0].x + 40 // walk back in after the pushback, as the attacker would
      press(m, Button.HP)
      step(m, 40)
      n++
    }
    expect(n).toBeGreaterThanOrEqual(3)
    expect(b.state).toBe('dizzy')
    expect(b.blocking).toBe(false)
    // A hit while dizzy knocks them down and clears it.
    press(m, Button.HK, {}, { x: 1 })
    step(m, 30)
    expect(b.state).not.toBe('dizzy')
    expect(b.stun).toBe(0)
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
    m.fighters[0].health = 100
    m.fighters[1].health = 60
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
    const m = fight(4)
    step(m, 30, { x: 1 }, { x: -1 })
    expect(Math.abs(m.fighters[0].x - m.fighters[1].x)).toBeGreaterThanOrEqual(RYU.bodyHalf * 2 - 0.01)
  })

  it('keeps everyone inside the walls, and never further apart than the screen', () => {
    const m = fight()
    step(m, 400, { x: -1 }, { x: 1 })
    for (const f of m.fighters) expect(Math.abs(f.x)).toBeLessThanOrEqual(m.stageHalf)
    expect(Math.abs(m.fighters[0].x - m.fighters[1].x)).toBeLessThanOrEqual(SYSTEM.maxSpread + 0.01)
  })

  it('turns a fighter round when the other one crosses over', () => {
    const m = fight()
    expect(m.fighters[0].facing).toBe(1)
    m.fighters[1].x = -200
    step(m, 2)
    expect(m.fighters[0].facing).toBe(-1)
  })
})

describe('combos', () => {
  it('does not scale damage — four hits is four hits’ worth, as it was', () => {
    const m = fight()
    const b = m.fighters[1]
    const first = b.health
    press(m, Button.LP)
    step(m, 4)
    const afterOne = b.health
    // Chain straight into the next light while they are still in hitstun. The press lands during
    // hitstop and is buffered; the second jab comes out the frame the freeze ends.
    press(m, Button.LP)
    step(m, 16)
    const afterTwo = b.health
    expect(first - afterOne).toBe(move('stand-lp').damage)
    expect(afterOne - afterTwo).toBe(move('stand-lp').damage)
    expect(m.combo[0]).toBe(2)
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
