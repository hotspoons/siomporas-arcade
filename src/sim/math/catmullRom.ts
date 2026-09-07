// Centripetal-ish Catmull-Rom evaluation on four control points. The track
// builder resamples this by arc length, so it only needs point + derivative.

import type { Vec3 } from './Vec3'

/** Uniform Catmull-Rom position at t∈[0,1] between p1 and p2. */
export function catmullRomPoint(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number, out: Vec3): Vec3 {
  const t2 = t * t
  const t3 = t2 * t
  const b0 = -0.5 * t3 + t2 - 0.5 * t
  const b1 = 1.5 * t3 - 2.5 * t2 + 1
  const b2 = -1.5 * t3 + 2 * t2 + 0.5 * t
  const b3 = 0.5 * t3 - 0.5 * t2
  out.x = p0.x * b0 + p1.x * b1 + p2.x * b2 + p3.x * b3
  out.y = p0.y * b0 + p1.y * b1 + p2.y * b2 + p3.y * b3
  out.z = p0.z * b0 + p1.z * b1 + p2.z * b2 + p3.z * b3
  return out
}

/** Derivative of the same segment with respect to t. */
export function catmullRomTangent(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number, out: Vec3): Vec3 {
  const t2 = t * t
  const b0 = -1.5 * t2 + 2 * t - 0.5
  const b1 = 4.5 * t2 - 5 * t
  const b2 = -4.5 * t2 + 4 * t + 0.5
  const b3 = 1.5 * t2 - t
  out.x = p0.x * b0 + p1.x * b1 + p2.x * b2 + p3.x * b3
  out.y = p0.y * b0 + p1.y * b1 + p2.y * b2 + p3.y * b3
  out.z = p0.z * b0 + p1.z * b1 + p2.z * b2 + p3.z * b3
  return out
}
