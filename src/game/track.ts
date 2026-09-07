// The conduit's centreline: a seeded procedural spline, resampled into an
// arc-length table so the sim can ask "where am I at 8,412 units in?" in O(log n).
//
// Everything downstream (tube geometry, obstacles, camera) works in
// (distance, theta, inset) conduit space and converts through here, so the
// track shape is the single source of truth for the world.

import { CatmullRomCurve3, Vector3 } from 'three'
import { RADIUS_BASE } from './constants'

/** Control points every SEGMENT_LEN units; 80 of them ≈ a 14km course. */
const SEGMENT_LEN = 180
const CONTROL_POINTS = 80
/** Dense resample resolution — one frame per ~8 units. */
const SAMPLE_STEP = 8

/** An orthonormal frame on the centreline: forward + the two radial axes. */
export interface Frame {
  pos: Vector3
  tan: Vector3
  nor: Vector3
  bin: Vector3
}

export function makeFrame(): Frame {
  return { pos: new Vector3(), tan: new Vector3(), nor: new Vector3(), bin: new Vector3() }
}

/** Deterministic PRNG so a seed always regenerates the same course. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Track {
  readonly seed: number
  readonly length: number

  private readonly pos: Float32Array
  private readonly tan: Float32Array
  private readonly nor: Float32Array
  private readonly bin: Float32Array
  /** Cumulative arc length at each sample; strictly increasing. */
  private readonly cum: Float64Array

  constructor(seed: number) {
    this.seed = seed
    const rnd = mulberry32(seed)

    // Random walk with a low-passed heading: raw per-step jitter gives kinked
    // corners, so steer the *rate* and let it decay. Pitch is clamped hard —
    // an unbounded walk sends the course straight up or down.
    const points: Vector3[] = []
    const p = new Vector3()
    let yaw = 0
    let pitch = 0
    let yawVel = 0
    let pitchVel = 0
    for (let i = 0; i < CONTROL_POINTS; i++) {
      points.push(p.clone())
      yawVel = yawVel * 0.72 + (rnd() - 0.5) * 0.34
      pitchVel = pitchVel * 0.7 + (rnd() - 0.5) * 0.12
      yaw += yawVel
      pitch = Math.max(-0.42, Math.min(0.42, pitch + pitchVel))
      p.x += Math.sin(yaw) * Math.cos(pitch) * SEGMENT_LEN
      p.y += Math.sin(pitch) * SEGMENT_LEN
      p.z += Math.cos(yaw) * Math.cos(pitch) * SEGMENT_LEN
    }

    const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.5)
    const divisions = Math.ceil((SEGMENT_LEN * (CONTROL_POINTS - 1)) / SAMPLE_STEP)
    const pts = curve.getPoints(divisions)
    // closed=false Frenet frames are computed to avoid twist accumulation,
    // which matters here: a flipped normal would spin the whole tunnel.
    const frames = curve.computeFrenetFrames(divisions, false)

    const n = pts.length
    this.pos = new Float32Array(n * 3)
    this.tan = new Float32Array(n * 3)
    this.nor = new Float32Array(n * 3)
    this.bin = new Float32Array(n * 3)
    this.cum = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const o = i * 3
      pts[i].toArray(this.pos, o)
      frames.tangents[i].toArray(this.tan, o)
      frames.normals[i].toArray(this.nor, o)
      frames.binormals[i].toArray(this.bin, o)
      this.cum[i] = i === 0 ? 0 : this.cum[i - 1] + pts[i].distanceTo(pts[i - 1])
    }
    this.length = this.cum[n - 1]
  }

  /** Index of the sample at or before arc length `s`. */
  private indexAt(s: number): number {
    const cum = this.cum
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= s) lo = mid
      else hi = mid
    }
    return lo
  }

  /**
   * Frame at arc length `s`. Writes into `out`. Off the ends of the course the
   * frame is extrapolated along the end tangent, so the entrance and exit
   * tunnels continue straight instead of collapsing into a degenerate ring.
   */
  sample(s: number, out: Frame): Frame {
    if (s < 0 || s > this.length) {
      const end = s < 0 ? 0 : this.length
      this.sample(end, out)
      out.pos.addScaledVector(out.tan, s - end)
      return out
    }
    const clamped = s
    const i = this.indexAt(clamped)
    const j = Math.min(i + 1, this.cum.length - 1)
    const span = this.cum[j] - this.cum[i]
    const f = span > 1e-6 ? (clamped - this.cum[i]) / span : 0
    lerp3(this.pos, i, j, f, out.pos)
    lerp3(this.tan, i, j, f, out.tan).normalize()
    lerp3(this.nor, i, j, f, out.nor).normalize()
    // Re-orthogonalise rather than interpolating the binormal: lerping three
    // axes independently drifts them out of square over a long span.
    out.bin.crossVectors(out.tan, out.nor).normalize()
    out.nor.crossVectors(out.bin, out.tan).normalize()
    return out
  }

  /**
   * Conduit radius at `s` — two slow sines, so the tube breathes between
   * caverns and tight squeezes without any authored data.
   */
  radiusAt(s: number): number {
    return RADIUS_BASE * (1 + 0.26 * Math.sin(s * 0.00065) + 0.11 * Math.sin(s * 0.0019 + 1.7))
  }

  /**
   * A point on (or just inside) the wall. `theta` is the roll angle around the
   * tube, `inset` the distance in from the wall toward the centreline.
   */
  surfacePoint(frame: Frame, s: number, theta: number, inset: number, out: Vector3): Vector3 {
    const r = this.radiusAt(s) - inset
    out.copy(frame.pos)
    out.addScaledVector(frame.nor, Math.cos(theta) * r)
    out.addScaledVector(frame.bin, Math.sin(theta) * r)
    return out
  }

  /** Same, but samples the frame for you. Convenience for one-off lookups. */
  pointAt(s: number, theta: number, inset: number, out: Vector3, scratch: Frame): Vector3 {
    this.sample(s, scratch)
    return this.surfacePoint(scratch, s, theta, inset, out)
  }

  /** Outward radial direction (wall-ward) at `theta`. */
  radial(frame: Frame, theta: number, out: Vector3): Vector3 {
    out.set(0, 0, 0)
    out.addScaledVector(frame.nor, Math.cos(theta))
    out.addScaledVector(frame.bin, Math.sin(theta))
    return out.normalize()
  }
}

function lerp3(a: Float32Array, i: number, j: number, f: number, out: Vector3): Vector3 {
  const oi = i * 3
  const oj = j * 3
  out.set(
    a[oi] + (a[oj] - a[oi]) * f,
    a[oi + 1] + (a[oj + 1] - a[oi + 1]) * f,
    a[oi + 2] + (a[oj + 2] - a[oi + 2]) * f,
  )
  return out
}

/** Shortest signed angle from `a` to `b`, in (-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}
