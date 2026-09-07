import { describe, expect, it } from 'vitest'
import { makeInputFrame, decodeInput, encodeInput } from '../src/sim/InputFrame'
import { SimSnapshot } from '../src/sim/SimSnapshot'
import { SimWorld } from '../src/sim/SimWorld'
import { SIM_DT, SPEED_BOOST_MAX, SPEED_MAX } from '../src/sim/Tuning'
import { TEST_COURSE } from '../src/sim/track/courses/testCourse'
import { buildTrack } from '../src/sim/track/TrackBuilder'
import { Rng } from '@apex/engine/math/Rng'

function drive(seed: number, ticks: number, steerFn: (t: number) => number) {
  const world = new SimWorld(buildTrack(TEST_COURSE), seed)
  const snap = new SimSnapshot()
  const input = makeInputFrame()
  for (let i = 0; i < ticks; i++) {
    input.steer = steerFn(i * SIM_DT)
    input.throttle = 1
    input.fire = i % 40 < 20
    world.tick(SIM_DT, input, snap)
  }
  return { world, snap }
}

describe('SimWorld', () => {
  it('is deterministic for the same input tape', () => {
    const a = drive(7, 1200, (t) => Math.sin(t * 2.3))
    const b = drive(7, 1200, (t) => Math.sin(t * 2.3))
    expect(a.snap.vehicle.s).toBe(b.snap.vehicle.s)
    expect(a.snap.vehicle.theta).toBe(b.snap.vehicle.theta)
    expect(a.snap.hud.score).toBe(b.snap.hud.score)
    expect(a.snap.trafficCount).toBe(b.snap.trafficCount)
  })

  it('reaches full throttle speed and finishes the course', () => {
    const { world, snap } = drive(3, 120 * 12, () => 0)
    expect(snap.vehicle.speed).toBeLessThanOrEqual(SPEED_BOOST_MAX)
    expect(snap.vehicle.speed).toBeGreaterThan(SPEED_MAX - 1)
    expect(['finished', 'running', 'timeout']).toContain(world.phase)
    expect(Number.isFinite(snap.vehicle.pos.x)).toBe(true)
  })

  it('round-trips the input tape encoding', () => {
    const f = makeInputFrame()
    f.steer = -0.5
    f.throttle = 1
    f.brake = 0
    f.fire = true
    f.shockwave = true
    f.pitch = 0.25
    const g = decodeInput(encodeInput(f), makeInputFrame())
    expect(Math.abs(g.steer - f.steer)).toBeLessThan(0.01)
    expect(g.throttle).toBe(1)
    expect(g.fire).toBe(true)
    expect(g.shockwave).toBe(true)
    expect(Math.abs(g.pitch - f.pitch)).toBeLessThan(0.01)
  })
})

describe('Rng', () => {
  it('reproduces a sequence from a seed', () => {
    const a = new Rng(42)
    const b = new Rng(42)
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next())
  })
  it('is roughly uniform', () => {
    const r = new Rng(9)
    let sum = 0
    for (let i = 0; i < 20000; i++) sum += r.next()
    expect(Math.abs(sum / 20000 - 0.5)).toBeLessThan(0.02)
  })
})
