import { describe, expect, it } from 'vitest'
import { CARS } from '../src/sim/CarSpec'
import { makeInputFrame } from '../src/sim/InputFrame'
import { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import { Track, type TrackData } from '../src/sim/Track'
import { CELL, RECOVER_BACK, SIM_DT } from '../src/sim/Tuning'

/** A straight with a building beside it, to get wedged under. */
const WITH_BUILDING: TrackData = {
  name: 'Building',
  size: 10,
  pieces: [
    { type: 'start', x: 1, z: 5, rot: 0, level: 0 },
    { type: 'straight', x: 2, z: 5, rot: 0, level: 0 },
    { type: 'straight', x: 3, z: 5, rot: 0, level: 0 },
    { type: 'building', x: 4, z: 3, rot: 0, level: 0 },
  ],
}

describe('the recover key', () => {
  it('backs the car up so it can get out from under a building', () => {
    const t = new Track(WITH_BUILDING)
    const solid = t.solids.find((s) => s.kind === 'wall')
    expect(solid).toBeDefined()
    const sim = new Sim(t, CARS[0], 0)
    const car = sim.car as unknown as { mode: string; pos: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }; forward: { set(x: number, y: number, z: number): void }; yaw: number; speed: number; onGrass: boolean }
    // Nose first into the middle of the building, facing it, stopped: exactly the wedge.
    car.mode = 'ground'
    car.pos.set(solid!.x, 0.35, solid!.z)
    car.yaw = 0
    car.forward.set(1, 0, 0)
    car.speed = 0
    car.onGrass = true
    const inside = (x: number, z: number) => Math.abs(x - solid!.x) < solid!.hw && Math.abs(z - solid!.z) < solid!.hh
    expect(inside(car.pos.x, car.pos.z)).toBe(true)

    const input = makeInputFrame()
    const snap = new Snapshot()
    input.reset = true
    sim.tick(SIM_DT, input, snap)
    expect(inside(car.pos.x, car.pos.z), 'still inside after one press').toBe(false)
    // It went backwards, not forwards, and by a useful amount.
    expect(car.pos.x).toBeLessThan(solid!.x - RECOVER_BACK * 0.5)
  })

  it('walks further back each press when the first one is not enough', () => {
    const t = new Track(WITH_BUILDING)
    const sim = new Sim(t, CARS[0], 0)
    const car = sim.car as unknown as { mode: string; pos: { x: number; z: number; set(x: number, y: number, z: number): void }; forward: { set(x: number, y: number, z: number): void }; yaw: number; speed: number; onGrass: boolean }
    car.mode = 'ground'
    car.pos.set(6 * CELL, 0.35, 2 * CELL)
    car.yaw = 0
    car.forward.set(1, 0, 0)
    car.speed = 0
    car.onGrass = true
    const input = makeInputFrame()
    const snap = new Snapshot()
    const start = car.pos.x
    input.reset = true
    sim.tick(SIM_DT, input, snap)
    const once = car.pos.x
    sim.tick(SIM_DT, input, snap)
    expect(start - once).toBeGreaterThan(RECOVER_BACK * 0.8)
    expect(once - car.pos.x).toBeGreaterThan(RECOVER_BACK * 0.8)
  })
})
