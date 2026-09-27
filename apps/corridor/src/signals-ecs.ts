// Traffic control, as entities in the same world as the traffic.
//
// Rich, 2026-09-27: "traffic control systems, e.g. stop lights, need to be hooked into the ECS so
// we manage it in relation to the rest of the world... Also need some sort of API so we can
// program sets of lights to match what DPW would do for a county or state road, but make this opt
// in and by default just use the dumb system currently in place."
//
// So there are two layers and the second one is optional:
//
//   THE DUMB ONE, which is the default and is what the viewer draws today: a fixed cycle, split
//   between the approaches by their bearing, with a yellow and an all-red. No detection, no
//   coordination. It is wrong in the way a cheap model is wrong — every junction runs its own
//   clock regardless of anything — and it is right enough that a world populated with it reads as
//   traffic.
//
//   THE PROGRAMMED ONE, opt in per junction. This is the vocabulary a traffic engineer actually
//   uses, and the reason to use theirs rather than invent one is that the behaviour people
//   recognise on a county arterial comes from it: minimum green, yellow change and all-red
//   clearance intervals, an actuated phase that is skipped when nobody is waiting, and — the one
//   that makes a road feel like a road — COORDINATION, where a run of junctions share a cycle
//   length and are given offsets so a platoon leaving one green arrives at the next on green.
//
// Nothing here draws anything. `furniture.ts` owns the masts and the lamps; this owns what colour
// they should be, and the two meet at `headState()`.

import { addComponent, addEntity, createRelation, query, type World } from 'bitecs'
import { MAX_ACTORS } from './actors'

const f32 = () => new Float32Array(MAX_ACTORS)
const u8 = () => new Uint8Array(MAX_ACTORS)
const u16 = () => new Uint16Array(MAX_ACTORS)

/** What a head is showing. Ordered so a comparison like `state >= YELLOW` means "not green". */
export const GREEN = 0
export const YELLOW = 1
export const RED = 2
export type Colour = typeof GREEN | typeof YELLOW | typeof RED

/* ---- components -------------------------------------------------------------------------- */

/**
 * A junction's controller. One per signalised junction, whatever its shape.
 *
 * `t` is seconds into the cycle and is the ONLY state a fixed-time controller has, which is what
 * makes coordination a matter of arithmetic rather than of messaging: two junctions on the same
 * `cycleS` with different `offsetS` are coordinated, and nothing has to tell either about the
 * other.
 */
export const SignalGroup = {
  t: f32(),
  cycleS: f32(),
  offsetS: f32(),
  phase: u8(),
  /** index into the program table; 0 is the dumb fixed cycle */
  program: u16(),
  /** how many phases this junction's program has */
  phases: u8(),
}

/**
 * One signal head: an approach, and the colour it is showing.
 *
 * `bearing` is the compass direction traffic TRAVELS on this approach, matching the bake's
 * `travel_deg`, so a car and a head can be matched by heading without either knowing the other's
 * idea of geometry.
 */
export const SignalHead = {
  x: f32(),
  y: f32(),
  bearing: f32(),
  /** which phase of its group gives this approach green */
  phase: u8(),
  state: u8(),
  /** metres back from the junction centre where traffic stops */
  stopLine: f32(),
  lanes: u8(),
}

/** Demand: something is waiting at this head. An actuated phase reads it; a fixed one ignores it. */
export const Demand = { waiting: u16(), since: f32() }

/** Which group a head belongs to. A relation, so a group can be destroyed with its heads. */
export const ControlledBy = createRelation()

/* ---- the programmable part ------------------------------------------------------------------ */

/** One phase of a controller: which approaches move, and for how long. */
export interface Phase {
  /** a name a person recognises: "main street through", "side street", "protected left" */
  name: string
  /** the shortest this phase may run, once it starts. Real controllers guarantee it. */
  minGreenS: number
  /** the longest, when there is demand to hold it */
  maxGreenS: number
  /** change interval. 3 to 6 s in practice, and a function of the approach speed. */
  yellowS: number
  /** all-red clearance, so the junction empties before the conflicting phase starts */
  allRedS: number
  /**
   * ACTUATED phases are skipped when nothing is waiting. That is the single biggest difference
   * between a programmed junction and the dumb one: a side street that nobody is on does not stop
   * the main road, which is most of why a county arterial feels the way it does at 2 a.m.
   */
  actuated?: boolean
}

