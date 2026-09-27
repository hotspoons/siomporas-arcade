// Does traffic behave like traffic, without anybody scripting it?
//
// The whole argument for using the Intelligent Driver Model rather than writing rules is that the
// behaviour is EMERGENT: nobody writes a queue, a shock wave or a platoon. So the tests ask for
// those, not for the formula — a test that checks the arithmetic of `idm()` proves I typed it in
// correctly and nothing about whether a road works.
import { describe, expect, it } from 'vitest'
import { addComponent, addEntity, query } from 'bitecs'
import { OnRoad, Transform, Vehicle, Velocity } from '../src/actors'
import { ActorWorld, STEP_S, spawnVehicle } from '../src/actorworld'
import { Driver, JamGap, SpeedLimit, driveSystem, idm, makeDriver, rng } from '../src/traffic'
import { DUMB, GREEN, RED, SignalGroup, SignalHead, SignalPrograms, buildSignals, sameAxis, signalSystem, type SignalProgram } from '../src/signals-ecs'

/** a straight road with one signal on it, and `n` cars queued back from the stop line */
function road(n: number, opts: { obeyRate?: number; seed?: number } = {}) {
  const aw = new ActorWorld()
  const w = aw.world
  const programs = new SignalPrograms()
  const { groups, heads } = buildSignals(w, [{ x: 0, y: 200, yaw_deg: 180, travel_deg: 0, lanes: 2, junction: 1 }], programs)
  const rand = rng(opts.seed ?? 7)
  const cars: number[] = []
  for (let i = 0; i < n; i++) {
    const e = spawnVehicle(aw, { x: 0, y: 100 - i * 9, yaw: 0 })
    addComponent(w, e, OnRoad)
    OnRoad.chain[e] = 1
    OnRoad.s[e] = 100 - i * 9
    OnRoad.lane[e] = 0
    OnRoad.dir[e] = 1
    makeDriver(w, e, rand, opts)
    SpeedLimit.v[e] = 15
    Vehicle.speed[e] = 15
    cars.push(e)
  }
  aw.add('signals', signalSystem(programs)).add('drive', driveSystem({ heads }))
  return { aw, w, programs, groups, heads, cars }
}

/** keep a car's plan position and its world position in step, which the real world does elsewhere */
function project(w: ReturnType<typeof road>) {
  for (const e of w.cars) Transform.y[e] = OnRoad.s[e]
}

describe('the model', () => {
  it('accelerates toward the limit on an empty road and does not pass it', () => {
    let v = 0
    for (let i = 0; i < 2000; i++) v = Math.max(0, v + idm(v, 15, Infinity, 0, 1.4, 2, 2, 1.2) * STEP_S)
    expect(v).toBeGreaterThan(14.8)
    expect(v).toBeLessThanOrEqual(15.01)
  })

  it('brakes harder the closer and faster it closes', () => {
    const far = idm(15, 15, 60, 5, 1.4, 2, 2, 1.2)
    const near = idm(15, 15, 12, 5, 1.4, 2, 2, 1.2)
    const closing = idm(15, 15, 12, 12, 1.4, 2, 2, 1.2)
    expect(near).toBeLessThan(far)
    expect(closing).toBeLessThan(near)
  })

  it('the same seed populates the same road twice', () => {
    const a = road(20, { seed: 42 })
    const b = road(20, { seed: 42 })
    expect(a.cars.map((e) => Driver.speedFactor[e])).toEqual(b.cars.map((e) => Driver.speedFactor[e]))
  })
})

