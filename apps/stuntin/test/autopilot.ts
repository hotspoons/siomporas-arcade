// Test driver: steers toward the centreline and brakes for curvature ahead,
// looking across lane boundaries so it slows before a corner, not in it.

import { makeInputFrame } from '../src/sim/InputFrame'
import { makeLaneFrame } from '../src/sim/PathTable'
import type { Sim } from '../src/sim/Sim'
import { Snapshot } from '../src/sim/Snapshot'
import type { Lane } from '../src/sim/Track'
import { GRIP_LATERAL, SIM_DT } from '../src/sim/Tuning'

const f = makeLaneFrame()

/** Slowest corner speed within `ahead` metres along the main line. */
export function cornerTarget(lane: Lane, s: number, ahead = 90, gripFraction = 0.8): number {
  let target = 999
  let l: Lane | undefined = lane
  let offset = s
  let travelled = 0
  while (l && travelled < ahead) {
    for (let d = offset; d <= l.table.length && travelled + (d - offset) < ahead; d += 8) {
      l.table.frameAt(d, f)
      const k = Math.abs(f.kRight)
      if (k > 1e-4) target = Math.min(target, Math.sqrt((gripFraction * GRIP_LATERAL) / k))
    }
    travelled += l.table.length - offset
    offset = 0
    l = l.next[0]
  }
  return target
}

export function autopilot(sim: Sim, seconds: number, throttle = 1, onEvent?: (t: string) => void): Snapshot {
  const snap = new Snapshot()
  const input = makeInputFrame()
  for (let i = 0; i < seconds * 120; i++) {
    const c = sim.car
    const target = c.mode === 'track' && c.lane ? cornerTarget(c.lane, c.s) : 999
    input.throttle = c.speed < target ? throttle : 0
    input.brake = c.speed > target + 1 ? 1 : 0
    input.steer = c.mode === 'track' ? Math.max(-1, Math.min(1, -c.lateral * 0.4 - c.lateralVel * 0.15)) : 0
    sim.tick(SIM_DT, input, snap)
    sim.events.drain((e) => onEvent?.(e.type))
  }
  return snap
}
