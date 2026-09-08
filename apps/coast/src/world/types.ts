// The authored world: a set of tracks joined into a directed graph, each track
// a plan-view centreline you can lay out node by node.
//
// A track is NOT a list of sections like the built-in stages (src/sim/Stages.ts).
// It is a poly-Bézier through waypoints in real metres — drag a node to move the
// road, drag its handles to change the curvature between nodes, exactly as you
// would in a vector editor. The compiler (compile.ts) resamples that curve at
// SEG_LENGTH and hands the sim the same segment list it has always had, so
// nothing downstream knows the difference.
//
// Everything laid along a track is addressed by `at`: the fraction 0..1 of the
// track's arc length. That survives moving nodes around, which segment indices
// would not.

/** A waypoint on the plan-view centreline. Positions and handles are in metres. */
export interface TrackNode {
  x: number
  z: number
  /** Elevation above the datum, metres (edited in the profile strip). */
  y: number
  /**
   * Bézier control points relative to the node: `out` steers the span leaving it,
   * `in` the span arriving. Absent = auto (a smooth Catmull-Rom shape through the
   * neighbours), which is what a freshly dropped node gets.
   */
  outX?: number
  outZ?: number
  inX?: number
  inZ?: number
  /** Handles stay mirrored through the node (a smooth node); true = a cusp, each handle moves alone. */
  cusp?: boolean
  /** Banking here, 0 = flat, 1 = full Rad Mobile terrace. Interpolated between nodes. */
  bank?: number
}

/** A scene change at `at`: the roadside, road width and base colours from here on. */
export interface SceneStop {
  at: number
  /** A key of SCENES (see scenes.ts). */
  scene: string
  /** Crossfade width as a fraction of the track, for the palette blend. */
  fade?: number
}

/** A time-of-day / weather change at `at`. Two of these give you a Rad Mobile shift mid-stage. */
export interface VibeStop {
  at: number
  /** A key of VIBES (see vibes.ts). */
  vibe: string
  /** Crossfade width as a fraction of the track (default VIBE_FADE). */
  fade?: number
}

/** A single roadside object placed by hand, over and above whatever the scene grows. */
export interface PropRef {
  kind: string
  at: number
  /** Lateral offset in road widths; |offset| > 1 is off the tarmac. */
  offset: number
  scale?: number
  collide?: boolean
}

export type SpanKind =
  /** The sea comes up to the road past a sliver of beach, on `side`. */
  | 'shore'
  /** A bore: walls, ceiling, no sky, dark without headlights. */
  | 'tunnel'
  /** Roadworks: a barrier taper in, a jersey barrier along the lane line, a taper out. */
  | 'workzone'
  /** A continuous rank of building fronts at the kerb on `side`. */
  | 'facades'
  /** Force the guardrail on through here, whatever the scene says. */
  | 'guardrail'
  /** Nothing grows here (leave the view open). */
  | 'clear'

/** A macro element laid over a stretch of road. */
export interface Span {
  kind: SpanKind
  from: number
  to: number
  /** -1 left, +1 right, 0 both / not applicable. */
  side?: -1 | 0 | 1
}

/** An intersection with crossing traffic, at a point. */
export interface Crossing {
  at: number
}

export interface CoastTrack {
  id: string
  name: string
  nodes: TrackNode[]
  scenes: SceneStop[]
  vibes: VibeStop[]
  props: PropRef[]
  spans: Span[]
  crossings: Crossing[]
  /** Next tracks: two ids = a fork (left, right); one = straight on; none = a finish line. */
  next: string[]
  /** Gentle swell under everything: amplitude in metres and its period in segments. */
  roll?: { amp: number; period: number }
  /**
   * Seconds this stage puts on the clock: the starting time when it is the first one, the checkpoint
   * bonus when you reach it. Absent means the game's own timings, which is what the shipped route uses
   * — a short authored track finishes before the clock has said anything unless it sets its own.
   */
  seconds?: number
  /** Where this track sits in the set view (grid units). */
  ui?: { x: number; y: number }
}

