// The world the car drives through: the ground under it, the things that break, the things that
// blow up, and the panel that dents.
//
// The terrain tests are the ones worth reading. A heightfield has two indices and getting them the
// wrong way round produces a surface that is the real one TRANSPOSED — which on a road running east
// is smooth, plausible, and at the wrong height, and which no screenshot will ever show you. So
// the layout is checked with a ramp along x and a ramp along z, separately, by casting rays at it.

import { beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Breakables, Debris, explode } from '../src/physics/destruction'
import { Deformable } from '../src/physics/deform'
import { QUERY } from '../src/physics/layers'
import { loadRapier, rapier } from '../src/physics/rapier'
import { Ragdoll } from '../src/physics/ragdoll'
import { addStatic, addTree, Terrain } from '../src/physics/terrain'
import { PhysicsWorld, type Impact } from '../src/physics/world'

beforeAll(async () => {
  await loadRapier()
})

function run(phys: PhysicsWorld, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) phys.step(1 / 60)
}

/**
 * Cast straight down from 200 m and report what height it found, or null.
 *
 * The step first is not ceremony. Rapier's spatial queries run against the broad phase, and the
 * broad phase is only brought up to date inside `world.step` — a collider created and immediately
 * ray-cast at is INVISIBLE, with no error anywhere. Every query in this file steps first for that
 * reason, and so must every caller in a game.
 */
function groundUnder(phys: PhysicsWorld, x: number, z: number): number | null {
  const R = rapier()
  phys.step(phys.dt)
  const hit = phys.world.castRay(new R.Ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 }), 400, true, undefined, QUERY.ground)
  return hit ? 200 - hit.timeOfImpact : null
}

describe('terrain', () => {
  it('builds tiles around the player and drops the ones behind', () => {
    const phys = new PhysicsWorld()
    const t = new Terrain(phys, () => 0, { tile: 64, cells: 8, radius: 100 })
    for (let i = 0; i < 40; i++) t.update(0, 0, 8)
    const near = t.stats.tiles
    expect(near).toBeGreaterThan(4)
    for (let i = 0; i < 40; i++) t.update(2000, 0, 8)
    // everything from the first position is a kilometre behind and must be gone
    expect(groundUnder(phys, 0, 0)).toBeNull()
    expect(groundUnder(phys, 2000, 0)).not.toBeNull()
    expect(t.stats.tiles).toBeLessThanOrEqual(near + 1)
    phys.free()
  })

  it('puts the ground at the height the sampler said — along X', () => {
    const phys = new PhysicsWorld()
    const t = new Terrain(phys, (x) => x * 0.1, { tile: 64, cells: 64, radius: 100 })
    for (let i = 0; i < 30; i++) t.update(0, 0, 8)
    for (const x of [-40, -10, 0, 17, 45]) {
      const y = groundUnder(phys, x, 0)
      expect(y, `x=${x}`).not.toBeNull()
      expect(y!, `x=${x}`).toBeCloseTo(x * 0.1, 1)
    }
    phys.free()
  })

  it('puts the ground at the height the sampler said — along Z (the transpose check)', () => {
    const phys = new PhysicsWorld()
    const t = new Terrain(phys, (_x, z) => z * 0.1, { tile: 64, cells: 64, radius: 100 })
    for (let i = 0; i < 30; i++) t.update(0, 0, 8)
    for (const z of [-40, -10, 0, 17, 45]) {
      const y = groundUnder(phys, 0, z)
      expect(y, `z=${z}`).not.toBeNull()
      expect(y!, `z=${z}`).toBeCloseTo(z * 0.1, 1)
    }
    phys.free()
  })

  it('refuses to build a tile that is mostly hole, and fills the few that are not', () => {
    const phys = new PhysicsWorld()
    // data only where x < 0: the tiles to the right are empty and must not become a floor at y = 0
    const t = new Terrain(phys, (x) => (x < 0 ? 5 : null), { tile: 64, cells: 16, radius: 150, minCoverage: 0.25 })
    for (let i = 0; i < 60; i++) t.update(0, 0, 8)
    expect(groundUnder(phys, -100, 0)).toBeCloseTo(5, 1)
    expect(groundUnder(phys, 100, 0)).toBeNull() // no collider, not a cliff to zero
    expect(t.stats.skipped).toBeGreaterThan(0)
    phys.free()
  })
})

