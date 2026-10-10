// Which thing a click on the map means, when several modes have something under it.
//
// Rich, 2026-10-10: *"The active tab's items should appear bolder than other tabs items and be
// first on selection when clicking."*
//
// THE ACTIVE MODE FIRST, then the smallest of everything else. That reverses the rule this
// replaced, which was "smallest wins across every mode", written (2026-09-29) because a canopy area
// covers the whole corridor, so in the Areas tab an active-first rule meant a loop standing in the
// middle of it could never be clicked. That problem is real, and it is answered here differently:
//
// A SECOND CLICK ON THE SAME SPOT GOES TO THE NEXT THING THERE. The first click takes the active
// mode's thing — what you are working on, as asked — and clicking again without moving walks down
// the list: the loop inside the canopy, then the zone under both, and round. Every 2D editor with
// stacked things does this (Illustrator's "select behind", Blender's repeat-click cycle), and it
// costs nothing to the common case of one thing under the cursor.
//
// Pure, so the order is tested without a canvas: test/pick-order.test.ts.

/** The editor's modes, as far as picking cares: `points` covers its Courses tab's race gates too. */
export type PickMode = 'areas' | 'place' | 'structures' | 'traffic' | 'stunts' | 'points'

export interface PickHit {
  mode: PickMode
  id: string
  /** how big the thing is (m²): smaller is more specific, so it ranks first among equals */
  size: number
}

/** A fixed order between modes, so two things of the same size never swap from one click to the next. */
const ORDER: PickMode[] = ['points', 'stunts', 'place', 'structures', 'traffic', 'areas']

const key = (h: PickHit) => `${h.mode}:${h.id}`

/** The active mode's things first (smallest first), then every other mode's, smallest first. */
export function rankHits(hits: PickHit[], active: string): PickHit[] {
  return [...hits].sort((a, b) => {
    const aa = a.mode === active ? 0 : 1, bb = b.mode === active ? 0 : 1
    if (aa !== bb) return aa - bb
    return a.size - b.size || ORDER.indexOf(a.mode) - ORDER.indexOf(b.mode)
  })
}

/** How far a click may land from the last one and still be "the same spot", in metres on the ground. */
export const SAME_SPOT_M = 2

/**
 * Remembers the last click so a repeat on the same spot moves to the next candidate.
 *
 * THE LIST IS FROZEN AT THE FIRST CLICK. The second click usually switches mode (the loop's), and
 * re-ranking against the new active mode would put the loop first again — the cycle would stick on
 * it. So the cycle walks the order the first click saw, for as long as the clicks stay put and the
 * same things stay under them.
 */
export class ClickCycle {
  private last: { x: number; y: number; order: PickHit[]; keys: string; at: number } | null = null

  choose(pt: { x: number; y: number }, ranked: PickHit[]): PickHit | null {
    if (!ranked.length) {
      this.last = null
      return null
    }
    const keys = ranked.map(key).sort().join('|')
    const l = this.last
    if (l && l.keys === keys && Math.hypot(pt.x - l.x, pt.y - l.y) <= SAME_SPOT_M) {
      l.at = (l.at + 1) % l.order.length
      return l.order[l.at]
    }
    this.last = { x: pt.x, y: pt.y, order: ranked, keys, at: 0 }
    return ranked[0]
  }

  /** Forget: the selection changed some other way (the list, a key, a load). */
  reset() {
    this.last = null
  }
}
