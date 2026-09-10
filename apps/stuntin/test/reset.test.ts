// Reset during a crash replay: the lap takes a penalty and the car restarts before the incident.
// (This used to be set up by crawling into a loop and falling off, which stopped crashing the car
// once the phantom-collision fixes landed — so it drives into something that is really there.)

import { expect, it } from 'vitest'
import { CARS } from '../src/sim/CarSpec'
import { makeInputFrame } from '../src/sim/InputFrame'
import { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import { Track } from '../src/sim/Track'
import { RICH2 } from '../src/sim/tracks/rich2'
import { RESET_PENALTY, SIM_DT } from '../src/sim/Tuning'

it('reset during the crash replay restarts before the incident for a penalty', () => {
  const track = new Track(RICH2)
  const wall = track.solids.find((s) => s.kind === 'wall')
  expect(wall).toBeDefined()
  const sim = new Sim(track, CARS[0], 0)
  const car = sim.car as unknown as { mode: string; onGrass: boolean; speed: number; yaw: number; pos: { set(x: number, y: number, z: number): void }; forward: { set(x: number, y: number, z: number): void } }
  const from = { x: wall!.x - wall!.hw - 30, z: wall!.z }
  car.mode = 'ground'
  car.onGrass = true
  car.pos.set(from.x, track.groundHeight(from.x, from.z) + 0.35, from.z)
  car.yaw = 0
  car.forward.set(1, 0, 0)
  car.speed = 45
  const inp = makeInputFrame()
  inp.throttle = 1
  const snap = new Snapshot()
  for (let i = 0; i < 240 && sim.phase !== 'replay'; i++) sim.tick(SIM_DT, inp, snap)
  expect(sim.phase).toBe('replay')
  const crashPos = { x: sim.car.pos.x, z: sim.car.pos.z }
  const lapBefore = sim.lapTime
  for (let i = 0; i < 30; i++) sim.tick(SIM_DT, inp, snap)
  inp.reset = true
  sim.tick(SIM_DT, inp, snap)
  inp.reset = false
  const drained: { t: string; a: number }[] = []
  sim.events.drain((e) => drained.push({ t: e.type, a: e.a }))
  expect(sim.phase).toBe('driving')
  expect(sim.car.speed).toBe(0)
  expect(sim.lapTime - lapBefore).toBeGreaterThan(RESET_PENALTY - 0.01)
  expect(Math.hypot(sim.car.pos.x - crashPos.x, sim.car.pos.z - crashPos.z)).toBeGreaterThan(5)
  expect(drained.some((d) => d.t === 'respawn' && d.a === 2)).toBe(true)
  // And it drives on from there.
  for (let i = 0; i < 240; i++) sim.tick(SIM_DT, inp, snap)
  expect(sim.car.speed).toBeGreaterThan(2)
})