describe('static things', () => {
  it('stands a tree up that a ray can find', () => {
    const phys = new PhysicsWorld()
    addTree(phys, 10, 0, 0, 0.3, 12)
    const R = rapier()
    phys.step(phys.dt)
    const hit = phys.world.castRay(new R.Ray({ x: 0, y: 3, z: 0 }, { x: 1, y: 0, z: 0 }), 50, true, undefined, QUERY.solid)
    expect(hit).not.toBeNull()
    expect(hit!.timeOfImpact).toBeCloseTo(9.7, 1) // the near face of a 0.3 m trunk at x = 10
    phys.free()
  })
})

describe('breakables', () => {
  function street() {
    const phys = new PhysicsWorld({ impactThreshold: 2000 })
    const R = rapier()
    const gb = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -1, 0))
    const gd = R.ColliderDesc.cuboid(500, 1, 500)
    phys.describe(gd, 'terrain', { events: false })
    phys.world.createCollider(gd, gb)
    return phys
  }

  it('leaves a sign standing until something hits it hard enough', () => {
    const phys = street()
    const R = rapier()
    const breaks = new Breakables(phys)
    const sign = addStatic(phys, { kind: 'box', x: 30, y: 1.5, z: 0, size: [0.08, 1.5, 0.4] })
    breaks.add(sign, { threshold: 3000, mass: 14, tag: 'stop-sign' })
    expect(breaks.standing).toBe(1)

    // a gentle nudge: a 60 kg body at 2 m/s carries 120 N·s, well under the threshold
    const slow = phys.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(20, 1.5, 0).setLinvel(2, 0, 0))
    const sd = R.ColliderDesc.cuboid(0.4, 0.4, 0.4).setMass(60)
    phys.describe(sd, 'vehicle')
    phys.world.createCollider(sd, slow)
    run(phys, 8)
    expect(breaks.standing, 'a nudge must not fell a sign').toBe(1)
    phys.world.removeRigidBody(slow)

    const seen: string[] = []
    breaks.onBreak((e) => seen.push(String(e.spec.tag)))
    const fast = phys.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 1.5, 0).setLinvel(28, 0, 0).setCcdEnabled(true))
    const fd = R.ColliderDesc.cuboid(2, 0.6, 1).setMass(1400)
    phys.describe(fd, 'vehicle')
    phys.world.createCollider(fd, fast)
    run(phys, 4)
    expect(seen).toEqual(['stop-sign'])
    expect(breaks.standing).toBe(0)
    expect(sign.parent()!.isDynamic()).toBe(true)
    // and it went somewhere: a sign that breaks and stays exactly where it was is not a break
    const p = sign.parent()!.translation()
    expect(Math.hypot(p.x - 30, p.y - 1.5, p.z)).toBeGreaterThan(0.3)
    phys.free()
  })
})

describe('explosions', () => {
  function withCars(n: number) {
    const phys = new PhysicsWorld()
    const R = rapier()
    const gb = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -1, 0))
    const gd = R.ColliderDesc.cuboid(500, 1, 500)
    phys.describe(gd, 'terrain', { events: false })
    phys.world.createCollider(gd, gb)
    const cars = []
    for (let i = 0; i < n; i++) {
      const b = phys.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(i * 6, 1, 0))
      const d = R.ColliderDesc.cuboid(2, 0.6, 1).setMass(1400)
      phys.describe(d, 'vehicle')
      phys.world.createCollider(d, b)
      cars.push(b)
    }
    run(phys, 1)
    return { phys, cars }
  }

  it('throws what is in range, harder when it is nearer, and nothing outside', () => {
    const { phys, cars } = withCars(5)
    const before = cars.map((c) => c.translation().y)
    // The blast sits ON THE GROUND, under the cars. A charge placed at y = 1 is ABOVE a settled
    // car's centre of mass and its radial direction points down, so it drives the car into the
    // road — correct physics, and a reminder that where a bomb is matters as much as how big it is.
    const moved = explode(phys, { x: 0, y: 0, z: 0, radius: 14, impulse: 12, lift: 0.5 })
    expect(moved).toBe(3) // 0, 6 and 12 m away; 18 and 24 are outside
    run(phys, 0.4)
    const rise = cars.map((c, i) => c.translation().y - before[i])
    expect(rise[0]).toBeGreaterThan(rise[1])
    expect(rise[1]).toBeGreaterThan(rise[2])
    expect(rise[0]).toBeGreaterThan(0.5) // it really left the ground
    expect(Math.abs(rise[4])).toBeLessThan(0.05) // and the one down the street did not move
    phys.free()
  })

  it('is blocked by a wall when line of sight is asked for', () => {
    const shove = (lineOfSight: boolean) => {
      const { phys, cars } = withCars(2)
      const R = rapier()
      // a wall between the blast at x = 0 and the car at x = 6
      const wb = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(3, 3, 0))
      const wd = R.ColliderDesc.cuboid(0.4, 3, 12)
      phys.describe(wd, 'structure', { events: false })
      phys.world.createCollider(wd, wb)
      phys.step(phys.dt)
      const y0 = cars[1].translation().y
      explode(phys, { x: 0, y: 0.5, z: 0, radius: 14, impulse: 12, lineOfSight })
      run(phys, 0.3)
      const d = cars[1].translation().y - y0
      phys.free()
      return d
    }
    expect(shove(false)).toBeGreaterThan(0.2) // without the check the wall is not there
    expect(shove(true)).toBeLessThan(0.05) // with it, the wall is
  })

  it('flattens the breakables in range', () => {
    const phys = new PhysicsWorld()
    const breaks = new Breakables(phys)
    for (let i = 0; i < 5; i++) {
      const c = addStatic(phys, { kind: 'box', x: i * 5, y: 1.5, z: 0, size: [0.08, 1.5, 0.4] })
      breaks.add(c, { threshold: 500, mass: 14 })
    }
    expect(breaks.standing).toBe(5)
    phys.step(phys.dt) // the broad phase has to have seen them, or the query finds nothing
    explode(phys, { x: 0, y: 1, z: 0, radius: 12, impulse: 4000, breakAt: 500 }, breaks)
    expect(breaks.standing).toBe(2) // the three within 12 m went; the two beyond did not
    phys.free()
  })
})

