// What a trail is paved with, from its tags. Rich, 2026-10-06: "use trailblazed to decide
// 'paving', e.g. dirt". The rule is arithmetic on OSM's vocabulary, so it is tested here.
import { describe, expect, it } from 'vitest'
import { buildTrailsAndRail, sleeperPlacements, trailKind, trailPaving, type TrailRun } from '../src/world/trail'

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

  it('draws rail as ballast plus two steel ribbons and a sleeper bed', () => {
    const rail: TrailRun = { ...line, kind: 'rail', id: 'r9' }
    const { group, counts } = buildTrailsAndRail([rail], ground, 'site-c')
    expect(counts.rail).toBe(1)
    // ballast + steel are two different colours, so two meshes; sleepers are one InstancedMesh
    expect(group.children).toHaveLength(3)
    expect(group.getObjectByName('rail:sleepers')).toBeTruthy()
  })
})

describe('where the sleepers go', () => {
  it('places one tie per spacing along a straight run, across the track', () => {
    const ties = sleeperPlacements([{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], 1)
    expect(ties).toHaveLength(11) // 0..10 inclusive
    expect(ties[0]).toMatchObject({ x: 0, z: 0 })
    // local +Z is the track (+x here), so angle = atan2(1, 0) = pi/2
    expect(ties[1].angle).toBeCloseTo(Math.PI / 2, 6)
    expect(ties[10].x).toBeCloseTo(10, 6)
  })

  it('interpolates height and carries the bend into the tie angle', () => {
    const ties = sleeperPlacements([{ x: 0, y: 0, z: 0 }, { x: 10, y: 2, z: 0 }, { x: 10, y: 2, z: 10 }], 5)
    const last = ties[ties.length - 1]
    expect(last.x).toBeCloseTo(10, 6)
    expect(last.z).toBeCloseTo(10, 6)
    expect(last.y).toBeCloseTo(2, 6)
    // the second leg runs toward +z, so local +Z is +z: atan2(0, 1) = 0
    expect(last.angle).toBeCloseTo(0, 6)
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
