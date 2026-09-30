// Gates, circuits and stages: the second of the three primitives in PLAN-RACES-TRAFFIC.md.
//
// Rich, 2026-09-29: *"in the placement editor, we need to be able to define circuits and stages.
// Circuits have a start/finish line, stages have a start and end line and checkpoints that need to
// be entered or you will get a penalty. Again, things for our ECS that we can track."*
//
// A GATE IS A LINE, NOT A VOLUME, and that is the decision everything else follows from. A trigger
// box asks "am I inside it", which is the wrong question three separate ways: it is true for a car
// sitting still in it, it is true whichever way you are facing, and at any real speed you are only
// inside it for a fraction of a tick. A line asks "did the segment I moved along this tick cross
// it, and in which direction", which is true exactly once, cannot be sat on, and CANNOT BE JUMPED —
// a car doing 60 m/s at a 5 Hz physics step moves twelve metres between samples and would pass
// clean through any box small enough to be a start line.
//
// WHICH WAY IS FORWARD. A gate runs from `a` to `b`, and you cross it correctly when you pass from
// the RIGHT of that line to the LEFT of it. Equivalently: the forward direction is `a→b` rotated a
// quarter turn anticlockwise. That is a convention, not a fact, so the editor draws an arrow — a
// start line somebody has to guess the direction of is a start line that will be backwards half the
// time, and a backwards start line is invisible until somebody drives it.
//
// NOTHING HERE KNOWS ABOUT THE ECS, a scene, or a clock. It takes positions and gives back events,
// so a whole race can be replayed in a test from a list of coordinates.

import type { FrameStamp } from './editor/schema'

/* ---- the gate ---------------------------------------------------------------------------------- */

export const GATE_ROLES = ['start', 'finish', 'startfinish', 'checkpoint', 'split'] as const
export type GateRole = (typeof GATE_ROLES)[number]

export interface Gate {
  id: string
  name: string
  role: GateRole
  /** SITE frame, metres: x east, y north. You cross it correctly going right-to-left across a→b. */
  a: [number, number]
  b: [number, number]
  /**
   * Where it comes in the sequence. Checkpoints and splits are driven in this order; the start and
   * the finish ignore it.
   */
  order?: number
  /** a checkpoint you are allowed to miss without a penalty — a decoration, or an alternative line */
  optional?: boolean
}

/** Which way a movement went through a gate's line. */
export const FORWARD = 1
export const BACKWARD = -1
export const NO_CROSSING = 0
export type Crossing = typeof FORWARD | typeof BACKWARD | typeof NO_CROSSING

/** Positive when `p` is to the LEFT of the line a→b, negative to the right, zero on it. */
export function sideOf(g: Gate, p: { x: number; y: number }): number {
  return (g.b[0] - g.a[0]) * (p.y - g.a[1]) - (g.b[1] - g.a[1]) * (p.x - g.a[0])
}

/**
 * Did the move from `from` to `to` cross this gate, and which way?
 *
 * Both tests matter and neither alone is enough. The SIDE test says the movement crossed the
 * infinite line and in which direction; the SEGMENT test says it did so between the two posts
 * rather than fifty metres off the end of them. A start line is short and the road beside it is
 * long, so a gate checked on the side test alone fires when you drive past the pit wall.
 */