describe('a red light makes a queue, and nobody wrote one', () => {
  it('cars stop at the line and stack up behind each other', () => {
    const w = road(12)
    // hold the group on the phase this approach does NOT have
    SignalGroup.t[w.groups[0]] = 30 // into phase 1's green; our head is phase 0, so red
    for (let i = 0; i < 1200; i++) {
      w.aw.tick(STEP_S)
      project(w)
      SignalGroup.t[w.groups[0]] = 30 // pin it red
    }
    expect(SignalHead.state[w.heads[0]]).toBe(RED)

    // sorted by position, front of the queue first
    const q = w.cars.map((e) => ({ s: OnRoad.s[e], v: Vehicle.speed[e] })).sort((a, b) => b.s - a.s)

    // the front is AT the line and not through it
    expect(q[0].s).toBeGreaterThan(185)
    expect(q[0].s).toBeLessThanOrEqual(194)

    // the queue is ORDERED and SPACED: nobody is inside anybody
    for (let i = 1; i < q.length; i++) expect(q[i - 1].s - q[i].s).toBeGreaterThan(2)

    /*
     * AND THE SHOCK WAVE, which is the thing worth asserting and which my first version of this
     * test missed entirely by asking "are eight cars stopped". After 24 seconds the front six ARE
     * stopped and the back six are still arriving at 0.07, 0.76, 1.61, 3.0, 4.8 and 6.1 m/s — a
     * monotonic gradient running backwards from the stop line. That gradient IS the wave, it is
     * emergent from the model rather than written anywhere, and it is the whole reason for using
     * IDM instead of rules.
     */
    expect(q[0].v).toBe(0)
    for (let i = 1; i < q.length; i++) expect(q[i].v).toBeGreaterThanOrEqual(q[i - 1].v - 1e-6)
    expect(q[q.length - 1].v).toBeGreaterThan(q[0].v) // the back is still moving

    // given long enough, all of it settles
    for (let i = 0; i < 3000; i++) { w.aw.tick(STEP_S); project(w); SignalGroup.t[w.groups[0]] = 30 }
    expect(w.cars.every((e) => Vehicle.speed[e] < 0.1)).toBe(true)
  })

  it('and discharges on green as a platoon', () => {
    const w = road(12)
    SignalGroup.t[w.groups[0]] = 30
    for (let i = 0; i < 1200; i++) { w.aw.tick(STEP_S); project(w); SignalGroup.t[w.groups[0]] = 30 }
    const before = w.cars.map((e) => OnRoad.s[e])
    // green for this approach
    for (let i = 0; i < 600; i++) { w.aw.tick(STEP_S); project(w); SignalGroup.t[w.groups[0]] = 1 }
    expect(SignalHead.state[w.heads[0]]).toBe(GREEN)
    const after = w.cars.map((e) => OnRoad.s[e])
    const moved = after.filter((s, i) => s - before[i] > 5).length
    expect(moved).toBeGreaterThan(8)
    // the front goes first: a platoon, not everyone at once
    expect(after[0] - before[0]).toBeGreaterThan(after[11] - before[11])
  })
})

describe('most people obey, some do not', () => {
  it('a compliant driver stops and a non-compliant one goes through', () => {
    for (const obeyRate of [1, 0]) {
      const w = road(1, { obeyRate })
      SignalGroup.t[w.groups[0]] = 30 // red for us
      for (let i = 0; i < 900; i++) { w.aw.tick(STEP_S); project(w); SignalGroup.t[w.groups[0]] = 30 }
      const s = OnRoad.s[w.cars[0]]
      if (obeyRate === 1) expect(s).toBeLessThan(200) // stopped at the line
      else expect(s).toBeGreaterThan(210) // straight through it
    }
  })

  it('the population is mostly compliant', () => {
    const w = road(400, { obeyRate: 0.97, seed: 3 })
    const runners = w.cars.filter((e) => Driver.compliance[e] === 0).length
    expect(runners).toBeGreaterThan(2) // some
    expect(runners).toBeLessThan(60) // most people obey
  })

  it('a driver who decides to run it does not dither', () => {
    const w = road(1, { obeyRate: 0 })
    SignalGroup.t[w.groups[0]] = 30
    let flips = 0
    let was = Driver.running[w.cars[0]]
    for (let i = 0; i < 600; i++) {
      w.aw.tick(STEP_S)
      project(w)
      SignalGroup.t[w.groups[0]] = 30
      if (Driver.running[w.cars[0]] !== was) { flips++; was = Driver.running[w.cars[0]] }
    }
    expect(flips).toBeLessThanOrEqual(1) // decided once, then held
  })
})

