import { describe, expect, it } from 'vitest'
import {
  BACK,
  Button,
  CHARGE_BACK,
  CHARGE_DOWN,
  DP,
  FORWARD,
  HCF,
  InputHistory,
  QCB,
  QCF,
  RDP,
  matchCharge,
  matchDoubleTap,
  matchMotion,
  matchRotation,
  type Dir,
  type Facing,
} from '../src/sim/Motion'

/**
 * Feed numpad directions, oldest first, one frame each. Written the way you would say the input out
 * loud — `feed(h, [5, 2, 2, 3, 6])` — and converted back to the absolute stick the history actually
 * stores, so the tests exercise the same facing conversion the game does.
 */
function feed(h: InputHistory, dirs: readonly Dir[], facing: Facing = 1, buttons = 0): void {
  for (const d of dirs) {
    const fx = ((d - 1) % 3) - 1
    const y = Math.floor((d - 1) / 3) - 1
    h.push(fx * facing, y, buttons)
  }
}

/** `n` frames of neutral, for letting a motion go stale. */
function wait(h: InputHistory, n: number): void {
  for (let i = 0; i < n; i++) h.push(0, 0, 0)
}

describe('direction and facing', () => {
  it('reads the numpad relative to the way the fighter is facing', () => {
    const h = new InputHistory()
    h.push(1, 0, 0) // absolute right
    expect(h.dir(0, 1)).toBe(6)
    expect(h.dir(0, -1)).toBe(4)
    h.push(-1, -1, 0) // absolute down-left
    expect(h.dir(0, 1)).toBe(1)
    expect(h.dir(0, -1)).toBe(3)
  })

  it('returns neutral for frames that have not happened', () => {
    const h = new InputHistory()
    expect(h.dir(0, 1)).toBe(5)
    expect(h.dir(99, 1)).toBe(5)
  })

  it('survives wrapping round the ring', () => {
    const h = new InputHistory(8)
    feed(h, [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 6])
    expect(h.length).toBe(8)
    expect(h.dir(0, 1)).toBe(6)
    expect(h.dir(1, 1)).toBe(2)
    expect(h.dir(7, 1)).toBe(2)
    expect(h.dir(8, 1)).toBe(5) // fell off the end
  })
})

describe('quarter circles', () => {
  it('matches a clean 236', () => {
    const h = new InputHistory()
    feed(h, [5, 2, 3, 6])
    expect(matchMotion(h, QCF, 1)).toBe(true)
  })

  it('matches the messy input a person actually produces', () => {
    const h = new InputHistory()
    // held frames, a skipped 3, and a stray 1 on the way into the crouch
    feed(h, [5, 5, 1, 2, 2, 2, 3, 3, 6, 6])
    expect(matchMotion(h, QCF, 1)).toBe(true)
  })

  it('matches when the diagonal is skipped entirely, as on a d-pad', () => {
    const h = new InputHistory()
    feed(h, [5, 2, 2, 6])
    expect(matchMotion(h, QCF, 1)).toBe(true)
  })

  it('still matches a few frames after the stick is let go', () => {
    const h = new InputHistory()
    feed(h, [5, 2, 3, 6])
    wait(h, 5)
    expect(matchMotion(h, QCF, 1)).toBe(true)
  })

  it('goes stale once the buffer is past', () => {
    const h = new InputHistory()
    feed(h, [5, 2, 3, 6])
    wait(h, 20)
    expect(matchMotion(h, QCF, 1)).toBe(false)
  })

  it('rejects a motion drawn out beyond the window', () => {
    const h = new InputHistory()
    feed(h, [2])
    wait(h, 20)
    feed(h, [3, 6])
    expect(matchMotion(h, QCF, 1)).toBe(false)
  })

  it('does not fire on forward alone', () => {
    const h = new InputHistory()
    feed(h, [5, 5, 6, 6, 6])
    expect(matchMotion(h, QCF, 1)).toBe(false)
  })

  it('is the mirror of itself: the same stick is qcf facing right and qcb facing left', () => {
    const h = new InputHistory()
    feed(h, [5, 2, 3, 6], 1)
    expect(matchMotion(h, QCF, 1)).toBe(true)
    expect(matchMotion(h, QCB, 1)).toBe(false)
    expect(matchMotion(h, QCF, -1)).toBe(false)
    expect(matchMotion(h, QCB, -1)).toBe(true)
  })
})

