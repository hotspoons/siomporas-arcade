// The centreline: a chain of cubic Bézier spans through the track's waypoints,
// resampled by arc length. Both the compiler and the editor go through here, so
// what you drag is exactly what you drive.
//
// Handles work as they do in a vector editor. A node with no handles of its own
// gets auto ones (the Catmull-Rom shape through its neighbours), which is why a
// freshly dropped waypoint already bends the road sensibly. Drag a handle and it
// becomes explicit; on a smooth node the opposite handle mirrors, on a cusp it
// stays put.

import type { TrackNode } from './types'

export interface Vec2 {
  x: number
  z: number
}

export interface PathSample {
  /** Arc length from the start, metres. */
  s: number
  x: number
  z: number
  /** Elevation, metres. */
  y: number
  /** Heading in radians; 0 = +z, positive turning toward +x. */
  heading: number
  /** Banking 0..1. */
  bank: number
}

/** The four control points of the span leaving node `i`. */
export function spanControls(nodes: readonly TrackNode[], i: number): [Vec2, Vec2, Vec2, Vec2] {
  const a = nodes[i]
  const b = nodes[i + 1]
  const ha = handleOut(nodes, i)
  const hb = handleIn(nodes, i + 1)
  return [
    { x: a.x, z: a.z },
    { x: a.x + ha.x, z: a.z + ha.z },
    { x: b.x + hb.x, z: b.z + hb.z },
    { x: b.x, z: b.z },
  ]
}

/** The auto handle vector out of node `i` — a third of the Catmull-Rom tangent. */
function autoOut(nodes: readonly TrackNode[], i: number): Vec2 {
  const p = nodes[i]
  const next = nodes[i + 1]
  if (!next) {
    const prev = nodes[i - 1]
    return prev ? { x: (p.x - prev.x) / 3, z: (p.z - prev.z) / 3 } : { x: 0, z: 1 }
  }
  const prev = nodes[i - 1]
  if (!prev) return { x: (next.x - p.x) / 3, z: (next.z - p.z) / 3 }
  return { x: (next.x - prev.x) / 6, z: (next.z - prev.z) / 6 }
}

export function handleOut(nodes: readonly TrackNode[], i: number): Vec2 {
  const n = nodes[i]
  if (n.outX !== undefined && n.outZ !== undefined) return { x: n.outX, z: n.outZ }
  if (!n.cusp && n.inX !== undefined && n.inZ !== undefined) return { x: -n.inX, z: -n.inZ }
  return autoOut(nodes, i)
}

export function handleIn(nodes: readonly TrackNode[], i: number): Vec2 {
  const n = nodes[i]
  if (n.inX !== undefined && n.inZ !== undefined) return { x: n.inX, z: n.inZ }
  if (!n.cusp && n.outX !== undefined && n.outZ !== undefined) return { x: -n.outX, z: -n.outZ }
  const a = autoOut(nodes, i)
  return { x: -a.x, z: -a.z }
}

function bez(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}
function bezD(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t
  return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2)
}

/** Point on the span leaving node `i` at parameter t. */
export function spanPoint(nodes: readonly TrackNode[], i: number, t: number): Vec2 {
  const [a, b, c, d] = spanControls(nodes, i)
  return { x: bez(a.x, b.x, c.x, d.x, t), z: bez(a.z, b.z, c.z, d.z, t) }
}

/**
 * Cubic Hermite through (s, v) pairs with Catmull-Rom tangents, limited so a
 * value never overshoots its neighbours — an elevation profile that dips below
 * a valley it is only passing through would launch the car off nothing.
 */
