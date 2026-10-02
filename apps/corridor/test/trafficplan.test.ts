// Does a painted zone actually put cars on the road, and the right number of them?
//
// `traffic.ts` has had the Intelligent Driver Model in it since 2026-09-27 with nothing calling it,
// so the thing under test here is the half that was missing: density in, positions out. It is
// checked against a metre rule rather than by looking at a screen, because "is that about right?"
// is not a question a screenshot of forty cars can answer.
import { describe, expect, it } from 'vitest'
import { rng } from '../src/game/traffic/traffic'
import { lanesPerDirection, planTraffic, summarise, type RoadChain } from '../src/game/traffic/trafficplan'
import { vehiclesPerKm, Zones, type Zone } from '../src/game/world/zones'

/** A straight road running east from the origin, so `at(s)` is trivially checkable. */
const straight = (index: number, length: number, lanes = 2): RoadChain =>
  ({ index, length_m: length, lanes, at: (s) => ({ x: s, y: 0 }) })

const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

const zones = (...zs: Zone[]) => { const z = new Zones(); z.set(zs); return z }
const traffic = (id: string, poly: [number, number][], density: number): Zone =>
  ({ id, name: id, kind: 'traffic', polygon: poly, traffic: { density } })

describe('planning traffic', () => {
  it('puts NO cars on a world with no zones', () => {
    const plan = planTraffic([straight(0, 5000)], zones(), rng(1))
    expect(plan).toEqual([])
  })

  it('puts about the right number of cars in, at the spacing the density means', () => {
    // one kilometre of two-lane road, one lane each way, at a known density
    const density = 0.5
    const z = zones(traffic('all', box(-100, -100, 2000, 100), density))
    const plan = planTraffic([straight(0, 1000)], z, rng(3))
    const expected = (1000 / 1000) * 2 * vehiclesPerKm(density) // 2 lanes total (1 each way)
    // within 20%: the jitter and the random start offset move the count a little either way
    expect(plan.length).toBeGreaterThan(expected * 0.8)
    expect(plan.length).toBeLessThan(expected * 1.2)
  })

  it('scales with density — jammed is many times busier than clear', () => {
    const road = [straight(0, 2000)]
    const clear = planTraffic(road, zones(traffic('a', box(-100, -100, 3000, 100), 0.05)), rng(5))
    const jammed = planTraffic(road, zones(traffic('a', box(-100, -100, 3000, 100), 1)), rng(5))
    expect(jammed.length).toBeGreaterThan(clear.length * 10)
  })

  it('asks per car, not per road — a zone on half the road fills half the road', () => {
    // the zone covers x 0…1000 of a 2000 m road
    const z = zones(traffic('half', box(0, -50, 1000, 50), 0.8))
    const plan = planTraffic([straight(0, 2000)], z, rng(11))
    expect(plan.length).toBeGreaterThan(10)
    // EVERY car is in the first half. A single sample at the midpoint would not give this.
    expect(plan.every((s) => s.s <= 1010)).toBe(true)
  })

  it('uses both directions and every lane', () => {
    const z = zones(traffic('all', box(-100, -100, 3000, 100), 0.6))
    const plan = planTraffic([straight(0, 1000, 4)], z, rng(2))
    expect(new Set(plan.map((s) => s.dir))).toEqual(new Set([0, 1]))
    expect(new Set(plan.map((s) => s.lane))).toEqual(new Set([0, 1]))
    expect(lanesPerDirection(4)).toBe(2)
    expect(lanesPerDirection(1)).toBe(1) // a single-track road still has two directions
    expect(lanesPerDirection(2)).toBe(1)
  })

  it('keeps every car on the road it was planned for', () => {
    const z = zones(traffic('all', box(-100, -100, 3000, 100), 0.7))
    const plan = planTraffic([straight(0, 800), straight(1, 1200)], z, rng(4))
    for (const s of plan) {
      expect(s.s).toBeGreaterThan(0)
      expect(s.s).toBeLessThan(s.chain === 0 ? 800 : 1200)
    }
    expect(summarise(plan).perChain.get(0)).toBeGreaterThan(0)
    expect(summarise(plan).perChain.get(1)).toBeGreaterThan(0)
  })

  it('respects a budget, so a jammed city cannot exhaust the actor pool', () => {
    const z = zones(traffic('all', box(-100, -100, 100000, 100), 1))
    const plan = planTraffic([straight(0, 50000)], z, rng(6), { max: 300 })
    expect(plan.length).toBeLessThanOrEqual(300)
  })

  it('skips a chain too short to be a road', () => {
    const z = zones(traffic('all', box(-100, -100, 3000, 100), 1))
    expect(planTraffic([straight(0, 12)], z, rng(6))).toEqual([])
  })

  it('populates the same way twice for a seed, and differently for another', () => {
    const z = zones(traffic('all', box(-100, -100, 3000, 100), 0.5))
    const road = [straight(0, 1500)]
    const a = planTraffic(road, z, rng(9))
    const b = planTraffic(road, z, rng(9))
    const c = planTraffic(road, z, rng(10))
    expect(b.map((s) => s.s)).toEqual(a.map((s) => s.s))
    expect(c.map((s) => s.s)).not.toEqual(a.map((s) => s.s))
  })

  /*
   * THE FAILURE THIS EXISTS TO CATCH: a zone painted beside the road instead of on it. It plans
   * zero cars and looks exactly like a zone that is working, so the summary has to make it visible.
   */
  it('plans nothing for a zone that misses the road, which is a thing you can then report', () => {
    const z = zones(traffic('beside-it', box(0, 200, 1000, 300), 1))
    const plan = planTraffic([straight(0, 1000)], z, rng(1))
    expect(summarise(plan).total).toBe(0)
  })
})
