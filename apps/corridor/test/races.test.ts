// Gates, and whether a lap is a lap.
//
// The whole of a race's rules is "did that movement cross that line, which way, and in what order",
// so this is where the rules are checked — a driveable circuit is not a thing a screenshot can
// verify, and the failures are all of the kind that look fine until somebody wins by reversing.
import { describe, expect, it } from 'vitest'
import {
  BACKWARD, clock, crossing, describeCourse, FORWARD, gateForward, gateWidth, midpoint,
  NO_CROSSING, orderedGates, Run, sideOf, validateCourse, type Course, type Gate,
} from '../src/game/race/races'

/** A gate across the x axis at `x`, running from y=-10 to y=+10, so forward is +x. */
const across = (id: string, x: number, role: Gate['role'] = 'checkpoint', order = 0): Gate =>
  ({ id, name: id, role, order, a: [x, -10], b: [x, 10] })

const at = (x: number, y = 0) => ({ x, y })

describe('a gate is a line you cross, not a box you sit in', () => {
  const g = across('g', 100)

  it('knows which side you are on', () => {
    // a runs to b as y increases, so +x is to the RIGHT of it and the left is -x
    expect(sideOf(g, at(90))).toBeGreaterThan(0)
    expect(sideOf(g, at(110))).toBeLessThan(0)
    expect(sideOf(g, at(100))).toBe(0)
  })

  it('fires once, in the direction you went', () => {
    expect(crossing(g, at(90), at(110))).toBe(BACKWARD)
    expect(crossing(g, at(110), at(90))).toBe(FORWARD)
    expect(crossing(g, at(90), at(99))).toBe(NO_CROSSING)
    expect(crossing(g, at(101), at(110))).toBe(NO_CROSSING)
  })

  /*
   * THE ONE THAT MATTERS AT SPEED. A car at 60 m/s stepping at 5 Hz moves twelve metres between
   * samples; anything that asks "am I inside the trigger" misses it entirely. A segment test
   * cannot be jumped however big the step is.
   */
  it('cannot be jumped over, however long the step', () => {
    expect(crossing(g, at(-900), at(900))).toBe(BACKWARD)
    expect(crossing(g, at(900), at(-900))).toBe(FORWARD)
  })

  it('does not fire when you pass the end of it', () => {
    // same crossing of the infinite line, fifty metres past the post
    expect(crossing(g, { x: 110, y: 50 }, { x: 90, y: 50 })).toBe(NO_CROSSING)
    // and right at the post it still counts
    expect(crossing(g, { x: 110, y: 9.9 }, { x: 90, y: 9.9 })).toBe(FORWARD)
  })

  it('does not fire for a car sitting still on the line, or sliding along it', () => {
    expect(crossing(g, at(100), at(100))).toBe(NO_CROSSING)
    expect(crossing(g, { x: 100, y: -5 }, { x: 100, y: 5 })).toBe(NO_CROSSING)
  })

  it('reports its width, middle and the way you drive through it', () => {
    expect(gateWidth(g)).toBe(20)
    expect(midpoint(g)).toEqual({ x: 100, y: 0 })
    const f = gateForward(g)
    expect(f.x).toBeCloseTo(-1, 6) // a→b points +y, so forward is -x
    expect(f.y).toBeCloseTo(0, 6)
  })
})

/* ---- a stage ------------------------------------------------------------------------------- */

const stage: Course = {
  id: 's1', name: 'Test stage', kind: 'stage', penalty_s: 10,
  gates: [
    { ...across('start', 0, 'start'), a: [0, -10], b: [0, 10] },
    across('cp1', 100, 'checkpoint', 1),
    across('cp2', 200, 'checkpoint', 2),
    across('cp3', 300, 'checkpoint', 3),
    across('finish', 400, 'finish'),
  ].map((g) => ({ ...g, a: [g.a[0], 10] as [number, number], b: [g.b[0], -10] as [number, number] })),
  // flipped so that driving in +x is FORWARD through every gate
}

/** Drive from x0 to x1 in one-second steps of `speed` metres. */
function drive(run: Run, x0: number, x1: number, t0 = 0, speed = 20) {
  const events = []
  let x = x0
  let t = t0
  while (x < x1) {
    const nx = Math.min(x1, x + speed)
    events.push(...run.move(t + 1, at(x), at(nx)))
    x = nx
    t += 1
  }
  return events
}