export function crossing(g: Gate, from: { x: number; y: number }, to: { x: number; y: number }): Crossing {
  const s0 = sideOf(g, from)
  const s1 = sideOf(g, to)

  /*
   * LANDING EXACTLY ON THE LINE IS NOT A CROSSING YET; leaving it is.
   *
   * This is not a pedantic case — a gate drawn across a straight road and a car sampled on a round
   * number of metres lands on it regularly, and the first version's asymmetry made that arrival
   * count as a BACKWARD crossing on the step after it. A start line that reports you going the
   * wrong way once in a while is the kind of bug that gets blamed on the driver.
   *
   * So: a strict change of side, or a departure from the line. An arrival is deferred to the next
   * step, which then sees `s0 === 0` and resolves it — exactly one event either way.
   */
  const changed = s0 * s1 < 0 || (s0 === 0 && s1 !== 0)
  if (!changed) return NO_CROSSING

  // where on a→b it happened: 0 at `a`, 1 at `b`, outside that it went past the posts
  const t = crossParam(g, from, to)
  if (t === null || t < 0 || t > 1) return NO_CROSSING

  /*
   * THE DIRECTION COMES FROM THE MOVEMENT, not from which side you started on. Both answer the
   * same question when the start is strictly to one side, and only this one answers it when the
   * start is on the line.
   */
  const f = gateForward(g)
  const along = (to.x - from.x) * f.x + (to.y - from.y) * f.y
  if (along === 0) return NO_CROSSING
  return along > 0 ? FORWARD : BACKWARD
}

/** How far along a→b the crossing sits, or null when the two segments are parallel. */
function crossParam(g: Gate, from: { x: number; y: number }, to: { x: number; y: number }): number | null {
  const gx = g.b[0] - g.a[0]
  const gy = g.b[1] - g.a[1]
  const mx = to.x - from.x
  const my = to.y - from.y
  const den = gx * my - gy * mx
  if (Math.abs(den) < 1e-12) return null
  return ((from.x - g.a[0]) * my - (from.y - g.a[1]) * mx) / den
}

/** The middle of the gate, for a camera, a marker or a "you are here". */
export function midpoint(g: Gate): { x: number; y: number } {
  return { x: (g.a[0] + g.b[0]) / 2, y: (g.a[1] + g.b[1]) / 2 }
}

/** How wide the gate is, metres. A two-metre start line is one somebody will drive around. */
export function gateWidth(g: Gate): number {
  return Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1])
}

/** The unit vector you drive along to cross it correctly — a→b turned a quarter turn anticlockwise. */
export function gateForward(g: Gate): { x: number; y: number } {
  const dx = g.b[0] - g.a[0]
  const dy = g.b[1] - g.a[1]
  const len = Math.hypot(dx, dy) || 1
  return { x: -dy / len, y: dx / len }
}

/* ---- what you do with gates -------------------------------------------------------------------- */

export const COURSE_KINDS = ['circuit', 'stage'] as const
export type CourseKind = (typeof COURSE_KINDS)[number]

/**
 * A circuit or a stage. ONE type, because they differ by two fields and nothing else.
 *
 * A circuit is a lap: one `startfinish` gate you cross `laps` times, with splits in between. A
 * stage is a run: a `start`, a `finish`, and checkpoints in order, where a missed checkpoint is a
 * PENALTY and not a failure — Rich: *"checkpoints that need to be entered or you will get a
 * penalty"*. Two types would mean two of everything that reads them, for a boolean.
 */
/**
 * The place you drive into to start a race.
 *
 * Rich, 2026-09-29: *"we'll need to be able to place entry points you drive through to commit you
 * into a race … Think race areas in Forza Horizon where you drive into a throbber and you enter
 * the race."*
 *
 * A CIRCLE, NOT A GATE. A gate is a line you cross in a direction, which is right for a start line
 * and wrong for this: you should be able to arrive at a race from any direction, at any speed, and
 * have it notice. A radius on the ground is the shape that does that, and it is the shape every
 * game that has ever done this has used.
 *
 * It is NOT the start line. Driving into the throbber commits you; the clock starts when you cross
 * the start gate, which may be a hundred metres further on. That gap is the roll-up, and it is what
 * makes a standing start feel deliberate rather than abrupt.
 */
export interface RaceEntry {
  /** site frame, metres */
  x: number
  y: number
  /** how close you have to be. 12 m is a lane and a half — findable, not trippable */
  r: number
}

export interface Course {
  id: string
  name: string
  kind: CourseKind
  /** where you drive in to commit to it. Without one a course can only be started from code */
  entry?: RaceEntry
  /** circuits only; ignored for a stage */
  laps?: number
  /** seconds added per missed checkpoint. 10 is the rally convention */
  penalty_s?: number
  gates: Gate[]
  /** what to say before it starts, and what to say when it is done */
  intro?: string
  outro?: string
}

