// Does a drawn bounds actually decide how busy the road is, and does the swing swing?
//
// The whole point of `zones.ts` is that traffic becomes something a LEVEL places rather than a
// global, so the assertions worth making are: a point inside a zone gets that zone's answer, a
// point outside gets nothing at all, a small zone inside a big one wins, and the same seed gives
// the same rush hour twice.
import { describe, expect, it } from 'vitest'
import { ActorWorld } from '../src/actorworld'
import { rng } from '../src/traffic'
import { spawnZones, stateOf, TrafficArea, trigger, zoneSystem } from '../src/zones-ecs'
import {
  carsFor, describeTraffic, FREE_FLOW_PER_KM, JAM_PER_KM, levelOf, rollDensity, TRAFFIC_LEVELS,
  trafficColour, validateZones, vehiclesPerKm, Zones, type Zone,
} from '../src/zones'

const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

const zone = (id: string, poly: [number, number][], traffic: Zone['traffic']): Zone =>
  ({ id, name: id, kind: 'traffic', polygon: poly, traffic })

describe('a zone is a bounds with traffic on it', () => {
  it('answers inside and says nothing outside', () => {
    const z = new Zones()
    z.set([zone('town', box(0, 0, 100, 100), { density: 0.8 })])
    expect(z.densityAt(50, 50)).toBeCloseTo(0.8, 6)
    // OUTSIDE IS ZERO, not a default sprinkle: a level that places no traffic gets no traffic
    expect(z.densityAt(150, 50)).toBe(0)
    expect(new Zones().densityAt(0, 0)).toBe(0)
  })

  it('lets a small zone inside a big one be the exception', () => {
    const z = new Zones()
    z.set([
      zone('city', box(0, 0, 1000, 1000), { density: 0.7 }),
      zone('the-bypass', box(400, 400, 500, 500), { density: 0.1 }),
    ])
    expect(z.densityAt(10, 10)).toBeCloseTo(0.7, 6)
    expect(z.densityAt(450, 450)).toBeCloseTo(0.1, 6)
  })

  it('carries the driver population, and falls back to most-people-obey', () => {
    const z = new Zones()
    z.set([zone('lawless', box(0, 0, 10, 10), { density: 0.5, obeyRate: 0.6, speedFactor: 1.2 })])
    expect(z.driversAt(5, 5)).toEqual({ obeyRate: 0.6, speedFactor: 1.2 })
    expect(z.driversAt(50, 50)).toEqual({ obeyRate: 0.97, speedFactor: 1 })
  })

  it('ignores a polygon that is not one', () => {
    const z = new Zones()
    z.set([zone('bad', [[0, 0], [1, 1]] as [number, number][], { density: 1 })])
    expect(z.count).toBe(0)
  })
})

describe('the swing', () => {
  it('is fixed with no maximum and rolls between the two with one', () => {
    expect(rollDensity({ density: 0.9 }, () => 0.5)).toBeCloseTo(0.9, 6)
    expect(rollDensity({ density: 0.2, densityMax: 0.8 }, () => 0)).toBeCloseTo(0.2, 6)
    expect(rollDensity({ density: 0.2, densityMax: 0.8 }, () => 1)).toBeCloseTo(0.8, 6)
    expect(rollDensity({ density: 0.2, densityMax: 0.8 }, () => 0.5)).toBeCloseTo(0.5, 6)
    // a maximum below the floor is not a swing, it is a typo, and the floor wins
    expect(rollDensity({ density: 0.6, densityMax: 0.3 }, () => 1)).toBeCloseTo(0.6, 6)
  })

  it('rolls ONCE per load, so the road does not change while you drive through it', () => {
    const z = new Zones()
    const zs = [zone('rush', box(0, 0, 100, 100), { density: 0, densityMax: 1 })]
    z.set(zs, rng(7))
    const first = z.densityAt(50, 50)
    expect(z.densityAt(50, 50)).toBe(first)
    expect(z.densityAt(51, 51)).toBe(first)
  })

  it('gives the same rush hour for the same seed and a different one otherwise', () => {
    const zs = [zone('rush', box(0, 0, 100, 100), { density: 0, densityMax: 1 })]
    const a = new Zones(); a.set(zs, rng(7))
    const b = new Zones(); b.set(zs, rng(7))
    const c = new Zones(); c.set(zs, rng(8))
    expect(b.densityAt(50, 50)).toBe(a.densityAt(50, 50))
    expect(c.densityAt(50, 50)).not.toBe(a.densityAt(50, 50))
  })

  it('uses the floor when nobody passes a generator — an editor must not reroll on every save', () => {
    const z = new Zones()
    z.set([zone('rush', box(0, 0, 100, 100), { density: 0.25, densityMax: 0.95 })])
    expect(z.densityAt(50, 50)).toBeCloseTo(0.25, 6)
  })
})

