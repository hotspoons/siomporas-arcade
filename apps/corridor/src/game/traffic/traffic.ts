// Traffic: the Intelligent Driver Model, a personality per driver, and what they do at a red.
//
// Rich, 2026-09-27: "if there are models we can use to approximate traffic in certain settings and
// model them with stop lights and speed limits and all that, that would be awesome... have some
// people who ignore, most people will obey."
//
// THE MODEL IS NOT OURS AND SHOULD NOT BE. The Intelligent Driver Model (Treiber, Hennecke &
// Helbing, 2000) is four decades of traffic engineering in about twenty lines, and the thing that
// makes it worth using is that the behaviour Rich wants is EMERGENT rather than scripted: give a
// hundred IDM drivers a light that turns red and the queue, the shock wave that runs backwards
// through it, and the platoon that leaves on green all happen by themselves. Nobody writes a jam.
//
//   a = A * [ 1 - (v/v0)^delta - (s*(v, dv) / s)^2 ]
//   s*(v, dv) = s0 + v*T + v*dv / (2*sqrt(A*B))
//
// `v0` desired speed, `T` headway, `s0` jam distance, `A` acceleration, `B` comfortable braking.
// The free-road term and the interaction term, and the whole of car-following is in the second.
//
// THE ONE TRICK WORTH KNOWING: a red light is a STATIONARY CAR at the stop line. That is all. IDM
// then queues, decelerates smoothly, creeps, and discharges on green with no special case anywhere
// — and a driver who ignores the red simply does not get the virtual leader.

import { addComponent, hasComponent, query, type World } from 'bitecs'
import { MAX_ACTORS, OnRoad, Transform, Vehicle, Velocity } from '../actors/actors'
import { Demand, GREEN, RED, SignalHead, YELLOW, headFor } from './signals-ecs'

const f32 = () => new Float32Array(MAX_ACTORS)
const u8 = () => new Uint8Array(MAX_ACTORS)
const u32 = () => new Uint32Array(MAX_ACTORS)

/* ---- who is driving -------------------------------------------------------------------------- */

/**
 * A driver's personality. Drawn from a seed so the same road is populated the same way twice, and
 * one of them is always the person doing 38 in a 50.
 *
 * `compliance` is the one Rich asked for by name: the probability this driver stops for a light
 * they could run. MOST PEOPLE OBEY — the default population is 97% — and the ones who do not are
 * what makes a junction feel unsafe rather than mechanical. It is a property of the PERSON and not
 * of the moment, so the same driver runs reds all session, which is how you learn to distrust the
 * blue van.
 */
export const Driver = {
  /** desired speed as a fraction of the limit: 0.8 is the slow one, 1.2 is the impatient one */
  speedFactor: f32(),
  /** safe time headway, seconds. 1.0 is tight, 2.0 is cautious. */
  headwayS: f32(),
  /** comfortable acceleration and braking, m/s^2 */
  accelA: f32(),
  brakeB: f32(),
  /** 0..1, the chance of stopping for a light that is red or about to be */
  compliance: f32(),
  /** 1 while this driver has decided to run the current light, so they do not dither mid-junction */
  running: u8(),
  /** what the driver saw on the last step: the gap to whatever it is following, m (Infinity: nothing) */
  gap: f32(),
  /** …and which entity that was, plus one (0: nothing, or a light or the player) */
  leader: u32(),
}

/** The speed limit in force where this vehicle is, m/s. Set by the road, read by the model. */
export const SpeedLimit = { v: f32() }

/** Minimum bumper-to-bumper gap, metres. Part of the model, kept per vehicle so trucks differ. */
export const JamGap = { s0: f32() }

/* ---- the model ------------------------------------------------------------------------------- */

