// A directed lane baked into world space: uniformly spaced samples with
// position, tangent, up (surface normal after banking), right, curvature along
// up (for normal-force checks) and a surface-present flag. Lookups are O(1);
// projection is a brute-force nearest sample — lanes are short.

import { Vec3 } from '@apex/engine/math/Vec3'
import { PATH_STEP } from './Tuning'

export interface LaneFrame {
  pos: Vec3
  tan: Vec3
  up: Vec3
  right: Vec3
  /** Curvature component along up: + when the path bends toward up (inside of a loop). */
  kUp: number
  /** Horizontal-ish curvature along right: + when bending right. */
  kRight: number
  surface: boolean
}

export function makeLaneFrame(): LaneFrame {
  return { pos: new Vec3(), tan: new Vec3(1, 0, 0), up: new Vec3(0, 1, 0), right: new Vec3(0, 0, 1), kUp: 0, kRight: 0, surface: true }
}

export interface LaneHit {
  s: number
  /** Lateral offset along right. */
  x: number
  /** Height above the surface along up. */
  h: number
  /** Metres beyond either end of the lane (0 when inside it). */
  over: number
}

export class PathTable {
  readonly n: number
  readonly length: number
  readonly pos: Float32Array
  readonly tan: Float32Array
  readonly up: Float32Array
  readonly right: Float32Array
  readonly kUp: Float32Array
  readonly kRight: Float32Array
  readonly surface: Uint8Array
  /** Axis-aligned bounds for the spatial index. */
  minX = Infinity
  minY = Infinity
  minZ = Infinity
  maxX = -Infinity
  maxY = -Infinity
  maxZ = -Infinity
  private readonly vA = new Vec3()

  constructor(n: number) {
    this.n = n
    this.length = (n - 1) * PATH_STEP
    this.pos = new Float32Array(n * 3)
    this.tan = new Float32Array(n * 3)
    this.up = new Float32Array(n * 3)
    this.right = new Float32Array(n * 3)
    this.kUp = new Float32Array(n)
    this.kRight = new Float32Array(n)
    this.surface = new Uint8Array(n)
  }

  frameAt(s: number, out: LaneFrame): LaneFrame {
    const f = Math.max(0, Math.min(this.n - 1, s / PATH_STEP))
    const i = Math.min(Math.floor(f), this.n - 2)
    const t = f - i
    const j = i + 1
    lerp3(this.pos, i, j, t, out.pos)
    lerp3(this.tan, i, j, t, out.tan).normalize()
    lerp3(this.up, i, j, t, out.up)
    out.up.projectOntoPlane(out.tan).normalize()
    out.right.cross(out.tan, out.up).normalize()
    out.kUp = this.kUp[i] + (this.kUp[j] - this.kUp[i]) * t
    out.kRight = this.kRight[i] + (this.kRight[j] - this.kRight[i]) * t
    out.surface = t < 0.5 ? this.surface[i] === 1 : this.surface[j] === 1
    return out
  }

  /** Nearest sample to p, refined along the local tangent. */
  project(p: Vec3, scratch: LaneFrame, out: LaneHit): LaneHit {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < this.n; i++) {
      const k = i * 3
      const dx = p.x - this.pos[k]
      const dy = p.y - this.pos[k + 1]
      const dz = p.z - this.pos[k + 2]
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    let s = best * PATH_STEP
    this.frameAt(s, scratch)
    this.vA.copy(p).sub(scratch.pos)
    const raw = s + this.vA.dot(scratch.tan)
    s = Math.max(0, Math.min(this.length, raw))
    this.frameAt(s, scratch)
    this.vA.copy(p).sub(scratch.pos)
    out.s = s
    out.over = raw < 0 ? -raw : raw > this.length ? raw - this.length : 0
    out.x = this.vA.dot(scratch.right)
    out.h = this.vA.dot(scratch.up) - (out.over > 0 ? 0 : 0)
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
