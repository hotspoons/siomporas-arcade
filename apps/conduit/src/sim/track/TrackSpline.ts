// The baked centreline: an arc-length-uniform table of positions, parallel-
// transport frames (with authored roll applied), tube radius and geometry arc.
// `s` is arc length in metres; the table has one row per TRACK_SAMPLE_STEP, so
// every lookup is O(1) — no binary search, no allocation.
//
// Frame convention (track space): theta = 0 is the FLOOR (nor points from the
// centreline toward the floor), theta > 0 sweeps toward the RIGHT wall (bin),
// theta wraps at ±π on the ceiling. The craft's "up" is -radial(theta).

import { TRACK_SAMPLE_STEP } from '../Tuning'
import { Vec3 } from '@apex/engine/math/Vec3'

export interface Frame {
  pos: Vec3
  /** Unit forward. */
  tan: Vec3
  /** Unit, points from centreline to the floor (theta = 0). */
  nor: Vec3
  /** Unit, points from centreline to the right wall (theta = +π/2). */
  bin: Vec3
  /** Tube radius at this s. */
  radius: number
  /** Half-angle of geometry present, measured from the floor. π = closed tube. */
  arc: number
}

export function makeFrame(): Frame {
  return { pos: new Vec3(), tan: new Vec3(), nor: new Vec3(), bin: new Vec3(), radius: 1, arc: Math.PI }
}

/** Result of projecting a world point back onto the track. */
export interface TrackPoint {
  s: number
  theta: number
  /** Distance from the centreline. */
  radial: number
}

export class TrackSpline {
  readonly n: number
  readonly length: number
  readonly pos: Float32Array
  readonly tan: Float32Array
  readonly nor: Float32Array
  readonly bin: Float32Array
  readonly radius: Float32Array
  readonly arc: Float32Array

  private readonly vA = new Vec3()
  private readonly vB = new Vec3()

  constructor(n: number) {
    this.n = n
    this.length = (n - 1) * TRACK_SAMPLE_STEP
    this.pos = new Float32Array(n * 3)
    this.tan = new Float32Array(n * 3)
    this.nor = new Float32Array(n * 3)
    this.bin = new Float32Array(n * 3)
    this.radius = new Float32Array(n)
    this.arc = new Float32Array(n)
  }

  /**
   * Frame at arc length s. Outside [0, length] the spline extrapolates along
   * its end tangent, so the approach and the run-out stay straight instead of
   * collapsing to a point.
   */
  frameAt(s: number, out: Frame): Frame {
    const n = this.n
    if (s <= 0) {
      this.row(0, out)
      out.pos.addScaled(out.tan, s)
      return out
    }
    if (s >= this.length) {
      this.row(n - 1, out)
      out.pos.addScaled(out.tan, s - this.length)
      return out
    }
    const f = s / TRACK_SAMPLE_STEP
    const i = Math.floor(f)
    const t = f - i
    const j = Math.min(i + 1, n - 1)
    lerp3(this.pos, i, j, t, out.pos)
    lerp3(this.tan, i, j, t, out.tan).normalize()
    lerp3(this.nor, i, j, t, out.nor)
    // Re-orthogonalise: lerp of two unit normals drifts slightly off the tangent plane.
    out.nor.projectOntoPlane(out.tan).normalize()
    out.bin.cross(out.nor, out.tan)
    out.radius = this.radius[i] + (this.radius[j] - this.radius[i]) * t
    out.arc = this.arc[i] + (this.arc[j] - this.arc[i]) * t
    return out
  }

  positionAt(s: number, out: Vec3): Vec3 {
    if (s <= 0 || s >= this.length) {
      const i = s <= 0 ? 0 : this.n - 1
      const d = s <= 0 ? s : s - this.length
      out.set(this.pos[i * 3] + this.tan[i * 3] * d, this.pos[i * 3 + 1] + this.tan[i * 3 + 1] * d, this.pos[i * 3 + 2] + this.tan[i * 3 + 2] * d)
      return out
    }
    const f = s / TRACK_SAMPLE_STEP
    const i = Math.floor(f)
    const j = Math.min(i + 1, this.n - 1)
    return lerp3(this.pos, i, j, f - i, out)
  }

  private row(i: number, out: Frame): void {
    const k = i * 3
    out.pos.set(this.pos[k], this.pos[k + 1], this.pos[k + 2])
    out.tan.set(this.tan[k], this.tan[k + 1], this.tan[k + 2])
    out.nor.set(this.nor[k], this.nor[k + 1], this.nor[k + 2])
    out.bin.set(this.bin[k], this.bin[k + 1], this.bin[k + 2])
    out.radius = this.radius[i]
    out.arc = this.arc[i]
  }

  /**
   * Find the track-space coordinates of a world point, searching only
   * [sGuess - range, sGuess + range]. Coarse pass over the table, then one
   * Newton-style refinement along the local tangent.
   */
  project(p: Vec3, sGuess: number, range: number, scratch: Frame, out: TrackPoint): TrackPoint {
    const i0 = Math.max(0, Math.floor((sGuess - range) / TRACK_SAMPLE_STEP))
    const i1 = Math.min(this.n - 1, Math.ceil((sGuess + range) / TRACK_SAMPLE_STEP))
    let best = i0
    let bestD = Infinity
    const d = this.vA
    for (let i = i0; i <= i1; i++) {
      const k = i * 3
      const dx = p.x - this.pos[k]
      const dy = p.y - this.pos[k + 1]
      const dz = p.z - this.pos[k + 2]
      const dist = dx * dx + dy * dy + dz * dz
      if (dist < bestD) {
        bestD = dist
        best = i
      }
    }
    let s = best * TRACK_SAMPLE_STEP
    for (let iter = 0; iter < 2; iter++) {
      this.frameAt(s, scratch)
      d.copy(p).sub(scratch.pos)
      s += d.dot(scratch.tan)
    }
    this.frameAt(s, scratch)
    d.copy(p).sub(scratch.pos)
    const along = d.dot(scratch.tan)
    const r = this.vB.copy(d).addScaled(scratch.tan, -along)
    out.s = s
    out.radial = r.length()
    out.theta = Math.atan2(r.dot(scratch.bin), r.dot(scratch.nor))
    return out
  }
}

function lerp3(a: Float32Array, i: number, j: number, t: number, out: Vec3): Vec3 {
  const ki = i * 3
  const kj = j * 3
  out.x = a[ki] + (a[kj] - a[ki]) * t
  out.y = a[ki + 1] + (a[kj + 1] - a[ki + 1]) * t
  out.z = a[ki + 2] + (a[kj + 2] - a[ki + 2]) * t
  return out
}