describe('a density is a number of cars, not a probability', () => {
  it('runs from an empty road to bumper to bumper', () => {
    expect(vehiclesPerKm(0)).toBeCloseTo(FREE_FLOW_PER_KM, 6)
    expect(vehiclesPerKm(1)).toBeCloseTo(JAM_PER_KM, 6)
    // and it is not linear: the resolution is in the bottom half, where it is felt
    expect(vehiclesPerKm(0.5)).toBeLessThan((FREE_FLOW_PER_KM + JAM_PER_KM) / 2)
  })

  it('turns a stretch of road into a car count', () => {
    // two kilometres of two-lane road, jammed: four lane-kilometres at 140
    expect(carsFor(2000, 2, 1)).toBe(560)
    expect(carsFor(2000, 2, 0)).toBe(24)
    expect(carsFor(0, 2, 1)).toBe(0)
    expect(carsFor(2000, 0, 1)).toBe(0)
  })
})

describe('the colour scale is the interface', () => {
  it('reads a density back as a level, green through maroon', () => {
    expect(levelOf(0).id).toBe('clear')
    expect(levelOf(1).id).toBe('jammed')
    expect(levelOf(0.55).id).toBe('heavy')
    expect(TRAFFIC_LEVELS.map((l) => l.density)).toEqual([...TRAFFIC_LEVELS.map((l) => l.density)].sort((a, b) => a - b))
  })

  it('interpolates between the bands, so a gradient does not look like five zones', () => {
    expect(trafficColour(0.05)).toBe(TRAFFIC_LEVELS[0].colour)
    expect(trafficColour(1)).toBe(TRAFFIC_LEVELS[4].colour)
    const mid = trafficColour(0.175) // halfway between clear and light
    expect(mid).not.toBe(TRAFFIC_LEVELS[0].colour)
    expect(mid).not.toBe(TRAFFIC_LEVELS[1].colour)
    expect(mid).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('says in a sentence what a zone will do', () => {
    expect(describeTraffic({ density: 1 })).toMatch(/Jammed, always/)
    expect(describeTraffic({ density: 0.2, densityMax: 0.9 })).toMatch(/rolled when the level loads/)
    expect(describeTraffic({ density: 0.5, obeyRate: 0.6 })).toMatch(/60% stop for a red/)
    expect(describeTraffic(undefined)).toMatch(/no traffic/)
  })
})

describe('validation catches the documents that would do nothing', () => {
  it('names every problem rather than the first', () => {
    const r = validateZones({
      version: 1,
      zones: [
        { id: '', name: 'x', kind: 'traffic', polygon: box(0, 0, 1, 1), traffic: { density: 2 } },
        { id: 'dup', name: 'a', kind: 'traffic', polygon: box(0, 0, 1, 1), traffic: { density: 0.5, densityMax: 0.2 } },
        { id: 'dup', name: 'b', kind: 'weather' as 'traffic', polygon: box(0, 0, 1, 1), traffic: { density: 0.5 } },
      ],
    })
    expect(r.ok).toBe(false)
    expect(r.errors.length).toBeGreaterThanOrEqual(4)
    expect(r.errors.join(' ')).toMatch(/has no id/)
    expect(r.errors.join(' ')).toMatch(/density must be between/)
    expect(r.errors.join(' ')).toMatch(/swing has no room/)
    expect(r.errors.join(' ')).toMatch(/used twice/)
  })

  it('passes a document that is fine, and warns about a zone nothing can be inside', () => {
    const good = validateZones({ version: 1, zones: [zone('ok', box(0, 0, 100, 100), { density: 0.4 })] })
    expect(good.errors).toEqual([])
    const tiny = validateZones({ version: 1, zones: [zone('tiny', box(0, 0, 0.5, 0.5), { density: 0.4 })] })
    expect(tiny.errors).toEqual([])
    expect(tiny.warnings.join(' ')).toMatch(/square metre/)
  })
})

/*
 * THE ECS HALF. Rich: "hook it to the ECS system so we can define things from code as well and
 * trigger a traffic area". The thing to prove is that a trigger actually reaches the lookup that
 * spawning asks — a component somebody can write and nothing reads is the failure this file exists
 * to avoid.
 */
describe('a zone is an entity you can trigger', () => {
  const build = () => {
    const aw = new ActorWorld()
    const z = new Zones()
    z.set([
      zone('bridge', box(0, 0, 100, 100), { density: 0.1 }),
      zone('downtown', box(200, 0, 300, 100), { density: 0.6, obeyRate: 0.8 }),
    ])
    return { aw, z, ents: spawnZones(aw.world, z) }
  }

  it('starts every entity at what the document rolled', () => {
    const { z, ents } = build()
    expect(ents.all).toHaveLength(2)
    expect(stateOf(ents, 'bridge')!.density).toBeCloseTo(0.1, 6)
    expect(TrafficArea.obeyRate[ents.byId.get('downtown')!]).toBeCloseTo(0.8, 6)
    expect(z.densityAt(50, 50)).toBeCloseTo(0.1, 6)
  })

  it('closes a road when something tells it to, and the LOOKUP changes — not just the component', () => {
    const { aw, z, ents } = build()
    expect(trigger(ents, 'bridge', 1)).toBe(true)
    // nothing has changed until a tick runs: the system is what joins the two halves
    expect(z.densityAt(50, 50)).toBeCloseTo(0.1, 6)
    zoneSystem(aw.world, z, 1 / 60)
    expect(z.densityAt(50, 50)).toBeCloseTo(1, 6)
    // and the other zone is untouched
    expect(z.densityAt(250, 50)).toBeCloseTo(0.6, 6)
  })

  it('fills up over time when asked to, because a jam that appears in one frame looks like a bug', () => {
    const { aw, z, ents } = build()
    trigger(ents, 'bridge', 1, 10) // ten seconds from 0.1 to 1
    zoneSystem(aw.world, z, 1)
    const after1s = z.densityAt(50, 50)
    expect(after1s).toBeGreaterThan(0.1)
    expect(after1s).toBeLessThan(0.3)
    for (let i = 0; i < 20; i++) zoneSystem(aw.world, z, 1)
    expect(z.densityAt(50, 50)).toBeCloseTo(1, 6) // and it stops at the target, it does not overshoot
  })

  it('says so when a script names a zone that is not there', () => {
    const { ents } = build()
    expect(trigger(ents, 'nowhere', 1)).toBe(false)
    expect(stateOf(ents, 'nowhere')).toBeNull()
  })

  it('turns a density into a number of cars for a real stretch of road', () => {
    const { aw, z, ents } = build()
    trigger(ents, 'downtown', 1)
    zoneSystem(aw.world, z, 1 / 60)
    // 800 m of two-lane road through downtown, jammed
    expect(carsFor(800, 2, z.densityAt(250, 50))).toBe(224)
  })
})
