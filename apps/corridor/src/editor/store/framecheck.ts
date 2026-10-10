// Is an authored document in the bake's frame? Measured, not dated.
//
// Rich, 2026-10-10, about the Traffic tab's banner on dc-metro-take-2 — "zones.json was authored in
// a different frame — authored before frames were stamped … If these were drawn before 2026-09-22
// they are in the old UTM-relative metres and will sit off the road": *"This screenshot about
// zones.json is bullshit."*
//
// It was. Those five Beltway zones were written over MCP on 2026-10-08, in the ENU frame the bake
// serves, by a tool that did not stamp a frame (it does now — tools/worldeditor/mcptools.mjs). The
// old check (`frameMismatch` in schema.ts) took "no stamp" for "maybe before 2026-09-22" and said
// so to every unstamped file, which is a guess about a date dressed as a fact about coordinates.
//
// THE QUESTION IS ANSWERABLE. The only frame change there has ever been is UTM-relative metres →
// true ENU about the anchor, and the manifest carries the rigid fit between them
// (`utm_convergence_deg`, `utm_scale` — tools/corridor/corridor/geo.py `enu_fit`; checked against
// pyproj at dc-metro's anchor: 0.24 m at 10 km, 0.6 m at 17 km). So for a document whose frame is
// unknown, ask the roads: do its shapes sit on them as written, or would they after that turn?
//
//   fits     on the roads as written — stamp the frame (in memory now, on disk at the next save)
//            and say nothing
//   old      off the roads as written and on them after the turn — offer to move them, with the
//            numbers
//   unknown  the roads cannot tell (nothing near a road either way, or too close to the anchor
//            for the turn to matter) — say nothing; that is not evidence of anything
//
// "On a road" is two different measurements, because a polygon and a point are different things.
// A POLYGON covers road: a traffic zone is a strip around one, a canopy band runs along one, so
// the test is whether road stations fall INSIDE it. Its vertices are no use — a 90 m Beltway strip
// keeps every vertex 45 m from the centreline, which is "far from the road" by any vertex rule and
// exactly on it. A POINT (a start, a placed diner) is near a road or not, by distance.
//
// Pure: no three, no DOM, no Site. The caller hands in road stations; editor/view/layers.ts and
// the modes do the plumbing. Tested in test/frame-measure.test.ts.

import type { FrameStamp } from './schema'

/** One sample of a carriageway: site frame (x east, y north) and its paved half width. */
export interface RoadStation { x: number; y: number; half: number }

/** A point is "on a road" within this many metres of the pavement edge — a kerbside start, a gate. */
export const NEAR_M = 20
/** A polygon is "on a road" when at least this many road stations (10 m apart) fall inside it. */
export const COVER_MIN = 2
/** The turn has to move things at least this far for the roads to be able to tell the frames apart. */
export const MIN_SHIFT_M = 6

/**
 * Road stations bucketed on a grid, for the two questions the check asks: how far is the nearest
 * pavement edge from a point, and how many stations fall inside a polygon.
 *
 * Not `site.edgeInfo`. That is the canonical pavement field, but it searches seven 20 m cells and
 * answers Infinity beyond ~70 m — which a frame turn of 300 m at dc-metro's Bethesda end is well
 * past, so "how far off" would read as "off, by an unknown amount" on both sides of the question.
 */
export class RoadIndex {
  private cells = new Map<string, RoadStation[]>()
  private cell: number
  readonly count: number
  constructor(stations: Iterable<RoadStation>, cell = 50) {
    this.cell = cell
    let n = 0
    for (const s of stations) {
      const k = `${Math.floor(s.x / cell)},${Math.floor(s.y / cell)}`
      const arr = this.cells.get(k)
      if (arr) arr.push(s)
      else this.cells.set(k, [s])
      n++
    }
    this.count = n
  }

  /** Metres from the nearest pavement edge (negative on the pavement), at most `cap`. */
  distance(x: number, y: number, cap = 200): number {
    const r = Math.ceil(cap / this.cell)
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell)
    let best = cap
    for (let a = -r; a <= r; a++) {
      for (let b = -r; b <= r; b++) {
        const arr = this.cells.get(`${cx + a},${cy + b}`)
        if (!arr) continue
        for (const s of arr) {
          const d = Math.hypot(s.x - x, s.y - y) - s.half
          if (d < best) best = d
        }
      }
    }
    return best
  }

  /** How many stations fall inside a polygon (even-odd), looking only at the cells its box covers. */
  inside(poly: [number, number][]): number {
    if (poly.length < 3) return 0
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
    const c0 = Math.floor(x0 / this.cell), c1 = Math.floor(x1 / this.cell)
    const r0 = Math.floor(y0 / this.cell), r1 = Math.floor(y1 / this.cell)
    // a polygon bigger than the whole index is cheaper walked station by station
    let n = 0
    const test = (s: RoadStation) => { if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1 && pointIn(poly, s.x, s.y)) n++ }
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > this.cells.size) {
      for (const arr of this.cells.values()) for (const s of arr) test(s)
      return n
    }
    for (let a = c0; a <= c1; a++) for (let b = r0; b <= r1; b++) for (const s of this.cells.get(`${a},${b}`) ?? []) test(s)
    return n
  }
}