describe('a stage', () => {
  it('times you from the start line to the finish line', () => {
    const run = new Run(stage)
    const events = drive(run, -20, 420)
    expect(events.find((e) => e.at === 'started')).toBeTruthy()
    const fin = events.find((e) => e.at === 'finished')
    expect(fin).toBeTruthy()
    expect(fin.penalties).toBe(0)
    expect(fin.time).toBeGreaterThan(0)
    expect(run.state.missed).toBe(0)
  })

  it('does not start until you cross the line — the clock is not the load time', () => {
    const run = new Run(stage)
    run.move(1, at(-100), at(-50))
    expect(run.state.startedAt).toBeNull()
    expect(run.running).toBe(false)
    expect(run.result(9).time).toBe(0)
  })

  /*
   * THE ANTI-CUT, and it needs no geometry beyond the gates. Nothing watches for a shortcut; gate 3
   * simply arrives while gate 2 is still expected, so 2 is charged for.
   */
  /*
   * DRIVING THROUGH A GATE IS NOT CUTTING IT, however long the step. One `move` can legitimately
   * cross two gates — a chicane's pair are metres apart — so cutting has to mean going AROUND,
   * which is what this does: off to y = 100, past cp2's line, and back.
   */
  const around = (run: Run, t: number) => {
    run.move(t, at(120), { x: 150, y: 100 })                 // swing wide, before cp2
    run.move(t + 1, { x: 150, y: 100 }, { x: 250, y: 100 })  // past cp2, ninety metres off the end of its posts
    run.move(t + 2, { x: 250, y: 100 }, at(260))             // back to the road BEFORE cp3…
    return run.move(t + 3, at(260), at(320))                 // …so cp3 is taken properly, on the road
  }

  it('charges a penalty for a checkpoint you drove around, and keeps going', () => {
    const run = new Run(stage)
    run.move(1, at(-20), at(20))   // start
    run.move(2, at(20), at(120))   // cp1
    const cut = around(run, 3)
    expect(cut.some((e) => e.at === 'missed' && e.gate.id === 'cp2')).toBe(true)
    expect(run.state.missed).toBe(1)
    expect(run.penalties).toBe(10)
    const events = run.move(7, at(320), at(420))
    const fin = events.find((e) => e.at === 'finished')
    expect(fin.penalties).toBe(10)
    expect(fin.total).toBeCloseTo(fin.time + 10, 6)
  })

  it('credits every gate a single long step really did pass through', () => {
    const run = new Run(stage)
    run.move(1, at(-20), at(20))
    const events = run.move(2, at(20), at(420)) // the whole stage in one jump, straight down the road
    expect(events.filter((e) => e.at === 'gate')).toHaveLength(3)
    expect(events.filter((e) => e.at === 'missed')).toHaveLength(0)
    expect(events.find((e) => e.at === 'finished').penalties).toBe(0)
  })

  it('charges for every checkpoint still outstanding when you take the finish', () => {
    const run = new Run(stage)
    run.move(1, at(-20), at(20))
    // straight to the finish down a parallel road, missing all three checkpoints
    run.move(2, at(20), { x: 20, y: 100 })
    run.move(3, { x: 20, y: 100 }, { x: 420, y: 100 })
    const events = run.move(4, { x: 420, y: 100 }, at(420))
    expect(run.state.finishedAt).toBeNull() // it has not crossed the finish LINE yet
    const home = run.move(5, at(380), at(420))
    expect(home.filter((e) => e.at === 'missed')).toHaveLength(3)
    expect(home.find((e) => e.at === 'finished').penalties).toBe(30)
    expect(events).toBeDefined()
  })

  it('does not charge for an optional checkpoint', () => {
    const soft: Course = { ...stage, gates: stage.gates.map((g) => (g.id === 'cp2' ? { ...g, optional: true } : g)) }
    const run = new Run(soft)
    run.move(1, at(-20), at(20))
    run.move(2, at(20), at(120))
    around(run, 3)
    expect(run.state.missed).toBe(0)
  })

  it('says when you cross the finish backwards rather than silently finishing you', () => {
    const run = new Run(stage)
    run.move(1, at(-20), at(20))
    const events = run.move(2, at(420), at(380))
    expect(events.some((e) => e.at === 'wrongway')).toBe(true)
    expect(run.state.finishedAt).toBeNull()
  })

  it('stops recording once it is over', () => {
    const run = new Run(stage)
    drive(run, -20, 420)
    const after = run.move(99, at(420), at(-20))
    expect(after).toEqual([])
  })
})

/* ---- a circuit ----------------------------------------------------------------------------- */

const circuit: Course = {
  id: 'c1', name: 'Test circuit', kind: 'circuit', laps: 2,
  gates: [
    { id: 'sf', name: 'start/finish', role: 'startfinish', a: [0, 10], b: [0, -10] },
    { id: 'sp1', name: 'split 1', role: 'split', order: 1, a: [200, 10], b: [200, -10] },
  ],
}

