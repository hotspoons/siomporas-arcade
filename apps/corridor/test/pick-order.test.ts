// Which thing a click on the map means. Rich, 2026-10-10: "The active tab's items should … be
// first on selection when clicking" — and the canopy-area case that made the old rule
// smallest-wins (a loop inside a corridor-wide area could never be clicked from the Areas tab) is
// still reachable: a second click on the same spot goes to the next thing there.
import { describe, expect, it } from 'vitest'
import { ClickCycle, rankHits, type PickHit } from '../src/editor/view/pickorder'

const canopy: PickHit = { mode: 'areas', id: 'a-01', size: 640_000 }
const loop: PickHit = { mode: 'stunts', id: 'f-01', size: 6_400 }
const zone: PickHit = { mode: 'traffic', id: 'z-01', size: 90_000 }
const bridge: PickHit = { mode: 'structures', id: 'st-01', size: 600 }

describe('rankHits', () => {
  it('puts the active mode’s thing first, however big', () => {
    expect(rankHits([loop, canopy, zone], 'areas').map((h) => h.id)).toEqual(['a-01', 'f-01', 'z-01'])
    expect(rankHits([loop, canopy, zone], 'traffic').map((h) => h.id)).toEqual(['z-01', 'f-01', 'a-01'])
  })
  it('ranks everything else smallest first — a structure from the Areas tab before the zone', () => {
    expect(rankHits([zone, canopy, bridge, loop], 'areas').map((h) => h.id)).toEqual(['a-01', 'st-01', 'f-01', 'z-01'])
  })
  it('with nothing of the active mode under the pointer, the smallest of any mode', () => {
    expect(rankHits([zone, loop], 'structures')[0]).toBe(loop)
    expect(rankHits([zone], 'structures')[0]).toBe(zone)
    expect(rankHits([], 'structures')).toEqual([])
  })
  it('never swaps two things of the same size between clicks', () => {
    const a: PickHit = { mode: 'traffic', id: 'z', size: 10 }, b: PickHit = { mode: 'stunts', id: 's', size: 10 }
    expect(rankHits([a, b], 'place')[0]).toBe(b)
    expect(rankHits([b, a], 'place')[0]).toBe(b)
  })
})

describe('ClickCycle', () => {
  it('takes the first, then walks down the list on clicks at the same spot, and round', () => {
    const c = new ClickCycle()
    const ranked = rankHits([canopy, loop, zone], 'areas')
    expect(c.choose({ x: 0, y: 0 }, ranked)).toBe(canopy)
    // the second click lands within a metre or so of the first: the loop, as the old rule wanted
    expect(c.choose({ x: 0.8, y: 0.5 }, ranked)).toBe(loop)
    expect(c.choose({ x: 0, y: 0 }, ranked)).toBe(zone)
    expect(c.choose({ x: 0, y: 0 }, ranked)).toBe(canopy)
  })
  it('keeps the first click’s order even though the second switched the active mode', () => {
    const c = new ClickCycle()
    expect(c.choose({ x: 0, y: 0 }, rankHits([canopy, loop, zone], 'areas'))).toBe(canopy)
    // now in Stunts (the click went to the loop) the ranking would put the loop first again
    expect(c.choose({ x: 0, y: 0 }, rankHits([canopy, loop, zone], 'areas'))).toBe(loop)
    expect(c.choose({ x: 0, y: 0 }, rankHits([canopy, loop, zone], 'stunts'))).toBe(zone)
  })
  it('starts over when the click moves, or different things are under it', () => {
    const c = new ClickCycle()
    const ranked = rankHits([canopy, loop], 'areas')
    expect(c.choose({ x: 0, y: 0 }, ranked)).toBe(canopy)
    expect(c.choose({ x: 30, y: 0 }, ranked)).toBe(canopy)
    expect(c.choose({ x: 30, y: 0 }, rankHits([canopy, loop, zone], 'areas'))).toBe(canopy)
    expect(c.choose({ x: 30, y: 0 }, [])).toBeNull()
    expect(c.choose({ x: 30, y: 0 }, ranked)).toBe(canopy)
  })
})
