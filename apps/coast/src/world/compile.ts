// Authored track → road segments. This is the only place that knows how the
// plan-view centreline becomes the classic pseudo-3D representation.
//
// The renderer accumulates `curve` twice per segment (a curvature, not a
// heading), so a segment's curve is simply the heading change across it,
// rescaled into the 2000-unit road scale the rest of the game is authored in:
//
//     curve = Δheading × SEG_LENGTH / CURVE_UNIT
//
// which means a 1.4 km-radius sweeper comes out at curve 3, right where the
// hand-authored stages sit. Anything tighter than MIN_RADIUS is clamped and
// reported, because the pseudo-3D projection cannot show a hairpin.

import { Rng } from '@apex/engine/math/Rng'
import { blankSegment, Stage, type Segment, type StageDesc, type Theme } from '../sim/Road'
import { CROSSING_EVERY, FORK_SEGMENTS, RUNWAY_SEGMENTS, SEG_LENGTH } from '../sim/Tuning'
import { CURVE_UNIT } from '../render/RenderTuning'
import { buildPath, MAX_GRADE, NODE_GRADE, scaleToGrade, STEEP_GRADE, TrackPath } from './path'
import { sceneDef } from './scenes'
import type { CoastTrack, PropRef, WorldData } from './types'

/**
 * Hardest corner the game can take. The limit is not the projection but the car:
 * the centrifugal push at curve c is CENTRIFUGAL × c road widths per second and
 * full lock only buys back STEER_RATE, so past about curve 5 you have to brake and
 * past 9 no amount of steering holds the road. Corners tighter than that are opened
 * out at compile time and flagged in the editor.
 */
export const MAX_CURVE = 9
/** Sweeper radius you should stay above to take a corner flat out. */
export const EASY_RADIUS = 800

/** Radius (m) of a corner drawn at `curve`, and back again. */
export function curveToRadius(curve: number): number {
  return Math.abs(curve) < 1e-6 ? Infinity : (SEG_LENGTH * SEG_LENGTH) / (Math.abs(curve) * CURVE_UNIT)
}
export function radiusToCurve(radius: number): number {
  return (SEG_LENGTH * SEG_LENGTH) / (Math.max(1, radius) * CURVE_UNIT)
}

/** Tightest corner that survives the clamp, in metres of radius. */
export const MIN_RADIUS = curveToRadius(MAX_CURVE)

export interface TrackReport {
  /** Length of real road, metres and segments. */
  metres: number
  segments: number
  /** Seconds flat out at 96 m/s — the number that decides whether the clock is fair. */
  seconds: number
  /** Tightest radius on the track, metres. */
  minRadius: number
  /** Segments whose curvature had to be clamped. */
  clamped: number
  /** Total metres climbed, and the steepest gradient the finished road reaches. */
  climb: number
  maxGrade: number
  /** The steepest gradient the waypoints asked for, before anything was held back. */
  gradeAsked: number
  /** Waypoints whose height had to be pulled toward their neighbours to stay drivable. */
  waypointsFlattened: number
  /** What the finished profile had to be scaled by as a last resort (1 = nothing). */
  gradeScale: number
  /**
   * The finished road's height at every segment boundary — what the car will drive, after
   * the swell, the levelling and the gradient guarantee. The editor's profile strip draws
   * this rather than re-deriving it, so the strip cannot disagree with the game.
   */
  profile: number[]
  problems: string[]
}

export interface CompiledTrack {
  stage: Stage
  report: TrackReport
}

/** The scene index (into the track's scene list) at fraction `at`. */
function sceneIndexAt(track: CoastTrack, at: number): number {
  const stops = sortedScenes(track)
  let idx = 0
  for (let i = 0; i < stops.length; i++) if (at >= stops[i].at) idx = i
  return idx
}

export function sortedScenes(track: CoastTrack): { at: number; scene: string; fade?: number }[] {
  const s = track.scenes.length ? [...track.scenes].sort((a, b) => a.at - b.at) : [{ at: 0, scene: 'coast' }]
  if (s[0].at > 0) s[0] = { ...s[0], at: 0 }
  return s
}

/** Themes for a track, in scene-stop order, with the segment table indexing them. */
export function trackThemes(track: CoastTrack): Theme[] {
  return sortedScenes(track).map((s) => sceneDef(s.scene).theme)
}

/** Place a prop on the segment its arc fraction falls in. */
function placeProp(segs: Segment[], real: number, p: PropRef): void {
  const i = Math.min(real - 1, Math.max(0, Math.round(p.at * (real - 1))))
  segs[i].sprites.push({ kind: p.kind, offset: p.offset, scale: p.scale ?? 1, collide: p.collide ?? true })
}