export interface CourseDoc {
  version: 1
  frame?: FrameStamp
  courses: Course[]
}

export const EMPTY_COURSES: CourseDoc = { version: 1, courses: [] }
export const DEFAULT_PENALTY_S = 10
/** How close you have to drive to commit to a race, when nobody has said. */
export const DEFAULT_ENTRY_R = 12

/** Is this point inside a course's entry marker? */
export function inEntry(c: Course, x: number, y: number): boolean {
  const e = c.entry
  if (!e) return false
  const r = e.r > 0 ? e.r : DEFAULT_ENTRY_R
  return (x - e.x) ** 2 + (y - e.y) ** 2 <= r * r
}

/**
 * The course whose entry you are standing in, or null.
 *
 * THE SMALLEST ONE WINS where two overlap, the same rule as zones and stunts — a small marker
 * inside a big one is somebody saying "except here", and picking the first in file order would make
 * which race you enter depend on the order somebody happened to draw them.
 */
export function entryAt(courses: readonly Course[], x: number, y: number): Course | null {
  let best: Course | null = null
  for (const c of courses) {
    if (!inEntry(c, x, y)) continue
    const r = c.entry!.r || DEFAULT_ENTRY_R
    if (!best || r < (best.entry!.r || DEFAULT_ENTRY_R)) best = c
  }
  return best
}

/** The gates you have to hit, in order. Splits and checkpoints are the same thing to a tracker. */
export function orderedGates(c: Course): Gate[] {
  return c.gates
    .filter((g) => g.role === 'checkpoint' || g.role === 'split')
    .sort((p, q) => (p.order ?? 0) - (q.order ?? 0))
}

export function startGate(c: Course): Gate | null {
  return c.gates.find((g) => g.role === (c.kind === 'circuit' ? 'startfinish' : 'start')) ?? null
}

export function finishGate(c: Course): Gate | null {
  return c.kind === 'circuit'
    ? c.gates.find((g) => g.role === 'startfinish') ?? null
    : c.gates.find((g) => g.role === 'finish') ?? null
}

/* ---- running one ------------------------------------------------------------------------------- */

export type RaceEvent =
  | { at: 'started'; t: number }
  | { at: 'gate'; t: number; gate: Gate; index: number }
  | { at: 'missed'; t: number; gate: Gate; index: number }
  | { at: 'lap'; t: number; lap: number; lapTime: number }
  | { at: 'wrongway'; t: number; gate: Gate }
  | { at: 'finished'; t: number; time: number; penalties: number; total: number }

export interface RunState {
  /** null until the start line is crossed */
  startedAt: number | null
  finishedAt: number | null
  /** how many of the ordered gates have been taken, in order */
  next: number
  missed: number
  lap: number
  lastLapAt: number
  lapTimes: number[]
}

/**
 * One attempt at one course.
 *
 * FED POSITIONS, NOT TICKS. `move(t, from, to)` is called with whatever pair of positions the
 * caller has, so the physics can run at 60 Hz and this can be asked once a frame, or a replay can
 * be pushed through it at whatever rate it was recorded at, and the answers are the same. The
 * caller owns the clock; this owns the rules.
 *
 * IT DOES NOT FAIL YOU FOR A MISSED CHECKPOINT. Missing one adds a penalty and moves on, which is
 * the rally rule and is also the only forgiving option: a stage that ends silently because you
 * clipped the inside of a chicane is a stage nobody finishes and nobody understands.
 */
export class Run {
  readonly course: Course
  readonly state: RunState = { startedAt: null, finishedAt: null, next: 0, missed: 0, lap: 0, lastLapAt: 0, lapTimes: [] }
  private readonly ordered: Gate[]
  private readonly start: Gate | null
  private readonly finish: Gate | null

  constructor(course: Course) {
    this.course = course
    this.ordered = orderedGates(course)
    this.start = startGate(course)
    this.finish = finishGate(course)
  }

