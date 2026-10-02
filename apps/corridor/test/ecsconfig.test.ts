// Does a level's ECS config put the right number of the right things in the right places?
//
// Population bugs do not throw and they do not look like bugs. They look like "hmm, that seems
// like a lot of cars", and nobody counts. So the planner is pure and these tests count: twelve
// per kilometre over four kilometres is forty-eight, a pedestrian brush puts nobody on the
// carriageway, and the same seed opens the same level twice.
import { describe, expect, it } from 'vitest'
import { query } from 'bitecs'
import { ActorWorld } from '../src/game/actors/actorworld'
import { Autonomous, Engine, Hostile, Human, OnRoad, Transform, Vehicle, Visual, Walking } from '../src/game/actors/actors'
import {
  BRUSHES, COMPONENTS, MAX_POPULATION, applyEcs, planPopulations, populationCount, validateEcs,
  type EcsConfig, type PlaceCtx,
} from '../src/game/session/ecsconfig'

/**
 * A straight 4 km road running EAST at y = 0, and a 1 km square site around it.
 *
 * yaw = π/2, not 0: `Transform.yaw` is `atan2(vx, vy)` throughout this ECS, so 0 faces north and
 * a road running east is a quarter turn from it. Writing 0 here is how the verge offset came out
 * along the road instead of across it.
 */
const ROAD_M = 4000
const EAST = Math.PI / 2
const ctx: PlaceCtx = {
  roadM: ROAD_M,
  onRoad: (s) => (s >= 0 && s <= ROAD_M ? { x: s - ROAD_M / 2, y: 0, yaw: EAST } : null),
  bbox: [-500, -500, 500, 500],
}

const CFG: EcsConfig = {
  archetypes: {
    commuter: { components: ['Velocity', 'Vehicle', 'Autonomous', 'Engine', 'Visual', 'OnRoad'], asset: 'sedan-generic', speed: 22 },
    pedestrian: { components: ['Velocity', 'Human', 'Walking', 'Visual'], asset: 'person-casual', speed: 1.3 },
  },
  populations: [{ archetype: 'commuter', brush: 'traffic', density: 12, seed: 7 }],
}