function pointIn(poly: [number, number][], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** The bake's frame block, as much of it as this check reads. */
export interface BakeFrame extends FrameStamp {
  utm_convergence_deg?: number
  utm_scale?: number
}

/**
 * Old UTM-relative site metres → this bake's ENU metres: the rigid fit the bake recorded.
 * `e + i·n = scale · e^{iθ} · (x + i·y)`, θ = `utm_convergence_deg` (geo.py `enu_fit`). Null when
 * the bake is not ENU or did not record the fit — then there is no old frame to compare against.
 */
export function oldFrameMove(frame: BakeFrame | undefined): ((p: [number, number]) => [number, number]) | null {
  if (!frame || frame.kind !== 'enu' || typeof frame.utm_convergence_deg !== 'number') return null
  const t = (frame.utm_convergence_deg * Math.PI) / 180
  const s = typeof frame.utm_scale === 'number' ? frame.utm_scale : 1
  const c = Math.cos(t) * s, n = Math.sin(t) * s
  return ([x, y]) => [c * x - n * y, n * x + c * y]
}

/** What a document holds, for the check: polygons (which should cover road) and points (near it). */
export interface Shapes {
  /** one entry per thing, so the message can count things rather than vertices */
  polygons: { id: string; ring: [number, number][] }[]
  points: { id: string; at: [number, number] }[]
}

export interface FrameMeasure {
  /** things measured */
  n: number
  /** things on a road as written / after the old-frame turn (a polygon covering ≥ COVER_MIN stations, a point within NEAR_M) */
  onNow: number
  onOld: number
  /** things that sit on the roads clearly BETTER as written / after the turn (by a quarter or more) */
  betterNow: number
  betterOld: number
  /** road stations inside the polygons, as written and after the turn — 10 m of road each */
  roadNow: number
  roadOld: number
  /** median distance the turn moves a thing, metres */
  shift: number
  /** ids of the things that sit better after the turn — the evidence, for the message */
  movedOn: string[]
}

const median = (v: number[]) => {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  return s[s.length >> 1]
}

const centroid = (ring: [number, number][]): [number, number] => {
  let x = 0, y = 0
  for (const p of ring) { x += p[0]; y += p[1] }
  return [x / ring.length, y / ring.length]
}

/** "Clearly better" is a quarter more road, so two near-equal answers are a tie, not a verdict. */
const CLEAR = 1.25

/**
 * Measure a document against the roads, as written and after `move`.
 *
 * BY HOW MUCH, NOT WHETHER. A polygon is scored by how much road it covers in each frame, because
 * "covers some road" is true of both answers far too often: dc-metro-take-2's Beltway circles its
 * anchor, so the old-frame turn slides a zone ALONG the ring and a zone still covers road after it
 * — 528 stations of z-01's 1000, measured. What tells the frames apart is that one of them covers
 * all of it.
 */
export function measureFrame(shapes: Shapes, roads: RoadIndex, move: (p: [number, number]) => [number, number]): FrameMeasure {
  const m: FrameMeasure = { n: 0, onNow: 0, onOld: 0, betterNow: 0, betterOld: 0, roadNow: 0, roadOld: 0, shift: 0, movedOn: [] }
  const shifts: number[] = []
  const score = (id: string, a: number, b: number, on: number) => {
    m.n++
    if (a >= on) m.onNow++
    if (b >= on) m.onOld++
    if (a >= on && a > b * CLEAR) m.betterNow++
    else if (b >= on && b > a * CLEAR) { m.betterOld++; m.movedOn.push(id) }
  }
  for (const { id, ring } of shapes.polygons) {
    if (ring.length < 3) continue
    const a = roads.inside(ring)
    const b = roads.inside(ring.map(move))
    m.roadNow += a
    m.roadOld += b
    score(id, a, b, COVER_MIN)
    const c = centroid(ring), t = move(c)
    shifts.push(Math.hypot(t[0] - c[0], t[1] - c[1]))
  }
  for (const { id, at } of shapes.points) {
    const t = move(at)
    // a point is on a road or not: 1 or 0, so "clearly better" is simply one and not the other
    score(id, roads.distance(at[0], at[1]) <= NEAR_M ? 1 : 0, roads.distance(t[0], t[1]) <= NEAR_M ? 1 : 0, 1)
    shifts.push(Math.hypot(t[0] - at[0], t[1] - at[1]))
  }
  m.shift = median(shifts)
  return m
}

export type FrameJudgement = 'fits' | 'old' | 'unknown'

/**
 * The verdict, deliberately lopsided: "old" needs the roads to say so clearly — at least half the
 * things sitting better after the turn, and at most half as many sitting better as written.
 * Anything less is not a reason to put a banner in front of somebody.
 */
export function judgeFrame(m: FrameMeasure): FrameJudgement {
  if (!m.n) return 'unknown'
  // the frames agree to within a few metres here: whichever it was written in, it is right
  if (m.shift < MIN_SHIFT_M) return 'fits'
  if (m.betterOld * 2 >= m.n && m.betterNow * 2 <= m.betterOld) return 'old'
  // on the roads as written, and no worse than after the turn
  if (m.onNow > 0 && m.betterNow >= m.betterOld) return 'fits'
  return 'unknown'
}

/** What the editor does about one document. */
export type FrameVerdict =
  | { state: 'stamped' }
  | { state: 'fits'; measure: FrameMeasure | null }
  | { state: 'unknown'; measure: FrameMeasure | null }
  | { state: 'old'; measure: FrameMeasure; message: string; move: (p: [number, number]) => [number, number]; turnDeg: number }
  | { state: 'other'; message: string }

/**
 * The whole decision for one document.
 *
 * `stamp` is the document's own frame block; `frame` the bake's. `roads` is lazy because building
 * the index walks every carriageway, and most documents are stamped and never need it.
 */
export function checkFrame(stamp: FrameStamp | undefined, frame: BakeFrame | undefined, shapes: Shapes, roads: () => RoadIndex | null, noun = 'things'): FrameVerdict {
  const count = shapes.polygons.length + shapes.points.length
  // nothing with coordinates cannot be in the wrong frame (Rich, 2026-09-30, on a fresh bake)
  if (!count) return { state: 'stamped' }
  const now = frame ?? {}
  const unstamped = !stamp || (!stamp.kind && !stamp.anchor)
  if (!unstamped) {
    const a = stamp.anchor, b = now.anchor
    // A different anchor is a different site's metres, or a re-anchored bake: no rigid fit is
    // recorded between two anchors, so all this can do is say so.
    if (a && b && (Math.abs(a.lon - b.lon) > 1e-6 || Math.abs(a.lat - b.lat) > 1e-6)) {
      return { state: 'other', message: `written about a different anchor (${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}; the bake's is ${b.lat.toFixed(5)}, ${b.lon.toFixed(5)}) — the editor cannot move them between anchors` }
    }
    // stamped in the frame the bake serves: nothing to measure
    if (!(stamp.kind === 'utm' && now.kind === 'enu')) return { state: 'stamped' }
  }
  const move = oldFrameMove(now)
  if (!move) return unstamped ? { state: 'unknown', measure: null } : { state: 'stamped' }
  const idx = roads()
  if (!idx || !idx.count) return { state: 'unknown', measure: null }
  const m = measureFrame(shapes, idx, move)
  const j = judgeFrame(m)
  if (j !== 'old') return { state: j, measure: m }
  const turn = now.utm_convergence_deg ?? 0
  const km = (st: number) => `${((st * 10) / 1000).toFixed(1)} km`
  const roadSay = shapes.polygons.length ? ` — ${km(m.roadNow)} of road inside them as written, ${km(m.roadOld)} after the turn` : ''
  const which = m.movedOn.length ? ` (${m.movedOn.slice(0, 5).join(', ')}${m.movedOn.length > 5 ? '…' : ''})` : ''
  const message = `${m.betterOld} of ${m.n} ${noun}${which} sit on the roads better in the pre-2026-09-22 frame than as they are written${roadSay}. That frame is UTM-relative metres, turned ${turn.toFixed(2)}° about the anchor from this one: a median ${Math.round(m.shift)} m move.`
  return { state: 'old', measure: m, message, move, turnDeg: turn }
}

/** Road stations from the site's carriageways, every `step` metres, in the site frame. */
export function stationsOf(
  chains: { length_m: number; half: number; at: (s: number) => { pos: { x: number; z: number } } }[],
  step = 10,
): RoadStation[] {
  const out: RoadStation[] = []
  for (const c of chains) {
    if (!(c.length_m > 0)) continue
    const n = Math.max(1, Math.ceil(c.length_m / step))
    for (let i = 0; i <= n; i++) {
      const p = c.at(Math.min(c.length_m, (c.length_m * i) / n)).pos
      out.push({ x: p.x, y: -p.z, half: c.half })
    }
  }
  return out
}