describe('the controller', () => {
  it('two approaches on the same road share a phase; a crossing one does not', () => {
    expect(sameAxis(0, 180)).toBe(true) // northbound and southbound
    expect(sameAxis(0, 10)).toBe(true)
    expect(sameAxis(0, 90)).toBe(false) // the crossing street
  })

  it('a junction is green for exactly one phase at a time', () => {
    const aw = new ActorWorld()
    const programs = new SignalPrograms()
    const { heads } = buildSignals(aw.world, [
      { x: 0, y: 0, yaw_deg: 180, travel_deg: 0, lanes: 2, junction: 4 },
      { x: 0, y: 0, yaw_deg: 0, travel_deg: 180, lanes: 2, junction: 4 },
      { x: 0, y: 0, yaw_deg: 270, travel_deg: 90, lanes: 2, junction: 4 },
      { x: 0, y: 0, yaw_deg: 90, travel_deg: 270, lanes: 2, junction: 4 },
    ], programs)
    aw.add('signals', signalSystem(programs))
    const seen = new Set<string>()
    for (let i = 0; i < 4000; i++) {
      aw.tick(STEP_S)
      const greens = heads.filter((h) => SignalHead.state[h] === GREEN)
      // the two that share an axis go together, or nobody does — never a crossing pair
      if (greens.length === 2) {
        const [a, b] = greens
        expect(sameAxis(SignalHead.bearing[a], SignalHead.bearing[b])).toBe(true)
      }
      expect(greens.length === 0 || greens.length === 2).toBe(true)
      seen.add(greens.map((h) => SignalHead.phase[h]).join(','))
    }
    expect(seen.size).toBeGreaterThan(1) // it actually cycles
  })

  it('a programmed junction is opt in, and the default is the dumb one', () => {
    const aw = new ActorWorld()
    const programs = new SignalPrograms()
    const { groups } = buildSignals(aw.world, [{ x: 0, y: 0, yaw_deg: 180, travel_deg: 0, lanes: 2, junction: 1 }], programs)
    expect(SignalGroup.program[groups[0]]).toBe(0)
    expect(programs.at(0)).toBe(DUMB)

    // what a county would run on an arterial: a long main phase, a short actuated side street
    const arterial: SignalProgram = {
      id: 'md3-arterial',
      cycleS: 120,
      offsetS: 18,
      phases: [
        { name: 'MD 3 through', minGreenS: 35, maxGreenS: 78, yellowS: 4.5, allRedS: 2 },
        { name: 'side street', minGreenS: 7, maxGreenS: 28, yellowS: 4, allRedS: 2, actuated: true },
      ],
    }
    const i = programs.add(arterial)
    expect(i).toBe(1)
    SignalGroup.program[groups[0]] = i
    SignalGroup.cycleS[groups[0]] = 120
    SignalGroup.offsetS[groups[0]] = 18
    expect(programs.at(SignalGroup.program[groups[0]]).id).toBe('md3-arterial')
    // and registering the same id again replaces rather than duplicates
    expect(programs.add({ ...arterial, offsetS: 22 })).toBe(1)
    expect(programs.count).toBe(2)
  })

  it('coordination is arithmetic: two junctions on one cycle with an offset stay in step', () => {
    const aw = new ActorWorld()
    const programs = new SignalPrograms()
    const corridor: SignalProgram = { id: 'corridor', cycleS: 60, phases: [{ name: 'a', minGreenS: 25, maxGreenS: 25, yellowS: 4, allRedS: 1 }, { name: 'b', minGreenS: 25, maxGreenS: 25, yellowS: 4, allRedS: 1 }] }
    const p = programs.add(corridor)
    const a = buildSignals(aw.world, [{ x: 0, y: 0, yaw_deg: 180, travel_deg: 0, lanes: 2, junction: 1 }], programs)
    const b = buildSignals(aw.world, [{ x: 600, y: 0, yaw_deg: 180, travel_deg: 0, lanes: 2, junction: 1 }], programs)
    for (const g of [...a.groups, ...b.groups]) { SignalGroup.program[g] = p; SignalGroup.cycleS[g] = 60 }
    SignalGroup.offsetS[b.groups[0]] = 20 // a platoon takes 20 s to travel between them
    aw.add('signals', signalSystem(programs))

    // the downstream junction's green should begin 20 s after the upstream one's, every cycle
    let upstreamGreenAt = -1
    let downstreamGreenAt = -1
    for (let i = 0; i < 3000; i++) {
      const prevA = SignalHead.state[a.heads[0]]
      const prevB = SignalHead.state[b.heads[0]]
      aw.tick(STEP_S)
      const t = i * STEP_S
      if (prevA !== GREEN && SignalHead.state[a.heads[0]] === GREEN && upstreamGreenAt < 0) upstreamGreenAt = t
      if (prevB !== GREEN && SignalHead.state[b.heads[0]] === GREEN && upstreamGreenAt >= 0 && downstreamGreenAt < 0) downstreamGreenAt = t
    }
    expect(upstreamGreenAt).toBeGreaterThanOrEqual(0)
    expect(downstreamGreenAt).toBeGreaterThan(upstreamGreenAt)
    expect(downstreamGreenAt - upstreamGreenAt).toBeCloseTo(20, 0)
  })
})