export interface SignalProgram {
  id: string
  /** every phase, in service order */
  phases: Phase[]
  /**
   * Coordination. Junctions sharing a `cycleS` and given increasing `offsetS` down a corridor put
   * a platoon through a run of greens — the "green wave". Leave `cycleS` unset and the controller
   * is free-running, which is what an isolated junction does.
   */
  cycleS?: number
  offsetS?: number
}

/**
 * The default, and what the viewer has been drawing all along: a fixed cycle, two phases, no
 * detection and no coordination.
 *
 * Deliberately the same shape as a programmed one, so nothing downstream needs to know which it
 * has. A junction with no program is not a special case; it is this program.
 */
export const DUMB: SignalProgram = {
  id: 'fixed',
  phases: [
    { name: 'one axis', minGreenS: 20, maxGreenS: 20, yellowS: 4, allRedS: 1 },
    { name: 'the other', minGreenS: 20, maxGreenS: 20, yellowS: 4, allRedS: 1 },
  ],
}

/** The programs this world knows. Index 0 is always DUMB, so an unprogrammed junction gets it. */
export class SignalPrograms {
  private list: SignalProgram[] = [DUMB]
  private byId = new Map<string, number>([['fixed', 0]])

  /** Register a program and get its index. Re-registering an id replaces it. */
  add(p: SignalProgram): number {
    const i = this.byId.get(p.id)
    if (i !== undefined) {
      this.list[i] = p
      return i
    }
    this.list.push(p)
    this.byId.set(p.id, this.list.length - 1)
    return this.list.length - 1
  }

  at(i: number): SignalProgram {
    return this.list[i] ?? DUMB
  }

  indexOf(id: string): number {
    return this.byId.get(id) ?? 0
  }

  get count() {
    return this.list.length
  }

  /** Total length of one pass through a program, which a free-running controller needs. */
  cycleOf(p: SignalProgram): number {
    return p.cycleS ?? p.phases.reduce((n, f) => n + f.maxGreenS + f.yellowS + f.allRedS, 0)
  }
}

/* ---- building them from what the bake knows --------------------------------------------------- */

export interface MastRecord {
  x: number
  y: number
  yaw_deg: number
  travel_deg: number
  lanes: number
  junction: number
}

/**
 * Turn the bake's masts into groups and heads.
 *
 * ONE GROUP PER JUNCTION, and approaches are assigned to phases by BEARING: two approaches whose
 * travel directions are within 45 degrees of opposite are the same road and move together, which
 * is what a real two-phase junction does. Everything else goes to the other phase. It is crude and
 * it is the dumb controller's whole job; a programmed junction overrides the assignment.
 */
export function buildSignals(world: World, masts: MastRecord[], programs: SignalPrograms): { groups: number[]; heads: number[] } {
  const byJunction = new Map<string, MastRecord[]>()
  for (const m of masts) {
    // the bake groups by proximity and records the size, but not an id: position rounds to one
    const key = `${Math.round(m.x / 60)},${Math.round(m.y / 60)}`
    ;(byJunction.get(key) ?? byJunction.set(key, []).get(key)!).push(m)
  }
  const groups: number[] = []
  const heads: number[] = []
  for (const [, ms] of byJunction) {
    const g = addEntity(world)
    addComponent(world, g, SignalGroup)
    const prog = programs.at(0)
    SignalGroup.program[g] = 0
    SignalGroup.phases[g] = prog.phases.length
    SignalGroup.cycleS[g] = programs.cycleOf(prog)
    SignalGroup.offsetS[g] = 0
    SignalGroup.t[g] = 0
    SignalGroup.phase[g] = 0
    groups.push(g)

    // the first mast's axis defines phase 0; anything within 45 degrees of it or its opposite
    // shares that phase
    const axis = ms[0].travel_deg
    for (const m of ms) {
      const h = addEntity(world)
      addComponent(world, h, SignalHead)
      addComponent(world, h, Demand)
      addComponent(world, h, ControlledBy(g))
      SignalHead.x[h] = m.x
      SignalHead.y[h] = m.y
      SignalHead.bearing[h] = m.travel_deg
      SignalHead.lanes[h] = Math.max(1, m.lanes | 0)
      SignalHead.stopLine[h] = 6
      SignalHead.phase[h] = sameAxis(axis, m.travel_deg) ? 0 : 1
      SignalHead.state[h] = RED
      heads.push(h)
    }
  }
  return { groups, heads }
}

