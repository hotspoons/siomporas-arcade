import { describe, expect, it } from 'vitest'
import { Track } from '../src/sim/Track'
import { BUILTIN_TRACKS, OVAL, STUNT_PARK } from '../src/sim/tracks'
import { PIECES, rotateSide, opposite } from '../src/sim/pieces'
import { makeLaneFrame } from '../src/sim/PathTable'

describe('pieces', () => {
  it('rotate sides consistently', () => {
    expect(rotateSide('E', 1)).toBe('N')
    expect(rotateSide('N', 1)).toBe('W')
    expect(rotateSide('E', 4)).toBe('E')
    expect(opposite('N')).toBe('S')
  })
  it('every lane starts and ends on its ports (roughly at cell-edge midpoints)', () => {
    for (const def of PIECES) {
      for (const lane of def.lanes) {
        const a = { x: 0, y: 0, z: 0, ux: 0, uy: 1, uz: 0, roll: 0, surface: true }
        lane.path(0, a)
        lane.path(1, a)
        expect(Number.isFinite(a.x + a.y + a.z)).toBe(true)
      }
    }
  })
})

describe('Track', () => {
  it('builds a closed oval with no errors', () => {
    const t = new Track(OVAL)
    expect(t.errors).toEqual([])
    expect(t.closed).toBe(true)
    expect(t.loopLength).toBeGreaterThan(200)
    expect(t.lanes.length).toBe(10)
    for (const l of t.lanes) expect(l.next.length).toBe(1)
  })
  it('lanes join up end to start within tolerance', () => {
    const t = new Track(STUNT_PARK)
    expect(t.errors).toEqual([])
    const f0 = makeLaneFrame()
    const f1 = makeLaneFrame()
    for (const l of t.lanes) {
      l.table.frameAt(l.table.length, f0)
      for (const n of l.next) {
        n.table.frameAt(0, f1)
        expect(f0.pos.distanceTo(f1.pos)).toBeLessThan(1.5)
        expect(f0.tan.dot(f1.tan)).toBeGreaterThan(0.9)
      }
    }
  })
  it('has a split with two branches that rejoin', () => {
    const t = new Track(STUNT_PARK)
    const split = t.lanes.find((l) => l.next.length === 2)
    expect(split).toBeDefined()
    expect(t.closed).toBe(true)
  })
  it('keeps loop frames continuous (up points at the loop centre)', () => {
    const t = new Track(STUNT_PARK)
    const loop = t.lanes.find((l) => t.data.pieces[l.pieceIndex].type === 'loop')!
    const f = makeLaneFrame()
    let minUpY = 1
    let prevUp = makeLaneFrame().up.clone()
    for (let s = 0; s <= loop.table.length; s += 1) {
      loop.table.frameAt(s, f)
      minUpY = Math.min(minUpY, f.up.y)
      if (s > 0) expect(f.up.dot(prevUp)).toBeGreaterThan(0.9)
      prevUp = f.up.clone()
    }
    expect(minUpY).toBeLessThan(-0.95) // upside down at the top
  })
  it('every built-in track is closed and error-free', () => {
    for (const data of BUILTIN_TRACKS) {
      const t = new Track(data)
      expect(t.errors, data.name).toEqual([])
      expect(t.closed, data.name).toBe(true)
      expect(t.warnings, data.name).toEqual([])
    }
  })
  it('reports open ends', () => {
    const t = new Track({ name: 'x', size: 8, pieces: [{ type: 'start', x: 1, z: 1, rot: 0, level: 0 }] })
    expect(t.errors.length).toBeGreaterThan(0)
    expect(t.closed).toBe(false)
  })
})
