// The speedbowl's wall: the third lane above the banking, near enough vertical, where the corner
// presses the car into the surface hard enough to carry a speed the deck cannot.

import { describe, expect, it } from 'vitest'
import { makeAcross, sectionAt, sectionAtOut, wallOf } from '../src/sim/bank'
import { makeLaneFrame } from '../src/sim/PathTable'
import { Track, type TrackData } from '../src/sim/Track'
import { BANK_GRIP, BANK_HOLD, GRAVITY, GRIP_LATERAL, LOAD_MAX, ROAD_HALF_WIDTH } from '../src/sim/Tuning'

const BOWL: TrackData = {
  name: 'Bowl',
  size: 16,
  pieces: [
    { type: 'start', x: 1, z: 7, rot: 0, level: 0 },
    { type: 'straight', x: 2, z: 7, rot: 0, level: 0 },
    { type: 'bank6', x: 3, z: 7, rot: 0, level: 0 },
  ],
}

function bowlLane(): { track: Track; lane: ReturnType<Track['lanes']['find']> } {
  const track = new Track(BOWL)
  return { track, lane: track.lanes.find((l) => track.data.pieces[l.pieceIndex].type === 'bank6') }
}

/** The angle the surface stands at, and what the sim's own numbers say it will hold, at one offset. */
function atOffset(x: number): { deg: number; mph: number } {
  const { lane } = bowlLane()
  const f = makeLaneFrame()
  lane!.table.frameAt(lane!.table.length * 0.5, f)
  const sec = sectionAt(lane!.bank, f.right.y, x, makeAcross())
  const c = Math.cos(sec.a)
  const s = Math.sin(sec.a)
  const rightY = f.right.y * c + f.up.y * s
  const upY = f.up.y * c - f.right.y * s
  const load = Math.min(LOAD_MAX, Math.abs(upY) + (BANK_GRIP * Math.abs(rightY)) / Math.max(0.08, Math.abs(upY)))
  const held = -GRAVITY * rightY * BANK_HOLD
  const v = Math.sqrt(Math.max(0, (GRIP_LATERAL * load + held) / Math.abs(f.kRight)))
  return { deg: (Math.atan2(Math.abs(rightY), Math.abs(upY)) * 180) / Math.PI, mph: v / 0.44704 }
}

describe('the speedbowl wall', () => {
  it('stands the surface up towards vertical past the edge of the deck', () => {
    const deck = atOffset(0)
    const top = atOffset(-14)
    expect(deck.deg).toBeGreaterThan(50)
    expect(deck.deg).toBeLessThan(60)
    expect(top.deg).toBeGreaterThan(80)
  })

  it('carries three hundred at the top where the deck gives up at two', () => {
    expect(atOffset(0).mph).toBeGreaterThan(170)
    expect(atOffset(0).mph).toBeLessThan(220)
    expect(atOffset(-14).mph).toBeGreaterThan(270)
  })

  it('is drivable width, not scenery: the lane runs on up it', () => {
    const { lane } = bowlLane()
    const f = makeLaneFrame()
    lane!.table.frameAt(lane!.table.length * 0.5, f)
    const { side, maxA } = wallOf(lane!.bank, f.right.y)
    expect(side).not.toBe(0)
    // Nine metres of surface past the road's edge, standing on about three metres of ground.
    const arc = maxA * lane!.bank!.radius + lane!.bank!.run
    expect(arc).toBeGreaterThan(10)
    const sec = sectionAt(lane!.bank, f.right.y, side * (ROAD_HALF_WIDTH + arc), makeAcross())
    // Where the top of it ends up in the world: high above the middle of the road, and standing on
    // not much more ground than it is tall. That is a wall, not a wide shoulder.
    const up = sec.out * f.right.y + sec.lift * f.up.y
    const reach = Math.hypot(sec.out * f.right.x + sec.lift * f.up.x, sec.out * f.right.z + sec.lift * f.up.z)
    expect(up).toBeGreaterThan(10)
    expect(reach).toBeLessThan(up)
  })

  it('reads the same wall from an offset across the frame as from along the surface', () => {
    const { lane } = bowlLane()
    const f = makeLaneFrame()
    lane!.table.frameAt(lane!.table.length * 0.5, f)
    const { side } = wallOf(lane!.bank, f.right.y)
    // A point picked by arc length and then looked up by its flat offset lands back where it started.
    for (const arc of [6, 9, 12]) {
      const byArc = sectionAt(lane!.bank, f.right.y, side * (ROAD_HALF_WIDTH + arc), makeAcross())
      const byOut = sectionAtOut(lane!.bank, f.right.y, byArc.out, makeAcross())
      expect(byOut.lift).toBeCloseTo(byArc.lift, 3)
      expect(byOut.a).toBeCloseTo(byArc.a, 3)
    }
  })

  it('grows out of the banking rather than standing up at the mouth of the corner', () => {
    const { lane } = bowlLane()
    const f = makeLaneFrame()
    const at = (frac: number): number => {
      lane!.table.frameAt(lane!.table.length * frac, f)
      const { maxA, run } = wallOf(lane!.bank, f.right.y)
      return maxA * lane!.bank!.radius + run
    }
    // Nothing where the road is still flat, and everything by the time the deck is fully banked. It
    // is scaled by how far the banking has ramped in — without that the wall is *tallest* at the
    // mouth, because there the deck is flat and all of the angle up to vertical is left to the wall.
    expect(at(0.01)).toBeLessThan(1)
    expect(at(0.06)).toBeLessThan(at(0.12))
    expect(at(0.12)).toBeLessThan(at(0.5))
    expect(at(0.5)).toBeGreaterThan(10)
  })

  it('leaves an ordinary banked sweeper alone', () => {
    const track = new Track({ ...BOWL, pieces: [BOWL.pieces[0], BOWL.pieces[1], { type: 'bank2', x: 3, z: 7, rot: 0, level: 0 }] })
    const lane = track.lanes.find((l) => track.data.pieces[l.pieceIndex].type === 'bank2')
    expect(lane?.bank).toBeUndefined()
  })
})