function hermite1d(xs: readonly number[], vs: readonly number[], x: number): number {
  const n = xs.length
  if (!n) return 0
  if (n === 1 || x <= xs[0]) return vs[0]
  if (x >= xs[n - 1]) return vs[n - 1]
  let i = 0
  while (i < n - 2 && xs[i + 1] < x) i++
  const h = Math.max(1e-6, xs[i + 1] - xs[i])
  const t = (x - xs[i]) / h
  const slope = (a: number, b: number) => (vs[b] - vs[a]) / Math.max(1e-6, xs[b] - xs[a])
  const d0 = i === 0 ? slope(0, 1) : (slope(i - 1, i) + slope(i, i + 1)) / 2
  const d1 = i + 2 >= n ? slope(i, i + 1) : (slope(i, i + 1) + slope(i + 1, i + 2)) / 2
  // Fritsch–Carlson style limiter: kill tangents at local extrema so humps stay humps.
  const sec = slope(i, i + 1)
  const lim = (d: number) => (sec === 0 ? 0 : Math.sign(d) === Math.sign(sec) ? Math.min(Math.abs(d), 3 * Math.abs(sec)) * Math.sign(sec) : 0)
  const m0 = lim(d0) * h
  const m1 = lim(d1) * h
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * vs[i] + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * vs[i + 1] + (t3 - t2) * m1
}

const SAMPLE_METRES = 2

export class TrackPath {
  readonly length: number
  /** Arc position of each node. */
  readonly nodeS: number[] = []
  private readonly ss: number[] = []
  private readonly px: number[] = []
  private readonly pz: number[] = []
  /** Unwrapped heading per sample, so interpolation never jumps a turn. */
  private readonly ph: number[] = []
  private readonly nodes: readonly TrackNode[]
  private readonly ys: number[]
  private readonly banks: number[]

  constructor(nodes: readonly TrackNode[]) {
    this.nodes = nodes
    let s = 0
    let heading = 0
    let first = true
    const push = (x: number, z: number, dx: number, dz: number) => {
      let h = Math.atan2(dx, dz)
      if (!first) {
        // Unwrap onto the previous heading.
        while (h - heading > Math.PI) h -= Math.PI * 2
        while (heading - h > Math.PI) h += Math.PI * 2
      }
      heading = h
      first = false
      this.ss.push(s)
      this.px.push(x)
      this.pz.push(z)
      this.ph.push(h)
    }
    if (nodes.length < 2) {
      const n = nodes[0] ?? { x: 0, z: 0, y: 0 }
      push(n.x, n.z, 0, 1)
      this.length = 0
      this.nodeS = [0]
      this.ys = [n.y ?? 0]
      this.banks = [0]
      return
    }
    for (let i = 0; i < nodes.length - 1; i++) {
      this.nodeS.push(s)
      const [a, b, c, d] = spanControls(nodes, i)
      const chord = Math.hypot(d.x - a.x, d.z - a.z) + Math.hypot(b.x - a.x, b.z - a.z) + Math.hypot(c.x - b.x, c.z - b.z) + Math.hypot(d.x - c.x, d.z - c.z)
      const steps = Math.max(8, Math.min(600, Math.ceil(chord / SAMPLE_METRES)))
      let prevX = bez(a.x, b.x, c.x, d.x, 0)
      let prevZ = bez(a.z, b.z, c.z, d.z, 0)
      if (i === 0) push(prevX, prevZ, bezD(a.x, b.x, c.x, d.x, 0), bezD(a.z, b.z, c.z, d.z, 0))
      for (let k = 1; k <= steps; k++) {
        const t = k / steps
        const x = bez(a.x, b.x, c.x, d.x, t)
        const z = bez(a.z, b.z, c.z, d.z, t)
        s += Math.hypot(x - prevX, z - prevZ)
        push(x, z, bezD(a.x, b.x, c.x, d.x, t), bezD(a.z, b.z, c.z, d.z, t))
        prevX = x
        prevZ = z
      }
    }
    this.nodeS.push(s)
    this.length = s
    this.ys = nodes.map((n) => n.y ?? 0)
    this.banks = nodes.map((n) => n.bank ?? 0)
  }

