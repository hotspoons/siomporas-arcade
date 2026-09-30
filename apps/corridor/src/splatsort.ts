// How often a gaussian capture has to be re-sorted, and why it has to be sorted at all.
//
// Rich, 2026-09-29, reading the performance panel: *"the splats sorting frequency seems to be
// driving the stalls. Upping the interval to 1 sort a second lowered the stalls, but I don't
// understand why the sort needs to be run at all, or at least as often as it is."*
//
// WHY AT ALL: gaussians are alpha-blended, and alpha blending is order-dependent. They have to be
// drawn back-to-front from wherever the camera is, or near splats blend under far ones and the
// capture turns to haze.
//
// WHY IT WAS SO OFTEN: Spark decides the view has changed if the camera moved more than a
// MILLIMETRE or turned more than 2.6°. In a car that is every frame, so `minSortIntervalMs` was the
// only brake — a fixed timer, which is why raising it helped and why it also re-sorts a parked car.
//
// WHY TURNING DOES NOT COUNT: a radial sort orders by DISTANCE from the camera, which does not
// change when you turn on the spot. Half the re-sorts in a driving game were for a bend.
//
// WHAT A SORT COSTS, which is the part worth knowing: not the sort. That runs in a worker. It is a
// GPU pass writing every gaussian's depth, a readback of that buffer to the CPU — about 10 MB at
// 2.5M gaussians — and an ordering texture of the same size uploaded back. Twenty megabytes across
// the bus, on the frame that asks for it.
//
// This module is separate from `splats.ts` only because that one imports the site loader, which
// reads `location` as it loads and so cannot be imported by a test.

import * as T from './tuning'

/**
 * How far the camera may travel before the order has to be rebuilt, metres.
 *
 * A FRACTION OF THE DISTANCE TO THE CONTENT, because that is what parallax is: a metre of travel
 * with the capture a hundred metres off swings it half a degree and re-orders almost nothing; a
 * metre while parked inside it re-orders everything you can see.
 *
 * Bounded at both ends, and BOTH BOUNDS GO A LONG WAY. The floor stops a capture you are standing
 * in from re-sorting every centimetre. The ceiling decides how far you may travel before a sort is
 * forced regardless — and at 180 mph you cover four hundred metres between sorts on a five-second
 * timer, so a ceiling in the tens of metres is never reached and can never skip anything. It goes
 * to four kilometres, which is far enough to turn the distance gate off entirely.
 */
export function resortAfter(nearestM: number, opts: { parallax?: number; min?: number; max?: number } = {}): number {
  const parallax = opts.parallax ?? T.SPLAT_SORT_PARALLAX
  const min = opts.min ?? T.SPLAT_SORT_MIN_M
  const max = opts.max ?? T.SPLAT_SORT_MAX_M
  if (!Number.isFinite(nearestM)) return max
  return Math.max(min, Math.min(max, nearestM * parallax))
}

/**
 * Should the order be rebuilt now?
 *
 * TWO GATES, AND THE TIMER IS THE ONE THAT MATTERS AT SPEED. Rich, 2026-09-29: *"those ranges are
 * way too tight for the sorting… driving 180MPH is going to trigger the resort wayy too often. I
 * think we need the sort timer to be a lowest number of ms resort and it needs to go up to 5
 * seconds."* Quite right, and the first version had it backwards: a rule that fires every N METRES
 * fires more often the faster you go, so the case it was worst for is the case this game is mostly
 * in. At 80 m/s a two-metre threshold is forty sorts a second.
 *
 * So the distance rule can only ever SKIP a sort, never add one:
 *
 *   the timer     a floor on how often a sort may happen at all. At speed this is the only thing
 *                 that decides, and it is the knob to reach for when it stutters.
 *   the distance  on top of that, do not bother if the camera has barely moved.
 *   the turn      or if it has not turned far enough to matter.
 *
 * THE TURN IS WHY THIS IS NOT JUST DISTANCE. A radial order is the same whichever way you face, so
 * for a while this file claimed turning could not change anything. It can, and Rich found the case
 * with the floor set high: *"traveling in one direction, then turning around and having trees in
 * the distance z sorted above trees in the foreground."* The reason is that the sort's INPUT is
 * frustum-dependent — what was behind you was not in the ordering at all — so a 180° turn presents
 * a screen full of splats that were never sorted for any view. Ninety degrees of heading change
 * forces one.
 *
 * The timer still governs. A spin at the wheel cannot ask for more sorts than the floor allows; it
 * only spends the next one it is entitled to.
 */
export function shouldResort(
  sinceMs: number,
  movedM: number,
  turnedDeg: number,
  nearestM: number,
  opts: { minMs?: number; parallax?: number; min?: number; max?: number; turnDeg?: number } = {},
): boolean {
  const minMs = opts.minMs ?? T.SPLAT_SORT_MS
  if (sinceMs < minMs) return false
  if (movedM >= resortAfter(nearestM, opts)) return true
  return turnedDeg >= (opts.turnDeg ?? T.SPLAT_SORT_TURN_DEG)
}

/**
 * The angle between two directions, degrees. Both are expected to be unit length.
 *
 * `acos` of the dot rather than anything cleverer: this is called once a frame and the accuracy
 * near zero — where `acos` is at its worst — does not matter, because a threshold of ninety degrees
 * is nowhere near it.
 */
export function angleBetween(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))
  return (Math.acos(dot) * 180) / Math.PI
}