  get running(): boolean {
    return this.state.startedAt !== null && this.state.finishedAt === null
  }

  /** Seconds of penalty accumulated so far. */
  get penalties(): number {
    return this.state.missed * (this.course.penalty_s ?? DEFAULT_PENALTY_S)
  }

  /**
   * Advance by one movement. Returns everything that happened, oldest first.
   *
   * Several things can happen in one move — the last checkpoint and the finish line are often a
   * few metres apart — so this returns a list rather than the first event, which is the shape that
   * loses one of them.
   */
  move(t: number, from: { x: number; y: number }, to: { x: number; y: number }): RaceEvent[] {
    const out: RaceEvent[] = []
    if (this.state.finishedAt !== null) return out

    // --- not started: only the start line matters -----------------------------------------------
    if (this.state.startedAt === null) {
      if (this.start && crossing(this.start, from, to) === FORWARD) {
        this.state.startedAt = t
        this.state.lastLapAt = t
        out.push({ at: 'started', t })
      }
      return out
    }

    // --- the ordered gates ----------------------------------------------------------------------
    for (const [i, g] of this.ordered.entries()) {
      if (i < this.state.next) continue
      if (crossing(g, from, to) !== FORWARD) continue
      /*
       * TAKING A LATER GATE MISSES THE ONES BEFORE IT. That is the whole mechanism: nothing
       * watches for you cutting a corner, it simply notices that gate 5 arrived while gate 3 was
       * still expected, and charges for 3 and 4. It cannot be fooled by driving slowly, and it
       * needs no geometry beyond the gates somebody already drew.
       */
      for (let k = this.state.next; k < i; k++) {
        if (this.ordered[k].optional) continue
        this.state.missed++
        out.push({ at: 'missed', t, gate: this.ordered[k], index: k })
      }
      this.state.next = i + 1
      out.push({ at: 'gate', t, gate: g, index: i })
      // NO `break`: one movement can legitimately cross two gates — a chicane's pair are metres
      // apart and a long step takes both — and crediting only the first would charge a penalty
      // for a gate the car demonstrably drove through.
    }

    // --- the finish, or a lap -------------------------------------------------------------------
    if (this.finish) {
      const c = crossing(this.finish, from, to)
      if (c === BACKWARD && this.course.kind === 'stage') out.push({ at: 'wrongway', t, gate: this.finish })
      if (c === FORWARD) {
        /*
         * A LAP ONLY COUNTS IF THE SPLITS WERE TAKEN. On a circuit the start line and the finish
         * line are the same line, so without this, sitting on it and reversing back and forth is a
         * lap every two seconds. The splits are the anti-cut, and they are the same gates the
         * stage uses as checkpoints.
         */
        const tookThemAll = this.state.next >= this.ordered.filter((g) => !g.optional).length
        if (this.course.kind === 'circuit' && !tookThemAll) {
          // not a lap: they came back round without going the long way
        } else if (this.course.kind === 'circuit') {
          this.state.lap++
          const lapTime = t - this.state.lastLapAt
          this.state.lapTimes.push(lapTime)
          this.state.lastLapAt = t
          this.state.next = 0
          out.push({ at: 'lap', t, lap: this.state.lap, lapTime })
          if (this.state.lap >= (this.course.laps ?? 1)) out.push(this.finishNow(t))
        } else {
          // a stage: everything not yet taken is missed, then it is over
          for (let k = this.state.next; k < this.ordered.length; k++) {
            if (this.ordered[k].optional) continue
            this.state.missed++
            out.push({ at: 'missed', t, gate: this.ordered[k], index: k })
          }
          this.state.next = this.ordered.length
          out.push(this.finishNow(t))
        }
      }
    }
    return out
  }

  private finishNow(t: number): RaceEvent {
    this.state.finishedAt = t
    const time = t - (this.state.startedAt ?? t)
    return { at: 'finished', t, time, penalties: this.penalties, total: time + this.penalties }
  }