  /** Index of the last sample at or before arc length `s`. */
  private indexAt(s: number): number {
    const ss = this.ss
    let lo = 0
    let hi = ss.length - 1
    if (s <= 0) return 0
    if (s >= this.length) return Math.max(0, ss.length - 2)
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (ss[mid] <= s) lo = mid
      else hi = mid
    }
    return lo
  }

  at(s: number, out: PathSample = { s: 0, x: 0, z: 0, y: 0, heading: 0, bank: 0 }): PathSample {
    const i = this.indexAt(s)
    const j = Math.min(i + 1, this.ss.length - 1)
    const span = Math.max(1e-6, this.ss[j] - this.ss[i])
    const t = Math.max(0, Math.min(1, (s - this.ss[i]) / span))
    out.s = s
    out.x = this.px[i] + (this.px[j] - this.px[i]) * t
    out.z = this.pz[i] + (this.pz[j] - this.pz[i]) * t
    out.heading = this.ph[i] + (this.ph[j] - this.ph[i]) * t
    out.y = this.elevationAt(s)
    out.bank = this.bankAt(s)
    return out
  }

  headingAt(s: number): number {
    const i = this.indexAt(s)
    const j = Math.min(i + 1, this.ss.length - 1)
    const span = Math.max(1e-6, this.ss[j] - this.ss[i])
    const t = Math.max(0, Math.min(1, (s - this.ss[i]) / span))
    return this.ph[i] + (this.ph[j] - this.ph[i]) * t
  }

  elevationAt(s: number): number {
    return hermite1d(this.nodeS, this.ys, s)
  }

  /** Banking eases in and out between nodes rather than ramping linearly. */
  bankAt(s: number): number {
    const xs = this.nodeS
    if (xs.length < 2) return this.banks[0] ?? 0
    if (s <= xs[0]) return this.banks[0]
    if (s >= xs[xs.length - 1]) return this.banks[this.banks.length - 1]
    let i = 0
    while (i < xs.length - 2 && xs[i + 1] < s) i++
    const t = (s - xs[i]) / Math.max(1e-6, xs[i + 1] - xs[i])
    const e = t * t * (3 - 2 * t)
    return this.banks[i] + (this.banks[i + 1] - this.banks[i]) * e
  }

  /** Polyline in plan view, one point every `every` metres (for drawing). */
  polyline(every = 8): Vec2[] {
    const out: Vec2[] = []
    const p: PathSample = { s: 0, x: 0, z: 0, y: 0, heading: 0, bank: 0 }
    for (let s = 0; s < this.length; s += every) {
      this.at(s, p)
      out.push({ x: p.x, z: p.z })
    }
    this.at(this.length, p)
    out.push({ x: p.x, z: p.z })
    return out
  }

  /**
   * Nearest point on the path to a plan-view position: its arc length and signed lateral
   * offset (metres). The editor calls this on every pointer move, so the coarse pass walks
   * the stored samples directly rather than resampling the curve.
   */
  nearest(x: number, z: number): { s: number; lateral: number; dist: number } {
    let bestI = 0
    let bestD = Infinity
    for (let i = 0; i < this.px.length; i++) {
      const d = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
    let bestS = this.ss[bestI]
    const p: PathSample = { s: 0, x: 0, z: 0, y: 0, heading: 0, bank: 0 }
    // Refine between the two neighbouring samples.
    const span = Math.max(1e-3, (this.ss[Math.min(bestI + 1, this.ss.length - 1)] - this.ss[Math.max(0, bestI - 1)]) / 2)
    for (let k = 0; k < 20; k++) {
      const h = span / (k + 2)
      for (const cand of [bestS - h, bestS + h]) {
        if (cand < 0 || cand > this.length) continue
        this.at(cand, p)
        const d = (p.x - x) ** 2 + (p.z - z) ** 2
        if (d < bestD) {
          bestD = d
          bestS = cand
        }
      }
    }
    this.at(bestS, p)
    const hx = Math.sin(p.heading)
    const hz = Math.cos(p.heading)
    // Left of travel is -x in the road's frame (the same sign convention the sim uses).
    const lateral = (x - p.x) * hz - (z - p.z) * hx
    return { s: bestS, lateral, dist: Math.sqrt(bestD) }
  }

  get nodeCount(): number {
    return this.nodes.length
  }
}

export function buildPath(nodes: readonly TrackNode[]): TrackPath {
  return new TrackPath(nodes)
}
