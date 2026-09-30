// The machine gun, played headlessly: the rate, the alternating muzzles, the hits, the tracers'
// lifetime; and the hardware mounted on a chassis.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GunLayer, builtinGun, builtinLauncher, builtinMissile, mountWeapons } from '../src/weaponfx'
import * as T from '../src/tuning'

describe('GunLayer', () => {
  it('fires at GUN_RATE while held, alternating muzzles, and reports where each round lands', () => {
    const hits: { x: number; dirX: number }[] = []
    const gun = new GunLayer({
      hitTest: (from, to) => (from.z < 0 ? new THREE.Vector3(from.x + 30, from.y, from.z) : null), // the left gun's rounds land on a car 30 m out
      groundAt: () => -100, // no ground within reach: the right gun's rounds land nowhere
      onHit: (h) => hits.push({ x: h.at.x, dirX: h.dir.x }),
    })
    const muzzles = [new THREE.Vector3(0, 1, -0.6), new THREE.Vector3(0, 1, 0.6)]
    const aim = new THREE.Vector3(1, 0, 0)
    for (let i = 0; i < 60; i++) gun.fire(muzzles, aim, 1 / 60)
    expect(gun.fired).toBeGreaterThanOrEqual(T.GUN_RATE - 1)
    expect(gun.fired).toBeLessThanOrEqual(T.GUN_RATE + 1)
    // half the rounds came from the left muzzle and every one of those landed on the car
    expect(hits.length).toBe(Math.floor(gun.fired / 2) + (gun.fired % 2))
    for (const h of hits) { expect(h.x).toBeCloseTo(30, 0); expect(h.dirX).toBeGreaterThan(0.99) }
    expect(gun.hits).toBe(hits.length)
    expect(gun.live).toBeGreaterThan(0)
    gun.tick(0.2)
    expect(gun.live).toBe(0)
  })

  it('does nothing without a muzzle', () => {
    const gun = new GunLayer({ hitTest: () => null, groundAt: () => null, onHit: () => {} })
    gun.fire([], new THREE.Vector3(1, 0, 0), 1)
    expect(gun.fired).toBe(0)
  })
})

describe('the hardware', () => {
  it('mounts a launcher on the roof and a gun on each bonnet corner, muzzles ahead of the guns', () => {
    const m = mountWeapons({ length: 5, width: 2, height: 1.85 }, { launcher: null, gun: null })
    expect(m.root.children.length).toBe(3)
    expect(m.muzzles.length).toBe(2)
    for (const mz of m.muzzles) { expect(mz.x).toBeGreaterThan(1.5); expect(mz.y).toBeGreaterThan(1) }
    expect(Math.sign(m.muzzles[0].z)).toBe(-Math.sign(m.muzzles[1].z))
    expect(m.root.children[0].position.y).toBeGreaterThan(1.7)
  })

  it('uses an override model in place of a built-in when one is chosen', () => {
    const custom = new THREE.Group()
    custom.name = 'my-launcher'
    const m = mountWeapons({ length: 4.4, width: 1.9, height: 1.35 }, { launcher: custom, gun: null })
    expect(m.root.children[0].name).toBe('my-launcher')
    expect(m.root.children[1].name).toBe('gun')
  })

  it('has built-ins that point +X and are sized in metres', () => {
    for (const g of [builtinLauncher(), builtinGun(), builtinMissile()]) {
      const box = new THREE.Box3().setFromObject(g)
      const size = box.getSize(new THREE.Vector3())
      expect(size.x).toBeGreaterThan(0.4)
      expect(size.x).toBeLessThan(2)
      expect(size.y).toBeLessThan(0.6)
    }
  })
})