export interface WorldData {
  /** Schema version, for migrations. */
  v: 1
  name: string
  /** Track id the run starts on. */
  start: string
  tracks: CoastTrack[]
}

export function emptyTrack(id: string, name: string): CoastTrack {
  // A kilometre of straight road, so a new track is drivable before you touch it.
  return {
    id,
    name,
    nodes: [
      { x: 0, z: 0, y: 0 },
      { x: 0, z: 500, y: 0 },
      { x: 0, z: 1000, y: 0 },
    ],
    scenes: [{ at: 0, scene: 'coast' }],
    vibes: [{ at: 0, vibe: 'day' }],
    props: [],
    spans: [],
    crossings: [],
    next: [],
    ui: { x: 0, y: 0 },
  }
}

export function emptyWorld(name = 'New World'): WorldData {
  const t = emptyTrack('t1', 'Stage 1')
  return { v: 1, name, start: t.id, tracks: [t] }
}

/** Tracks reachable from the start, breadth first — the run's stage pool. */
export function reachable(w: WorldData): CoastTrack[] {
  const by = new Map(w.tracks.map((t) => [t.id, t]))
  const seen = new Set<string>()
  const out: CoastTrack[] = []
  const queue = [w.start]
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const t = by.get(id)
    if (!t) continue
    out.push(t)
    for (const n of t.next) queue.push(n)
  }
  return out
}

/** Longest run from `id` to a finish, in tracks; stops at a loop rather than recursing forever. */
export function routeLengthOf(w: WorldData, id: string, seen: Set<string> = new Set()): number {
  if (seen.has(id)) return 0
  const t = w.tracks.find((x) => x.id === id)
  if (!t) return 0
  const next = new Set(seen)
  next.add(id)
  return 1 + (t.next.length ? Math.max(...t.next.map((n) => routeLengthOf(w, n, next))) : 0)
}

export interface WorldProblem {
  level: 'error' | 'warn'
  text: string
}

/** What is wrong with a world: broken links, loops, unreachable tracks, no finish. */
export function checkWorld(w: WorldData): WorldProblem[] {
  const out: WorldProblem[] = []
  const ids = new Set(w.tracks.map((t) => t.id))
  if (!w.tracks.length) out.push({ level: 'error', text: 'the world has no tracks' })
  if (!ids.has(w.start)) out.push({ level: 'error', text: `the start track “${w.start}” is missing` })
  for (const t of w.tracks) {
    if (t.nodes.length < 2) out.push({ level: 'error', text: `${t.name}: needs at least two waypoints` })
    if (t.next.length > 2) out.push({ level: 'error', text: `${t.name}: a track can lead to at most two others (a fork)` })
    for (const n of t.next) if (!ids.has(n)) out.push({ level: 'error', text: `${t.name}: leads to a missing track “${n}”` })
    if (t.next.includes(t.id)) out.push({ level: 'error', text: `${t.name}: leads to itself` })
  }
  // Cycles: a run must always reach a finish.
  const state = new Map<string, 1 | 2>()
  const by = new Map(w.tracks.map((t) => [t.id, t]))
  const walk = (id: string): boolean => {
    if (state.get(id) === 1) return true
    if (state.get(id) === 2) return false
    state.set(id, 1)
    for (const n of by.get(id)?.next ?? []) if (walk(n)) return true
    state.set(id, 2)
    return false
  }
  if (ids.has(w.start) && walk(w.start)) out.push({ level: 'error', text: 'the route loops: a run would never finish' })
  const live = new Set(reachable(w).map((t) => t.id))
  for (const t of w.tracks) if (!live.has(t.id)) out.push({ level: 'warn', text: `${t.name}: nothing leads here from the start` })
  const ends = reachable(w).filter((t) => !t.next.length)
  if (ids.has(w.start) && !ends.length && !out.some((p) => p.level === 'error')) out.push({ level: 'error', text: 'no finish: every route has to end somewhere' })
  return out
}
