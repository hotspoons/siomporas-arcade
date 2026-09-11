// Motion inputs: the part that decides whether this feels like the games it is pretending to be.
//
// Everything here operates on a ring buffer of raw per-frame input and answers one question —
// "given what the player has done recently, did they just do a dragon punch?" It knows nothing
// about characters, moves, hitboxes or the game being 2D or 3D. That is deliberate: the same parser
// runs in all three dimensions, because a quarter circle is a quarter circle whether the camera is
// side-on or not.
//
// NOTATION. Numpad, as the genre has written it for thirty years, always relative to the direction
// the fighter is facing:
//
//     7 8 9      4 is back, 6 is forward, 5 is neutral.
//     4 5 6      236 = quarter circle forward. 623 = dragon punch.
//     1 2 3      [4]6 = hold back, then forward.
//
// WHY THE MATCHING IS LOOSE. A player doing 236 does not produce 2, 3, 6 on three consecutive
// frames. They produce something like 5,2,2,3,3,3,6,6 with a stray 1 in the middle, and on a d-pad
// they frequently skip 3 entirely. So the matcher scans backwards for each step in turn and allows
// anything at all between the steps, subject to the whole motion fitting inside a window. This is
// how the real thing works and why it feels forgiving; an exact-sequence matcher feels broken even
// though it is "correct".
//
// FACING AND CROSS-UPS. Raw input is stored absolute — screen left and screen right — and converted
// to numpad at match time using the facing the fighter has *now*. That is the simple rule and it has
// a known cost: if you jump over someone and complete a motion as you cross, the half you input
// before the flip is reinterpreted. Every game in the genre has a version of this problem and every
// solution to it is worse. Storing it absolute at least means the bug is explicable.

/** Numpad direction, relative to facing. */
export type Dir = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** +1 faces screen right, -1 faces screen left. */
export type Facing = 1 | -1

/**
 * Six buttons, because this is a six-button game. A modern pad has the face four plus both
 * shoulders, which is exactly six and is not a coincidence — see DESIGN.md.
 */
export const Button = {
  LP: 1 << 0,
  MP: 1 << 1,
  HP: 1 << 2,
  LK: 1 << 3,
  MK: 1 << 4,
  HK: 1 << 5,
} as const

export type ButtonMask = number

/** Direction groups worth having names for. */
export const BACK: readonly Dir[] = [1, 4, 7]
export const FORWARD: readonly Dir[] = [3, 6, 9]
export const DOWN: readonly Dir[] = [1, 2, 3]
export const UP: readonly Dir[] = [7, 8, 9]

/**
 * Default leniencies, in frames at 60Hz. These are the numbers to argue about, and they are the
 * numbers that decide whether the game feels like 1991 or like a modern revival. Roughly:
 * fifteen frames for a quarter circle is period-accurate and strict; modern games run nearer
 * twenty-five. Start here and raise them after watching someone who is not you try to play.
 */
export const LENIENCY = {
  /** How long a whole motion may take, first step to last. */
  window: 15,
  /** How stale the last step of a motion may be when the button is pressed. */
  buffer: 8,
  /** Frames a charge must be held. */
  charge: 45,
  /** How long after letting go of a charge the button still counts. */
  chargeRelease: 12,
  /** Window for the two taps of a dash. */
  doubleTap: 12,
} as const

export interface Motion {
  readonly name: string
  /** Steps in the order they are input. Each step is the set of directions that satisfies it. */
  readonly steps: readonly (readonly Dir[])[]
  /** Overrides LENIENCY.window for this motion. */
  readonly window?: number
}

/**
 * The motions the game actually uses. Note how many of them list more directions per step than the
 * notation implies — 236 accepts 1 for its first step because players roll through it, and accepts
 * 9 for its last because they are already jumping out of it. Being generous here costs nothing and
 * is most of what "tight controls" means in practice.
 */
