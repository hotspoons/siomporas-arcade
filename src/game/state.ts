// The single mutable run state. Deliberately a plain object, not React state:
// the sim writes to it 60×/s and React reads snapshots of it at ~20Hz (see
// ui/Hud.tsx), so per-frame renders never happen.

import { BOOST_MAX, SHIELD_MAX, START_TIME } from './constants'
import { buildCourse, type CourseItem } from './course'
import { Track } from './track'

export type Phase = 'title' | 'running' | 'wrecked' | 'finished'

export interface Game {
  seed: number
  track: Track
  course: CourseItem[]
  /** Bumped whenever the course is regenerated, so the world rebuilds. */
  courseVersion: number

  phase: Phase
  /** Distance along the centreline. */
  s: number
  /** Forward speed, units/s. */
  v: number
  /** Roll angle around the tube, and its rate. */
  theta: number
  thetaVel: number
  /** Distance lifted off the wall toward the centreline, and its rate. */
  lift: number
  liftVel: number

  shield: number
  boost: number
  boosting: boolean
  timeLeft: number
  elapsed: number
  checkpoints: number
  /** Seconds of post-hit grace remaining. */
  invuln: number

  /** Decaying 0…1 impulses the renderer/HUD read for feedback. */
  hitFlash: number
  pickupFlash: number
  checkpointFlash: number
  shake: number

  /** Cursor into `course`, monotonically advanced by the sim. */
  cursor: number
  /** Best distance reached on this seed, for the title/wreck screens. */
  best: number
}

const DEFAULT_SEED = 1337

function loadBest(seed: number): number {
  try {
    const raw = localStorage.getItem('apex-conduit-best')
    if (!raw) return 0
    return (JSON.parse(raw) as Record<string, number>)[String(seed)] ?? 0
  } catch {
    return 0
  }
}

function saveBest(seed: number, distance: number) {
  try {
    const raw = localStorage.getItem('apex-conduit-best')
    const all = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    all[String(seed)] = Math.round(distance)
    localStorage.setItem('apex-conduit-best', JSON.stringify(all))
  } catch {
    // Private windows and blocked site data throw on both read and write;
    // a missing best score is cosmetic, so swallow it.
  }
}

const track = new Track(DEFAULT_SEED)

export const game: Game = {
  seed: DEFAULT_SEED,
  track,
  course: buildCourse(track, DEFAULT_SEED),
  courseVersion: 0,
  phase: 'title',
  s: 0,
  v: 0,
  theta: 0,
  thetaVel: 0,
  lift: 0,
  liftVel: 0,
  shield: SHIELD_MAX,
  boost: BOOST_MAX,
  boosting: false,
  timeLeft: START_TIME,
  elapsed: 0,
  checkpoints: 0,
  invuln: 0,
  hitFlash: 0,
  pickupFlash: 0,
  checkpointFlash: 0,
  shake: 0,
  cursor: 0,
  best: loadBest(DEFAULT_SEED),
}

const listeners = new Set<() => void>()

/** Notified on phase changes only — HUD numbers are polled, not pushed. */
export function subscribePhase(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setPhase(phase: Phase) {
  if (game.phase === phase) return
  game.phase = phase
  for (const fn of listeners) fn()
}

/** Regenerate the whole course from a new seed and return to the title. */
export function newCourse(seed: number) {
  game.seed = seed >>> 0
  game.track = new Track(game.seed)
  game.course = buildCourse(game.track, game.seed)
  game.courseVersion++
  game.best = loadBest(game.seed)
  resetRun()
  setPhase('title')
}

/** Put the craft back on the start line without touching the course. */
export function resetRun() {
  game.s = 0
  game.v = 0
  game.theta = 0
  game.thetaVel = 0
  game.lift = 0
  game.liftVel = 0
  game.shield = SHIELD_MAX
  game.boost = BOOST_MAX
  game.boosting = false
  game.timeLeft = START_TIME
  game.elapsed = 0
  game.checkpoints = 0
  game.invuln = 0
  game.hitFlash = 0
  game.pickupFlash = 0
  game.checkpointFlash = 0
  game.shake = 0
  game.cursor = 0
  for (const item of game.course) item.taken = false
}

export function startRun() {
  resetRun()
  setPhase('running')
}

export function endRun(outcome: 'wrecked' | 'finished') {
  if (game.s > game.best) {
    game.best = game.s
    saveBest(game.seed, game.s)
  }
  setPhase(outcome)
}
