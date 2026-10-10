// A missile or a round under an overpass flies on under it, as a car drives on; onto the deck from
// above, or up into its underside, it hits. Rich, 2026-10-10: "if you shoot a missile under a
// bridge it blows up on invisible geometry".

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { DECK_DEPTH_M, surfaceCrossing } from '../src/game/combat/surface'
import { MissileLayer } from '../src/game/combat/missiles'
import { GunLayer } from '../src/game/combat/weaponfx'

// a road at y 0 everywhere, and a deck at y 8 over x in [40, 60]: `upper` is what you see, `lower` the road under it
const upper = (x: number) => (x >= 40 && x <= 60 ? 8 : 0)
const lower = () => 0

describe('surfaceCrossing', () => {
  it('lets a step under the deck through, and lands on the road beneath', () => {
    expect(surfaceCrossing(1.5, { x: 50, y: 1.4, z: 0 }, upper, lower)).toBeNull()
    expect(surfaceCrossing(0.3, { x: 50, y: -0.1, z: 0 }, upper, lower)).toBe(0)
  })
  it('hits the deck from above and its underside from below', () => {
    expect(surfaceCrossing(9, { x: 50, y: 7.9, z: 0 }, upper, lower, 0.2)).toBe(8.2)
    expect(surfaceCrossing(20, { x: 50, y: -3, z: 0 }, upper, lower)).toBe(8) // through it in one step
    expect(surfaceCrossing(5, { x: 50, y: 7.5, z: 0 }, upper, lower)).toBe(8 - DECK_DEPTH_M)
  })
  it('is the old test off a crossing, and without a lower ground', () => {
    expect(surfaceCrossing(1, { x: 10, y: 0.1, z: 0 }, upper, lower, 0.2)).toBe(0.2)
    expect(surfaceCrossing(1, { x: 10, y: 0.5, z: 0 }, upper, lower, 0.2)).toBeNull()
    // THE CONTROL: with no lower ground, under the deck is "below the ground" — the bug
    expect(surfaceCrossing(1.5, { x: 50, y: 1.4, z: 0 }, upper, null)).toBe(8)
  })
  it('answers null where neither knows the ground', () => {
    expect(surfaceCrossing(1, { x: 0, y: -5, z: 0 }, () => null, () => null)).toBeNull()
  })
})

describe('a missile fired along the road under an overpass', () => {
  const flyUnder = (withLower: boolean) => {
    const hits: { x: number; y: number }[] = []
    const layer = new MissileLayer({
      hitTest: () => null,
      groundAt: (x) => upper(x),
      lowerAt: withLower ? lower : undefined,
      onHit: (at) => hits.push({ x: at.x, y: at.y }),
    })
    layer.fire(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(1, 0, 0), 0)
    for (let i = 0; i < 60; i++) layer.tick(1 / 60)
    return { hits, layer }
  }
  it('flies on under the deck', () => {
    const { hits } = flyUnder(true)
    expect(hits.filter((h) => h.x >= 40 && h.x <= 60)).toEqual([])
  })
  it('went off under the deck before (the control)', () => {
    const { hits } = flyUnder(false)
    expect(hits.length).toBe(1)
    expect(hits[0].x).toBeGreaterThanOrEqual(40)
    expect(hits[0].x).toBeLessThanOrEqual(62)
  })
})

describe('a gun round fired along the road under an overpass', () => {
  const shoot = (withLower: boolean) => {
    const hits: THREE.Vector3[] = []
    const gun = new GunLayer({ hitTest: () => null, groundAt: (x) => upper(x), lowerAt: withLower ? lower : undefined, onHit: ({ at }) => hits.push(at) })
    // nearly level, a hair down: it would meet the road far beyond the bridge
    gun.fire([new THREE.Vector3(0, 1.2, 0)], new THREE.Vector3(1, -0.004, 0).normalize(), 1 / 60)
    return hits
  }
  it('passes under the deck', () => {
    const hits = shoot(true)
    expect(hits.every((h) => h.x < 40 || h.x > 60)).toBe(true)
  })
  it('stopped at the deck before (the control)', () => {
    const hits = shoot(false)
    expect(hits.length).toBe(1)
    expect(hits[0].x).toBeGreaterThanOrEqual(40)
    expect(hits[0].x).toBeLessThanOrEqual(60)
  })
})
