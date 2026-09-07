import { describe, expect, it } from 'vitest'
import { CARS } from '../src/sim/CarSpec'
import { makeInputFrame } from '../src/sim/InputFrame'
import { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import { Track } from '../src/sim/Track'
import { SIM_DT } from '../src/sim/Tuning'
import { autopilot } from './autopilot'
import { OVAL, STUNT_PARK } from '../src/sim/tracks'

describe('Car on the oval', () => {
  it('completes laps at full throttle with an autopilot and never crashes', () => {
    const sim = new Sim(new Track(OVAL), CARS[0], 0)
    const events: string[] = []
    const snap = autopilot(sim, 60, 1, (t) => events.push(t))
    expect(events.filter((e) => e === 'crash')).toEqual([])
    expect(snap.hud.laps).toBeGreaterThanOrEqual(2)
    expect(snap.hud.bestLap).toBeGreaterThan(5)
  })
  it('is deterministic', () => {
    const a = autopilot(new Sim(new Track(OVAL), CARS[0], 0), 20)
    const b = autopilot(new Sim(new Track(OVAL), CARS[0], 0), 20)
    expect(a.car.pos.x).toBe(b.car.pos.x)
    expect(a.hud.lapTime).toBe(b.hud.lapTime)
  })
})

describe('Stunt park', () => {
  it('a fast car clears the loop, the jump and the corkscrew and laps', () => {
    const sim = new Sim(new Track(STUNT_PARK), CARS[0], 0)
    const events: string[] = []
    const snap = autopilot(sim, 90, 1, (t) => events.push(t))
    expect(snap.hud.laps).toBeGreaterThanOrEqual(1)
    expect(events).toContain('launch') // the jump
    expect(events).toContain('land')
    expect(events.filter((e) => e === 'crash').length).toBe(0)
  })
  it('a car that crawls into the loop falls off and the replay runs', () => {
    const sim = new Sim(new Track(STUNT_PARK), CARS[0], 0)
    const events: string[] = []
    // Enough throttle to reach the loop, far too little to get round.
    const snap = new Snapshot()
    const input = makeInputFrame()
    for (let i = 0; i < 40 * 120; i++) {
      input.throttle = sim.car.speed < 11 ? 1 : 0
      input.steer = sim.car.mode === 'track' ? -sim.car.lateral * 0.4 : 0
      sim.tick(SIM_DT, input, snap)
      sim.events.drain((e) => events.push(e.type))
    }
    expect(events).toContain('launch')
    expect(events.some((e) => e === 'crash' || e === 'land')).toBe(true)
    if (events.includes('crash')) expect(events).toContain('respawn')
  })
})