describe('debris', () => {
  it('keeps to its budget, oldest out', () => {
    const phys = new PhysicsWorld()
    const d = new Debris(phys, { budget: 10 })
    const retired: number[] = []
    d.onRetire((b) => retired.push(b.handle))
    const first = d.spawn({ x: 0, y: 5, z: 0 }, { x: 0.2, y: 0.2, z: 0.2 }, 5)
    for (let i = 0; i < 20; i++) d.spawn({ x: i, y: 5, z: 0 }, { x: 0.2, y: 0.2, z: 0.2 }, 5)
    expect(d.count).toBe(10)
    expect(retired[0]).toBe(first.handle) // the first one in is the first one out
    d.free()
    phys.free()
  })

  it('takes a piece back once it has been still long enough', () => {
    const phys = new PhysicsWorld({ hz: 60 })
    const R = rapier()
    const gb = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -1, 0))
    const gd = R.ColliderDesc.cuboid(50, 1, 50)
    phys.describe(gd, 'terrain', { events: false })
    phys.world.createCollider(gd, gb)
    const d = new Debris(phys, { budget: 50, lifetime: 1 })
    d.spawn({ x: 0, y: 2, z: 0 }, { x: 0.2, y: 0.2, z: 0.2 }, 5)
    run(phys, 1)
    expect(d.count).toBe(1) // still settling
    run(phys, 6)
    expect(d.count).toBe(0) // asleep for longer than its lifetime, and gone
    d.free()
    phys.free()
  })
})

