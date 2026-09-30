// What "down" is when you are halfway up a loop.
//
// Rich, 2026-09-29: *"the car just drove right through the loop"* — once the chassis stopped
// colliding with the track, nothing was left to stop it, and nothing was left to carry it either.
// That is the honest state of a ray-cast vehicle on a vertical surface: each wheel casts its ray
// along the CHASSIS' own down axis, so a car sitting level cannot feel a road that has stood up in
// front of it. The ray points at the field.
//
// So the car has to be told. This module decides, for a position in the world, whether it is on a
// stunt track and which way that track's surface faces; `Vehicle.stick` does the turning and the
// pulling. Split there because the geometry belongs to corridor and the forces belong to the engine.
//
// THE FADE IS THE WHOLE DESIGN. An assist that is either on or off snaps the car upright the moment
// it clips a fixture's edge and drops it the moment it leaves. Strength falls off with distance from
// the lane, so driving past a loop does nothing, driving onto one takes hold over a car's length,
// and leaving one hands you back to ordinary gravity over the same distance.

import type { Pose } from './stunts'

export interface AssistOpts {
  /** full strength within this far of the lane's centreline, metres */
  hold_m?: number
  /** nothing at all beyond this, metres */
  release_m?: number
}

export const HOLD_M = 5
export const RELEASE_M = 11

/**
 * How strongly the track should hold a car at this distance from its lane, 0…1.
 *
 * Smoothstepped rather than linear: a linear fade has a corner at each end, and a corner in a force
 * is something you feel through the wheel.
 */
export function holdStrength(d: number, opts: AssistOpts = {}): number {
  const hold = opts.hold_m ?? HOLD_M
  const release = opts.release_m ?? RELEASE_M
  if (!(d > hold)) return 1
  if (d >= release) return 0
  const t = 1 - (d - hold) / (release - hold)
  return t * t * (3 - 2 * t)
}

/** The surface's up at a pose, in THREE's frame (x east, y up, z south). Site poses are z-up. */
export function upOf(p: Pose): { x: number; y: number; z: number } {
  const u = p.up ?? { x: 0, y: 0, z: 1 }
  const len = Math.hypot(u.x, u.y, u.z) || 1
  return { x: u.x / len, y: u.z / len, z: -u.y / len }
}

/**
 * How far ahead of the car to read the track, metres.
 *
 * ALIGNING TO WHAT IS UNDER YOU IS TOO LATE. The surface under a car on the flat run-in is flat, so
 * an assist that reads it does nothing at all — and then the nose meets the ramp at full speed and
 * the car stops dead, which is the fault this whole thread began with. Reading a car's length or
 * two ahead means the body is already pitching when the ramp arrives, which is what a driver does
 * without thinking and what makes the difference between climbing and crashing.
 *
 * Scaled with speed, because the faster you go the sooner you need to start.
 */
export function lookAhead(speed: number, opts: { min?: number; max?: number; seconds?: number } = {}): number {
  const min = opts.min ?? 5
  const max = opts.max ?? 16
  return Math.max(min, Math.min(max, Math.abs(speed) * (opts.seconds ?? 0.35)))
}

/**
 * How much of the extra gravity a surface actually needs, 0…2.
 *
 * NONE OF IT ON THE FLAT, and that is not an optimisation — it is the difference between a car that
 * drives and one that cannot move. Ordinary gravity already holds a car on a level road; adding
 * 25 m/s² of it presses the suspension through its travel until the body rests on the tarmac, the
 * tyres carry no weight, and the car stops with all four wheels "down". Measured exactly that way:
 * stopped at the mouth of the approach, four wheels in contact, the chassis touching a floor.
 *
 * So the pull is scaled by how far the surface has turned away from level: nothing while flat, all
 * of it where the track is vertical, and twice as much upside down — which is where a car is held
 * on by nothing else at all.
 */
export function pullScale(up: { x: number; y: number; z: number }): number {
  return Math.max(0, Math.min(2, 1 - up.y))
}

/** One gravity, so the assist's own strength can be read as "how many g of net press". */
export const G = 9.81

/**
 * How hard to press the car into the surface, m/s², capped.
 *
 * THE CAP IS NOT A TASTE DECISION. A ray-cast vehicle's suspension has a finite travel; press
 * harder than it can absorb and the body reaches the track, at which point the solver is pushing
 * the car out of a surface the assist is pushing it into — which reads, from the driving seat, as a
 * loop made of treacle. Two and a half g is past anything a car does on a road and short of that.
 */
export function pullFor(up: { x: number; y: number; z: number }, strength: number, opts: { max?: number } = {}): number {
  return Math.min(opts.max ?? G * 2.5, strength * pullScale(up))
}

export interface Assist {
  /** which way is up, in three's frame */
  up: { x: number; y: number; z: number }
  /** 0…1 */
  strength: number
  /** how far the car is from the lane, metres — for a readout */
  d: number
}

/**
 * Work out the assist for a car at a point, given whatever the world says is nearest.
 *
 * Null when there is nothing near enough to matter, which is the normal case everywhere except on a
 * fixture — so the caller does nothing at all on an ordinary road.
 */
export function assistAt(near: { pose: Pose; d: number } | null, opts: AssistOpts = {}): Assist | null {
  if (!near) return null
  const strength = holdStrength(near.d, opts)
  if (strength <= 0) return null
  return { up: upOf(near.pose), strength, d: near.d }
}

/**
 * The assist for a car, from what is under it and what is in front of it.
 *
 * TWO SAMPLES, EACH ANSWERING A DIFFERENT QUESTION. The one under the car decides WHETHER the
 * assist applies at all — you have to be on the fixture for the track to have an opinion about
 * which way is up. The one ahead decides WHICH WAY, because the whole point is to be turned for the
 * surface before you reach it.
 */
export function assistAhead(
  under: { pose: Pose; d: number } | null,
  ahead: { pose: Pose; d: number } | null,
  opts: AssistOpts = {},
): Assist | null {
  const here = assistAt(under, opts)
  if (!here) return null
  // the far sample only supplies the direction, and only when it is on the lane itself
  const there = ahead && holdStrength(ahead.d, opts) > 0 ? upOf(ahead.pose) : null
  return there ? { ...here, up: there } : here
}

/**
 * Should the assist apply at all, given how the car is oriented?
 *
 * YES EVEN WHEN THE CAR IS ALREADY UPRIGHT, because the flat run-in to a loop is part of the
 * fixture and the assist there is a no-op that costs nothing: the surface's up and the car's up
 * already agree, so the torque is zero and the pull is straight down, which is where gravity was
 * pointing anyway. It matters that this is true — it means the assist can be switched on the moment
 * a car touches a fixture rather than at some threshold nobody can see.
 */
export function assistIsIdle(a: Assist, carUp: { x: number; y: number; z: number }): boolean {
  const dot = a.up.x * carUp.x + a.up.y * carUp.y + a.up.z * carUp.z
  return dot > 0.999
}