describe('a circuit', () => {
  /** One lap: out past the split, then back round to the line from behind. */
  function lap(run: Run, t: number) {
    const out = []
    out.push(...run.move(t, at(-20), at(220)))       // over the line and through the split
    out.push(...run.move(t + 1, at(220), { x: 220, y: 200 })) // round the back
    out.push(...run.move(t + 2, { x: -20, y: 200 }, at(-20))) // and back to before the line
    return out
  }

  it('counts a lap only when the splits were taken', () => {
    const run = new Run(circuit)
    run.move(1, at(-20), at(20)) // cross the line: this starts it
    expect(run.state.lap).toBe(0)
    // now back over the line the wrong way and forwards again, without the split
    run.move(2, at(20), at(-20))
    const events = run.move(3, at(-20), at(20))
    expect(events.some((e) => e.at === 'lap')).toBe(false)
    expect(run.state.lap).toBe(0)
  })

  it('counts one when they were, and finishes after the last lap', () => {
    const run = new Run(circuit)
    run.move(1, at(-20), at(20))                 // start
    run.move(2, at(20), at(220))                 // split 1
    const first = run.move(3, at(-20), at(20))   // round to the line again
    expect(first.some((e) => e.at === 'lap')).toBe(true)
    expect(run.state.lap).toBe(1)

    run.move(4, at(20), at(220))
    const second = run.move(5, at(-20), at(20))
    expect(second.find((e) => e.at === 'lap').lap).toBe(2)
    expect(second.some((e) => e.at === 'finished')).toBe(true)
    expect(run.state.lapTimes).toHaveLength(2)
  })

  it('reports where you are while you are going round', () => {
    const run = new Run(circuit)
    run.move(1, at(-20), at(20))
    const r = run.result(5)
    expect(r.lap).toBe(0)
    expect(r.laps).toBe(2)
    expect(r.next?.id).toBe('sp1')
    expect(r.time).toBeCloseTo(4, 6)
  })
})

/* ---- validation ---------------------------------------------------------------------------- */

describe('validating a course catches the ones that load and cannot be driven', () => {
  it('refuses a circuit with no split, because reversing over the line would be a lap', () => {
    const bad: Course = { ...circuit, gates: [circuit.gates[0]] }
    const r = validateCourse(bad)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/at least one split gate/)
    // and the full one passes, so the check is about the split and not about everything
    expect(validateCourse(circuit).errors).toEqual([])
  })

  it('wants a start and a finish', () => {
    expect(validateCourse({ ...stage, gates: stage.gates.filter((g) => g.role !== 'finish') }).errors.join(' ')).toMatch(/finish/)
    expect(validateCourse({ ...stage, gates: stage.gates.filter((g) => g.role !== 'start') }).errors.join(' ')).toMatch(/start/)
  })

  it('warns about a gate narrow enough to drive around, and one wide enough to catch other roads', () => {
    const narrow: Course = { ...circuit, gates: [...circuit.gates, { id: 'n', name: 'n', role: 'split', order: 2, a: [50, 0], b: [50, 2] }] }
    expect(validateCourse(narrow).warnings.join(' ')).toMatch(/narrow enough to drive around/)
    const wide: Course = { ...circuit, gates: [...circuit.gates, { id: 'w', name: 'w', role: 'split', order: 2, a: [50, -200], b: [50, 200] }] }
    expect(validateCourse(wide).warnings.join(' ')).toMatch(/catch traffic on other roads/)
  })

  it('refuses a gate with both ends in the same place', () => {
    const dot: Course = { ...circuit, gates: [...circuit.gates, { id: 'd', name: 'd', role: 'split', order: 2, a: [5, 5], b: [5, 5] }] }
    expect(validateCourse(dot).errors.join(' ')).toMatch(/no width/)
  })

  it('orders the gates by their order, whatever order they are in the file', () => {
    const jumbled: Course = {
      ...stage,
      gates: [...stage.gates].reverse(),
    }
    expect(orderedGates(jumbled).map((g) => g.id)).toEqual(['cp1', 'cp2', 'cp3'])
  })
})

describe('how it reads', () => {
  it('describes a course in one line', () => {
    expect(describeCourse(circuit)).toMatch(/circuit · 2 laps · 1 split/)
    expect(describeCourse(stage)).toMatch(/stage · 3 checkpoints/)
  })

  it('formats a time like a stopwatch', () => {
    expect(clock(4.5)).toBe('4.50')
    expect(clock(64.23)).toBe('1:04.23')
    expect(clock(-1)).toBe('—')
  })
})