describe('deformation', () => {
  function panel() {
    const geo = new THREE.BoxGeometry(4, 1, 2, 12, 6, 8)
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
  }

  function hit(impulse: number, at = { x: 2, y: 0, z: 0 }): Impact {
    return { a: null!, b: null!, x: at.x, y: at.y, z: at.z, nx: 1, ny: 0, nz: 0, impulse, peak: impulse }
  }

  it('moves the vertices near the contact and leaves the far side alone', () => {
    const mesh = panel()
    mesh.updateWorldMatrix(true, false)
    const d = new Deformable(mesh, { radius: 1, maxDent: 0.4, threshold: 100 })
    const before = Float32Array.from(mesh.geometry.getAttribute('position').array as Float32Array)
    expect(d.apply(hit(10_000))).toBe(true)
    const after = mesh.geometry.getAttribute('position').array as Float32Array
    let nearMoved = 0
    let farMoved = 0
    for (let i = 0; i < before.length; i += 3) {
      const moved = Math.hypot(after[i] - before[i], after[i + 1] - before[i + 1], after[i + 2] - before[i + 2])
      if (moved < 1e-6) continue
      if (before[i] > 1) nearMoved++
      else farMoved++
    }
    expect(nearMoved).toBeGreaterThan(0)
    expect(farMoved).toBe(0) // a hit on the nose must not dent the boot
    expect(d.damage).toBeGreaterThan(0)
  })

  it('does not clone-share a dent between two cars', () => {
    // The bug this exists for: three.js shares BufferGeometry between meshes, so denting one car
    // dents every car built from the same geometry. `Deformable` clones; this proves it.
    const geo = new THREE.BoxGeometry(4, 1, 2, 8, 4, 4)
    const a = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
    const b = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
    a.updateWorldMatrix(true, false)
    b.updateWorldMatrix(true, false)
    const da = new Deformable(a, { radius: 2, threshold: 100 })
    const db = new Deformable(b, { radius: 2, threshold: 100 })
    da.apply(hit(20_000))
    expect(da.damage).toBeGreaterThan(0)
    expect(db.damage).toBe(0)
    const pa = a.geometry.getAttribute('position').array as Float32Array
    const pb = b.geometry.getAttribute('position').array as Float32Array
    let same = true
    for (let i = 0; i < pa.length; i++) if (Math.abs(pa[i] - pb[i]) > 1e-6) same = false
    expect(same).toBe(false)
  })

  it('ignores a scrape and accumulates repeated hits up to the limit', () => {
    const mesh = panel()
    mesh.updateWorldMatrix(true, false)
    const d = new Deformable(mesh, { radius: 1.5, maxDent: 0.2, threshold: 1000, perImpulse: 1e-5 })
    expect(d.apply(hit(500))).toBe(false) // under the threshold: a kerb is not a crash
    expect(d.damage).toBe(0)
    d.apply(hit(5000))
    const one = d.damage
    d.apply(hit(5000))
    expect(d.damage).toBeGreaterThan(one) // the second hit goes deeper
    for (let i = 0; i < 50; i++) d.apply(hit(20_000))
    expect(d.damage).toBeLessThanOrEqual(1) // and it cannot fold through itself
    const pos = mesh.geometry.getAttribute('position').array as Float32Array
    let maxMove = 0
    const restX = 2
    for (let i = 0; i < pos.length; i += 3) maxMove = Math.max(maxMove, Math.abs(pos[i]) > restX ? Math.abs(pos[i]) - restX : 0)
    expect(maxMove).toBeLessThan(0.25)
  })

  it('repairs back to where it started', () => {
    const mesh = panel()
    mesh.updateWorldMatrix(true, false)
    const before = Float32Array.from(mesh.geometry.getAttribute('position').array as Float32Array)
    const d = new Deformable(mesh, { threshold: 100 })
    d.apply(hit(30_000))
    d.repair()
    const after = mesh.geometry.getAttribute('position').array as Float32Array
    for (let i = 0; i < before.length; i++) expect(after[i]).toBeCloseTo(before[i], 6)
    expect(d.damage).toBe(0)
  })
})

describe('ragdolls', () => {
  function street() {
    const phys = new PhysicsWorld({ hz: 120 })
    const R = rapier()
    const gb = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -1, 0))
    const gd = R.ColliderDesc.cuboid(200, 1, 200).setFriction(1)
    phys.describe(gd, 'terrain', { events: false })
    phys.world.createCollider(gd, gb)
    return phys
  }

  it('builds a humanoid that falls over and comes to rest in one piece', () => {
    const phys = street()
    const rd = Ragdoll.humanoid(phys, 0, 0, 0, 1.75)
    expect(rd.limbs.length).toBe(11)
    expect(rd.mass).toBeCloseTo(72, 0) // the spec's masses, which are a person's
    const head = rd.get('head')!
    expect(head.body.translation().y).toBeGreaterThan(1.4)
    run(phys, 8)
    // it fell: the head is near the ground
    expect(head.body.translation().y).toBeLessThan(0.6)
    // and it did not come apart: every limb is still near the pelvis
    const p = rd.get('pelvis')!.body.translation()
    for (const l of rd.limbs) {
      const t = l.body.translation()
      expect(Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z), `${l.name} stayed attached`).toBeLessThan(1.6)
    }
    phys.free()
  })

  it('refuses a limb whose parent has not been built', () => {
    const phys = street()
    expect(() =>
      Ragdoll.from(phys, [
        { name: 'hand', parent: 'arm', from: { x: 0, y: 1, z: 0 }, to: { x: 0, y: 0.8, z: 0 }, radius: 0.05, mass: 1 },
      ]),
    ).toThrow(/has not been built/)
    phys.free()
  })

  it('is thrown by an explosion, as one body', () => {
    const phys = street()
    const rd = Ragdoll.humanoid(phys, 4, 0, 0, 1.75)
    run(phys, 0.5)
    const before = rd.get('pelvis')!.body.translation().x
    phys.step(phys.dt)
    const moved = explode(phys, { x: 0, y: 0.4, z: 0, radius: 12, impulse: 14, lift: 0.5 })
    expect(moved).toBeGreaterThan(0)
    run(phys, 1)
    expect(rd.get('pelvis')!.body.translation().x).toBeGreaterThan(before + 1)
    phys.free()
  })
})
