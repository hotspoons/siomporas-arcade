// What a trail is paved with, from its tags. Rich, 2026-10-06: "use trailblazed to decide
// 'paving', e.g. dirt". The rule is arithmetic on OSM's vocabulary, so it is tested here.
import { describe, expect, it } from 'vitest'
import { buildTrailsAndRail, trailKind, trailPaving, type TrailRun } from '../src/world/trail'

describe('routing a bake kind to a trail or a walk', () => {
  it('sends sidewalks and crossings to the concrete sweep', () => {
    expect(trailKind('sidewalk')).toBe(false)
    expect(trailKind('crossing')).toBe(false)
  })

  it('sends paths and rails to the ribbon builder', () => {
    expect(trailKind('path')).toBe(true)
    expect(trailKind('cycleway')).toBe(true)
    expect(trailKind('rail')).toBe(true)
  })
})

describe('sweeping trails and rail into ribbons', () => {
  const ground = () => 0
  const line: TrailRun = { kind: 'path', width_m: 1.4, coords: [[0, 0, 10], [10, 0, 10], [20, 0, 10]] }

  it('draws a dirt path as one mesh and counts its metres', () => {
    const { group, counts } = buildTrailsAndRail([line], ground, 'site-a')
    expect(counts.trails).toBe(1)
    expect(counts.rail).toBe(0)
    expect(counts.metres).toBe(20)
    expect(group.children).toHaveLength(1)
  })

  it('dedupes the same baked way arriving from two tiles', () => {
    const r = { ...line, id: 'r123' }
    const { counts } = buildTrailsAndRail([r, r], ground, 'site-b')
    expect(counts.trails).toBe(1)
  })

  it('draws rail as ballast plus two steel ribbons', () => {
    const rail: TrailRun = { ...line, kind: 'rail', id: 'r9' }
    const { group, counts } = buildTrailsAndRail([rail], ground, 'site-c')
    expect(counts.rail).toBe(1)
    // ballast + steel are two different colours, so two meshes
    expect(group.children).toHaveLength(2)
  })
})

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