/** IDM acceleration for one vehicle. `gap` and `dv` describe the leader; Infinity means free road. */
export function idm(v: number, v0: number, gap: number, dv: number, a: number, b: number, s0: number, T: number): number {
  const free = 1 - (v / Math.max(0.1, v0)) ** 4
  if (!Number.isFinite(gap)) return a * free
  // desired dynamic distance: standing gap, the headway you keep, and the closing-speed term that
  // is the whole reason this brakes like a person rather than like a spring
  const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)))
  const interaction = (sStar / Math.max(0.5, gap)) ** 2
  return a * (free - interaction)
}

/** A seeded generator, so a populated world is the same world twice. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 1e6) / 1e6
  }
}

/**
 * Give a vehicle a driver. `compliance` defaults to a population where most people obey.
 *
 * The 3% is not a guess dressed as data — it is a dial, and it is here rather than buried so a
 * level can say "this is the bad part of town" by moving one number.
 */
export function makeDriver(world: World, e: number, rand: () => number, opts: { obeyRate?: number } = {}) {
  addComponent(world, e, Driver)
  addComponent(world, e, SpeedLimit)
  addComponent(world, e, JamGap)
  Driver.speedFactor[e] = 0.82 + rand() * 0.42 // 0.82 to 1.24 of the limit
  Driver.headwayS[e] = 0.9 + rand() * 1.1
  Driver.accelA[e] = 0.9 + rand() * 1.1
  Driver.brakeB[e] = 1.6 + rand() * 1.4
  Driver.compliance[e] = rand() < (opts.obeyRate ?? 0.97) ? 1 : 0
  Driver.running[e] = 0
  SpeedLimit.v[e] = 13.4 // 30 mph until a road says otherwise
  JamGap.s0[e] = 2 + rand() * 1.5
}

/* ---- the systems ----------------------------------------------------------------------------- */

export interface TrafficOpts {
  /** every signal head in the world, for the stop-line lookup */
  heads: number[]
  /** how close a driver looks for a light governing them */
  lookM?: number
  /**
   * Something on the road that is not in the ECS — the PLAYER. Given a car's position and heading,
   * the gap to it along the car's own lane and the closing speed, or null when it is not in the
   * way. Without this the traffic drove straight through the player, and a player in a jam was
   * pinned between cars that could not see him (Rich, 2026-09-30: "my car is stuck in place").
   */
  obstacle?: (x: number, y: number, yaw: number, speed: number) => { gap: number; dv: number } | null
  /** when it says so, nobody sees anybody: no leader, no light, no player. A game mode, and a joke */
  blind?: () => boolean
}

/**
 * Longitudinal control: every autonomous vehicle picks an acceleration and applies it.
 *
 * The leader is whatever is closest ahead — another vehicle, or the virtual stationary car a red
 * light puts at the stop line. Which of those it is does not matter to the model, and that is the
 * point of the trick.
 */
