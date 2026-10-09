// The machine gun, played headlessly: the rate, the alternating muzzles, the hits, the tracers'
// lifetime; and the hardware mounted on a chassis.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GunLayer, builtinGun, builtinLauncher, builtinMissile, mountWeapons } from '../src/game/combat/weaponfx'
import * as T from '../src/tuning'

describe('GunLayer', () => {
  it('fires at GUN_RATE while held, alternating muzzles, and reports where each round lands', () => {
    const hits: { x: number; dirX: number }[] = []
    const gun = new GunLayer({
      // The left gun's rounds land on a car 30 m out. `hitTest` is now called once per short
      // segment of the ray, not once for the whole range, so the hit is the segment that REACHES
      // the car — x spans 30 — and the corpus is on the left when the muzzle was (z < 0 at the
      // crossing, which a right-muzzle shot never is because its spread cannot cross the axis).
      hitTest: (from, to) => (from.x < 30 && to.x >= 30 && from.z < 0 ? new THREE.Vector3(30, from.y, from.z) : null),
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
  /** a muzzle's point in the car's frame: through its pivot, so a turned gun fires where it points */
  const muzzleAt = (m: ReturnType<typeof mountWeapons>, i: number) => { m.root.updateMatrixWorld(true); return m.muzzles[i].pivot.localToWorld(m.muzzles[i].offset.clone()) }

  it('mounts a launcher on the roof and a gun on each bonnet corner, muzzles ahead of the guns', () => {
    const m = mountWeapons({ length: 5, width: 2, height: 1.85 }, { launcher: null, gun: null })
    expect(m.root.children.length).toBe(3) // three pivots: the launcher's and two guns'
    expect(m.turrets.map((t) => t.kind).sort()).toEqual(['gun', 'gun', 'missile'])
    expect(m.muzzles.length).toBe(2)
    const mz = [muzzleAt(m, 0), muzzleAt(m, 1)]
    for (const p of mz) { expect(p.x).toBeGreaterThan(1.5); expect(p.y).toBeGreaterThan(1) }
    expect(Math.sign(mz[0].z)).toBe(-Math.sign(mz[1].z))
    expect(m.turrets.find((t) => t.kind === 'missile')!.pivot.position.y).toBeGreaterThan(1.7)
  })

  it('turns a gun on its pivot and the muzzle goes with it', () => {
    const m = mountWeapons({ length: 5, width: 2, height: 1.85 }, { launcher: null, gun: null })
    const before = muzzleAt(m, 0)
    // yaw the gun 90° to the right (a negative three rotation about +Y turns +X toward +Z)
    m.muzzles[0].pivot.rotation.set(0, -Math.PI / 2, 0, 'YZX')
    const after = muzzleAt(m, 0)
    expect(after.z - m.muzzles[0].pivot.position.z).toBeCloseTo(0.85, 2) // the barrel now points +Z
    expect(after.x).toBeLessThan(before.x) // and no longer reaches ahead
  })

  it('uses an override model in place of a built-in when one is chosen', () => {
    const custom = new THREE.Group()
    custom.name = 'my-launcher'
    const m = mountWeapons({ length: 4.4, width: 1.9, height: 1.35 }, { launcher: custom, gun: null })
    // the model hangs under its pivot
    expect(m.root.children[0].name).toBe('turret:missile')
    expect(m.root.children[0].children[0].name).toBe('my-launcher')
    expect(m.root.children[1].children[0].name).toBe('gun')
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