/**
 * Compile one authored track into a Stage the sim can drive.
 *
 * `seed` only drives the scatter of scenery, exactly as it does for the
 * built-in stages, so the road itself is identical run to run.
 */
export function compileTrack(track: CoastTrack, seed: number, path?: TrackPath): CompiledTrack {
  const p = path ?? buildPath(track.nodes)
  const themes = trackThemes(track)
  const rng = new Rng(seed)
  const problems: string[] = []
  const real = Math.max(2, Math.round(p.length / SEG_LENGTH))
  const segs: Segment[] = []
  let clamped = 0
  let minRadius = Infinity
  let climb = 0

  // --- elevation ------------------------------------------------------------
  // One height per segment boundary, so the profile can be levelled and grade-limited as a
  // whole before it becomes segments. The swell goes on first: the limit has to govern the
  // road the car actually drives, not the profile before the ripple was added.
  const roll = track.roll ?? { amp: 3.2, period: 52 }
  const periods = roll.amp > 0 ? Math.max(1, Math.round(real / Math.max(8, roll.period))) : 0
  const ys: number[] = []
  for (let i = 0; i <= real; i++) ys.push(p.elevationAt(Math.min(p.length, i * SEG_LENGTH)) + (periods ? roll.amp * Math.sin((i / real) * Math.PI * 2 * periods) : 0))

  // Bring the end back to the datum so stages join without a step, over enough road that
  // the ramp itself is not a cliff — a smoothstep peaks at 1.5× its average gradient, and
  // it is laid over a profile that may already be using its whole budget, so allow 3×.
  const level = (target: number) => {
    const drift = ys[real] - target
    if (Math.abs(drift) < 0.05) return 0
    const need = Math.ceil((3 * Math.abs(drift)) / (SEG_LENGTH * MAX_GRADE))
    const n = Math.max(40, Math.min(Math.floor(real * 0.7), need))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      ys[real - n + k] -= drift * t * t * (3 - 2 * t)
    }
    return need
  }
  const needed = level(0)
  const graded = scaleToGrade(ys, SEG_LENGTH)
  if (needed > real * 0.7) problems.push('the last waypoint sits far off the datum — the run back down to the next stage eats most of the track')
  if (p.gradeClamped) problems.push(`${p.gradeClamped} waypoint${p.gradeClamped === 1 ? '' : 's'} asked for a ${Math.round(p.worstGrade * 100)} % climb and ${p.gradeClamped === 1 ? 'was' : 'were'} pulled back to ${Math.round(NODE_GRADE * 100)} % — space them further apart to climb higher`)
  if (graded.factor < 1) problems.push(`the hills asked for a ${Math.round(graded.worst * 100)} % gradient, which is a wall — the whole profile was flattened to ${Math.round(graded.factor * 100)} % of the height you drew`)

  // --- geometry -------------------------------------------------------------
  const headings: number[] = []
  for (let i = 0; i <= real; i++) headings.push(p.headingAt(Math.min(p.length, i * SEG_LENGTH)))
  let maxGrade = 0
  for (let i = 0; i < real; i++) {
    const dHeading = headings[i + 1] - headings[i]
    let curve = (dHeading * SEG_LENGTH) / CURVE_UNIT
    if (Math.abs(curve) > MAX_CURVE) {
      curve = Math.sign(curve) * MAX_CURVE
      clamped++
    }
    if (Math.abs(dHeading) > 1e-6) minRadius = Math.min(minRadius, SEG_LENGTH / Math.abs(dHeading))
    climb += Math.max(0, ys[i + 1] - ys[i])
    maxGrade = Math.max(maxGrade, Math.abs(ys[i + 1] - ys[i]) / SEG_LENGTH)
    const seg = blankSegment(i, curve, ys[i], ys[i + 1], p.bankAt((i + 0.5) * SEG_LENGTH))
    seg.scene = sceneIndexAt(track, (i + 0.5) / real)
    segs.push(seg)
  }
  if (clamped) problems.push(`${clamped} segment${clamped === 1 ? '' : 's'} tighter than ${Math.round(MIN_RADIUS)} m had to be opened out — widen those corners`)
  if (minRadius < EASY_RADIUS) problems.push(`tightest corner is ${Math.round(minRadius)} m radius: you will have to brake for it (${EASY_RADIUS} m+ is flat out)`)
  if (graded.factor === 1 && !p.gradeClamped && maxGrade > STEEP_GRADE) problems.push(`steepest climb is ${Math.round(maxGrade * 100)} % — steep, but drivable`)

  const forks = track.next.length === 2
  segs[0].checkpoint = true
  if (forks) {
    for (let i = 0; i < FORK_SEGMENTS && i < real; i++) {
      const s = segs[real - FORK_SEGMENTS + i]
      if (!s) continue
      s.fork = (i + 1) / FORK_SEGMENTS
      s.curve = 0
      s.tunnel = false
      s.closed = 0
    }
  }
  const forkFrom = forks ? (real - FORK_SEGMENTS) / real : 1.1

  // --- macro elements -------------------------------------------------------
  const idx = (at: number) => Math.min(real - 1, Math.max(0, Math.round(at * (real - 1))))
  for (const span of track.spans) {
    const a = idx(Math.min(span.from, span.to))
    const b = idx(Math.max(span.from, span.to))
    const side = span.side ?? 0
    switch (span.kind) {
      case 'shore':
        for (let i = a; i <= b; i++) segs[i].shore = (side || 1) as -1 | 1
        break
      case 'tunnel':
        for (let i = a; i <= b; i++) {
          segs[i].tunnel = true
          segs[i].shore = 0
          segs[i].sprites.length = 0
        }
        if (b > a) segs[a].portal = true
        break
      case 'guardrail':
        // Handled per-scene by the renderer; the span forces it on with a rail sprite line.
        for (let i = a; i <= b; i += 2) for (const e of side ? [side] : [-1, 1]) segs[i].sprites.push({ kind: 'barrier', offset: e * 1.06, scale: 0.75, collide: true })
        break
      case 'workzone': {
        const s = (side || (rng.next() < 0.5 ? -1 : 1)) as -1 | 1
        const taper = [0.98, 0.84, 0.7, 0.58]
        taper.forEach((o, k) => {
          const i = a + k * 2
          if (i <= b) segs[i].sprites.push({ kind: 'barrier', offset: s * o, scale: 0.8, collide: true })
        })
        for (let i = a + 8; i <= b - 8; i++) if (segs[i]) segs[i].closed = s
        taper.forEach((o, k) => {
          const i = b - k * 2
          if (i >= a) segs[i].sprites.push({ kind: 'barrier', offset: s * o, scale: 0.8, collide: true })
        })
        break
      }
      case 'facades': {
        const kinds = ['facade1', 'facade2', 'facade3', 'facade4']
        for (let i = a; i <= b; i++) for (const e of side ? [side] : [-1, 1]) segs[i].sprites.push({ kind: kinds[rng.int(kinds.length)], offset: e * rng.range(1.5, 1.56), scale: 1, collide: true })
        break
      }
      case 'clear':
        for (let i = a; i <= b; i++) segs[i].sprites.length = 0
        break
    }
  }
  for (const c of track.crossings) {
    const i = idx(c.at)
    if (segs[i].tunnel || i / real >= forkFrom) continue
    segs[i].crossing = true
    if (segs[i + 1]) segs[i + 1].crossing = true
  }
  // Scenes that come with crossroads or roadworks lay their own, but only where you
  // have not placed any yourself — pick Downtown and you get a junction for free;
  // place one and the scene stops guessing.
  if (!track.crossings.length) {
    for (let i = CROSSING_EVERY; i < real - FORK_SEGMENTS - 20; i += CROSSING_EVERY) {
      const seg = segs[i]
      if (!(themes[seg.scene] ?? themes[0]).crossings) continue
      if (Math.abs(seg.curve) > 1.2 || seg.tunnel) continue
      seg.crossing = true
      if (segs[i + 1]) segs[i + 1].crossing = true
    }
  }
  if (!track.spans.some((s) => s.kind === 'workzone')) {
    let i = 120 + rng.int(160)
    while (i + 90 < real - FORK_SEGMENTS - 30) {
      if ((themes[segs[i].scene] ?? themes[0]).workZones) {
        const s = (rng.next() < 0.5 ? -1 : 1) as -1 | 1
        const len = 40 + rng.int(40)
        const taper = [0.98, 0.84, 0.7, 0.58]
        taper.forEach((o, k) => segs[i + k * 2]?.sprites.push({ kind: 'barrier', offset: s * o, scale: 0.8, collide: true }))
        for (let k = 8; k < len - 8; k++) if (segs[i + k] && !segs[i + k].tunnel) segs[i + k].closed = s
        taper.forEach((o, k) => segs[i + len - 1 - k * 2]?.sprites.push({ kind: 'barrier', offset: s * o, scale: 0.8, collide: true }))
        i += len
      }
      i += 260 + rng.int(220)
    }
  }

  // --- scenery ---------------------------------------------------------------
  const cleared = new Set<number>()
  for (const span of track.spans) if (span.kind === 'clear' || span.kind === 'tunnel') for (let i = idx(Math.min(span.from, span.to)); i <= idx(Math.max(span.from, span.to)); i++) cleared.add(i)
  for (let i = 8; i < real; i++) {
    const seg = segs[i]
    if (seg.tunnel || cleared.has(i) || seg.fork > 0.15) continue
    if (segs[Math.max(0, i - 3)].crossing || segs[Math.min(real - 1, i + 3)].crossing || seg.crossing) continue
    const theme = themes[seg.scene] ?? themes[0]
    for (const side of [-1, 1] as const) {
      if (seg.shore === side) continue
      if (rng.next() >= theme.density) continue
      const total = theme.roadside.reduce((acc, x) => acc + x.weight, 0)
      let pick = rng.next() * total
      let r = theme.roadside[0]
      for (const cand of theme.roadside) {
        pick -= cand.weight
        if (pick < 0) {
          r = cand
          break
        }
      }
      if (!r) continue
      seg.sprites.push({ kind: r.kind, offset: side * rng.range(r.minOffset, r.maxOffset), scale: (r.scale ?? 1) * rng.range(0.9, 1.15), collide: r.collide ?? true })
    }
    if (theme.landmarks.length && i % theme.landmarkEvery === 0) {
      const k = theme.landmarks[Math.floor(i / theme.landmarkEvery) % theme.landmarks.length]
      // Alternate sides, but never build a diner in the sea.
      let side = Math.floor(i / theme.landmarkEvery) % 2 === 0 ? -1 : 1
      if (seg.shore === side) side = -side as -1 | 1
      if (seg.shore !== side) seg.sprites.push({ kind: k, offset: side * 1.9, scale: 1, collide: true })
    }
  }
  // Hand-placed props go on last, so they always survive the scatter.
  for (const prop of track.props) placeProp(segs, real, prop)
  if (segs.length > 2 && !track.props.some((x) => x.kind === 'gantry')) segs[2].sprites.push({ kind: 'gantry', offset: 0, scale: 1, collide: false })

  // --- runway ---------------------------------------------------------------
  const endY = segs[real - 1].y1
  for (let i = 0; i < RUNWAY_SEGMENTS; i++) {
    const s = blankSegment(real + i, 0, endY, endY)
    s.runway = true
    s.fork = forks ? 1 : -1
    s.scene = segs[real - 1].scene
    segs.push(s)
  }

  const desc: StageDesc = { id: track.id, name: track.name, theme: themes[0].id, sections: [], next: [...track.next] }
  const stage = new Stage(desc, themes[0], seed, { segments: segs, length: real, forks, scenes: themes, vibes: track.vibes.length ? [...track.vibes] : [{ at: 0, vibe: 'day' }], seconds: track.seconds })
  const metres = real * SEG_LENGTH
  const seconds = metres / 90
  // TIME_START is 75 s and each checkpoint adds 62: a stage much under half a minute is over before
  // the clock has said anything — unless the track sets its own, which is what the Clock control does.
  if (seconds < 30 && track.seconds === undefined)
    problems.push(`only ${seconds.toFixed(0)} s flat out — under half a minute the clock never gets going (aim for 45–60 s, or set this stage's own Clock)`)
  if (track.seconds !== undefined && track.seconds < seconds * 0.75)
    problems.push(`the clock gives ${track.seconds} s but the road takes about ${seconds.toFixed(0)} s flat out — nobody will reach the end`)
  return {
    stage,
    report: { metres, segments: real, seconds, minRadius: minRadius === Infinity ? Infinity : minRadius, clamped, climb, maxGrade, gradeAsked: Math.max(p.worstGrade, graded.worst), waypointsFlattened: p.gradeClamped, gradeScale: graded.factor, profile: ys, problems },
  }
}

/** A world compiled for a run: every reachable track built once, keyed by id. */
export class CompiledWorld {
  readonly data: WorldData
  readonly stages = new Map<string, Stage>()
  readonly reports = new Map<string, TrackReport>()
  private readonly seed: number

  constructor(data: WorldData, seed: number) {
    this.data = data
    this.seed = seed
  }

  /** Build (and cache) a stage. Stages are built on demand: a big world need not compile all at once. */
  stage(id: string): Stage | null {
    const cached = this.stages.get(id)
    if (cached) return cached
    const track = this.data.tracks.find((t) => t.id === id)
    if (!track || track.nodes.length < 2) return null
    const out = compileTrack(track, this.seed * 31 + id.length * 7 + (id.charCodeAt(0) || 1))
    this.stages.set(id, out.stage)
    this.reports.set(id, out.report)
    return out.stage
  }
}
