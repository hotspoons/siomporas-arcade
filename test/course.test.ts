import { describe, expect, it } from 'vitest'
import { makeInputFrame } from '../src/sim/InputFrame'
import { SimSnapshot } from '../src/sim/SimSnapshot'
import { SimWorld } from '../src/sim/SimWorld'
import { SIM_DT } from '../src/sim/Tuning'
import { COURSE_01 } from '../src/sim/track/courses/course01'
import { buildTrack } from '../src/sim/track/TrackBuilder'
import { makeFrame } from '../src/sim/track/TrackSpline'

describe('Course 01', () => {
  const track = buildTrack(COURSE_01)

  it('is about 12 km and exercises every segment type', () => {
    expect(track.length).toBeGreaterThan(11000)
    const types = new Set(track.segments.map((s) => s.type))
    for (const t of ['TUBE', 'HALFPIPE', 'OPEN', 'BERM_IN', 'BERM_OUT', 'GAP', 'SPLIT', 'GATE']) expect(types.has(t as never)).toBe(true)
  })

  it('levels open sections toward world down', () => {
    const f = makeFrame()
    for (const seg of track.segments) {
      if (seg.type !== 'OPEN') continue
      const mid = (seg.sStart + seg.sEnd) / 2
      track.frameAt(mid, 0, f)
      // nor points to the floor, so it should be close to -Y.
      expect(f.nor.y).toBeLessThan(-0.9)
    }
  })

  it('builds a second branch for the split with matching endpoints', () => {
    const split = track.segments.find((s) => s.type === 'SPLIT')!
    expect(split.branch).not.toBeNull()
    const a = makeFrame()
    const b = makeFrame()
    track.frameAt(split.sStart, 0, a)
    track.frameAt(split.sStart, 1, b)
    expect(a.pos.distanceTo(b.pos)).toBeLessThan(6)
    track.frameAt(split.sEnd - 1, 0, a)
    track.frameAt(split.sEnd - 1, 1, b)
    expect(a.pos.distanceTo(b.pos)).toBeLessThan(8)
  })

  for (const [label, throttle, pitch, brake] of [
    ['at cruise', 0, 0, 0],
    ['at full throttle', 1, 0, 0],
    ['at full throttle holding nose-up (W held through the jump)', 1, 1, 0],
    ['at cruise holding nose-down', 0, -1, 0],
    ['at minimum speed (brake held) holding nose-down', 0, -1, 1],
  ] as const) {
    it(`lands every jump ${label}`, () => {
      const world = new SimWorld(track, 5)
      const snap = new SimSnapshot()
      const input = makeInputFrame()
      input.throttle = throttle
      input.pitch = pitch
      input.brake = brake ?? 0
      // No traffic and no clock: this test is about the track.
      let launches = 0
      let landings = 0
      for (let i = 0; i < 120 * 90 && world.phase === 'running'; i++) {
        for (const a of world.traffic.agents) a.active = false
        world.shield = 100
        world.timer = 999
        world.tick(SIM_DT, input, snap)
        world.events.drain((e) => {
          if (e.type === 'launch') launches++
          if (e.type === 'land') landings++
          if (e.type === 'crash') throw new Error(`crashed at s=${world.vehicle.s.toFixed(0)} after ${launches} launches`)
        })
      }
      expect(launches).toBe(2)
      expect(landings).toBe(2)
      expect(world.phase).toBe('finished')
    })
  }
})