export function driveSystem(opts: TrafficOpts) {
  const look = opts.lookM ?? 70
  return (world: World, dt: number) => {
    // EVERY car on a road, not only the driven ones: a wreck has lost its `Driver` and is still
    // in the lane, and a driver who cannot see it drives into it — Rich watched a jam pile up on
    // Route 3 one wreck at a time. A wreck that left the road sits on a chain nobody drives
    // (`OFF_ROAD` in trafficlayer.ts), so it is nobody's leader.
    const cars = query(world, [Vehicle, Transform, Velocity, OnRoad])
    // NEIGHBOURS BY LANE POSITION, not by distance in the plane. Two cars twenty metres apart on
    // opposite carriageways are not following each other, and a plain nearest-neighbour search
    // makes them brake for each other, which looks exactly like a phantom jam.
    const byChain = new Map<number, number[]>()
    for (let i = 0; i < cars.length; i++) {
      const e = cars[i]
      const c = OnRoad.chain[e]
      const list = byChain.get(c)
      if (list) list.push(e)
      else byChain.set(c, [e])
    }
    for (const list of byChain.values()) list.sort((a, b) => OnRoad.s[a] - OnRoad.s[b])

    for (const list of byChain.values()) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i]
        if (!hasComponent(world, e, Driver)) continue // a wreck: a leader for others, driven by nobody
        const v = Vehicle.speed[e]
        const v0 = SpeedLimit.v[e] * Driver.speedFactor[e]

        // the car ahead in this lane, if there is one
        let gap = Infinity
        let dv = 0
        let leader = 0
        for (let k = i + 1; k < list.length; k++) {
          const f = list[k]
          if (OnRoad.lane[f] !== OnRoad.lane[e] || OnRoad.dir[f] !== OnRoad.dir[e]) continue
          gap = OnRoad.s[f] - OnRoad.s[e] - Vehicle.lengthM[f]
          dv = v - Vehicle.speed[f]
          leader = f + 1
          break
        }

        // and the light, as a stationary car at the stop line — unless this driver is running it
        const h = headFor(opts.heads, Transform.x[e], Transform.y[e], (Transform.yaw[e] * 180) / Math.PI, look)
        if (h >= 0) {
          const state = SignalHead.state[h]
          const dx = SignalHead.x[h] - Transform.x[e]
          const dy = SignalHead.y[h] - Transform.y[e]
          const toLine = Math.max(0, Math.hypot(dx, dy) - SignalHead.stopLine[h])
          if (state === GREEN) {
            Driver.running[e] = 0
          } else {
            /*
             * THE DECISION IS MADE ONCE, AT THE LIGHT'S CHANGE, AND THEN HELD.
             *
             * A driver who re-rolls every frame dithers: brakes, goes, brakes, and ends up
             * stopped across the junction. `running` latches, so someone who decided to go
             * through goes through — which is also what makes them frightening rather than
             * random.
             */
            if (!Driver.running[e]) {
              const canStop = toLine > (v * v) / (2 * Driver.brakeB[e]) + 1
              const willStop = Driver.compliance[e] > 0 ? true : state === RED && toLine > 25
              if (!canStop || !willStop) Driver.running[e] = 1
            }
            if (!Driver.running[e]) {
              // yellow is treated as red by anyone who can still stop, which is the law and also
              // what stops a queue creeping into a junction
              if (state === RED || state === YELLOW) {
                if (toLine < gap) {
                  gap = toLine
                  dv = v // the virtual leader is stationary, so the closing speed is ours
                }
              }
            }
          }
        }

        const ob = opts.obstacle?.(Transform.x[e], Transform.y[e], Transform.yaw[e], v)
        if (ob && ob.gap < gap) { gap = ob.gap; dv = ob.dv }
        if (opts.blind?.()) { gap = Infinity; dv = 0; leader = 0 }
        Driver.gap[e] = gap
        Driver.leader[e] = leader
        const a = idm(v, v0, gap, dv, Driver.accelA[e], Driver.brakeB[e], JamGap.s0[e], Driver.headwayS[e])
        // real brakes have a limit, and without one IDM can ask for -40 m/s^2 at a stop line it
        // arrived at too fast, which reads as a car hitting a wall
        const next = Math.max(0, v + Math.max(-9, Math.min(a, Driver.accelA[e])) * dt)
        Vehicle.speed[e] = next
        OnRoad.s[e] += next * dt
      }
    }
  }
}

/** Count what is waiting at each head, so an actuated phase has something to actuate on. */
export function demandSystem(opts: TrafficOpts) {
  return (world: World) => {
    for (const h of opts.heads) Demand.waiting[h] = 0
    const cars = query(world, [Vehicle, Transform, Driver])
    for (let i = 0; i < cars.length; i++) {
      const e = cars[i]
      if (Vehicle.speed[e] > 2) continue // moving: not waiting
      const h = headFor(opts.heads, Transform.x[e], Transform.y[e], (Transform.yaw[e] * 180) / Math.PI, 40)
      if (h >= 0) Demand.waiting[h]++
    }
  }
}
