// A frame budget for work that used to be done all at once.
//
// Building crofton-triangle takes about 14 seconds of main-thread work, and every bit of it ran
// inside one call stack — so the browser did not freeze for fourteen seconds spread thin, it froze
// in TWO frames of 8.4 s and 4.7 s (measured through the dev bridge on Rich's machine, which is
// the only place a real frame time exists). Nothing painted, the tab was unresponsive, and the
// progress messages `status()` writes could not reach the screen because the screen never updated.
//
// The total work is the same either way. What changes is whether it is delivered in slices the
// browser can paint between. A `Budget` hands out time: you call `await b.tick()` in a loop, it
// returns immediately while this frame still has room, and yields to the next frame when it does
// not. The loop stays readable and the page stays alive.
//
// One thing the budget must NOT do is block on a frame that is not coming: see `nextSlice` and
// the hidden-tab check in `tick`.
//
// This is also the floor that tiled streaming is built on. A tile system is exactly this — build a
// bounded amount per frame, nearest first — plus a wanted set and eviction. There is no point
// adding those on top of a builder that cannot be interrupted.

/**
 * How the yield happens: a frame if one is actually coming, otherwise a macrotask.
 *
 * `requestAnimationFrame` DOES NOT FIRE in a background tab. Browsers pause it entirely, so a
 * budgeted build that yields on it stops dead the moment the tab loses focus and never resumes —
 * the page stays responsive, nothing is spinning, and the progress readout sits on whatever it
 * last printed. crofton-triangle sat at "grading 1/427 streets" indefinitely on Rich's machine
 * while building fine headless, and it took a visibility check to see why: the tab was simply not
 * in front. The same happens with an occluded window or a sleeping monitor.
 *
 * So: a macrotask when the document is hidden, and even when it is visible, race the frame
 * against a timer. A build must never depend on a frame that may not come.
 */
const nextSlice = (): Promise<void> => {
  if (typeof requestAnimationFrame !== 'function') return new Promise((r) => setTimeout(r, 0))
  return new Promise((r) => {
    let done = false
    const fin = () => {
      if (done) return
      done = true
      r()
    }
    requestAnimationFrame(fin)
    // only bites if rAF is not coming; a visible tab resolves on the frame, as intended
    setTimeout(fin, 100)
  })
}

export interface BudgetStats {
  /** how many times the work yielded back to the browser */
  yields: number
  /** total wall-clock across the whole budgeted run, ms */
  elapsedMs: number
  /** the longest single slice that ran without yielding, ms — the worst frame this caused */
  worstSliceMs: number
}

export class Budget {
  private sliceMs: number
  private sliceStart = performance.now()
  private started = performance.now()
  private onProgress?: (done: number, total: number) => void
  private done = 0
  private total = 0
  readonly stats: BudgetStats = { yields: 0, elapsedMs: 0, worstSliceMs: 0 }

  /** @param sliceMs how long to work before handing the frame back */
  constructor(sliceMs = 8) {
    this.sliceMs = sliceMs
  }

  /** optional: drives a progress readout, called at most once per yield */
  track(total: number, onProgress?: (done: number, total: number) => void) {
    this.total = total
    this.done = 0
    this.onProgress = onProgress
  }

  /**
   * Yield if this frame's slice is spent. `n` is how many items were completed since the last
   * call, purely for the progress readout.
   *
   * Call it in the loop body, not around the loop — the point is to interrupt work that is
   * already long, and a check that only runs between whole phases interrupts nothing.
   */
  async tick(n = 1): Promise<void> {
    this.done += n
    const now = performance.now()
    const slice = now - this.sliceStart
    if (slice < this.sliceMs) return
    // A HIDDEN TAB HAS NO FRAMES TO PROTECT. requestAnimationFrame is paused outright there, and
    // setTimeout is clamped to about 1 Hz, so yielding costs a second an item and a 427-branch
    // build never finishes — measured crawling 1 -> 46 of 427 in a minute before this check, and
    // stopped dead before that when the yield was rAF alone. The whole point of the budget is to
    // let the browser paint between slices; where it is not painting, just get on with it.
    if (typeof document !== 'undefined' && document.hidden) {
      this.sliceStart = now
      return
    }
    if (slice > this.stats.worstSliceMs) this.stats.worstSliceMs = slice
    this.stats.yields++
    this.onProgress?.(this.done, this.total)
    await nextSlice()
    this.sliceStart = performance.now()
  }

  /** close the books — `stats.elapsedMs` is wall clock including the time spent yielded */
  finish(): BudgetStats {
    const slice = performance.now() - this.sliceStart
    if (slice > this.stats.worstSliceMs) this.stats.worstSliceMs = slice
    this.stats.elapsedMs = Math.round(performance.now() - this.started)
    this.stats.worstSliceMs = Math.round(this.stats.worstSliceMs)
    return this.stats
  }
}

/**
 * Run a budgeted pass over a list. The common shape: build 427 of something without freezing.
 *
 * Returns the results in order, so it is a drop-in for `list.map(fn)` that yields.
 */
export async function mapBudgeted<T, R>(
  items: readonly T[],
  fn: (item: T, i: number) => R,
  sliceMs = 8,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const b = new Budget(sliceMs)
  b.track(items.length, onProgress)
  const out: R[] = new Array(items.length)
  for (let i = 0; i < items.length; i++) {
    out[i] = fn(items[i], i)
    await b.tick()
  }
  b.finish()
  return out
}
