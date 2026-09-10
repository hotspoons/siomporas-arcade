// The reported version of this: "I keep getting stuck on what looks like a smooth transition from
// terrain to road", with a position and a track to reproduce it on.
//
// The car was standing on the grass at the edge of a banked piece, and the sim told it that it was
// underneath the road. It was not: the deck's *centre line* was 0.63 m over its roof, but the deck
// where the car actually stood — five metres out, on the low side of the bank — was half a metre
// under its wheels. Measuring the surface at the centre line and the car's position five metres away
// is comparing two different places.

import { describe, expect, it } from 'vitest'
import { CARS } from '../src/sim/CarSpec'
import { makeInputFrame } from '../src/sim/InputFrame'
import { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import { Track } from '../src/sim/Track'
import { RICH2 } from '../src/sim/tracks/rich2'
import { SIM_DT } from '../src/sim/Tuning'

/** The car as the sim's private state, parked where the report says it was stuck. */
function parkedAtTheReportedSpot(): { sim: Sim; car: Record<string, never> & { probeBlocking(): string; mode: string; pos: { x: number; y: number; z: number } } } {
  const track = new Track(RICH2)
  const sim = new Sim(track, CARS[0], 0)
  const car = sim.car as unknown as { mode: string; onGrass: boolean; speed: number; yaw: number; pos: { set(x: number, y: number, z: number): void; x: number; y: number; z: number }; forward: { set(x: number, y: number, z: number): void }; probeBlocking(): string }
  car.mode = 'ground'
  car.onGrass = true
  car.pos.set(987.11, track.groundHeight(987.11, 655.36) + 0.35, 655.36)
  // Facing the road, the way the report had it.
  car.yaw = Math.atan2(0.85, -0.52)
  car.forward.set(-0.52, 0, 0.85)
  car.speed = 12
  return { sim, car: car as never }
}

/** The second report: parked on the grass beside the same bank, aimed up it. */
function aimedUpTheBank(): { sim: Sim; car: { mode: string; up: { y: number }; pos: { x: number; y: number; z: number }; speed: number } } {
  const track = new Track(RICH2)
  const sim = new Sim(track, CARS[0], 0)
  const car = sim.car as unknown as { mode: string; onGrass: boolean; speed: number; yaw: number; pos: { set(x: number, y: number, z: number): void } ; forward: { set(x: number, y: number, z: number): void } }
  car.mode = 'ground'
  car.onGrass = true
  car.pos.set(992.83, track.groundHeight(992.83, 610.59) + 0.35, 610.59)
  car.yaw = Math.atan2(-0.9, -0.43)
  car.forward.set(-0.43, 0, -0.9)
  car.speed = 14
  return { sim, car: sim.car as never }
}

describe('the edge of a banked piece', () => {
  it('is not something the car is under while it is standing beside it', () => {
    const { car } = parkedAtTheReportedSpot()
    expect(car.probeBlocking()).toBe('')
  })

  it('lets the car drive away from there instead of holding it against nothing', () => {
    const { sim, car } = parkedAtTheReportedSpot()
    const from = { x: car.pos.x, z: car.pos.z }
    const input = makeInputFrame()
    input.throttle = 1
    const snap = new Snapshot()
    const events: string[] = []
    for (let i = 0; i < 60 * 3; i++) {
      sim.tick(SIM_DT, input, snap)
      sim.events.drain((e) => events.push(e.type))
    }
    expect(events).not.toContain('crash')
    expect(Math.hypot(car.pos.x - from.x, car.pos.z - from.z)).toBeGreaterThan(20)
  })

  it('is something the car climbs onto leaning, one side up and one side down', () => {
    const { sim, car } = aimedUpTheBank()
    const input = makeInputFrame()
    input.throttle = 1
    const snap = new Snapshot()
    let leant = 0
    let climbed = 0
    for (let i = 0; i < 40; i++) {
      sim.tick(SIM_DT, input, snap)
      leant = Math.min(leant || 1, car.up.y)
      climbed = Math.max(climbed, car.pos.y)
    }
    // Up the bank, and tilted with it rather than sitting flat on the grass under it.
    expect(climbed).toBeGreaterThan(1)
    expect(leant).toBeLessThan(0.9)
  })

  it('does not leave the car bouncing against the bank it is standing on', () => {
    const { sim, car } = aimedUpTheBank()
    const input = makeInputFrame()
    input.throttle = 1
    const snap = new Snapshot()
    const events: string[] = []
    for (let i = 0; i < 60 * 2; i++) {
      sim.tick(SIM_DT, input, snap)
      sim.events.drain((e) => events.push(e.type))
    }
    expect(events.filter((e) => e === 'bump').length).toBeLessThan(3)
    expect(car.mode).not.toBe('crash')
  })

  it('is a road the car rejoins when it is pointed along it', () => {
    const { sim, car } = parkedAtTheReportedSpot()
    // Same spot, aimed the way the lane runs rather than across it.
    const inner = sim.car as unknown as { yaw: number; forward: { set(x: number, y: number, z: number): void }; scratch: { tan: { x: number; z: number } }; hit: unknown; nearby: unknown[] }
    const lane = new Track(RICH2).lanes.find((l) => l.pieceIndex === 6)!
    lane.table.project(sim.car.pos, inner.scratch as never, inner.hit as never)
    const tan = inner.scratch.tan
    inner.yaw = Math.atan2(tan.z, tan.x)
    inner.forward.set(tan.x, 0, tan.z)
    const input = makeInputFrame()
    input.throttle = 1
    const snap = new Snapshot()
    for (let i = 0; i < 30; i++) sim.tick(SIM_DT, input, snap)
    expect(car.mode).toBe('track')
  })
})
