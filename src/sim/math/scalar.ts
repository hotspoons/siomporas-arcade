// Scalar helpers shared across the sim. Kept tiny and allocation-free.

export const TAU = Math.PI * 2
export const DEG = Math.PI / 180

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Wrap an angle into [-π, π). */
export function wrapAngle(a: number): number {
  a = a % TAU
  if (a >= Math.PI) a -= TAU
  else if (a < -Math.PI) a += TAU
  return a
}

/** Signed shortest arc from `from` to `to`, in [-π, π). */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from)
}

/**
 * Frame-rate independent exponential approach: moves `current` toward
 * `target` so that after `1/rate` seconds ~63% of the gap is closed.
 */
export function expApproach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt)
}

/** Move toward a target by at most `maxDelta`. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current
  if (Math.abs(d) <= maxDelta) return target
  return current + Math.sign(d) * maxDelta
}
