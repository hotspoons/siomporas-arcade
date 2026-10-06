// Grade separation, without a renderer.
//
// Where two carriageways cross at different heights the ground can only follow one, and the other
// has to be a real surface or the car falls through it. The two decisions that make that work are
// pure arithmetic — which level the ground prefers, and the shape of the deck it hands the upper
// road — so they are tested here and only trusted on a screen after.
import { describe, expect, it } from 'vitest'
import { deckRibbon, isDeck, type DeckStation } from '../src/world/overpass'

const at = (over: Partial<DeckStation> = {}): DeckStation => ({ x: 0, z: 0, half: 5, off: 0, s: 0, y: 0, ...over })
const flat = () => 0

describe('which level the ground follows', () => {
  it('calls a carriageway a deck only where it is a real level above the earth', () => {
    // the Beltway under the ramp: the ramp spline at 41.8 over earth at 34 is a deck
    expect(isDeck(41.8, 34, 3)).toBe(true)
    // a fill embankment is IN the DEM, so the road is still ground
    expect(isDeck(36.5, 34, 3)).toBe(false)
    expect(isDeck(37, 34, 3)).toBe(false) // exactly the threshold is not a level
    expect(isDeck(37.01, 34, 3)).toBe(true)
  })

  it('does nothing when the road is on the earth', () => {
    expect(isDeck(34.2, 34, 3)).toBe(false)
    expect(isDeck(30, 34, 3)).toBe(false) // below the earth is still ground
  })
})

describe('the deck under the upper road', () => {
  it('makes nothing of a road that is on the earth', () => {
    expect(deckRibbon([at({ s: 0 }), at({ s: 10, x: 10 })], flat, 3)).toBeNull()
    expect(deckRibbon([at()], flat, 3)).toBeNull()
    expect(deckRibbon([], flat, 3)).toBeNull()
  })

  it('wraps one straight elevated span in a quad the width of its pavement', () => {
    const g = deckRibbon([at({ x: 0, z: 0, y: 10, s: 0 }), at({ x: 10, z: 0, y: 10, s: 10 })], flat, 3)!
    expect(g).not.toBeNull()
    expect([...g.indices]).toEqual([0, 1, 2, 1, 3, 2])
    expect(g.positions.length).toBe(12)
    // site frame: x east, y north (= -world z), z up (= world y). A 10 m span at +10, half-width 5.
    expect([...g.positions]).toEqual([
      0, 5, 10, // A, left edge (right of travel is +world z, so north -5; left is north +5)
      0, -5, 10, // A, right edge
      10, 5, 10, // B, left edge
      10, -5, 10, // B, right edge
    ])
  })

  it('offsets the pavement when the carriageway is off its spline', () => {
    const g = deckRibbon([at({ x: 0, z: 0, y: 10, s: 0, off: 3 }), at({ x: 10, z: 0, y: 10, s: 10, off: 3 })], flat, 3)!
    const north = [...g.positions].filter((_, i) => i % 3 === 1)
    // off 3, half 5 → edges at lateral -2 and +8, i.e. north +2 and -8
    expect(Math.min(...north)).toBe(-8)
    expect(Math.max(...north)).toBe(2)
  })

  it('covers only the part of the road that is actually up', () => {
    const list = [
      at({ x: 0, z: 0, y: 0, s: 0 }),
      at({ x: 10, z: 0, y: 0, s: 10 }),
      at({ x: 20, z: 0, y: 10, s: 20 }),
    ]
    const g = deckRibbon(list, flat, 3)!
    expect(g.positions.length).toBe(12) // one quad, over the 10→20 span only
    const xs = [...g.positions].filter((_, i) => i % 3 === 0)
    expect(Math.min(...xs)).toBe(10)
    expect(Math.max(...xs)).toBe(20)
  })

  it('will not bridge a gap in the station list', () => {
    const list = [at({ x: 0, z: 0, y: 10, s: 0 }), at({ x: 40, z: 0, y: 10, s: 40 })]
    expect(deckRibbon(list, flat, 3)).toBeNull()
  })

  it('uses the earth under the span, not a fixed datum', () => {
    // a flat road at 10 over a slope that climbs to meet it: the low span decks, the high one does not
    const earth = (x: number) => x
    const list = [at({ x: 0, y: 10, s: 0 }), at({ x: 10, y: 10, s: 10 }), at({ x: 20, y: 10, s: 20 })]
    const g = deckRibbon(list, earth, 3)!
    expect(g.positions.length).toBe(12) // only the 0→10 span (earth 5 under it), not 10→20
    const xs = [...g.positions].filter((_, i) => i % 3 === 0)
    expect(Math.max(...xs)).toBe(10)
  })
})
