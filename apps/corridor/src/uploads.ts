// What still has to reach the GPU.
//
// THE BUG THIS EXISTS FOR (Rich, 2026-09-28: "tree impostors sometimes do not disappear when real
// trees are drawn... if I refresh the page then it goes away then the problem comes back").
//
// three.js uploads a changed BufferAttribute one of two ways. With no update ranges it sends the
// whole array; with ranges it sends only those and then CLEARS THEM ITSELF. Both are correct, and
// mixing them is not:
//
//   a full rewrite followed by a ranged write   uploads only the ranges, so the rewrite is lost
//   two ranged writes with no render between,
//   where the second clears first               loses the first write's ranges
//
// Both leave the CPU array right and the GPU array wrong, which is exactly the shape of this bug:
// the impostor is marked hidden in memory, the card is still standing on the screen, nothing
// throws, and a reload fixes it because a reload uploads everything.
//
// Both happened. `refreshFar` cleared the ranges at its start, and it runs twice in a frame
// whenever a replant triggers one and the near set then moves — and the replant re-seats every
// matrix first, so the seat's full rewrite was being demoted to whatever ranges came after it.
//
// So the rule lives in one object: once something has said "all of it", nothing may narrow that
// back down to a range until an upload has actually happened.
//
// PURE. It holds no attribute and calls no WebGL — the caller asks it whether to register a range.
// That is what makes an upload-ordering bug something a test can state, which matters because
// every symptom of getting it wrong is visual and intermittent.

export interface Range { start: number; count: number }

export class Uploads {
  /** true when the whole buffer is pending, which is what an empty range list means to three */
  private all = false
  private readonly ranges: Range[] = []
  /**
   * How many writes have been made, and how many have reached the GPU.
   *
   * A running tally rather than a flag, because the failure is a write that is silently NOT sent:
   * the CPU array is right, every counter computed from it is right, and the screen is wrong. If
   * these two ever diverge, a write was dropped — which is a thing a probe can assert after a
   * frame, and the only symptom otherwise is a card standing in a tree, intermittently.
   */
  marked = 0
  sent = 0

  /** Everything changed. Any ranges already queued are moot — the full upload carries them. */
  markAll(): void {
    this.all = true
    this.ranges.length = 0
  }

  /**
   * One span changed.
   *
   * Ignored while a full upload is pending, because registering a range then would turn that
   * full upload into a partial one and silently drop every other change.
   */
  mark(start: number, count: number): void {
    this.marked += 1
    // counted either way: while a full upload is pending, this write IS carried by it
    if (this.all) return
    this.ranges.push({ start, count })
  }

  /** Should the caller register this range on the attribute? */
  shouldRegister(): boolean {
    return !this.all
  }

  get pendingAll(): boolean {
    return this.all
  }

  get pendingRanges(): readonly Range[] {
    return this.ranges
  }

  /**
   * The GPU has it now.
   *
   * Driven by three's own `onUpload` callback rather than by the frame loop: the upload happens
   * when the renderer next draws this attribute, which is not the same as "next frame" — a frame
   * that culls the mesh does not upload it, and clearing on a timer would throw away writes that
   * were never sent.
   */
  uploaded(): void {
    // a full upload carries everything written so far, whether or not it had a range
    this.sent = this.all ? this.marked : this.sent + this.ranges.length
    this.all = false
    this.ranges.length = 0
  }
}
