// Where a round or a missile meets the ground — with the bridges in it.
//
// Rich, 2026-10-10: "the missile collider algo needs to follow the same tunnel-under-bridge
// physics that cars do. Currently if you shoot a missile under a bridge it blows up on invisible
// geometry." The weapons asked `site.groundAt`, which at a grade-separated crossing is the UPPER
// carriageway — so a missile flying along the road under an overpass was "below the ground" the
// moment it passed beneath the deck, and went off in mid-air. The car never had that problem: it
// stands on `site.physGroundAt`, the LOWER carriageway, and the deck above is its own collider
// (`decksNear`). This is the same split for a projectile.
//
// A column where the two disagree is a crossing. The deck there is a SLAB — its top at `upper`,
// `DECK_DEPTH_M` thick — and the earth below is at `lower`. A step from `fromY` to `to.y` hits:
//   - the deck's top, coming down onto it from above;
//   - the deck's underside, rising into it from below (a shot up at a bridge does hit it);
//   - the earth below, otherwise, as anywhere else.
// Off a crossing the two heights agree exactly (scene.ts says so) and this is the old test.
// With physics on, the deck colliders catch most of this first through the sweep; with physics
// off (the default on most worlds) this is the only thing standing between a missile and a deck.

/** how thick a deck is taken to be, top to underside */
export const DECK_DEPTH_M = 1.2
/** upper − lower above this is a crossing; below it the two are the same ground */
const CROSSING_M = 0.5

/**
 * The height at which a step from `fromY` down/up to `to` meets something solid, or null.
 * `upper` is the surface you would see (the deck over a crossing), `lower` the ground under it.
 * `skin` lifts the contact, as the missile's old `g + 0.2` did.
 */
export function surfaceCrossing(
  fromY: number,
  to: { x: number; y: number; z: number },
  upper: (x: number, z: number) => number | null,
  lower: ((x: number, z: number) => number | null) | null | undefined,
  skin = 0,
): number | null {
  const hi = upper(to.x, to.z)
  const lo = lower ? lower(to.x, to.z) : null
  if (hi === null && lo === null) return null
  if (hi !== null && lo !== null && hi - lo > CROSSING_M) {
    const top = hi + skin
    const under = hi - DECK_DEPTH_M
    // onto the deck from above, or through it in one step
    if (fromY >= under && to.y <= top && fromY >= hi - skin) return top
    // up into the underside from below
    if (fromY < under && to.y >= under) return under
    // inside the slab (a shot that started in it) counts as the deck
    if (to.y < top && to.y >= under) return fromY >= hi ? top : under
    // the road or the earth beneath
    return to.y <= lo + skin ? lo + skin : null
  }
  const g = (lo ?? hi)!
  return to.y <= g + skin ? g + skin : null
}
