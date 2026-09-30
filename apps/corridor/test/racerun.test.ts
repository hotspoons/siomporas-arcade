// Driving into a throbber, counting down, racing, and giving up.
//
// Rich, 2026-09-29: *"we'll need to be able to place entry points you drive through to commit you
// into a race and the ability to exit the race … Think race areas in Forza Horizon."*
//
// Every one of these is a question a screenshot cannot answer — does the countdown block the start
// line, does sitting in the marker retrigger, does finishing a circuit inside its own marker
// restart it — so the whole session is driven here from a list of coordinates.
import { describe, expect, it } from 'vitest'
import { RaceSession, resultLines } from '../src/racerun'
import type { Course } from '../src/races'

/** A stage along the x axis: enter at 0, start at 100, checkpoints, finish at 500. */
const stage = (over: Partial<Course> = {}): Course => ({
  id: 's1', name: 'Test stage', kind: 'stage', penalty_s: 10,
  entry: { x: 0, y: 0, r: 12 },
  gates: [
    { id: 'start', name: 'start', role: 'start', a: [100, 10], b: [100, -10] },
    { id: 'cp1', name: 'cp1', role: 'checkpoint', order: 1, a: [200, 10], b: [200, -10] },
    { id: 'cp2', name: 'cp2', role: 'checkpoint', order: 2, a: [300, 10], b: [300, -10] },
    { id: 'finish', name: 'finish', role: 'finish', a: [500, 10], b: [500, -10] },
  ],
  ...over,
})

const at = (x: number, y = 0) => ({ x, y })

/** Drive from x0 to x1 in `step` metre hops of one second each. */
function drive(s: RaceSession, x0: number, x1: number, step = 20) {
  const out = []
  for (let x = x0; x <= x1; x += step) out.push(s.tick(at(x), 1))
  return out
}

describe('driving into the throbber', () => {
  it('commits you to the race, but does not start the clock', () => {
    const s = new RaceSession([stage()])
    expect(s.state.phase).toBe('idle')
    s.tick(at(-40), 1)
    expect(s.state.phase).toBe('idle')
    s.tick(at(0), 1) // into the marker
    expect(s.state.phase).toBe('armed')
    expect(s.state.course?.id).toBe('s1')
    expect(s.state.time).toBe(0)
    expect(s.state.message).toMatch(/drive to the start line/)
  })

  /*
   * SITTING IN IT MUST NOT RETRIGGER. A marker that arms every frame you are inside it resets the
   * race you are trying to start, which reads as the game refusing to begin.
   */
  it('does not re-arm while you sit in it', () => {
    const s = new RaceSession([stage()])
    s.tick(at(0), 1)
    const armedAt = s.state.course
    for (let i = 0; i < 10; i++) s.tick(at(0), 1)
    expect(s.state.phase).toBe('armed')
    expect(s.state.course).toBe(armedAt)
  })

  it('offers its markers to the renderer, and stops throbbing once a race is on', () => {
    const s = new RaceSession([stage()])
    expect(s.markers).toHaveLength(1)
    expect(s.markers[0]).toMatchObject({ x: 0, y: 0, r: 12, active: true })
    s.tick(at(0), 1)
    expect(s.markers[0].active).toBe(false)
  })

  it('picks the smallest marker where two overlap', () => {
    const big = stage({ id: 'big', entry: { x: 0, y: 0, r: 60 } })
    const small = stage({ id: 'small', entry: { x: 0, y: 0, r: 10 } })
    const s = new RaceSession([big, small])
    s.tick(at(2), 1)
    expect(s.state.course?.id).toBe('small')
  })
})

describe('the countdown', () => {
  it('holds you at the line and starts the clock on GO', () => {
    const s = new RaceSession([stage()], { countdown: 3 })
    s.tick(at(0), 1)
    // PAST the line, not onto it: a step that lands exactly on a gate is deferred to the next one,
    // which is what stops a car sampled on round numbers reporting a crossing it has not made
    drive(s, 20, 120)
    expect(s.state.phase).toBe('countdown')
    expect(s.state.time).toBe(0)

    s.tick(at(100), 1)
    expect(s.state.countdown).toBeCloseTo(2, 6)
    expect(s.state.message).toBe('2')
    s.tick(at(100), 1)
    s.tick(at(100), 1)
    expect(s.state.phase).toBe('running')
    expect(s.state.message).toMatch(/^0\./) // the clock is running from zero, not from the commit
  })

  it('starts immediately when there is no countdown', () => {
    const s = new RaceSession([stage()])
    s.tick(at(0), 1)
    drive(s, 20, 120)
    expect(s.state.phase).toBe('running')
  })
})

