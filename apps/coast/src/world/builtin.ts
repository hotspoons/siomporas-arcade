// Turning the hand-authored route into something the editor can open.
//
// The built-in world is a list of sections, not waypoints, so it cannot be
// edited in place — but it can be traced. Build each stage the normal way, walk
// its segments integrating the curvature into a plan-view line, and drop a
// waypoint every few hundred metres. What comes out drives almost identically
// and is now a track you can pull about.

import { Stage, type StageDesc, type Theme } from '../sim/Road'
import { ROLL_AMPLITUDE, SEG_LENGTH } from '../sim/Tuning'
import { CURVE_UNIT } from '../render/RenderTuning'
import { STAGES, STAGE_BY_ID, THEMES } from '../sim/Stages'
import type { CoastTrack, Crossing, SceneStop, Span, TrackNode, VibeStop, WorldData } from './types'

/** One waypoint per this many segments — often enough to keep the shape, sparse enough to edit. */
const NODE_EVERY = 40

/** Which editor scene stands in for a built-in theme. */
const SCENE_FOR_THEME: Record<string, string> = {
  coast: 'coast',
  sunset: 'strip',
  cliffs: 'cliffs',
  canyon: 'canyon',
  desert: 'desert',
  forest: 'forest',
  alpine: 'alpine',
  plains: 'plains',
  ridge: 'ridge',
  city: 'city',
  nightCity: 'neonCity',
  night: 'boulevard',
  storm: 'forest',
}

/** Which vibe the theme's own flags amount to. */
export function vibeForTheme(t: Theme): string {
  if (t.night && t.rain) return t.id === 'storm' ? 'storm' : 'rainNight'
  if (t.night) return t.id === 'nightCity' ? 'neon' : 'night'
  if (t.rain) return 'rain'
  if (t.silhouette) return 'sunset'
  return 'day'
}

/** The swell Road.ts lays under every stage, so the trace can take it back out again. */
function swellAt(i: number, length: number): number {
  const periods = Math.max(1, Math.round(length / 52))
  return ROLL_AMPLITUDE * Math.sin((i / length) * Math.PI * 2 * periods)
}

/** Trace a built stage into a waypoint track. */
export function trackFromStage(stage: Stage, theme: Theme): CoastTrack {
  const segs = stage.segments
  const n = stage.length
  const nodes: TrackNode[] = []
  let x = 0
  let z = 0
  let heading = 0
  for (let i = 0; i < n; i++) {
    // Only on the sampling stride: a waypoint on the last segment as well would sit a few
    // metres from the end one, and two waypoints that close read as a hairpin.
    if (i % NODE_EVERY === 0) {
      nodes.push({ x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, y: Math.round((segs[i].y0 - swellAt(i, n)) * 10) / 10, bank: segs[i].bank > 0.02 ? Math.round(segs[i].bank * 100) / 100 : undefined })
    }
    heading += (segs[i].curve * CURVE_UNIT) / SEG_LENGTH
    x += Math.sin(heading) * SEG_LENGTH
    z += Math.cos(heading) * SEG_LENGTH
  }
  // The last waypoint must sit at the end of the road, not at the last sampled segment.
  nodes.push({ x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, y: 0 })

  const spans: Span[] = []
  const crossings: Crossing[] = []
  const runs = (test: (i: number) => number | boolean, make: (from: number, to: number, v: number) => void) => {
    let start = -1
    let val: number | boolean = 0
    for (let i = 0; i <= n; i++) {
      const v = i < n ? test(i) : 0
      if (v && start < 0) {
        start = i
        val = v
      } else if ((!v || v !== val) && start >= 0) {
        make(start / n, (i - 1) / n, Number(val))
        start = v ? i : -1
        val = v
      }
    }
  }
  runs(
    (i) => segs[i].tunnel,
    (from, to) => spans.push({ kind: 'tunnel', from, to }),
  )
  runs(
    (i) => segs[i].shore,
    (from, to, v) => spans.push({ kind: 'shore', from, to, side: (v as -1 | 1) }),
  )
  runs(
    (i) => segs[i].closed,
    (from, to, v) => spans.push({ kind: 'workzone', from, to, side: (v as -1 | 1) }),
  )
  for (let i = 0; i < n; i++) if (segs[i].crossing && !segs[i - 1]?.crossing) crossings.push({ at: i / n })

  const scene = SCENE_FOR_THEME[theme.id] ?? 'coast'
  const scenes: SceneStop[] = [{ at: 0, scene }]
  const vibes: VibeStop[] = [{ at: 0, vibe: vibeForTheme(theme) }]
  return {
    id: stage.desc.id,
    name: stage.desc.name,
    nodes,
    scenes,
    vibes,
    props: [],
    spans,
    crossings,
    next: [...stage.desc.next],
    roll: { amp: ROLL_AMPLITUDE, period: 52 },
  }
}

/** Depth of a stage in the route tree, for laying the set view out left to right. */
function depths(): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (id: string, d: number) => {
    if ((out.get(id) ?? -1) >= d) return
    out.set(id, d)
    for (const nx of STAGE_BY_ID[id]?.next ?? []) walk(nx, d + 1)
  }
  walk('A', 0)
  for (const s of STAGES) if (!out.has(s.id)) out.set(s.id, 0)
  return out
}

/** The whole built-in route as an editable world — "fork from Coast to Coast". */
export function builtinAsWorld(name = 'Coast to Coast (copy)'): WorldData {
  const d = depths()
  const byDepth = new Map<number, number>()
  const tracks = STAGES.map((desc: StageDesc) => {
    const theme = THEMES[desc.theme]
    const stage = new Stage(desc, theme, 7)
    const t = trackFromStage(stage, theme)
    const depth = d.get(desc.id) ?? 0
    const row = byDepth.get(depth) ?? 0
    byDepth.set(depth, row + 1)
    t.ui = { x: depth, y: row }
    return t
  })
  return { v: 1, name, start: 'A', tracks }
}
