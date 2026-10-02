// Stage 4 and 5 of the game pipeline: what is IN the world, and what it looks like.
//
// docs/corridor/PLAN-GAME-PIPELINE.md, from Rich's own description of the loop: "apply an ECS
// config, bind assets to entities". The ECS itself has been real since the traffic work — bitECS,
// components, systems, the fixed step. What was missing is the layer that says which entities a
// LEVEL wants, how many, and where; today a level can write `simulations: [{kind, seed}]` and
// nothing reads more than the kind.
//
//   {
//     "ecs": {
//       "archetypes": {
//         "commuter":   { "components": ["Vehicle", "Autonomous", "Engine"], "asset": "sedan-generic" },
//         "pedestrian": { "components": ["Human", "Walking"],                "asset": "person-casual" }
//       },
//       "populations": [
//         { "archetype": "commuter", "brush": "traffic", "density": 12, "seed": 7 }
//       ]
//     },
//     "bindings": { "commuter": "rx7-fd" }
//   }
//
// TWO HALVES, DELIBERATELY SEPARATE.
//
// `planPopulations` is PURE: a config, a seed and a description of where the roads are, in, a list
// of spawn requests out. No bitECS, no THREE, no catalog. That is what makes "twelve commuters per
// kilometre" a thing a test can check rather than a thing you count on screen — and population
// bugs are exactly the kind that look like "hmm, seems like a lot of cars".
//
// `applyEcs` is the impure half and it does one thing: turn requests into entities. Everything it
// could get wrong (a component that does not exist, an asset that is not in the catalog, an
// archetype nothing names) it REPORTS rather than throws, for the same reason `applyLevel` does:
// a level whose traffic spawns and whose pedestrians reference a missing asset is an ordinary
// state, and the editor should say both things.
//
// BINDING BELONGS TO THE LEVEL, not to the world. The same street is a commute in one game and a
// car chase in another, so `bindings` sits beside `ecs` in the level document and overrides the
// archetype's own `asset`.
import { addComponent, addEntity } from 'bitecs'
import {
  Animal, Autonomous, Engine, Health, Hostile, Human, OnRoad, Player, Transform, Vehicle, Velocity,
  Visual, Walking,
} from '../actors/actors'
import type { ActorWorld } from '../actors/actorworld'
import { rng } from '../traffic/traffic'

/* ---- the vocabulary ---------------------------------------------------------------------- */

/**
 * The components an archetype may name, and what each one is initialised to.
 *
 * A TABLE, not a switch, so the list an archetype is validated against and the list that is
 * actually applied cannot drift apart — the failure that produces is an archetype that saves
 * cleanly and spawns something with no velocity.
 *
 * `Transform` is not in here: everything has one, and it is added unconditionally.
 */
export const COMPONENTS: Record<string, { store: Record<string, unknown>; init?: (e: number) => void }> = {
  Velocity: { store: Velocity, init: (e) => { Velocity.x[e] = 0; Velocity.y[e] = 0; Velocity.z[e] = 0 } },
  Vehicle: {
    store: Vehicle,
    init: (e) => { Vehicle.lengthM[e] = 4.4; Vehicle.widthM[e] = 1.8; Vehicle.speed[e] = 0; Vehicle.maxSpeed[e] = 25 },
  },
  Human: { store: Human, init: (e) => { Human.kind[e] = 0 } },
  Animal: { store: Animal, init: (e) => { Animal.species[e] = 0 } },
  Visual: { store: Visual, init: (e) => { Visual.asset[e] = 0; Visual.scale[e] = 1 } },
  Engine: { store: Engine, init: (e) => { Engine.rpm[e] = 0; Engine.pedal[e] = 0; Engine.gear[e] = 1; Engine.voice[e] = 0 } },
  Autonomous: { store: Autonomous },
  OnRoad: { store: OnRoad, init: (e) => { OnRoad.chain[e] = 0; OnRoad.s[e] = 0; OnRoad.lane[e] = 0; OnRoad.dir[e] = 1 } },
  Walking: { store: Walking, init: (e) => { Walking.speed[e] = 1.4 } },
  Hostile: { store: Hostile, init: (e) => { Hostile.faction[e] = 1; Hostile.aggression[e] = 1 } },
  Health: { store: Health, init: (e) => { Health.hp[e] = 100; Health.max[e] = 100 } },
  Player: { store: Player },
}

