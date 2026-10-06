// What a trail is paved with, from its tags. Rich, 2026-10-06: "use trailblazed to decide
// 'paving', e.g. dirt". The rule is arithmetic on OSM's vocabulary, so it is tested here.
import { describe, expect, it } from 'vitest'
import { trailPaving } from '../src/world/trail'

describe('what a trail is made of', () => {
  it('defaults an untagged path to DIRT, not asphalt', () => {
    expect(trailPaving({})).toBe('dirt')
    expect(trailPaving({ highway: 'path' })).toBe('dirt')
  })

  it('reads an explicit paved surface', () => {
    expect(trailPaving({ surface: 'asphalt' })).toBe('paved')
    expect(trailPaving({ surface: 'concrete' })).toBe('paved')
  })

  it('separates gravel from dirt', () => {
    expect(trailPaving({ surface: 'compacted' })).toBe('gravel')
    expect(trailPaving({ surface: 'fine_gravel' })).toBe('gravel')
    expect(trailPaving({ surface: 'ground' })).toBe('dirt')
  })

  it('falls back to trailblazed when there is no surface', () => {
    expect(trailPaving({ trailblazed: 'paved' })).toBe('paved')
    expect(trailPaving({ trailblazed: 'yes' })).toBe('dirt')
    expect(trailPaving({ trailblazed: 'unpaved' })).toBe('dirt')
  })

  it('lets surface beat trailblazed', () => {
    expect(trailPaving({ surface: 'asphalt', trailblazed: 'unpaved' })).toBe('paved')
  })

  it('takes the first of a semicolon list', () => {
    expect(trailPaving({ surface: 'asphalt;gravel' })).toBe('paved')
  })
})
