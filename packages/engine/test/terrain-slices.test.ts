// Sampling a physics tile in slices (terrain.ts `sliceMs`): the rows of a tile ahead are sampled
// across several updates and the collider lands when the last row is in; the tile under the wheels
// is never deferred; no ground point is ever sampled twice.
import { beforeAll, describe, expect, it } from 'vitest'
import { QUERY } from '../src/physics/layers'
import { loadRapier, rapier } from '../src/physics/rapier'
import { Terrain } from '../src/physics/terrain'
import { PhysicsWorld } from '../src/physics/world'

beforeAll(async () => {
  await loadRapier()
})

function groundUnder(phys: PhysicsWorld, x: number, z: number): number | null {
  const R = rapier()
  phys.step(phys.dt)
  const hit = phys.world.castRay(new R.Ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 }), 400, true, undefined, QUERY.ground)
  return hit ? 200 - hit.timeOfImpact : null
}

/** a sampler that costs something: a spin per call, so a slice can actually run out */
function slowSampler(calls: { n: number }, perCallMs = 0.02) {
  return (x: number) => {
    calls.n++
    const until = performance.now() + perCallMs
    while (performance.now() < until) { /* spin */ }
    return x * 0.01
  }
}

describe('terrain tiles sampled in slices', () => {
  it('builds the tile under the wheels at once and the ones ahead over several updates', () => {
    const phys = new PhysicsWorld()
    const calls = { n: 0 }
    const t = new Terrain(phys, slowSampler(calls), { tile: 64, cells: 16, radius: 150, sliceMs: 0.5 })
    t.update(32, 32, 8)
    // the eye's own tile and its neighbours are whole after one call; the ring is not
    expect(t.stats.tiles).toBeGreaterThanOrEqual(1)
    expect(groundUnder(phys, 32, 32)).toBeCloseTo(0.32, 1)
    const after1 = t.stats.tiles
    const want = 0
    // keep updating until the tile count has been still for fifty calls: the ring is complete
    let updates = 1
    let still = 0
    let last = after1
    while (updates < 2000 && still < 50) {
      t.update(32, 32, 8)
      updates++
      if (t.stats.tiles === last) still++
      else { still = 0; last = t.stats.tiles }
    }
    expect(t.stats.tiles).toBeGreaterThan(after1) // the slices finished tiles the first call left
    expect(updates).toBeGreaterThan(2) // and it took more than one slice to do it
    // a far tile exists now and reads the same ground as the whole-built one would
    expect(groundUnder(phys, 32 + 128, 32)).toBeCloseTo(1.6, 1)
    // every sample of every built tile was taken once — no row was re-sampled across slices — plus
    // the stale check, which reads up to 25 points under the eye on every update
    const n = 17 * 17
    expect(calls.n).toBeLessThanOrEqual(t.stats.tiles * n + want + updates * 25)
    expect(calls.n).toBeGreaterThanOrEqual(t.stats.tiles * n)
  })

  it('drops a half-sampled tile that leaves the ring instead of finishing it', () => {
    const phys = new PhysicsWorld()
    const calls = { n: 0 }
    const t = new Terrain(phys, slowSampler(calls, 0.05), { tile: 64, cells: 16, radius: 100, sliceMs: 0.2 })
    t.update(0, 0, 8)
    t.update(0, 0, 8) // a tile ahead is now part-sampled
    const before = calls.n
    // the eye jumps far away: the partial is for a tile nobody wants any more
    for (let i = 0; i < 40; i++) t.update(5000, 5000, 8)
    expect(calls.n).toBeGreaterThan(before)
    for (const key of [...(t as unknown as { tiles: Map<string, unknown> }).tiles.keys()]) {
      const [i, j] = key.split(',').map(Number)
      expect(Math.hypot(i * 64 - 5000, j * 64 - 5000)).toBeLessThan(400)
    }
  })

  it('with no slice, a tile is sampled whole on the call that asks for it', () => {
    const phys = new PhysicsWorld()
    const calls = { n: 0 }
    const t = new Terrain(phys, slowSampler(calls, 0), { tile: 64, cells: 8, radius: 100 })
    t.update(0, 0, 1)
    expect(t.stats.built).toBe(1)
    expect(calls.n).toBe(81)
  })
})