/** Where a population is put. Each is a different sampler; see `planPopulations`. */
export const BRUSHES = {
  traffic: 'along the drivable network, facing the way the road goes — density is per kilometre',
  walk: 'along the network but off the carriageway, either side — density is per kilometre',
  scatter: 'anywhere in the region, facing anywhere — density is per hectare',
} as const
export type Brush = keyof typeof BRUSHES

export interface Archetype {
  components: string[]
  /** a catalog id; `bindings` in the level overrides it */
  asset?: string
  /** metres per second, for whatever moves */
  speed?: number
  scale?: number
  hostile?: boolean
}

export interface Population {
  archetype: string
  brush?: Brush
  /** per kilometre of road for `traffic`/`walk`, per hectare for `scatter` */
  density?: number
  /** an absolute number, which wins over `density` */
  count?: number
  seed?: number
  /** [x0, y0, x1, y1] in site metres; absent means the whole site */
  region?: [number, number, number, number]
}

export interface EcsConfig {
  archetypes?: Record<string, Archetype>
  populations?: Population[]
}

/** One entity to make: which archetype, and where. */
export interface SpawnRequest {
  archetype: string
  x: number
  y: number
  yaw: number
  /** metres along the network, for the brushes that follow it */
  s?: number
}

/* ---- validation -------------------------------------------------------------------------- */

/**
 * Check a config. Returns every problem rather than the first.
 *
 * Same contract as the service's level validator: the editor wants to show a person everything
 * that is wrong at once, and a config that mentions a component the engine does not have should be
 * refused where it is written rather than spawn nothing at 2 a.m.
 */
export function validateEcs(cfg: EcsConfig | null | undefined, opts: { assets?: (id: string) => boolean } = {}): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!cfg) return { ok: true, errors, warnings }

  const names = Object.keys(cfg.archetypes ?? {})
  for (const [name, a] of Object.entries(cfg.archetypes ?? {})) {
    if (!Array.isArray(a?.components) || !a.components.length) {
      errors.push(`archetypes.${name} names no components`)
      continue
    }
    for (const c of a.components) {
      if (c === 'Transform') {
        warnings.push(`archetypes.${name} names Transform, which everything gets anyway`)
        continue
      }
      if (!(c in COMPONENTS)) {
        errors.push(`archetypes.${name} names component "${c}", which does not exist. Components: ${Object.keys(COMPONENTS).join(', ')}`)
      }
    }
    if (a.asset && opts.assets && !opts.assets(a.asset)) {
      // a warning, not an error: the asset may be queued for generation, and a level that cannot
      // be saved until its assets exist is a level you cannot author while they bake
      warnings.push(`archetypes.${name} binds "${a.asset}", which is not in the catalog yet — it will spawn with no model`)
    }
    if (a.speed !== undefined && !(Number.isFinite(a.speed) && a.speed >= 0)) errors.push(`archetypes.${name}.speed must be metres per second`)
  }

  for (const [i, p] of (cfg.populations ?? []).entries()) {
    if (!p?.archetype) { errors.push(`populations[${i}] names no archetype`); continue }
    if (!names.includes(p.archetype)) errors.push(`populations[${i}] names archetype "${p.archetype}", which is not defined. Defined: ${names.join(', ') || 'none'}`)
    if (p.brush !== undefined && !(p.brush in BRUSHES)) errors.push(`populations[${i}].brush "${p.brush}" is not one of ${Object.keys(BRUSHES).join(', ')}`)
    if (p.count === undefined && p.density === undefined) errors.push(`populations[${i}] says neither a count nor a density`)
    if (p.count !== undefined && !(Number.isInteger(p.count) && p.count >= 0)) errors.push(`populations[${i}].count must be a whole number`)
    if (p.density !== undefined && !(Number.isFinite(p.density) && p.density >= 0)) errors.push(`populations[${i}].density must be a number`)
    if (p.region !== undefined && !(Array.isArray(p.region) && p.region.length === 4 && p.region.every((n) => Number.isFinite(n)))) {
      errors.push(`populations[${i}].region must be [x0, y0, x1, y1] in site metres`)
    }
  }
  return { ok: !errors.length, errors, warnings }
}