export const QCF: Motion = { name: 'qcf', steps: [[1, 2], [2, 3], [3, 6, 9]] }
export const QCB: Motion = { name: 'qcb', steps: [[2, 3], [1, 2], [1, 4, 7]] }

/**
 * 623 — forward, down, down-forward. The last step is the diagonal and *not* a second forward:
 * writing it as 6236 looks more like what a player does with their thumb, but it rejects the clean
 * three-position input that a stick actually produces. Ending on the diagonal accepts both, because
 * in 6236 the diagonal is still in the buffer when the button arrives.
 *
 * This is why you cannot walk forward and throw a fireball. 6,6,2,3 contains a dragon punch, the
 * game fires the dragon punch, and you eat a sweep. That has been true since 1991 and it is not a
 * bug to be fixed — check DP before QCF and let it happen.
 */
export const DP: Motion = { name: 'dp', steps: [[3, 6, 9], [1, 2], [2, 3]], window: 18 }
export const RDP: Motion = { name: 'rdp', steps: [[1, 4, 7], [2, 3], [1, 2]], window: 18 }
export const HCF: Motion = { name: 'hcf', steps: [[4, 7], [1, 2], [2], [2, 3], [3, 6]], window: 24 }
export const HCB: Motion = { name: 'hcb', steps: [[6, 9], [2, 3], [2], [1, 2], [1, 4]], window: 24 }

/** A fixed-size ring of raw input frames. Age 0 is the frame just pushed. */
export class InputHistory {
  readonly capacity: number
  private readonly xs: Int8Array
  private readonly ys: Int8Array
  private readonly bs: Int32Array
  private head = 0
  private filled = 0

  constructor(capacity = 120) {
    this.capacity = capacity
    this.xs = new Int8Array(capacity)
    this.ys = new Int8Array(capacity)
    this.bs = new Int32Array(capacity)
  }

  /** One tick. `x` and `y` are absolute: +x is screen right, +y is up. */
  push(x: number, y: number, buttons: ButtonMask): void {
    this.head = (this.head + 1) % this.capacity
    this.xs[this.head] = Math.sign(x)
    this.ys[this.head] = Math.sign(y)
    this.bs[this.head] = buttons
    if (this.filled < this.capacity) this.filled++
  }

  get length(): number {
    return this.filled
  }

  private index(age: number): number {
    return (this.head - age + this.capacity * Math.ceil((age + 1) / this.capacity)) % this.capacity
  }

  /** The numpad direction `age` frames ago, as the fighter facing `facing` experienced it. */
  dir(age: number, facing: Facing): Dir {
    if (age < 0 || age >= this.filled) return 5
    const i = this.index(age)
    return (5 + this.xs[i] * facing + 3 * this.ys[i]) as Dir
  }

  buttons(age: number): ButtonMask {
    if (age < 0 || age >= this.filled) return 0
    return this.bs[this.index(age)]
  }

  /** True on the frame a button goes down, and not while it is held. */
  pressed(button: ButtonMask, age = 0): boolean {
    return (this.buttons(age) & button) !== 0 && (this.buttons(age + 1) & button) === 0
  }

  /** True on the frame a button comes up. SF2 fired specials on this too — see DESIGN.md. */
  released(button: ButtonMask, age = 0): boolean {
    return (this.buttons(age) & button) === 0 && (this.buttons(age + 1) & button) !== 0
  }

  clear(): void {
    this.head = 0
    this.filled = 0
  }
}

/**
 * Did the player just complete this motion?
 *
 * Scans backwards, last step first, taking the most recent frame that satisfies each step and then
 * looking strictly further back for the one before it. Anything may appear between steps. The whole
 * thing has to fit inside the motion's window, and the final step has to be no more than `buffer`
 * frames stale, which is what lets you finish the motion a few frames before you press the button.
 */
