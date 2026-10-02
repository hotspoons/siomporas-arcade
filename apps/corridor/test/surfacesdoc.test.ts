// A world's textures lay over the defaults and never replace them with nothing.
import { describe, expect, it } from 'vitest'
import { pickFromPool, resolveSurfaceSets } from '../src/assets/surfacesdoc'

describe('resolveSurfaceSets', () => {
  const sets = { asphalt_aged: 'A', concrete: 'C', chipseal: 'S', grass_mown: 'M', grass_rough: 'R' }
  it('draws a class with the chosen material, and the rest as before', () => {
    const r = resolveSurfaceSets(sets, { version: 1, road: { asphalt_aged: 'chipseal' }, ground: { mown: 'grass_rough' } })
    expect(r.asphalt_aged).toBe('S')
    expect(r.concrete).toBe('C')
    expect(r.grass_mown).toBe('R')
    expect(r.grass_rough).toBe('R')
  })
  it('ignores a choice the library did not deliver', () => {
    const r = resolveSurfaceSets(sets, { version: 1, road: { asphalt_aged: 'cobbles_nobody_made' } })
    expect(r.asphalt_aged).toBe('A')
  })
  it('is the defaults for no document', () => {
    expect(resolveSurfaceSets(sets, null)).toEqual(sets)
  })
})

describe('pickFromPool', () => {
  it('is stable per key and seed, spreads over the pool, and is nothing for an empty pool', () => {
    const pool = ['a', 'b', 'c', 'd']
    expect(pickFromPool(pool, 12345, 1)).toBe(pickFromPool(pool, 12345, 1))
    const seen = new Set<string>()
    for (let k = 0; k < 200; k++) seen.add(pickFromPool(pool, k * 977, 1)!)
    expect(seen.size).toBe(4)
    expect(pickFromPool(pool, 12345, 1) === pickFromPool(pool, 12345, 2) && pickFromPool(pool, 777, 1) === pickFromPool(pool, 777, 2)).toBe(false)
    expect(pickFromPool([], 1, 1)).toBeNull()
    expect(pickFromPool(undefined, 1, 1)).toBeNull()
  })
})
