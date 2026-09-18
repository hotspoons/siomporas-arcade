// The banked deck and the bank under its high side have to agree on where the deck's outer edge is.
// They very nearly didn't: a vertex built as `deckHalf × scale` and read back as `… ÷ scale` lands a
// few ulps either side of deckHalf depending on the row, and the ones that landed outside used to
// drop to grade while their neighbours stayed lifted — a wedge-shaped hole in the shoulder on the
// outside of every banked turn, with the background showing through it.

import { describe, expect, it } from 'vitest'
import { bankReach, deckHalf, groundHeight } from '../src/render/RoadMesh'
import { makeInputFrame } from '../src/sim/InputFrame'
import { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import { FORK_SECONDS, FORK_WIDEN, MAX_SPEED_HI, runInSegments, SEG_LENGTH } from '../src/sim/Tuning'

const TILTS = [-0.24, -0.15, -0.02, 0.02, 0.15, 0.24]

describe('banked deck edge', () => {
  it('lifts the deck edge to the full drop however the row scale rounds it', () => {
    const dh = deckHalf()
    const plateau = 2 * dh
    for (const tilt of TILTS) {
      const drop = Math.abs(tilt) * plateau
      // Every scale a drawn row can have, taken through the multiply-then-divide the renderer does.
      for (let scale = 0.5; scale < 500; scale *= 1.037) {
        const u = Math.sign(tilt) * ((dh * scale) / scale) // the high side, as the renderer computes it
        expect(groundHeight(u, tilt), `deck edge at scale ${scale}`).toBeCloseTo(drop, 9)
        expect(groundHeight(u, tilt), `bankHeight at scale ${scale}`).toBeCloseTo(drop, 9)
      }
    }
  })

  it('never lifts past the drop, and is at grade off the low side and past the bank', () => {
    const dh = deckHalf()
    const plateau = 2 * dh
    for (const tilt of TILTS) {
      const drop = Math.abs(tilt) * plateau
      for (let u = -plateau; u <= plateau; u += 0.37) {
        const deck = groundHeight(u, tilt)
        expect(deck).toBeLessThanOrEqual(drop + 1e-9)
      }
      // The low side and the ground beyond the bank are both at grade.
      expect(groundHeight(-Math.sign(tilt) * (dh + 1), tilt)).toBe(0)
      expect(groundHeight(Math.sign(tilt) * 1e4, tilt)).toBe(0)
    }
  })

  it('falls from the drop to grade across the bank, with no step at either end', () => {
    const dh = deckHalf()
    for (const tilt of [-0.24, 0.24]) {
      const drop = Math.abs(tilt) * 2 * dh
      const foot = Math.sign(tilt) * bankReach(tilt)
      expect(groundHeight(Math.sign(tilt) * dh, tilt)).toBeCloseTo(drop, 9)
      expect(groundHeight(foot * 0.999, tilt)).toBeLessThan(drop * 0.01)
      expect(groundHeight(foot, tilt)).toBe(0)
    }
  })

  it('is flat where there is no bank', () => {
    for (let u = -60; u <= 60; u += 3) expect(groundHeight(u, 0)).toBe(0)
  })
})

// A fork is a choice you keep. The old one widened a median between two carriageways and nudged you
// onto whichever side you were leaning to, so by halfway you had been committed without deciding.
describe('forks', () => {
  it('is one road the whole way across, right up to the line', () => {
    const sim = new Sim(7)
    const segs = sim.stage.segments
    const first = segs.findIndex((s) => s.fork >= 0)
    expect(first).toBeGreaterThan(0)
    for (const s of segs.slice(first, sim.stage.length)) {
      const halfW = 1 + s.fork * FORK_WIDEN
      expect(halfW).toBeGreaterThanOrEqual(1)
      // Everything from one edge to the other is road: no median, nothing to cross that costs you.
      for (let x = -halfW; x <= halfW; x += halfW / 8) expect(Math.abs(x) <= halfW).toBe(true)
    }
    // …and it is wider at the line than where it opened.
    expect(segs[sim.stage.length - 1].fork).toBeGreaterThan(segs[first].fork)
  })

  it('runs for about FORK_SECONDS and approaches straight', () => {
    const sim = new Sim(7)
    const segs = sim.stage.segments
    const first = segs.findIndex((s) => s.fork >= 0)
    const forkM = (sim.stage.length - first) * SEG_LENGTH
    // Within a segment of the asked-for length, at the cruising pace the constant is defined at.
    expect(forkM).toBeGreaterThan(FORK_SECONDS * MAX_SPEED_HI * 0.8 - SEG_LENGTH * 2)
    // The last of the run-in is straight: no corner hides the split.
    for (const s of segs.slice(first - Math.round(runInSegments() / 4), first)) expect(Math.abs(s.curve)).toBeLessThan(0.6)
  })

  it('throws the two ways apart instead of letting one carry straight on', () => {
    const left = new Sim(7)
    const right = new Sim(7)
    for (const [sim, x] of [
      [left, -1.5],
      [right, 1.5],
    ] as const) {
      const input = makeInputFrame()
      const snap = new Snapshot()
      sim.z = sim.stage.metres - 3
      sim.x = x
      sim.speed = 40
      sim.tick(0.2, input, snap)
    }
    expect(left.stage.desc.id).not.toBe(right.stage.desc.id)
    // Both opening curves are real, and they are opposite.
    expect(Math.abs(left.stage.segments[0].curve)).toBeGreaterThan(1)
    expect(Math.sign(left.stage.segments[0].curve)).toBe(-Math.sign(right.stage.segments[0].curve))
    // You come out in the lane you were in, not shunted to a centreline.
    expect(Math.abs(left.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(right.x)).toBeLessThanOrEqual(1)
  })
})
