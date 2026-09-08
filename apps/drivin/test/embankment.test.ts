import { describe, expect, it } from 'vitest'
import { CARS } from '../src/sim/CarSpec'
import { makeInputFrame } from '../src/sim/InputFrame'
import { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import { Track, type TrackData } from '../src/sim/Track'
import { SIM_DT } from '../src/sim/Tuning'

/** A banked sweeper with open grass around it. */
const BANKED: TrackData = {
  name: 'Bank',
  size: 12,
  pieces: [
    { type: 'start', x: 1, z: 5, rot: 0, level: 0 },
    { type: 'straight', x: 2, z: 5, rot: 0, level: 0 },
    // Ports on the west edge of its own first cell and the north edge of its far corner.
    { type: 'bank2', x: 3, z: 5, rot: 0, level: 0 },
  ],
}

/** Drive across the grass from a start point and report what, if anything, the car hits. */
function driveBy(x: number, z: number, headingZ: number): string[] {
  const sim = new Sim(new Track(BANKED), CARS[0], 0)
  const car = sim.car as unknown as { mode: string; pos: { set(x: number, y: number, z: number): void }; yaw: number; forward: { set(x: number, y: number, z: number): void }; speed: number; onGrass: boolean }
  car.mode = 'ground'
  car.pos.set(x, 0.35, z)
  car.yaw = headingZ > 0 ? 0 : Math.PI
  car.forward.set(headingZ > 0 ? 1 : -1, 0, 0)
  car.speed = 25
  car.onGrass = true
  const input = makeInputFrame()
  input.throttle = 1
  const snap = new Snapshot()
  const events: string[] = []
  for (let i = 0; i < 60 * 5; i++) {
    sim.tick(SIM_DT, input, snap)
    sim.events.drain((e) => events.push(e.type))
  }
  return events
}

describe('driving past an embankment on the grass', () => {
  it('does not crash into a bank that is thirty feet away', () => {
    // The lateral offset is measured in the deck's own plane, which leans out over the grass; a car on
    // the flat well clear of the structure used to be crashed into it.
    const events = driveBy(60, 380, 1)
    expect(events).not.toContain('crash')
    expect(events).not.toContain('bump')
  })

  it('still stops the car that drives into the deck where it stands at car height', () => {
    const t = new Track(BANKED)
    const lane = t.lanes.find((l) => t.data.pieces[l.pieceIndex].type === 'bank2')
    expect(lane).toBeDefined()
    const table = lane!.table
    // The deck climbs as it banks: find where its surface is about a metre up, which is the height a
    // car runs into, and drive at that spot from the side.
    let best = 0
    for (let i = 0; i < table.pos.length; i += 3) if (Math.abs(table.pos[i + 1] - 1) < Math.abs(table.pos[best + 1] - 1)) best = i
    expect(Math.abs(table.pos[best + 1] - 1)).toBeLessThan(0.4)
    const events = driveBy(table.pos[best] - 10, table.pos[best + 2], 1)
    expect(events.some((e) => e === 'crash' || e === 'bump')).toBe(true)
  })
})
