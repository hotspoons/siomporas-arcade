import { describe, expect, it } from 'vitest'
import { makeInputFrame } from '../src/sim/InputFrame'
import { Stage } from '../src/sim/Road'
import { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import { STAGES, STAGE_BY_ID, THEMES } from '../src/sim/Stages'
import { SIM_DT, TIME_START } from '../src/sim/Tuning'

describe('route tree', () => {
  it('every next id exists and every route is three stages long', () => {
    for (const s of STAGES) for (const n of s.next) expect(STAGE_BY_ID[n], `${s.id} → ${n}`).toBeDefined()
    const walk = (id: string, depth: number): number[] => {
      const s = STAGE_BY_ID[id]
      if (s.next.length === 0) return [depth]
      return s.next.flatMap((n) => walk(n, depth + 1))
    }
    for (const d of walk('A', 1)) expect(d).toBe(3)
  })
  it('builds stages with continuous curves and level ends', () => {
    for (const desc of STAGES) {
      const st = new Stage(desc, THEMES[desc.theme], 1)
      expect(st.length).toBeGreaterThan(500)
      const last = st.segments[st.length - 1]
      expect(Math.abs(last.y1)).toBeLessThan(0.5)
      for (let i = 1; i < st.length; i++) expect(Math.abs(st.segments[i].curve - st.segments[i - 1].curve)).toBeLessThan(0.6)
      if (st.forks) expect(st.segments[st.length - 1].fork).toBeCloseTo(1, 5)
    }
  })
})

/** Test driver: pick the widest gap among lane slots for the traffic just ahead, hold it against the curve. */
function autopilot(sim: Sim, snap: Snapshot): number {
  const seg = sim.stage.segmentAt(sim.z)
  const slots = [-0.72, -0.41, 0, 0.41, 0.72]
  let best = 0
  let bestScore = -Infinity
  for (const sx of slots) {
    let clear = 9
    for (let i = 0; i < snap.trafficCount; i++) {
      const dz = snap.trafficZ[i] - sim.z
      if (dz > -6 && dz < 130) clear = Math.min(clear, Math.abs(snap.trafficX[i] - sx))
    }
    const score = Math.min(clear, 0.6) * 10 - Math.abs(sx - sim.x) * 2 - Math.abs(sx) * 0.5
    if (score > bestScore) {
      bestScore = score
      best = sx
    }
  }
  return Math.max(-1, Math.min(1, (best - sim.x) * 3 + seg.curve * 0.15 * (sim.speed / 84) ** 2))
}

function run(seconds: number, steer: (s: Sim, snap: Snapshot) => number, throttle = 1, seed = 3) {
  const sim = new Sim(seed)
  const snap = new Snapshot()
  const input = makeInputFrame()
  const events: string[] = []
  for (let i = 0; i < seconds * 120; i++) {
    input.throttle = throttle
    input.steer = steer(sim, snap)
    sim.tick(SIM_DT, input, snap)
    sim.events.drain((e) => events.push(e.type))
  }
  return { sim, snap, events }
}

describe('Sim', () => {
  it('is deterministic', () => {
    const a = run(20, autopilot)
    const b = run(20, autopilot)
    expect(a.snap.z).toBe(b.snap.z)
    expect(a.snap.hud.score).toBe(b.snap.hud.score)
  })
  it('reaches a checkpoint on the centre line and gains time', () => {
    // Steer to stay on the road and dodge nothing fancy: hold the centre.
    const { snap, events, sim } = run(200, autopilot)
    expect(events).toContain('checkpoint')
    expect(sim.stageIndex).toBeGreaterThanOrEqual(1)
    expect(snap.hud.time).toBeGreaterThan(0)
  })
  it('times out when parked', () => {
    const { snap, events } = run(TIME_START + 2, () => 0, 0)
    expect(snap.phase).toBe('timeout')
    expect(events).toContain('timeout')
  })
  it('tumbles when driving into the scenery at speed', () => {
    const { events } = run(30, () => 1) // hard right off the road
    expect(events.some((e) => e === 'crash' || e === 'bump')).toBe(true)
  })
})

describe('full run', () => {
  it('drives all three stages to the finish with the autopilot', () => {
    const { snap, events } = run(420, autopilot)
    expect(events.filter((e) => e === 'checkpoint').length).toBe(2)
    expect(events).toContain('fork')
    expect(snap.phase).toBe('finished')
    expect(snap.hud.route.split(' › ').length).toBe(3)
  })
})