describe('dragon punch', () => {
  it('matches 623', () => {
    const h = new InputHistory()
    feed(h, [5, 6, 2, 3])
    expect(matchMotion(h, DP, 1)).toBe(true)
  })

  it('matches the common 6236 variant', () => {
    const h = new InputHistory()
    feed(h, [5, 6, 6, 2, 3, 6])
    expect(matchMotion(h, DP, 1)).toBe(true)
  })

  it('does not fire on a plain quarter circle', () => {
    const h = new InputHistory()
    feed(h, [5, 2, 3, 6])
    expect(matchMotion(h, DP, 1)).toBe(false)
  })

  it('a clean 623 is not also a quarter circle, so priority order is not load-bearing here', () => {
    const h = new InputHistory()
    feed(h, [5, 6, 2, 3])
    expect(matchMotion(h, QCF, 1)).toBe(false)
  })

  it('eats the fireball of anyone who walks forward into it, exactly as it should', () => {
    // 6,6,2,3,6 contains a dragon punch AND a quarter circle. Check DP first and the walking
    // player gets the uppercut they asked for without meaning to. Since 1991.
    const h = new InputHistory()
    feed(h, [5, 6, 6, 2, 3, 6])
    expect(matchMotion(h, DP, 1)).toBe(true)
    expect(matchMotion(h, QCF, 1)).toBe(true)
  })

  it('matches a reverse dragon punch, 421', () => {
    const h = new InputHistory()
    feed(h, [5, 4, 2, 1])
    expect(matchMotion(h, RDP, 1)).toBe(true)
    expect(matchMotion(h, QCB, 1)).toBe(false)
  })
})

describe('half circles', () => {
  it('matches 41236', () => {
    const h = new InputHistory()
    feed(h, [5, 4, 1, 2, 3, 6])
    expect(matchMotion(h, HCF, 1)).toBe(true)
  })

  it('tolerates the roll being held at each step', () => {
    const h = new InputHistory()
    feed(h, [5, 4, 4, 1, 1, 2, 2, 3, 3, 6])
    expect(matchMotion(h, HCF, 1)).toBe(true)
  })

  it('will not accept a quarter circle as half of one', () => {
    const h = new InputHistory()
    feed(h, [5, 2, 3, 6])
    expect(matchMotion(h, HCF, 1)).toBe(false)
  })
})

describe('charge', () => {
  it('matches back held long enough, then forward', () => {
    const h = new InputHistory()
    feed(h, Array<Dir>(50).fill(4))
    feed(h, [6])
    expect(matchCharge(h, CHARGE_BACK, 1)).toBe(true)
  })

  it('rejects a charge that was not held long enough', () => {
    const h = new InputHistory()
    feed(h, Array<Dir>(30).fill(4))
    feed(h, [6])
    expect(matchCharge(h, CHARGE_BACK, 1)).toBe(false)
  })

  it('still counts a few frames after the stick returns forward', () => {
    const h = new InputHistory()
    feed(h, Array<Dir>(50).fill(4))
    feed(h, [6, 6, 6, 6])
    expect(matchCharge(h, CHARGE_BACK, 1)).toBe(true)
  })

  it('drops the charge once the release window is past', () => {
    const h = new InputHistory()
    feed(h, Array<Dir>(50).fill(4))
    feed(h, [6])
    wait(h, 20)
    expect(matchCharge(h, CHARGE_BACK, 1)).toBe(false)
  })

  it('loses the charge the moment the stick leaves the hold set', () => {
    const h = new InputHistory()
    feed(h, Array<Dir>(50).fill(4))
    feed(h, [5, 4, 6])
    expect(matchCharge(h, CHARGE_BACK, 1)).toBe(false)
  })

  it('charges back and down at once when held down-back, which is why they crouch', () => {
    const h = new InputHistory()
    feed(h, Array<Dir>(50).fill(1))
    expect(matchCharge(h, CHARGE_BACK, 1, { releaseWindow: 0 })).toBe(false)
    feed(h, [6])
    expect(matchCharge(h, CHARGE_BACK, 1)).toBe(true)

    const g = new InputHistory()
    feed(g, Array<Dir>(50).fill(1))
    feed(g, [8])
    expect(matchCharge(g, CHARGE_DOWN, 1)).toBe(true)
  })
})