  /** The result so far, for a live readout as well as for the end. */
  result(now: number): { time: number; penalties: number; total: number; lap: number; laps: number; next: Gate | null } {
    const time = this.state.startedAt === null ? 0 : (this.state.finishedAt ?? now) - this.state.startedAt
    return {
      time,
      penalties: this.penalties,
      total: time + this.penalties,
      lap: this.state.lap,
      laps: this.course.kind === 'circuit' ? (this.course.laps ?? 1) : 1,
      next: this.ordered[this.state.next] ?? this.finish,
    }
  }
}

/* ---- validation -------------------------------------------------------------------------------- */

/**
 * Every problem with a course, not the first — and the problems worth naming are the ones that
 * produce a course which LOADS and cannot be completed.
 */
export function validateCourse(c: Course, opts: { minGate_m?: number } = {}): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const minWidth = opts.minGate_m ?? 4

  if (!c.id) errors.push('the course has no id')
  if (!(COURSE_KINDS as readonly string[]).includes(c.kind)) errors.push(`kind ${JSON.stringify(c.kind)} must be circuit or stage`)

  const start = startGate(c)
  const finish = finishGate(c)
  if (!start) errors.push(c.kind === 'circuit' ? 'a circuit needs a start/finish gate' : 'a stage needs a start gate')
  if (!finish) errors.push(c.kind === 'circuit' ? 'a circuit needs a start/finish gate' : 'a stage needs a finish gate')

  if (c.kind === 'circuit') {
    const sf = c.gates.filter((g) => g.role === 'startfinish')
    if (sf.length > 1) errors.push(`a circuit has one start/finish line; this one has ${sf.length}`)
    if (c.laps !== undefined && (!Number.isInteger(c.laps) || c.laps < 1)) errors.push('laps must be a whole number of at least 1')
    /*
     * A CIRCUIT WITH NO SPLITS CANNOT TELL A LAP FROM A WOBBLE. The start and finish are the same
     * line, so without something to take in between, reversing over it counts. This is an ERROR
     * rather than a warning because the course is not merely imperfect, it is unplayable.
     */
    if (!orderedGates(c).length) errors.push('a circuit needs at least one split gate, or crossing the line backwards and forwards counts as laps')
  } else {
    if (c.gates.filter((g) => g.role === 'start').length > 1) errors.push('a stage has one start line')
    if (c.gates.filter((g) => g.role === 'finish').length > 1) errors.push('a stage has one finish line')
  }

  const seen = new Set<string>()
  for (const g of c.gates) {
    if (!g.id) errors.push('a gate has no id')
    else if (seen.has(g.id)) errors.push(`gate ${g.id} is used twice`)
    else seen.add(g.id)
    const w = gateWidth(g)
    if (!(w > 0)) errors.push(`gate ${g.id || '?'} has no width — its two ends are in the same place`)
    else if (w < minWidth) warnings.push(`gate ${g.id} is ${w.toFixed(1)} m wide, which is narrow enough to drive around`)
    else if (w > 200) warnings.push(`gate ${g.id} is ${w.toFixed(0)} m wide and will catch traffic on other roads`)
  }

  const orders = orderedGates(c).map((g) => g.order ?? 0)
  if (new Set(orders).size !== orders.length) warnings.push('two gates share an order, so which comes first is arbitrary')

  return { ok: errors.length === 0, errors, warnings }
}

/** One line for a list: what this course is. */
export function describeCourse(c: Course): string {
  const n = orderedGates(c).length
  const bits: string[] = [c.kind]
  if (c.kind === 'circuit') bits.push(`${c.laps ?? 1} lap${(c.laps ?? 1) === 1 ? '' : 's'}`, `${n} split${n === 1 ? '' : 's'}`)
  else bits.push(`${n} checkpoint${n === 1 ? '' : 's'}`)
  bits.push(`${c.penalty_s ?? DEFAULT_PENALTY_S}s a miss`)
  return bits.join(' · ')
}

/** Seconds as a stopwatch reads them: 1:04.23. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return m ? `${m}:${s.toFixed(2).padStart(5, '0')}` : s.toFixed(2)
}
