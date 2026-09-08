import { describe, expect, it } from 'vitest'
import { OVAL } from '../src/sim/tracks'
import { brushTerrain, clampTerrain, flatTerrain, flattenUnderPieces, TERRAIN_MAX_STEP, terrainIndex } from '../src/sim/terrain'

const maxAbs = (h: number[]) => h.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const steepest = (h: number[], size: number) => {
  let worst = 0
  for (let z = 0; z <= size; z++)
    for (let x = 0; x <= size; x++) {
      const i = terrainIndex(size, x, z)
      if (x < size) worst = Math.max(worst, Math.abs(h[terrainIndex(size, x + 1, z)] - h[i]))
      if (z < size) worst = Math.max(worst, Math.abs(h[terrainIndex(size, x, z + 1)] - h[i]))
    }
  return worst
}

describe('clampTerrain', () => {
  it('settles a spike without moving the rest of the land', () => {
    const size = 8
    const h = flatTerrain(size)
    h[terrainIndex(size, 4, 4)] = 900
    expect(clampTerrain(h, size)).toBe(true)
    expect(steepest(h, size)).toBeLessThanOrEqual(TERRAIN_MAX_STEP + 1e-6)
    expect(h[terrainIndex(size, 0, 0)]).toBe(0)
  })

  it('leaves land that is already within the limits alone', () => {
    const size = 6
    const h = flatTerrain(size)
    brushTerrain(h, size, 3, 3, 3, 8)
    const before = [...h]
    expect(clampTerrain(h, size)).toBe(false)
    expect(h).toEqual(before)
  })

  it('replaces values that are not finite', () => {
    const size = 4
    const h = flatTerrain(size)
    h[terrainIndex(size, 2, 2)] = Number.NaN
    clampTerrain(h, size)
    expect(h.every((v) => Number.isFinite(v))).toBe(true)
  })
})

describe('flattenUnderPieces', () => {
  // The landscape editor used to grade the sculpted heightmap in place on every brush sample, so the
  // corridor resampled its own output and the spline overshoot compounded into six-figure spikes.
  it('is stable when it is run over its own output again and again', () => {
    const size = OVAL.size
    const h = flatTerrain(size)
    brushTerrain(h, size, 6, 6, 5, 40)
    brushTerrain(h, size, 10, 4, 4, -25)
    for (let i = 0; i < 400; i++) flattenUnderPieces(h, size, OVAL.pieces)
    expect(maxAbs(h)).toBeLessThan(200)
    expect(steepest(h, size)).toBeLessThanOrEqual(TERRAIN_MAX_STEP + 1e-6)
  })
})