/** Are two travel bearings the same road? Within 45 degrees of parallel or antiparallel. */
export function sameAxis(a: number, b: number): boolean {
  const d = Math.abs(((a - b + 540) % 360) - 180) // 0 = opposite, 180 = same direction
  return d <= 45 || d >= 135
}

/* ---- the system ------------------------------------------------------------------------------- */

/**
 * Advance every controller and set every head's colour.
 *
 * The phase a controller is in is computed FROM ITS CLOCK rather than stepped, so a coordinated
 * junction cannot drift out of step with its neighbours over a long session, and so a world can
 * be seeked to a time without replaying it.
 */
export function signalSystem(programs: SignalPrograms) {
  return (world: World, dt: number) => {
    const groups = query(world, [SignalGroup])
    // where each group is in its cycle, and which phase that is
    const phaseOf = new Map<number, { phase: number; colour: Colour }>()
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]
      const p = programs.at(SignalGroup.program[g])
      const cycle = SignalGroup.cycleS[g] || programs.cycleOf(p)
      SignalGroup.t[g] = (SignalGroup.t[g] + dt) % cycle
      const into = (SignalGroup.t[g] + cycle - (SignalGroup.offsetS[g] % cycle)) % cycle
      let acc = 0
      let phase = 0
      let colour: Colour = RED
      for (let k = 0; k < p.phases.length; k++) {
        const f = p.phases[k]
        const green = f.maxGreenS
        if (into < acc + green) { phase = k; colour = GREEN; break }
        if (into < acc + green + f.yellowS) { phase = k; colour = YELLOW; break }
        if (into < acc + green + f.yellowS + f.allRedS) { phase = k; colour = RED; break }
        acc += green + f.yellowS + f.allRedS
        phase = k
      }
      SignalGroup.phase[g] = phase
      phaseOf.set(g, { phase, colour })
    }

    /*
     * FROM THE GROUP DOWN, NOT FROM THE HEAD UP.
     *
     * The first version asked each head which group owned it, and answering that meant scanning
     * every group's relation — O(groups x heads) every frame, which on a site with 24 signalised
     * junctions is the most expensive thing in the simulation and grows as the square. Walking the
     * other way is one relation query per group and touches each head once.
     */
    for (const [g, st] of phaseOf) {
      const mine = query(world, [ControlledBy(g)])
      for (let i = 0; i < mine.length; i++) {
        const h = mine[i]
        SignalHead.state[h] = SignalHead.phase[h] === st.phase ? st.colour : RED
        if (Demand.waiting[h] > 0) Demand.since[h] += dt
        else Demand.since[h] = 0
      }
    }
  }
}

/** Which group controls this head. For probes and for the editor; not used per frame. */
export function groupOf(world: World, head: number): number {
  const groups = query(world, [SignalGroup])
  for (let i = 0; i < groups.length; i++) {
    if ((query(world, [ControlledBy(groups[i])]) as unknown as number[]).includes(head)) return groups[i]
  }
  return -1
}

/**
 * What a driver approaching on `bearing` sees at this junction: the head that governs them.
 *
 * Matching by bearing rather than by geometry is the point — a car knows which way it is going and
 * nothing else has to agree about where the lanes are.
 */
export function headFor(heads: number[], x: number, y: number, bearing: number, withinM = 60): number {
  let best = -1
  let bestD = withinM * withinM
  for (const h of heads) {
    const dx = SignalHead.x[h] - x
    const dy = SignalHead.y[h] - y
    const d2 = dx * dx + dy * dy
    if (d2 > bestD) continue
    /*
     * `SignalHead.bearing` is the direction traffic TRAVELS on this approach (the bake's
     * `travel_deg`), which is the same direction the car is pointing — not the way the lamps
     * face, which is the opposite. I had this inverted and it silently matched nothing: every
     * driver sailed through every red because no head ever governed them, and the test that
     * caught it was the one asking whether a compliant driver stops.
     */
    // `off` is 0 for the same heading and 180 for the opposite one — checked numerically, because
    // I talked myself into the wrong sign of this twice in a row
    const off = Math.abs(((SignalHead.bearing[h] - bearing + 540) % 360) - 180)
    if (off > 40) continue // more than 40 degrees off our heading: a different approach
    best = h
    bestD = d2
  }
  return best
}
