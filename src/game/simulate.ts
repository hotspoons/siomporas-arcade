// One physics step. Conduit space (distance, roll, lift) means there is no
// general-purpose collision here at all — every test is a cheap interval
// compare against the course list, which is why this holds up at 500 units/s.

import {
  BLOCK_HALF_ANGLE,
  BLOCK_HALF_LEN,
  BLOCK_HEIGHT,
  BOOST_DRAIN,
  BOOST_MAX,
  BOOST_PAD_GAIN,
  CHECKPOINT_BONUS,
  GRAVITY,
  HIT_INVULN,
  HIT_SPEED_KEEP,
  JUMP_VEL,
  LIFT_MAX,
  PAD_HALF_ANGLE,
  SPEED_BOOST_BONUS,
  SPEED_BRAKE,
  SPEED_COAST,
  SPEED_LERP,
  SPEED_MAX,
  SPEED_THRUST,
  TURN_ACCEL,
  TURN_DAMP,
  TURN_MAX,
} from './constants'
import type { InputState } from './input'
import { endRun, game } from './state'
import { angleDelta } from './track'

/** Cap the step so an alt-tabbed tab doesn't resume by teleporting a km. */
const MAX_STEP = 0.05

export function stepRun(rawDt: number, input: InputState) {
  const dt = Math.min(rawDt, MAX_STEP)
  if (game.phase !== 'running') {
    decayFeedback(dt)
    return
  }

  // --- roll around the tube ------------------------------------------------
  game.thetaVel += input.steer * TURN_ACCEL * dt
  game.thetaVel -= game.thetaVel * TURN_DAMP * dt
  game.thetaVel = clamp(game.thetaVel, -TURN_MAX, TURN_MAX)
  game.theta += game.thetaVel * dt

  // --- hop off the wall ----------------------------------------------------
  if (input.jump && game.lift <= 0.01) game.liftVel = JUMP_VEL
  if (game.lift > 0 || game.liftVel > 0) {
    game.liftVel -= GRAVITY * dt
    game.lift += game.liftVel * dt
    if (game.lift <= 0) {
      game.lift = 0
      game.liftVel = 0
    } else if (game.lift > LIFT_MAX) {
      game.lift = LIFT_MAX
      game.liftVel = Math.min(game.liftVel, 0)
    }
  }

  // --- speed ---------------------------------------------------------------
  game.boosting = input.boost && game.boost > 0
  if (game.boosting) game.boost = Math.max(0, game.boost - BOOST_DRAIN * dt)
  let cruise = input.brake ? SPEED_BRAKE : input.thrust ? SPEED_THRUST : SPEED_COAST
  if (game.boosting) cruise += SPEED_BOOST_BONUS
  game.v += (cruise - game.v) * SPEED_LERP * dt
  game.v = clamp(game.v, 0, SPEED_MAX)

  const sPrev = game.s
  game.s += game.v * dt
  game.elapsed += dt
  game.timeLeft -= dt
  if (game.invuln > 0) game.invuln = Math.max(0, game.invuln - dt)

  resolveCourse(sPrev)
  decayFeedback(dt)

  if (game.s >= game.track.length) {
    game.s = game.track.length
    endRun('finished')
    return
  }
  if (game.timeLeft <= 0) {
    game.timeLeft = 0
    endRun('wrecked')
  }
}

/**
 * Walk the course items the craft swept past this step. `cursor` only ever
 * moves forward, so this is O(items in the swept window), not O(course).
 */
function resolveCourse(sPrev: number) {
  const { course } = game
  while (game.cursor < course.length && course[game.cursor].s < sPrev - BLOCK_HALF_LEN * 2) {
    game.cursor++
  }
  for (let i = game.cursor; i < course.length; i++) {
    const item = course[i]
    if (item.s > game.s + BLOCK_HALF_LEN) break
    if (item.taken) continue

    if (item.kind === 'gate') {
      // Arches span the tube — crossing the plane is the whole test.
      if (game.s >= item.s) {
        item.taken = true
        game.checkpoints++
        game.timeLeft += CHECKPOINT_BONUS
        game.checkpointFlash = 1
      }
      continue
    }

    const dTheta = Math.abs(angleDelta(item.theta, game.theta))

    if (item.kind === 'pad') {
      if (game.s >= item.s && dTheta < PAD_HALF_ANGLE && game.lift < 3) {
        item.taken = true
        game.boost = Math.min(BOOST_MAX, game.boost + BOOST_PAD_GAIN)
        game.pickupFlash = 1
      }
      continue
    }

    // Blocks sit on the wall: clearing one means either rolling around it or
    // hopping over it.
    const overlapping = Math.abs(game.s - item.s) < BLOCK_HALF_LEN
    if (overlapping && dTheta < BLOCK_HALF_ANGLE && game.lift < BLOCK_HEIGHT) {
      item.taken = true
      if (game.invuln <= 0) hit()
    }
  }
}

function hit() {
  game.shield--
  game.v *= HIT_SPEED_KEEP
  game.invuln = HIT_INVULN
  game.hitFlash = 1
  game.shake = 1
  game.thetaVel *= -0.3
  if (game.shield <= 0) {
    game.shield = 0
    endRun('wrecked')
  }
}

/** Feedback impulses decay on their own so nothing has to clear them. */
function decayFeedback(dt: number) {
  game.hitFlash = Math.max(0, game.hitFlash - dt * 2.2)
  game.pickupFlash = Math.max(0, game.pickupFlash - dt * 2.6)
  game.checkpointFlash = Math.max(0, game.checkpointFlash - dt * 0.8)
  game.shake = Math.max(0, game.shake - dt * 1.8)
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/**
 * Attract-mode drift for the title screen: the conduit keeps flowing past at a
 * lazy cruise so the menu sits over a live scene instead of a frozen frame.
 */
export function stepAttract(dt: number) {
  const step = Math.min(dt, MAX_STEP)
  game.v += (110 - game.v) * 1.2 * step
  game.s += game.v * step
  game.theta += 0.22 * step
  if (game.s > game.track.length - 200) game.s = 0
  decayFeedback(step)
}
