// A race you can actually drive: roll into the marker, count down, go, finish or give up.
//
// Rich, 2026-09-29: *"Goal for the morning is being able to hook up a rally stage or a circuit from
// waypoints … we'll need to be able to place entry points you drive through to commit you into a
// race and the ability to exit the race … Think race areas in Forza Horizon where you drive into a
// throbber and you enter the race."*
//
// WHAT IS HERE AND WHAT IS NOT. `races.ts` owns the RULES — did that movement cross that line,
// which way, in what order. This owns the SESSION: which course you are in, what the clock is
// doing, and what the screen should say. It takes positions and a delta and gives back a state and
// a list of things that just happened, so a whole race can be driven in a test from a list of
// coordinates — which is the only way "does the countdown block the start line" has an answer.
//
// NO DOM, NO THREE, NO ECS. The HUD reads `state`; the renderer reads `markers`; neither is in here.
//
// THE STATES ARE A LINE, NOT A GRAPH:
//
//   idle → armed → countdown → running → finished
//                     ↑                      │
//                     └──────── abandoned ───┘
//
// `armed` is the bit that is easy to leave out and is the whole feel of it: you have committed, the
// race is chosen, and you are rolling up to the line under your own power. Nothing is timed yet.

import {
  clock, entryAt, finishGate, orderedGates, Run, startGate,
  type Course, type Gate, type RaceEvent,
} from './races'

export type RacePhase = 'idle' | 'armed' | 'countdown' | 'running' | 'finished' | 'abandoned'

export interface RaceState {
  phase: RacePhase
  course: Course | null
  /** seconds left of the countdown, or 0 */
  countdown: number
  /** elapsed race time, seconds */
  time: number
  penalties: number
  total: number
  lap: number
  laps: number
  /** the gate you are being sent to next, for a marker and for an arrow */
  next: Gate | null
  /** what to put on the screen right now — one line, already written for a person */
  message: string
  /** the result, once there is one */
  result: { time: number; penalties: number; total: number; laps: number[] } | null
}

export interface RaceOpts {
  /** seconds of countdown after you commit. 0 starts immediately */
  countdown?: number
  /**
   * How long the banner for a gate or a penalty stays up, seconds. Purely presentational, and here
   * rather than in the HUD so a test can assert what the screen said.
   */
  toast?: number
}

export interface RaceTick {
  state: RaceState
  /** everything that happened this tick, oldest first — for sound, for a HUD, for a program */
  events: RaceEvent[]
  /** a line worth showing prominently, or null */
  banner: string | null
}


/**
 * One session over a set of courses.
 *
 * Fed the player's position every frame. It decides when a race starts, keeps the clock, and hands
 * back what to draw.
 */
export class RaceSession {
  private courses: Course[]
  private opts: RaceOpts
  private phase: RacePhase = 'idle'
  private course: Course | null = null
  private run: Run | null = null
  private countdown = 0
  private t = 0
  private last: { x: number; y: number } | null = null
  private banner: string | null = null
  private bannerUntil = 0
  private result: RaceState['result'] = null
  /**
   * The entry you are currently standing in.
   *
   * Remembered so that leaving and re-entering can arm you again, and — more to the point — so
   * that finishing a race INSIDE its own entry marker does not instantly re-arm it, which is what
   * happens on a circuit whose start line is where you drove in.
   */
  private inside: string | null = null

  constructor(courses: Course[], opts: RaceOpts = {}) {
    this.courses = courses
    this.opts = opts
  }

  /** The courses this session can start, for a menu or a program. */
  get list(): readonly Course[] {
    return this.courses
  }

  /** Every entry marker, for the renderer's throbbers. */
  get markers(): { course: Course; x: number; y: number; r: number; active: boolean }[] {
    return this.courses
      .filter((c) => c.entry)
      .map((c) => ({
        course: c, x: c.entry!.x, y: c.entry!.y, r: c.entry!.r || 12,
        // a marker stops throbbing while ANY race is on: you cannot enter two
        active: this.phase === 'idle',
      }))
  }

  get state(): RaceState {
    const r = this.run?.result(this.t)
    return {
      phase: this.phase,
      course: this.course,
      countdown: this.countdown,
      time: r?.time ?? 0,
      penalties: r?.penalties ?? 0,
      total: r?.total ?? 0,
      lap: r?.lap ?? 0,
      laps: r?.laps ?? 1,
      next: r?.next ?? null,
      message: this.message(),
      result: this.result,
    }
  }

  private message(): string {
    const c = this.course
    switch (this.phase) {
      case 'idle': return ''
      case 'armed': return c ? `${c.name} — drive to the start line` : ''
      case 'countdown': return this.countdown > 0.5 ? String(Math.ceil(this.countdown)) : 'GO'
      case 'running': {
        const r = this.run!.result(this.t)
        if (c?.kind === 'circuit') return `lap ${Math.min(r.lap + 1, r.laps)} of ${r.laps} — ${clock(r.time)}`
        return `${clock(r.time)}${r.penalties ? ` +${r.penalties}s` : ''}`
      }
      case 'finished': return this.result ? `finished — ${clock(this.result.total)}` : 'finished'
      case 'abandoned': return 'race abandoned'
    }
  }

