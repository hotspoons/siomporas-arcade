// The one piece of maths the vocabulary needs, inlined so this package depends on nothing.
//
// It is the same function as `@apex/engine/math/scalar`'s, and the duplication is the POINT: the
// value of this package is that it can be lifted into another repository on its own, and a
// three-line easing curve is not worth giving that up for.

/** Hermite ease between two edges: 0 below `a`, 1 above `b`, flat at both ends. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1)))
  return t * t * (3 - 2 * t)
}