/* ---- planning: pure ---------------------------------------------------------------------- */

/** What `planPopulations` needs to know about the world, and nothing more. */
export interface PlaceCtx {
  /** drivable metres in the network — what a per-kilometre density is measured against */
  roadM: number
  /**
   * A point `s` metres along the network, and which way the road goes there.
   *
   * `yaw` is in the convention `Transform.yaw` uses everywhere in this ECS — `atan2(vx, vy)`, so
   * 0 faces NORTH (+y) and the heading is `(sin yaw, cos yaw)`. A road running east is π/2, not 0.
   */
  onRoad: (s: number) => { x: number; y: number; yaw: number } | null
  /** the site's extent, [x0, y0, x1, y1] in site metres */
  bbox: [number, number, number, number]
}

/** How many of a population there are: `count` wins, else `density` over the region's size. */
export function populationCount(p: Population, ctx: PlaceCtx): number {
  if (p.count !== undefined) return Math.max(0, Math.round(p.count))
  const d = p.density ?? 0
  const brush = p.brush ?? 'traffic'
  if (brush === 'scatter') {
    const [x0, y0, x1, y1] = p.region ?? ctx.bbox
    const hectares = (Math.abs(x1 - x0) * Math.abs(y1 - y0)) / 10_000
    return Math.max(0, Math.round(d * hectares))
  }
  return Math.max(0, Math.round((d * ctx.roadM) / 1000))
}

/** A cap, so a density typed with one zero too many cannot wedge the tab. */
export const MAX_POPULATION = 4000

/**
 * Work out where everything in a config goes.
 *
 * DETERMINISTIC from the seeds: the same level opens with the cars in the same places every time,
 * which is what makes a level playable twice and a bug reproducible once.
 *
 * `traffic` and `walk` walk the network at even spacing with a jittered start, rather than drawing
 * `s` at random: a random draw over a 4 km network clumps visibly, and traffic that arrives in
 * three knots with empty road between them does not read as traffic.
 */
export function planPopulations(cfg: EcsConfig | null | undefined, ctx: PlaceCtx): { requests: SpawnRequest[]; skipped: { population: number; why: string }[] } {
  const requests: SpawnRequest[] = []
  const skipped: { population: number; why: string }[] = []
  const [x0, y0, x1, y1] = ctx.bbox

  for (const [i, p] of (cfg?.populations ?? []).entries()) {
    const brush: Brush = p.brush ?? 'traffic'
    // the network check comes FIRST for a road brush: on a site with no drivable network a
    // per-kilometre density works out to zero, and "it works out to none" is a true statement
    // that tells the author nothing about why
    if (brush !== 'scatter' && !(ctx.roadM > 0)) { skipped.push({ population: i, why: 'this site has no drivable network to put them on' }); continue }
    let want = populationCount(p, ctx)
    if (!want) { skipped.push({ population: i, why: 'it works out to none' }); continue }
    if (want > MAX_POPULATION) {
      skipped.push({ population: i, why: `${want} is over the ${MAX_POPULATION} cap; ${MAX_POPULATION} placed` })
      want = MAX_POPULATION
    }
    const rand = rng((p.seed ?? 1) * 2654435761 + i * 40503)

    if (brush === 'scatter') {
      const [rx0, ry0, rx1, ry1] = p.region ?? [x0, y0, x1, y1]
      for (let n = 0; n < want; n += 1) {
        requests.push({
          archetype: p.archetype,
          x: Math.min(rx0, rx1) + rand() * Math.abs(rx1 - rx0),
          y: Math.min(ry0, ry1) + rand() * Math.abs(ry1 - ry0),
          yaw: rand() * Math.PI * 2,
        })
      }
      continue
    }

    const spacing = ctx.roadM / want
    let placed = 0
    for (let n = 0; n < want; n += 1) {
      // evenly spaced with a jitter of up to one gap, so it is not a parade and not a clump
      const s = (n + rand()) * spacing
      const at = ctx.onRoad(Math.min(ctx.roadM - 0.01, s))
      if (!at) continue
      if (brush === 'walk') {
        // Off the carriageway, alternating sides: a pedestrian standing in a lane is the most
        // obvious thing this could get wrong.
        //
        // PERPENDICULAR TO THE HEADING, which here is `(sin yaw, cos yaw)` — `Transform.yaw` is
        // `atan2(vx, vy)` throughout this ECS, so 0 faces north. `(-cos yaw, sin yaw)` is that
        // turned a quarter left; `(cos yaw, -sin yaw)` is the same line the other way round and
        // would do just as well, since the side alternates anyway. What is NOT interchangeable is
        // the yaw convention: read as `atan2(vy, vx)` the offset comes out along the road, and on
        // a road that happens to run due east — which is what the first test fixture used — every
        // wrong answer still lands on the verge and nothing shows it.
        const side = n % 2 === 0 ? 1 : -1
        const off = 5 + rand() * 3
        requests.push({
          archetype: p.archetype,
          x: at.x - Math.cos(at.yaw) * off * side,
          y: at.y + Math.sin(at.yaw) * off * side,
          yaw: at.yaw,
          s,
        })
      } else {
        requests.push({ archetype: p.archetype, x: at.x, y: at.y, yaw: at.yaw, s })
      }
      placed += 1
    }
    if (placed < want) skipped.push({ population: i, why: `${want - placed} of ${want} fell outside the network` })
  }
  return { requests, skipped }
}

