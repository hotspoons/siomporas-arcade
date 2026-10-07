import { describe, expect, it } from 'vitest'
import { chunkSegments, chunkStations, nChunksOf, nStationsOf } from '../src/world/branchchunks'

/*
 * A branch road is built one chunk at a time, and the chunks must tile the branch exactly: every
 * quad of the whole-branch mesh drawn once, no gap between two chunk meshes and no overlap to
 * z-fight. These lengths are the real Beltway carriageways (63.0 km / 61.9 km) plus the awkward ends.
 */
const LENGTHS = [0, 1, 6, 11, 100, 249, 250, 251, 500, 1000, 3000, 61900, 63030, 63027.719, 123456.7]
const CHUNK = 250

describe('branch chunk tiling', () => {
  for (const len of LENGTHS) {
    it(`tiles ${len} m with no gap or overlap`, () => {
      const segs = chunkSegments(len, CHUNK)
      expect(segs.length).toBe(nChunksOf(len, CHUNK))
      const last = nStationsOf(len) - 1
      expect(segs[0][0]).toBe(0)
      expect(segs[segs.length - 1][1]).toBe(last)
      for (let k = 0; k < segs.length; k++) {
        // every chunk draws at least one quad
        expect(segs[k][1]).toBeGreaterThan(segs[k][0])
        // and shares its end station with the next chunk's start — exact abutment
        if (k + 1 < segs.length) expect(segs[k][1]).toBe(segs[k + 1][0])
      }
    })
  }

  it('keeps chunk 0 exactly as a whole-branch build would start it', () => {
    // the first chunk's stations must be the 0,6,12,… grid, with absolute `s`
    const [ia, ib] = chunkStations(61900, 0, CHUNK)
    expect(ia).toBe(0)
    expect(ib).toBeGreaterThan(1)
  })

  it('covers the union of all quads once', () => {
    const len = 61900
    const nSt = nStationsOf(len)
    const seen = new Set<number>()
    for (const [ia, ib] of chunkSegments(len, CHUNK)) {
      for (let q = ia; q < ib; q++) {
        // quad q joins station q and q+1; each must be owned by exactly one chunk
        expect(seen.has(q)).toBe(false)
        seen.add(q)
      }
    }
    expect(seen.size).toBe(nSt - 1)
    for (let q = 0; q < nSt - 1; q++) expect(seen.has(q)).toBe(true)
  })
})