export function matchMotion(
  history: InputHistory,
  motion: Motion,
  facing: Facing,
  { buffer = LENIENCY.buffer, window = motion.window ?? LENIENCY.window }: { buffer?: number; window?: number } = {},
): boolean {
  const steps = motion.steps
  if (steps.length === 0) return true

  // The newest step may sit anywhere in the buffer; try each landing spot, newest first, because a
  // greedy scan that starts too far back can miss a match a later start would have found.
  for (let start = 0; start <= buffer && start < history.length; start++) {
    if (!steps[steps.length - 1].includes(history.dir(start, facing))) continue

    let age = start
    let ok = true
    for (let s = steps.length - 2; s >= 0; s--) {
      const limit = start + window
      let found = -1
      for (let a = age + 1; a <= limit && a < history.length; a++) {
        if (steps[s].includes(history.dir(a, facing))) {
          found = a
          break
        }
      }
      if (found < 0) {
        ok = false
        break
      }
      age = found
    }
    if (ok) return true
  }
  return false
}

export interface Charge {
  readonly name: string
  /** Directions that count as holding the charge. Holding 1 charges both back and down. */
  readonly hold: readonly Dir[]
  /** Directions that count as releasing it. */
  readonly release: readonly Dir[]
  readonly frames?: number
}

export const CHARGE_BACK: Charge = { name: 'charge-back', hold: BACK, release: FORWARD }
export const CHARGE_DOWN: Charge = { name: 'charge-down', hold: DOWN, release: UP }

/**
 * Charge moves. Held back for long enough, then forward, then the button — and the "then" between
 * forward and the button is generous, because nobody hits those two on the same frame.
 *
 * The hold set matters more than it looks. Holding down-back charges *both* a back charge and a
 * down charge simultaneously, which is why charge characters crouch-block: it is free, and it is
 * the whole reason the archetype is fun to play.
 */
export function matchCharge(
  history: InputHistory,
  charge: Charge,
  facing: Facing,
  {
    frames = charge.frames ?? LENIENCY.charge,
    releaseWindow = LENIENCY.chargeRelease,
  }: { frames?: number; releaseWindow?: number } = {},
): boolean {
  for (let start = 0; start <= releaseWindow && start < history.length; start++) {
    if (!charge.release.includes(history.dir(start, facing))) continue
    let held = 0
    for (let a = start + 1; a < history.length; a++) {
      if (!charge.hold.includes(history.dir(a, facing))) break
      held++
      if (held >= frames) return true
    }
  }
  return false
}

/**
 * A rotation — the grappler's 360. Satisfied by visiting `need` of the eight directions inside the
 * window, in any order and with no requirement that the rotation be consistent.
 *
 * That looseness is not laziness, it is the genre convention: it is what makes a 360 buffered into
 * a jump possible, and taking it away would make the move unusable on a d-pad. Six of eight is the
 * traditional number.
 */
export function matchRotation(
  history: InputHistory,
  facing: Facing,
  { need = 6, window = 30 }: { need?: number; window?: number } = {},
): boolean {
  let seen = 0
  let bits = 0
  for (let a = 0; a < window && a < history.length; a++) {
    const d = history.dir(a, facing)
    if (d === 5) continue
    const bit = 1 << d
    if ((bits & bit) === 0) {
      bits |= bit
      if (++seen >= need) return true
    }
  }
  return false
}

/** Tap, release, tap — a dash. `dir` is the direction group being tapped. */
export function matchDoubleTap(
  history: InputHistory,
  dirs: readonly Dir[],
  facing: Facing,
  { window = LENIENCY.doubleTap }: { window?: number } = {},
): boolean {
  const held = (a: number) => dirs.includes(history.dir(a, facing))
  if (!held(0) || held(1)) return false // must be the frame the second tap goes down
  let a = 1
  while (a < window && a < history.length && !held(a)) a++ // the gap
  if (a >= window || a >= history.length) return false
  const gapEnd = a
  while (a < window && a < history.length && held(a)) a++ // the first tap
  return a > gapEnd
}
