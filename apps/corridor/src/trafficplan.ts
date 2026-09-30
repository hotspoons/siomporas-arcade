// Where the cars go: a road network plus traffic zones, in, and a list of places to put a car, out.
//
// `traffic.ts` has had the Intelligent Driver Model in it since 2026-09-27 and NOTHING HAS EVER
// CALLED IT. There is no populator: `driveSystem` and `demandSystem` are exported and unreferenced
// anywhere in the app, which is what Rich meant by *"there should already be rudiments of a traffic
// system, but let's wire it up"*. This is the missing half, and it is deliberately the half with no
// scene in it.
//
// PURE ON PURPOSE. It takes chains as `{ length, lanes, at(s) }` and gives back `{ chain, s, lane,
// dir }` — which is exactly the `OnRoad` component — so the decision of how many cars go where can
// be checked against a metre rule in a test, while the part that needs a curve, a heightfield and a
// mesh stays in the viewer. Every traffic bug I can imagine is in this arithmetic and none of them
// is in the transform.
//
// THE SPACING IS THE MODEL, NOT A PROBABILITY. A density is vehicles per kilometre per lane
// (`zones.ts`), so the gap between cars is 1000 / that, in metres, and placing a car every gap is
// the whole algorithm. Randomising WHETHER to place one at each step — the obvious first
// implementation — gives a Poisson distribution, which produces clumps and holes that look like a
// bug at low density and never packs properly at high. Real traffic at a given density has a
// characteristic spacing with variation around it, so: even spacing, jittered.

import { vehiclesPerKm, type Zones } from './zones'

/** One driveable chain: the spine, or a branch. `at` is in the site frame, metres. */
export interface RoadChain {
  /** the `OnRoad.chain` value — the spine is 0 */
  index: number
  length_m: number
  /** total lanes, both directions */
  lanes: number
  /** a point at distance `s` along it */
  at: (s: number) => { x: number; y: number }
  /** m/s. Only used to seed `SpeedLimit`; the planner does not read it */
  limit_ms?: number
}

/** Where one car goes: the `OnRoad` component, before anything has been spawned. */
export interface TrafficSlot {
  chain: number
  s: number
  /** 0-based lane within its own direction */
  lane: number
  /** 0 = along the chain, 1 = against it */
  dir: 0 | 1
  /** the density that put it here, so the spawner can set the driver's speed factor */
  density: number
}

export interface PlanOpts {
  /** never plan more than this many cars, whatever the zones say */
  max?: number
  /** how much a car's position wanders from its slot, as a fraction of the gap. 0…0.5 */
  jitter?: number
  /** ignore a chain shorter than this — a six-metre slip road with a car on it is a parked car */
  minChain_m?: number
}

/** How the lanes split. At least one each way, because a one-lane road still has two directions. */
export function lanesPerDirection(lanes: number): number {
  return Math.max(1, Math.floor((Number.isFinite(lanes) ? lanes : 2) / 2))
}

/**
 * Plan the traffic for a whole network.
 *
 * `rand` is the seeded generator from `traffic.ts`, so a level populates identically twice — which
 * matters more than it sounds: a rally stage where the traffic is somewhere else on the retry is a
 * stage nobody can learn.
 *
 * A world with no zones gets NO CARS. That is the design: traffic is something a level places.
 */
export function planTraffic(chains: RoadChain[], zones: Zones, rand: () => number, opts: PlanOpts = {}): TrafficSlot[] {
  const max = opts.max ?? 2000
  const jitter = Math.max(0, Math.min(0.5, opts.jitter ?? 0.35))
  const minChain = opts.minChain_m ?? 30
  const out: TrafficSlot[] = []

  for (const chain of chains) {
    if (!(chain.length_m > minChain)) continue
    const perDir = lanesPerDirection(chain.lanes)
    for (let dir = 0 as 0 | 1; dir <= 1; dir = (dir + 1) as 0 | 1) {
      for (let lane = 0; lane < perDir; lane++) {
        /*
         * WALK THE CHAIN, ASKING AS WE GO. The density is read at each car's own position rather
         * than once per chain, because a chain runs through more than one zone — that is the whole
         * point of drawing a zone on part of a road — and a single sample at the midpoint would put
         * downtown's traffic on the bypass at either end of it.
         */
        let s = rand() * 40 // a different starting offset per lane, so cars are not in ranks
        while (s < chain.length_m && out.length < max) {
          const p = chain.at(s)
          const density = zones.densityAt(p.x, p.y)
          if (density <= 0) {
            // nothing here: step by the free-flow gap so an empty stretch is cheap to cross
            s += 1000 / vehiclesPerKm(0)
            continue
          }
          const gap = 1000 / vehiclesPerKm(density)
          const at = s + gap * jitter * (rand() * 2 - 1)
          if (at > 0 && at < chain.length_m) out.push({ chain: chain.index, s: at, lane, dir, density })
          s += gap
        }
      }
    }
    if (out.length >= max) break
  }
  return out
}

/**
 * What a plan adds up to, for a readout and for a budget check.
 *
 * `perChain` is how the cars fell across the network, which is the number that says whether a zone
 * was drawn where somebody thought it was: a zone painted beside the road rather than on it plans
 * zero cars and looks exactly like a zone that is working.
 */
export function summarise(slots: TrafficSlot[]): { total: number; perChain: Map<number, number>; busiest: number } {
  const perChain = new Map<number, number>()
  let busiest = 0
  for (const s of slots) {
    perChain.set(s.chain, (perChain.get(s.chain) ?? 0) + 1)
    if (s.density > busiest) busiest = s.density
  }
  return { total: slots.length, perChain, busiest }
}