/* ---- applying: entities ------------------------------------------------------------------ */

export interface ApplyEcsOpts {
  /** archetype → catalog id, from the level. Overrides the archetype's own `asset`. */
  bindings?: Record<string, string>
  /** a catalog id to the `Visual.asset` index the renderer draws; -1 for "not in the catalog" */
  assetIndex?: (id: string) => number
  /** ground height, so a scattered entity does not float or sink */
  groundAt?: (x: number, y: number) => number | null
}

/**
 * Turn a plan into entities.
 *
 * Reports rather than throws, per archetype and per asset, because a level whose traffic spawns
 * and whose pedestrians name a missing model is an ordinary state that the editor should describe
 * as two facts.
 */
export function applyEcs(aw: ActorWorld, cfg: EcsConfig | null | undefined, plan: SpawnRequest[], opts: ApplyEcsOpts = {}): { spawned: number; entities: number[]; unbound: string[]; skipped: string[] } {
  const w = aw.world
  const entities: number[] = []
  const unbound = new Set<string>()
  const skipped = new Set<string>()

  for (const r of plan) {
    const a = cfg?.archetypes?.[r.archetype]
    if (!a) { skipped.add(`no archetype "${r.archetype}"`); continue }

    const e = addEntity(w)
    addComponent(w, e, Transform)
    Transform.x[e] = r.x
    Transform.y[e] = r.y
    Transform.yaw[e] = r.yaw
    Transform.z[e] = opts.groundAt?.(r.x, r.y) ?? 0

    for (const name of a.components) {
      if (name === 'Transform') continue
      const c = COMPONENTS[name]
      if (!c) { skipped.add(`component "${name}" on "${r.archetype}"`); continue }
      addComponent(w, e, c.store as never)
      c.init?.(e)
    }
    if (a.hostile && !a.components.includes('Hostile')) {
      addComponent(w, e, Hostile)
      COMPONENTS.Hostile.init?.(e)
    }

    // the archetype's own numbers, AFTER the component defaults, or the defaults overwrite them
    if (a.speed !== undefined) {
      if (a.components.includes('Vehicle')) Vehicle.maxSpeed[e] = a.speed
      if (a.components.includes('Walking')) Walking.speed[e] = a.speed
    }
    if (a.components.includes('Visual')) {
      Visual.scale[e] = a.scale ?? 1
      const id = opts.bindings?.[r.archetype] ?? a.asset
      if (id) {
        const idx = opts.assetIndex?.(id) ?? -1
        if (idx < 0) unbound.add(id)
        else Visual.asset[e] = idx
      }
    }
    if (a.components.includes('OnRoad') && r.s !== undefined) OnRoad.s[e] = r.s

    entities.push(e)
  }
  return { spawned: entities.length, entities, unbound: [...unbound], skipped: [...skipped] }
}
