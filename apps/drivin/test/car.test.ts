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

describe('the happy glitch', () => {
  it('a near-vmax jump with the throttle held snaps speed back to vmax in the air', () => {
    const track = new Track(STUNT_PARK)
    const jump = track.lanes.find((l) => track.data.pieces[l.pieceIndex].type === 'jump')!
    const sim = new Sim(track, CARS[0], 0)
    const snap = new Snapshot()
    const input = makeInputFrame()
    input.throttle = 1
    // Start on the jump ramp at 90 % of vmax after "scrubbing" speed.
    sim.car.placeOn(jump, 2, CARS[0].topSpeed * 0.9)
    sim.car.speed = CARS[0].topSpeed * 0.9
    let airSpeed = 0
    for (let i = 0; i < 120 * 3; i++) {
      sim.tick(SIM_DT, input, snap)
      if (sim.car.mode === 'air') airSpeed = Math.max(airSpeed, Math.hypot(sim.car.vel.x, sim.car.vel.z))
    }
    expect(airSpeed).toBeGreaterThan(CARS[0].topSpeed * 0.99)
  })
  it('does nothing if you lift off the throttle', () => {
    const track = new Track(STUNT_PARK)
    const jump = track.lanes.find((l) => track.data.pieces[l.pieceIndex].type === 'jump')!
    const sim = new Sim(track, CARS[0], 0)
    const snap = new Snapshot()
    const input = makeInputFrame()
    sim.car.placeOn(jump, 2, CARS[0].topSpeed * 0.9)
    let airSpeed = 0
    for (let i = 0; i < 120 * 3; i++) {
      input.throttle = sim.car.mode === 'air' ? 0 : 1
      sim.tick(SIM_DT, input, snap)
      if (sim.car.mode === 'air') airSpeed = Math.max(airSpeed, Math.hypot(sim.car.vel.x, sim.car.vel.z))
    }
    expect(airSpeed).toBeLessThan(CARS[0].topSpeed * 0.97)
  })
})

describe('free roaming', () => {
  it('lets you drive off into the grass indefinitely without being reset', () => {
    const sim = new Sim(new Track(OVAL), CARS[0], 0)
    const snap = new Snapshot()
    const input = makeInputFrame()
    input.throttle = 1
    const events: string[] = []
    for (let i = 0; i < 120 * 30; i++) {
      // Hard right for two seconds to leave the road, then straight on into the distance.
      input.steer = i < 240 ? 1 : 0
      sim.tick(SIM_DT, input, snap)
      sim.events.drain((e) => events.push(e.type))
    }
    expect(events).not.toContain('respawn')
    expect(sim.car.mode).toBe('ground')
    // Far from every lane, still driving.
    let minD = Infinity
    for (const l of sim.track.lanes) minD = Math.min(minD, Math.hypot(sim.car.pos.x - (l.table.minX + l.table.maxX) / 2, sim.car.pos.z - (l.table.minZ + l.table.maxZ) / 2))
    expect(minD).toBeGreaterThan(60)
  })
  it('penalises a lap that skipped segments instead of refusing it', () => {
    const track = new Track(OVAL)
    const sim = new Sim(track, CARS[0], 0)
    const snap = new Snapshot()
    const input = makeInputFrame()
    // Teleport-free shortcut: hop the car onto the last lane before the start, having visited nothing else.
    const last = track.lanes.find((l) => l.next.includes(track.startLane!))!
    sim.car.placeOn(last, 2, 8)
    input.throttle = 0.4
    const events: { type: string; a: number }[] = []
    for (let i = 0; i < 120 * 10; i++) {
      sim.tick(SIM_DT, input, snap)
      sim.events.drain((e) => events.push({ type: e.type, a: e.a }))
    }
    const pen = events.find((e) => e.type === 'penalty')
    expect(events.some((e) => e.type === 'lap')).toBe(true)
    expect(pen && pen.a).toBeGreaterThan(5)
  })
})
