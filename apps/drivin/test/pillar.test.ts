// Reported as "I crash into a pillar that I don't see", twice, on flat grass beside a link road.
//
// The sim measured how high the road stood by comparing its surface with y = 0, and the renderer
// compared it with the landscape underneath. On a track at sea level those agree. Rich 2's ground
// there is two metres up, so a link road lying flat on it was elevated as far as the sim was
// concerned: it put pillars under it, the renderer drew none, and the car hit one.

import { describe, expect, it } from 'vitest'
import { CARS } from '../src/sim/CarSpec'
import { makeInputFrame } from '../src/sim/InputFrame'
import { makeLaneFrame } from '../src/sim/PathTable'
import { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import { Track } from '../src/sim/Track'
import { pillarHeight } from '../src/sim/pillars'
import { RICH2 } from '../src/sim/tracks/rich2'
import { PILLAR_SIDE, PILLAR_SPACING, SIM_DT } from '../src/sim/Tuning'

function parked(track: Track, x: number, z: number): { sim: Sim; car: { probeBlocking(): string; pos: { x: number; z: number }; speed: number } } {
  const sim = new Sim(track, CARS[0], 0)
  const car = sim.car as unknown as { mode: string; onGrass: boolean; yaw: number; speed: number; pos: { set(x: number, y: number, z: number): void }; forward: { set(x: number, y: number, z: number): void } }
  car.mode = 'ground'
  car.onGrass = true
  car.pos.set(x, track.groundHeight(x, z) + 0.35, z)
  car.yaw = 0
  car.forward.set(1, 0, 0)
  car.speed = 0
  return { sim, car: sim.car as never }
}

describe('pillars', () => {
  it('are not in the way of road that is lying on a hillside', () => {
    const track = new Track(RICH2)
    // The three positions from the report.
    for (const [x, z] of [
      [978.29, 1493.04],
      [978.18, 1493.33],
      [880.72, 1528.92],
    ]) {
      expect(parked(track, x, z).car.probeBlocking()).toBe('')
    }
  })

  it('are still there under road that really is up in the air', () => {
    const track = new Track(RICH2)
    const f = makeLaneFrame()
    // Find a station with a pillar under it, by the rule both the sim and the renderer now use.
    let found: { x: number; z: number } | null = null
    for (const lane of track.lanes) {
      for (let s = PILLAR_SPACING / 2; s < lane.table.length && !found; s += PILLAR_SPACING) {
        lane.table.frameAt(s, f)
        if (pillarHeight(f.pos.y, track.groundHeight(f.pos.x, f.pos.z), f.up.y, f.surface) <= 0) continue
        found = { x: f.pos.x + f.right.x * PILLAR_SIDE, z: f.pos.z + f.right.z * PILLAR_SIDE }
      }
      if (found) break
    }
    expect(found).not.toBeNull()
    expect(parked(track, found!.x, found!.z).car.probeBlocking()).toContain('pillar')
  })

  it('let a car that is standing inside one drive back out', () => {
    const track = new Track(RICH2)
    const f = makeLaneFrame()
    let at: { x: number; z: number } | null = null
    for (const lane of track.lanes) {
      for (let s = PILLAR_SPACING / 2; s < lane.table.length && !at; s += PILLAR_SPACING) {
        lane.table.frameAt(s, f)
        if (pillarHeight(f.pos.y, track.groundHeight(f.pos.x, f.pos.z), f.up.y, f.surface) <= 0) continue
        at = { x: f.pos.x + f.right.x * PILLAR_SIDE, z: f.pos.z + f.right.z * PILLAR_SIDE }
      }
      if (at) break
    }
    const { sim, car } = parked(track, at!.x, at!.z)
    const from = { x: car.pos.x, z: car.pos.z }
    const input = makeInputFrame()
    input.throttle = 1
    const snap = new Snapshot()
    for (let i = 0; i < 120; i++) sim.tick(SIM_DT, input, snap)
    // Held in place it could never leave: every tick it was still inside, so every tick it stopped.
    // Out from under it is enough — the pair's other pillar is six metres away and may well stop it.
    expect(Math.hypot(car.pos.x - from.x, car.pos.z - from.z)).toBeGreaterThan(2.5)
  })
})
