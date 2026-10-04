import * as T from '../tuning'

/*
 * THE NEAR-TREE BUDGET, adapted live.
 *
 * The near models — the procedural trees inside `TREE_NEAR_RADIUS` — are the whole frame cost of a
 * wood. Measured on Rich's machine, stopped in a thick wood at Crofton (2026-10-03): the far cards
 * at full density sit on the display's 60 Hz floor by themselves, while the models reach 43 ms a
 * frame and the near radius, not the density, is what moves it. The cost is canopy FILL, so what
 * has to stay bounded is the number of modeled trees near the eye, not how many trees stand.
 *
 * So the budget is spent on the models: this counts the trees around the eye and picks the near
 * radius that would seat roughly `TREE_ADAPT_MODELS` of them, then a slow loop trims that down when
 * the machine cannot hold `TREE_ADAPT_MS`. `TREE_ADAPT` attenuates the whole adjustment — 0 is the
 * designed amount, -1 pins the near field to the static knobs, +1 doubles the departure from them.
 *
 * The count is a fixed footprint (`TREE_NEAR_RADIUS` about the eye), so the signal does not move
 * with the radius it is choosing: in a dense wood the feed-forward asks for a small radius, in a
 * sparse one it may ask for a larger one, up to the knob.
 */

/** the quality may not fall below this fraction of the knob-level radius, nor rise past `Q_MAX` */
const Q_MIN = 0.3
const Q_MAX = 2.2
/** the trim the frame-time loop may apply before it stops shrinking (a fraction of the feed-forward) */
const TRIM_MIN = 0.35
/** frame times are medians over this many frames, and a window is not believed until this many */
const WINDOW = 30
const MIN_TRUST = 12
/** shrink rate while over budget, recovery rate toward the feed-forward, both per second */
const SHRINK = 1.6
const RECOVER = 0.5
/** how fast the smooth quality chases the target (per second) */
const CHASE = 2

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export interface TreeBudgetStats {
  /** trees detected inside the knob-level near footprint this seat */
  count: number
  /** the approachable model ceiling: knob capacity × species */
  ceiling: number
  /** what the tree count alone asks for */
  feed: number
  /** the frame-time trim, `TRIM_MIN` … 1 */
  trim: number
  /** the smooth quality the attenuator is applied to */
  raw: number
  /** the quality after `TREE_ADAPT` */
  q: number
  /** the effective near radius at the knob-level base it was last asked for */
  radius: number
  /** the achieved floor (slow minimum) and the median the loop is reading, ms */
  floorMs: number
  medMs: number
}

/** The three knobs the governor reads. Injected so a test can drive it without the tuning globals. */
export interface TreeBudgetConfig {
  /** the attenuator: see `TREE_ADAPT` */
  adapt: number
  /** the models the feed-forward aims to seat */
  models: number
  /** the frame time the closed loop trims toward, ms */
  ms: number
}

const fromTuning = (): TreeBudgetConfig => ({ adapt: T.TREE_ADAPT, models: T.TREE_ADAPT_MODELS, ms: T.TREE_ADAPT_MS })

export class TreeBudget {
  private readonly cfg: () => TreeBudgetConfig

  constructor(cfg: () => TreeBudgetConfig = fromTuning) {
    this.cfg = cfg
  }

  private count = 0
  private ceiling = Infinity
  private feed = 1
  private smooth = 1
  private trim = 1
  private ring: number[] = []
  private ringAt = 0
  private floor = Infinity
  private med = 0

  /**
   * The tree count, from the world. `count` is the number of trees inside `baseRadius` about the
   * eye; `ceiling` is the most models the near set could ever seat (knob capacity × species), so a
   * budget above it would only grow the radius without seating another tree.
   */
  trees(count: number, ceiling = Infinity, baseRadius = 0): void {
    this.count = Math.max(0, count)
    this.ceiling = ceiling > 0 ? ceiling : Infinity
    if (baseRadius > 0) this.base = baseRadius
    const want = Math.min(this.cfg().models, this.ceiling * 0.85)
    if (this.count <= 0) { this.feed = Q_MAX; return }
    // models seated scale with the AREA of the near field, so q = sqrt(want / count)
    this.feed = clamp(Math.sqrt(want / this.count), Q_MIN, Q_MAX)
  }
  private base = 110

  /** One frame of the closed loop. `dtMs` is the gap between frames, in milliseconds. */
  frame(dtMs: number): void {
    if (!(dtMs > 0) || !Number.isFinite(dtMs)) return
    const r = this.ring
    if (r.length < WINDOW) r.push(dtMs)
    else { r[this.ringAt] = dtMs; this.ringAt = (this.ringAt + 1) % WINDOW }
    const dt = dtMs / 1000
    if (r.length >= MIN_TRUST) {
      /*
       * The load signal is the fraction of recent frames that MISSED the budget, not a median
       * against a moving floor. That is the honest reading on a vsync'd panel: a frame that lands
       * on time is indistinguishable from one with headroom, so a window whose frames are all on
       * budget (however fast the machine is) is a window with no complaint — and one where a
       * quarter of the frames slipped to the next vsync is a window that is over. The absolute
       * target is the budget; `TREE_ADAPT_MS` should be set to the display's own cadence.
       */
      const slow = this.cfg().ms + 2
      let miss = 0
      for (const v of r) if (v > slow) miss++
      const frac = miss / r.length
      const med = median(r)
      this.med = med
      this.floor = percentile(r, 0.15)
      if (frac > 0.04 || med > this.cfg().ms + 4) this.trim *= Math.exp(-dt * SHRINK)
      else if (frac < 0.01 && med < this.cfg().ms + 1 && this.trim < 1) this.trim *= Math.exp(dt * RECOVER)
      this.trim = clamp(this.trim, TRIM_MIN, 1)
    }
    const want = clamp(this.feed * this.trim, Q_MIN, Q_MAX)
    this.smooth += (want - this.smooth) * Math.min(1, dt * CHASE)
  }

  /** The attenuator: 0 is the designed amount, -1 pins to the static knobs, +1 doubles. */
  q(): number {
    const att = 1 + clamp(this.cfg().adapt, -1, 1)
    return clamp(1 + (this.smooth - 1) * att, Q_MIN, Q_MAX)
  }

  /** The effective near radius for a knob-level base. */
  radius(base: number): number {
    return clamp(base * this.q(), 12, 320)
  }

  /** The effective per-species capacity: it follows the radius down but never past the knob. */
  capacity(base: number): number {
    const q = Math.min(1, this.q())
    return Math.max(8, Math.round(base * (0.55 + 0.45 * q)))
  }

  stats(): TreeBudgetStats {
    return {
      count: this.count,
      ceiling: Number.isFinite(this.ceiling) ? this.ceiling : 0,
      feed: this.feed,
      trim: this.trim,
      raw: this.smooth,
      q: this.q(),
      radius: this.radius(this.base),
      floorMs: Number.isFinite(this.floor) ? this.floor : 0,
      medMs: this.med,
    }
  }

  reset(): void {
    this.count = 0
    this.ceiling = Infinity
    this.feed = 1
    this.smooth = 1
    this.trim = 1
    this.ring.length = 0
    this.ringAt = 0
    this.floor = Infinity
    this.med = 0
  }
}

function percentile(a: number[], p: number): number {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0
}

function median(a: number[]): number {
  return percentile(a, 0.5)
}

export const TREE_BUDGET = new TreeBudget()
