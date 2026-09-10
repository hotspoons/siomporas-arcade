import { describe, expect, it } from 'vitest'
import { CARS } from '../src/sim/CarSpec'
import { makeInputFrame } from '../src/sim/InputFrame'
import { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import { makeLaneFrame } from '../src/sim/PathTable'
import { Track, type TrackData } from '../src/sim/Track'
import { CURB_WIDTH, ROAD_HALF_WIDTH, SIM_DT } from '../src/sim/Tuning'

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
function driveBy(x: number, z: number, headingZ: number, headingX = headingZ): string[] {
  const sim = new Sim(new Track(BANKED), CARS[0], 0)
  const car = sim.car as unknown as { mode: string; pos: { set(x: number, y: number, z: number): void }; yaw: number; forward: { set(x: number, y: number, z: number): void }; speed: number; onGrass: boolean }
  car.mode = 'ground'
  car.pos.set(x, 0.35, z)
  car.yaw = headingX > 0 ? 0 : Math.PI
  car.forward.set(headingX > 0 ? 1 : -1, 0, 0)
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

  it('still stops the car that drives into the side of the bank where it stands as a wall', () => {
    const t = new Track(BANKED)
    const lane = t.lanes.find((l) => t.data.pieces[l.pieceIndex].type === 'bank2')
    expect(lane).toBeDefined()
    const table = lane!.table
    // A bank is drivable from its low side — that edge is on the ground and you climb it — so the
    // thing that has to stop a car is the side where the deck's *edge* stands well above the ground
    // beside it. Find the worst of those and drive at it.
    const edge = ROAD_HALF_WIDTH + CURB_WIDTH
    const f = makeLaneFrame()
    let wallY = 0
    let wallX = 0
    let wallZ = 0
    let wallSide = -1
    const samples = table.pos.length / 3
    for (let i = 0; i < samples; i++) {
      table.frameAt((i / (samples - 1)) * table.length, f)
      for (const side of [-1, 1]) {
        const ey = f.pos.y + side * edge * f.right.y
        const gx = f.pos.x + side * edge * f.right.x
        const gz = f.pos.z + side * edge * f.right.z
        const stands = ey - t.groundHeight(gx, gz)
        if (stands > wallY) {
          wallY = stands
          wallX = gx
          wallZ = gz
          // Which way is outwards from the deck here: that is the side to come at it from.
          wallSide = Math.sign(gx - f.pos.x) || 1
        }
      }
    }
    expect(wallY).toBeGreaterThan(2)
    const events = driveBy(wallX + wallSide * 12, wallZ, 1, -wallSide)
    expect(events.some((e) => e === 'crash' || e === 'bump')).toBe(true)
  })
})