  /**
   * Start one by name, from a program or a menu, without driving into its marker.
   *
   * Returns false for a course this session does not have, rather than throwing: a program naming
   * a race that was deleted should say nothing happened, not take the game down.
   */
  start(id: string): boolean {
    const c = this.courses.find((x) => x.id === id)
    if (!c || this.phase === 'running' || this.phase === 'countdown') return false
    this.arm(c)
    return true
  }

  private arm(c: Course) {
    this.course = c
    this.run = new Run(c)
    this.phase = 'armed'
    this.result = null
    this.say(c.intro ?? `${c.name} — ${c.kind === 'circuit' ? `${c.laps ?? 1} laps` : `${orderedGates(c).length} checkpoints`}`)
  }

  /** Give up. The one thing a player must always be able to do. */
  abandon(): void {
    if (this.phase === 'idle' || this.phase === 'finished') return
    this.phase = 'abandoned'
    this.say('race abandoned')
    this.run = null
  }

  /** Back to nothing — after a result screen, or when the player drives away. */
  reset(): void {
    this.phase = 'idle'
    this.course = null
    this.run = null
    this.countdown = 0
    this.result = null
  }

  private say(text: string) {
    this.banner = text
    this.bannerUntil = this.t + (this.opts.toast ?? 3)
  }

  /**
   * Advance. `at` is the player's position in site metres; `dt` in seconds.
   *
   * THE MOVEMENT IS THE PAIR OF POSITIONS, not the current one: every gate test in `races.ts` is a
   * segment against a segment, which is what makes it impossible to drive through a line at speed
   * without being counted.
   */
  tick(at: { x: number; y: number }, dt: number): RaceTick {
    this.t += dt
    const from = this.last ?? at
    this.last = { x: at.x, y: at.y }
    const events: RaceEvent[] = []

    if (this.bannerUntil && this.t > this.bannerUntil) {
      this.banner = null
      this.bannerUntil = 0
    }

    /*
     * COMMITTING. Entering a marker arms the race; you have to LEAVE it before it can arm again, so
     * sitting in the throbber does not re-trigger every frame, and finishing a circuit inside its
     * own marker does not immediately restart it.
     */
    const here = entryAt(this.courses, at.x, at.y)
    if (here?.id !== this.inside) {
      this.inside = here?.id ?? null
      if (here && this.phase === 'idle') this.arm(here)
    }

    switch (this.phase) {
      case 'armed': {
        // the countdown begins when you reach the start line, not when you commit
        const start = this.course && startGate(this.course)
        if (start && this.run) {
          const crossed = this.run.move(this.t, from, at)
          if (crossed.some((e) => e.at === 'started')) {
            const n = this.opts.countdown ?? 0
            if (n > 0) {
              /*
               * A COUNTDOWN AFTER THE LINE would be a countdown you drive through. So crossing the
               * line while armed REWINDS the run and holds you: the clock starts on GO, from a
               * standing start at the line, which is what a countdown is for.
               */
              this.run = new Run(this.course!)
              this.countdown = n
              this.phase = 'countdown'
              this.say('get ready')
            } else {
              this.phase = 'running'
              events.push(...crossed)
              this.say('GO')
            }
          }
        }
        break
      }
      case 'countdown': {
        this.countdown = Math.max(0, this.countdown - dt)
        if (this.countdown <= 0) {
          this.phase = 'running'
          // the line is behind you now, so the run is started explicitly rather than by crossing
          this.run = new Run(this.course!)
          this.run.move(this.t, { x: at.x - 1e-6, y: at.y }, at)
          this.forceStart()
          this.say('GO')
        }
        break
      }
      case 'running': {
        if (!this.run) break
        events.push(...this.run.move(this.t, from, at))
        for (const e of events) {
          if (e.at === 'missed') this.say(`missed ${e.gate.name} — +${this.course?.penalty_s ?? 10}s`)
          else if (e.at === 'lap') this.say(`lap ${e.lap} — ${clock(e.lapTime)}`)
          else if (e.at === 'wrongway') this.say('wrong way')
          else if (e.at === 'finished') {
            this.phase = 'finished'
            this.result = { time: e.time, penalties: e.penalties, total: e.total, laps: [...this.run.state.lapTimes] }
            this.say(this.course?.outro ?? `finished — ${clock(e.total)}`)
          }
        }
        break
      }
      default:
        break
    }

    return { state: this.state, events, banner: this.banner }
  }

  /**
   * Put the run into its started state without a crossing.
   *
   * Used only by the countdown, where the line has already been crossed once and rewound. Reaching
   * into `state` is deliberate and is why it is one method with a name rather than scattered
   * assignments: the run's own rule is that the clock starts at the line, and this is the single
   * documented exception to it.
   */
  private forceStart() {
    if (!this.run) return
    this.run.state.startedAt = this.t
    this.run.state.lastLapAt = this.t
  }
}

/** A results screen, as lines of text — for the menu, a toast, or a test. */
export function resultLines(s: RaceState): string[] {
  if (!s.result) return []
  const out = [`${s.course?.name ?? 'race'} — ${clock(s.result.total)}`]
  if (s.result.penalties) out.push(`${clock(s.result.time)} driving + ${s.result.penalties}s penalties`)
  s.result.laps.forEach((l, i) => out.push(`lap ${i + 1}  ${clock(l)}`))
  return out
}

/** Which gate a player should be aiming at, for an on-screen arrow. */
export function nextGate(s: RaceState): Gate | null {
  if (s.phase !== 'running' || !s.course) return null
  return s.next ?? finishGate(s.course)
}
