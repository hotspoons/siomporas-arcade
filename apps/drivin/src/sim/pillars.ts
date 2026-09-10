// Where the pillars under an elevated road stand, in one place.
//
// The sim decides whether a car has hit one and the renderer decides whether to draw one, and for a
// while they disagreed: the renderer measured the road's height above the landscape under it, and the
// sim measured it above y = 0. On a track whose ground is at sea level those are the same number. On
// one with hills, a road lying flat on a hillside two metres up is "elevated" to the sim and at grade
// to the renderer, so the sim put pillars under it and the renderer drew nothing — and you crash into
// a pillar you cannot see.

/** The lowest a deck can stand over the ground and still be worth propping up. */
export const PILLAR_MIN_HEIGHT = 1.5

/**
 * How tall a pillar under the road would be at a point on a lane, or 0 where none stands: nothing
 * under road that is on the ground, nothing under road that is not upright, nothing where there is
 * no surface.
 */
export function pillarHeight(surfaceY: number, groundY: number, upY: number, surface: boolean): number {
  const h = surfaceY - groundY - 0.4
  return surface && upY >= 0.7 && h >= PILLAR_MIN_HEIGHT ? h : 0
}