describe('the race itself', () => {
  it('runs from the line to the finish and reports a time', () => {
    const s = new RaceSession([stage()])
    s.tick(at(0), 1)
    const ticks = drive(s, 20, 520)
    expect(s.state.phase).toBe('finished')
    expect(s.state.result).toBeTruthy()
    expect(s.state.result!.penalties).toBe(0)
    expect(s.state.result!.total).toBeGreaterThan(0)
    expect(ticks.some((t) => t.events.some((e) => e.at === 'finished'))).toBe(true)
    expect(resultLines(s.state)[0]).toMatch(/Test stage/)
  })

  it('charges for a checkpoint you drove around, and says so on the screen', () => {
    const s = new RaceSession([stage()])
    s.tick(at(0), 1)
    drive(s, 20, 220)            // over the start line and through cp1
    s.tick({ x: 250, y: 90 }, 1)  // off the road…
    s.tick({ x: 420, y: 90 }, 1)  // …round the outside of cp2, well past its posts…
    s.tick({ x: 440, y: 0 }, 1)   // …and back on, before the finish
    /*
     * A CUT IS ONLY CHARGED WHEN A LATER GATE ARRIVES. Nothing watches for the shortcut itself —
     * the finish turning up while cp2 is still expected is the whole mechanism — so the penalty
     * lands on the finish line, not out in the field.
     */
    const t = s.tick({ x: 520, y: 0 }, 1)
    expect(s.state.result?.penalties ?? s.state.penalties).toBe(10)
    expect(t.banner ?? s.state.message).toMatch(/missed|\+10s|finished/)
  })

  it('can always be given up', () => {
    const s = new RaceSession([stage()])
    s.tick(at(0), 1)
    drive(s, 20, 200)
    expect(s.state.phase).toBe('running')
    s.abandon()
    expect(s.state.phase).toBe('abandoned')
    expect(s.state.message).toMatch(/abandoned/)
    // and driving on afterwards does nothing
    drive(s, 220, 520)
    expect(s.state.phase).toBe('abandoned')
  })

  it('can be started by name, for a program or a menu', () => {
    const s = new RaceSession([stage()])
    expect(s.start('nope')).toBe(false)
    expect(s.start('s1')).toBe(true)
    expect(s.state.phase).toBe('armed')
  })
})

describe('a circuit', () => {
  const circuit: Course = {
    id: 'c1', name: 'Test circuit', kind: 'circuit', laps: 2,
    entry: { x: 0, y: 0, r: 12 },
    gates: [
      { id: 'sf', name: 'start/finish', role: 'startfinish', a: [100, 10], b: [100, -10] },
      { id: 'sp', name: 'split', role: 'split', order: 1, a: [300, 10], b: [300, -10] },
    ],
  }

  it('counts laps and finishes after the last one', () => {
    const s = new RaceSession([circuit])
    s.tick(at(0), 1)
    drive(s, 20, 120)            // over the line: running
    expect(s.state.phase).toBe('running')
    for (let lap = 1; lap <= 2; lap++) {
      s.tick(at(320), 1)          // the split
      s.tick(at(20), 1)           // round the back to before the line
      s.tick(at(120), 1)          // over the line again
    }
    expect(s.state.phase).toBe('finished')
    expect(s.state.result!.laps).toHaveLength(2)
  })

  /*
   * FINISHING INSIDE YOUR OWN MARKER must not instantly restart the race, which is the normal
   * layout for a circuit: you drive into the throbber beside the start line.
   */
  it('does not restart when the finish is inside the entry marker', () => {
    const near: Course = { ...circuit, entry: { x: 100, y: 0, r: 30 } }
    const s = new RaceSession([near])
    s.tick(at(100), 1)
    drive(s, 110, 130)
    for (let lap = 1; lap <= 2; lap++) {
      s.tick(at(320), 1)
      s.tick(at(80), 1)
      s.tick(at(120), 1)
    }
    expect(s.state.phase).toBe('finished')
    for (let i = 0; i < 5; i++) s.tick(at(100), 1) // sitting on the line, inside the marker
    expect(s.state.phase).toBe('finished')
  })
})