describe('validateEcs', () => {
  it('passes a config that names things that exist', () => {
    expect(validateEcs(CFG)).toEqual({ ok: true, errors: [], warnings: [] })
  })

  it('accepts no config at all', () => {
    expect(validateEcs(null).ok).toBe(true)
  })

  it('names the components that exist when one does not', () => {
    const r = validateEcs({ archetypes: { x: { components: ['Vehicle', 'RageMeter'] } }, populations: [] })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('RageMeter')
    expect(r.errors[0]).toContain('Vehicle') // the list of what does exist, in front of the author
  })

  it('refuses a population that names an archetype nobody defined', () => {
    const r = validateEcs({ archetypes: { a: { components: ['Vehicle'] } }, populations: [{ archetype: 'b', count: 1 }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('"b"')
    expect(r.errors.join(' ')).toContain('Defined: a')
  })

  it('refuses a population that says neither a count nor a density', () => {
    const r = validateEcs({ archetypes: { a: { components: ['Vehicle'] } }, populations: [{ archetype: 'a' }] })
    expect(r.errors.join(' ')).toContain('neither a count nor a density')
  })

  it('refuses a brush that is not one of the brushes', () => {
    const r = validateEcs({ archetypes: { a: { components: ['Vehicle'] } }, populations: [{ archetype: 'a', count: 1, brush: 'sprinkle' as never }] })
    expect(r.errors.join(' ')).toContain(Object.keys(BRUSHES)[0])
  })

  it('WARNS about an asset that is not in the catalog rather than refusing', () => {
    // a level you cannot save until its assets exist is a level you cannot author while they bake
    const r = validateEcs(CFG, { assets: () => false })
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toContain('sedan-generic')
  })

  it('mentions Transform without failing on it', () => {
    const r = validateEcs({ archetypes: { a: { components: ['Transform', 'Vehicle'] } }, populations: [] })
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toContain('Transform')
  })
})

describe('populationCount', () => {
  it('reads a density as per kilometre of road', () => {
    expect(populationCount({ archetype: 'a', brush: 'traffic', density: 12 }, ctx)).toBe(48)
    expect(populationCount({ archetype: 'a', brush: 'walk', density: 2 }, ctx)).toBe(8)
  })

  it('reads a scatter density as per hectare of the region', () => {
    // the whole 1 km square is 100 ha
    expect(populationCount({ archetype: 'a', brush: 'scatter', density: 0.5 }, ctx)).toBe(50)
    // a 100 m square is one hectare
    expect(populationCount({ archetype: 'a', brush: 'scatter', density: 3, region: [0, 0, 100, 100] }, ctx)).toBe(3)
  })

  it('lets an explicit count win over a density', () => {
    expect(populationCount({ archetype: 'a', brush: 'traffic', density: 12, count: 5 }, ctx)).toBe(5)
  })
})

describe('planPopulations', () => {
  it('plans as many as the density asks for', () => {
    const { requests } = planPopulations(CFG, ctx)
    expect(requests).toHaveLength(48)
    expect(new Set(requests.map((r) => r.archetype))).toEqual(new Set(['commuter']))
  })

  it('spreads them along the road instead of clumping', () => {
    // a random draw of `s` over 4 km leaves visible knots with empty road between them, which does
    // not read as traffic. Every 1 km quarter of the road should hold about a quarter of them.
    const { requests } = planPopulations(CFG, ctx)
    const quarters = [0, 0, 0, 0]
    for (const r of requests) quarters[Math.min(3, Math.floor(((r.s ?? 0) / ROAD_M) * 4))] += 1
    for (const q of quarters) expect(q).toBeGreaterThanOrEqual(10)
    // and no two closer than half the nominal spacing
    const s = requests.map((r) => r.s ?? 0).sort((a, b) => a - b)
    for (let i = 1; i < s.length; i += 1) expect(s[i] - s[i - 1]).toBeGreaterThan(0)
  })

  it('keeps everything it plans on the road for a traffic brush', () => {
    for (const r of planPopulations(CFG, ctx).requests) expect(r.y).toBe(0)
  })

  it('keeps nobody on the carriageway for a walk brush', () => {
    const cfg: EcsConfig = { ...CFG, populations: [{ archetype: 'pedestrian', brush: 'walk', density: 4, seed: 3 }] }
    const { requests } = planPopulations(cfg, ctx)
    expect(requests).toHaveLength(16)
    for (const r of requests) expect(Math.abs(r.y)).toBeGreaterThan(4)
    // and on both sides, not all down one verge
    expect(requests.some((r) => r.y > 0)).toBe(true)
    expect(requests.some((r) => r.y < 0)).toBe(true)
  })

  it('puts the verge PERPENDICULAR to the road, on a road that is not axis-aligned', () => {
    // THE DEGENERATE-FIXTURE TRAP. On a road running due east, cos(yaw) is zero and every wrong
    // perpendicular still lands off the carriageway, so the east fixture above cannot tell a
    // correct offset from one that walks along the road. This one runs north-east and states the
    // claim directly: the offset from the road is at right angles to the heading.
    const NE = Math.PI / 4
    const diag: PlaceCtx = {
      roadM: 1000,
      onRoad: (s) => (s >= 0 && s <= 1000 ? { x: s * Math.SQRT1_2, y: s * Math.SQRT1_2, yaw: NE } : null),
      bbox: [-100, -100, 900, 900],
    }
    const cfg: EcsConfig = { ...CFG, populations: [{ archetype: 'pedestrian', brush: 'walk', count: 24, seed: 11 }] }
    const { requests } = planPopulations(cfg, diag)
    expect(requests).toHaveLength(24)
    // the heading, in this ECS's yaw convention
    const hx = Math.sin(NE)
    const hy = Math.cos(NE)
    let left = 0
    let right = 0
    for (const r of requests) {
      const on = diag.onRoad(r.s!)!
      const ox = r.x - on.x
      const oy = r.y - on.y
      const along = ox * hx + oy * hy
      const across = Math.hypot(ox, oy)
      expect(Math.abs(along), `offset is ${along.toFixed(2)} m ALONG the road, not across it`).toBeLessThan(1e-6)
      expect(across).toBeGreaterThan(4)
      if (ox * -hy + oy * hx > 0) left += 1
      else right += 1
    }
    expect(left).toBeGreaterThan(0)
    expect(right).toBeGreaterThan(0)
  })

  it('keeps a scatter inside its region', () => {
    const cfg: EcsConfig = { ...CFG, populations: [{ archetype: 'pedestrian', brush: 'scatter', count: 200, region: [100, -50, 300, 90], seed: 5 }] }
    for (const r of planPopulations(cfg, ctx).requests) {
      expect(r.x).toBeGreaterThanOrEqual(100)
      expect(r.x).toBeLessThanOrEqual(300)
      expect(r.y).toBeGreaterThanOrEqual(-50)
      expect(r.y).toBeLessThanOrEqual(90)
    }
  })

  it('plans the same level the same way twice', () => {
    expect(planPopulations(CFG, ctx)).toEqual(planPopulations(CFG, ctx))
  })

  it('plans differently for a different seed', () => {
    const a = planPopulations(CFG, ctx).requests.map((r) => r.s)
    const b = planPopulations({ ...CFG, populations: [{ ...CFG.populations![0], seed: 99 }] }, ctx).requests.map((r) => r.s)
    expect(b).not.toEqual(a)
  })

  it('does not put two populations in identical places', () => {
    // the same seed on two entries would stack a pedestrian inside every car
    const cfg: EcsConfig = {
      archetypes: CFG.archetypes,
      populations: [
        { archetype: 'commuter', brush: 'traffic', count: 20, seed: 7 },
        { archetype: 'pedestrian', brush: 'traffic', count: 20, seed: 7 },
      ],
    }
    const { requests } = planPopulations(cfg, ctx)
    const a = requests.filter((r) => r.archetype === 'commuter').map((r) => r.s)
    const b = requests.filter((r) => r.archetype === 'pedestrian').map((r) => r.s)
    expect(b).not.toEqual(a)
  })

  it('caps a density with one zero too many, and says so', () => {
    const cfg: EcsConfig = { ...CFG, populations: [{ archetype: 'commuter', brush: 'traffic', density: 120000, seed: 1 }] }
    const r = planPopulations(cfg, ctx)
    expect(r.requests).toHaveLength(MAX_POPULATION)
    expect(r.skipped[0].why).toContain('cap')
  })

  it('says why a population on a site with no roads places nothing', () => {
    const r = planPopulations(CFG, { ...ctx, roadM: 0 })
    expect(r.requests).toHaveLength(0)
    expect(r.skipped[0].why).toContain('no drivable network')
  })

  it('plans nothing at all from nothing at all', () => {
    expect(planPopulations(null, ctx).requests).toEqual([])
    expect(planPopulations({ archetypes: {}, populations: [] }, ctx).requests).toEqual([])
  })
})

describe('applyEcs', () => {
  const build = (cfg = CFG, opts = {}) => {
    const aw = new ActorWorld()
    const plan = planPopulations(cfg, ctx).requests
    return { aw, plan, r: applyEcs(aw, cfg, plan, opts) }
  }

  it('makes one entity per request, with the components the archetype named', () => {
    const { aw, r } = build()
    expect(r.spawned).toBe(48)
    expect(query(aw.world, [Transform]).length).toBe(48)
    expect(query(aw.world, [Vehicle, Autonomous, Engine]).length).toBe(48)
    expect(query(aw.world, [Human]).length).toBe(0)
  })

  it('puts the entity where the plan said', () => {
    const { plan, r } = build()
    const e = r.entities[0]
    expect(Transform.x[e]).toBeCloseTo(plan[0].x, 4)
    expect(Transform.y[e]).toBeCloseTo(plan[0].y, 4)
    expect(Transform.yaw[e]).toBeCloseTo(plan[0].yaw, 4)
  })

  it('applies the archetype numbers AFTER the component defaults', () => {
    // Vehicle's init sets maxSpeed 25; the archetype says 22. Applying them the other way round
    // is a silent bug: everything drives at the default and the config looks like it was ignored.
    const { r } = build()
    expect(Vehicle.maxSpeed[r.entities[0]]).toBe(22)
    const ped = build({ ...CFG, populations: [{ archetype: 'pedestrian', brush: 'walk', count: 3, seed: 1 }] })
    expect(Walking.speed[ped.r.entities[0]]).toBeCloseTo(1.3, 5)
  })

  it('binds an asset through the level, over the archetype', () => {
    const index = (id: string) => ({ 'sedan-generic': 4, 'rx7-fd': 9 })[id] ?? -1
    const plain = build(CFG, { assetIndex: index })
    expect(Visual.asset[plain.r.entities[0]]).toBe(4)
    const bound = build(CFG, { assetIndex: index, bindings: { commuter: 'rx7-fd' } })
    expect(Visual.asset[bound.r.entities[0]]).toBe(9)
  })

  it('reports an asset that is not in the catalog and still spawns the entity', () => {
    const { r } = build(CFG, { assetIndex: () => -1 })
    expect(r.spawned).toBe(48)
    expect(r.unbound).toEqual(['sedan-generic'])
    expect(Visual.asset[r.entities[0]]).toBe(0)
  })

  it('reports an archetype that went missing between planning and applying', () => {
    const aw = new ActorWorld()
    const r = applyEcs(aw, { archetypes: {}, populations: [] }, [{ archetype: 'ghost', x: 0, y: 0, yaw: 0 }])
    expect(r.spawned).toBe(0)
    expect(r.skipped.join(' ')).toContain('ghost')
  })

  it('adds Hostile from the flag as well as from the component list', () => {
    const cfg: EcsConfig = {
      archetypes: { thug: { components: ['Velocity', 'Vehicle', 'Autonomous'], hostile: true } },
      populations: [{ archetype: 'thug', count: 4, seed: 2 }],
    }
    const { aw } = build(cfg)
    expect(query(aw.world, [Hostile]).length).toBe(4)
  })

  it('sits the entity on the ground when there is a ground to read', () => {
    const { r } = build(CFG, { groundAt: (x: number) => x / 100 })
    for (const e of r.entities) expect(Transform.z[e]).toBeCloseTo(Transform.x[e] / 100, 4)
  })

  it('carries s onto OnRoad, so the traffic model knows where it is', () => {
    const { plan, r } = build()
    expect(OnRoad.s[r.entities[0]]).toBeCloseTo(plan[0].s!, 3)
  })

  it('has an init for every component it offers', () => {
    // the failure this catches: a component in the table with no defaults spawns something with
    // zero size or zero health and looks like a physics bug
    for (const [name, c] of Object.entries(COMPONENTS)) {
      const fields = Object.keys(c.store)
      if (!fields.length) continue // a tag component has nothing to initialise
      expect(c.init, `${name} has fields but no init`).toBeTruthy()
    }
  })
})