describe('rotation', () => {
  it('matches a full circle', () => {
    const h = new InputHistory()
    feed(h, [4, 1, 2, 3, 6, 9, 8, 7])
    expect(matchRotation(h, 1)).toBe(true)
  })

  it('matches a shortcut that hits six of the eight', () => {
    const h = new InputHistory()
    feed(h, [4, 1, 2, 3, 6, 9])
    expect(matchRotation(h, 1)).toBe(true)
  })

  it('does not match a quarter circle', () => {
    const h = new InputHistory()
    feed(h, [5, 2, 3, 6])
    expect(matchRotation(h, 1)).toBe(false)
  })

  it('does not match directions spread beyond the window', () => {
    const h = new InputHistory()
    feed(h, [4, 1, 2])
    wait(h, 40)
    feed(h, [3, 6, 9])
    expect(matchRotation(h, 1)).toBe(false)
  })
})

describe('double tap', () => {
  it('matches tap, release, tap', () => {
    const h = new InputHistory()
    feed(h, [5, 6, 5, 6])
    expect(matchDoubleTap(h, FORWARD, 1)).toBe(true)
  })

  it('does not match a single held direction', () => {
    const h = new InputHistory()
    feed(h, [5, 6, 6, 6])
    expect(matchDoubleTap(h, FORWARD, 1)).toBe(false)
  })

  it('only fires on the frame the second tap goes down', () => {
    const h = new InputHistory()
    feed(h, [5, 6, 5, 6])
    expect(matchDoubleTap(h, FORWARD, 1)).toBe(true)
    feed(h, [6])
    expect(matchDoubleTap(h, FORWARD, 1)).toBe(false)
  })

  it('does not match taps too far apart', () => {
    const h = new InputHistory()
    feed(h, [6])
    wait(h, 20)
    feed(h, [6])
    expect(matchDoubleTap(h, FORWARD, 1)).toBe(false)
  })

  it('reads back-back as a backdash, and not as a forward dash', () => {
    const h = new InputHistory()
    feed(h, [5, 4, 5, 4])
    expect(matchDoubleTap(h, BACK, 1)).toBe(true)
    expect(matchDoubleTap(h, FORWARD, 1)).toBe(false)
  })
})

describe('buttons', () => {
  it('fires on the edge, not while held', () => {
    const h = new InputHistory()
    h.push(0, 0, 0)
    h.push(0, 0, Button.HP)
    expect(h.pressed(Button.HP)).toBe(true)
    h.push(0, 0, Button.HP)
    expect(h.pressed(Button.HP)).toBe(false)
    h.push(0, 0, 0)
    expect(h.pressed(Button.HP)).toBe(false)
    expect(h.released(Button.HP)).toBe(true)
  })

  it('tells two buttons apart in the same mask', () => {
    const h = new InputHistory()
    h.push(0, 0, 0)
    h.push(0, 0, Button.LP | Button.LK)
    expect(h.pressed(Button.LP)).toBe(true)
    expect(h.pressed(Button.LK)).toBe(true)
    expect(h.pressed(Button.HP)).toBe(false)
  })
})

describe('the whole thing together', () => {
  it('reads a fireball: motion then button, the way a player inputs it', () => {
    const h = new InputHistory()
    feed(h, [5, 5, 2, 2, 3, 6])
    h.push(1, 0, Button.HP) // still holding forward, punch goes down
    expect(h.pressed(Button.HP)).toBe(true)
    expect(matchMotion(h, QCF, 1)).toBe(true)
  })

  it('does not read a fireball out of someone just walking forward and punching', () => {
    const h = new InputHistory()
    feed(h, [6, 6, 6, 6, 6, 6])
    h.push(1, 0, Button.HP)
    expect(h.pressed(Button.HP)).toBe(true)
    expect(matchMotion(h, QCF, 1)).toBe(false)
  })

  it('does not read a fireball out of crouch-blocking and pressing punch', () => {
    const h = new InputHistory()
    feed(h, Array<Dir>(10).fill(1))
    h.push(-1, -1, Button.LP)
    expect(matchMotion(h, QCF, 1)).toBe(false)
  })
})
