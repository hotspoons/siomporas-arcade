import { describe, expect, it } from 'vitest'
import { COLUMNS, Select, type PadFrame, type Pick } from '../src/app/Select'
import { Button } from '../src/sim/Motion'

const ROSTER = ['ryu', 'zangief', 'blanka', 'chunli', 'kestrel', 'bollard', 'candela']
const NEUTRAL: PadFrame = { x: 0, y: 0, buttons: 0 }
const pad = (x: number, y: number, buttons = 0): PadFrame => ({ x, y, buttons })
const PUNCH = pad(0, 0, Button.HP)

/** A random that walks a fixed list, so every CPU decision in these tests is the same one twice. */
const fakeRandom = (values: number[]): (() => number) => {
  let i = 0
  return () => values[i++ % values.length]
}

/** Run until the screen hands back a pair, or give up. Returns what it chose. */
function run(sel: Select, p1: PadFrame, p2: PadFrame | null, limit = 600): Pick | null {
  for (let i = 0; i < limit; i++) {
    const pick = sel.step(p1, p2)
    if (pick) return pick
  }
  return null
}

describe('select: the cursor', () => {
  it('ignores the frame it opens on, so a punch already held does not lock anything', () => {
    const sel = new Select(ROSTER, true)
    sel.step(PUNCH, PUNCH)
    expect(sel.cursors[0].locked).toBe(-1)
    expect(sel.cursors[1].locked).toBe(-1)
  })

  it('moves one cell per press and wraps along the row', () => {
    const sel = new Select(ROSTER, true)
    sel.step(NEUTRAL, NEUTRAL)
    sel.step(pad(1, 0), NEUTRAL)
    expect(sel.cursors[0].cell).toBe(1)
    // Held, not tapped: the next frames must not walk the whole row.
    sel.step(pad(1, 0), NEUTRAL)
    sel.step(pad(1, 0), NEUTRAL)
    expect(sel.cursors[0].cell).toBe(1)
  })

  it('repeats when a direction is held long enough', () => {
    const sel = new Select(ROSTER, true)
    sel.step(NEUTRAL, NEUTRAL)
    // One on the press, one twenty frames later, one six frames after that. Hold it long enough and
    // it wraps all the way round, which is why this counts rather than asking whether it moved.
    for (let i = 0; i < 27; i++) sel.step(pad(1, 0), NEUTRAL)
    expect(sel.cursors[0].cell).toBe(3)
  })

  it('wraps down the column onto a cell that exists', () => {
    const sel = new Select(ROSTER, true)
    sel.step(NEUTRAL, NEUTRAL)
    // Eight cells — seven fighters and random — so two rows of four.
    expect(sel.rows).toBe(2)
    sel.step(pad(0, -1), NEUTRAL)
    expect(sel.cursors[0].cell).toBe(COLUMNS)
    sel.step(NEUTRAL, NEUTRAL)
    sel.step(pad(0, -1), NEUTRAL)
    expect(sel.cursors[0].cell).toBe(0)
  })

  it('never lands past the end of the roster', () => {
    const sel = new Select(ROSTER, true)
    sel.step(NEUTRAL, NEUTRAL)
    for (let i = 0; i < 200; i++) {
      sel.step(pad(i % 3 === 0 ? 1 : 0, i % 5 === 0 ? -1 : 0), NEUTRAL)
      expect(sel.cursors[0].cell).toBeLessThan(sel.cells.length)
      expect(sel.cursors[0].cell).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('select: choosing', () => {
  it('gives back what both players locked in', () => {
    const sel = new Select(ROSTER, true)
    sel.step(NEUTRAL, NEUTRAL)
    sel.step(pad(1, 0), pad(-1, 0)) // p1 → zangief, p2 starts on candela → bollard
    const pick = run(sel, PUNCH, PUNCH)
    expect(pick).toEqual({ p1: 'zangief', p2: 'bollard' })
  })

  it('holds the matchup for a beat before it starts the fight', () => {
    const sel = new Select(ROSTER, true)
    sel.step(NEUTRAL, NEUTRAL)
    expect(sel.step(PUNCH, PUNCH)).toBeNull()
    expect(sel.settled).toBe(true)
    let frames = 1
    while (!sel.step(NEUTRAL, NEUTRAL)) frames++
    expect(frames).toBeGreaterThan(30)
    expect(frames).toBeLessThan(120)
  })

  it('resolves the random cell to a real fighter, and never to random itself', () => {
    for (const r of [0, 0.34, 0.66, 0.99]) {
      const sel = new Select(ROSTER, true, () => r)
      sel.step(NEUTRAL, NEUTRAL)
      // Walk player one onto the last cell, which is always random.
      sel.cursors[0].cell = sel.cells.length - 1
      const pick = run(sel, PUNCH, PUNCH)
      expect(ROSTER).toContain(pick?.p1)
    }
  })

  it('lets the machine pick for itself, and always stops', () => {
    const sel = new Select(ROSTER, false, fakeRandom([0.1, 0.4, 0.8, 0.55, 0.3, 0.95, 0.7]))
    sel.step(NEUTRAL, null)
    const pick = run(sel, PUNCH, null)
    expect(pick?.p1).toBe('ryu')
    expect(ROSTER).toContain(pick?.p2)
  })

  it('does not wait for a second player who is not there', () => {
    const sel = new Select(ROSTER, false, fakeRandom([0.2, 0.6, 0.9]))
    sel.step(NEUTRAL, null)
    expect(run(sel, PUNCH, null, 300)).not.toBeNull()
  })

  it('puts the cursors on the pair that is already fighting', () => {
    const sel = new Select(ROSTER, true)
    sel.preset(0, 'blanka')
    sel.preset(1, 'kestrel')
    expect(sel.cells[sel.cursors[0].cell]).toBe('blanka')
    expect(sel.cells[sel.cursors[1].cell]).toBe('kestrel')
    sel.preset(0, 'nobody')
    expect(sel.cells[sel.cursors[0].cell]).toBe('blanka')
  })
})
