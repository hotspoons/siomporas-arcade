// Zones as entities, so code can define and change one while the game is running.
//
// Rich, 2026-09-29: *"Would be good to hook it to the ECS system so we can define things from code
// as well and trigger a traffic area, but first we need a bounds."*
//
// The bounds is `zones.ts`, which is pure data and knows nothing about entities. This is the other
// half: every zone in the document becomes an entity, and the ENTITY IS THE AUTHORITY AT RUNTIME.
// The editor writes the document, the document seeds the entities, and from then on a script,
// a scenario rule or a race event changes the component — `TrafficArea.density[e] = 1` and the road
// ahead of you closes up.
//
// WHY THE LOOKUP IS NOT THE AUTHORITY. `Zones.densityAt` is asked per spawn and per junction, so it
// has to be a bbox test and a point-in-polygon and nothing else — it cannot walk an ECS query. So
// the entities hold the live numbers and `syncZones` writes them back into the lookup once a tick.
// One copy per tick of a handful of floats, against a query per spawn: the right way round.
//
// NOTHING HERE DRAWS. The editor paints the polygons and the viewer shades the road; this owns what
// the numbers currently are.

import { addComponent, addEntity, query, type World } from 'bitecs'
import { MAX_ACTORS } from '../actors/actors'
import type { Zone, Zones } from './zones'

const f32 = () => new Float32Array(MAX_ACTORS)
const u16 = () => new Uint16Array(MAX_ACTORS)

/**
 * A traffic area, live.
 *
 * `index` is its position in the `Zones` lookup — the geometry stays there because a polygon is not
 * a typed array and pretending otherwise is how an ECS ends up with a side table anyway.
 *
 * `density` starts at whatever the zone rolled when the level loaded and is then anybody's to
 * change. `target` and `rate` are for changing it over time rather than instantly: a road does not
 * fill up in a frame, and a jam that appears between one frame and the next looks like a bug.
 */
export const TrafficArea = {
  index: u16(),
  density: f32(),
  obeyRate: f32(),
  speedFactor: f32(),
  /** where the density is heading; equal to `density` when nothing is changing */
  target: f32(),
  /** how fast it gets there, density units per second. 0 = instantly */
  rate: f32(),
}

/** Everything a caller needs to find a zone entity again. */
export interface ZoneEntities {
  /** entity id per zone id */
  byId: Map<string, number>
  /** the entity ids in document order */
  all: number[]
}

/**
 * Put every zone in the world as an entity.
 *
 * Called once when a level loads, after `Zones.set` has rolled the swings — the rolled density is
 * the starting value, so a zone with a min and a max begins where the dice put it and can then be
 * driven anywhere by code.
 */
export function spawnZones(world: World, zones: Zones): ZoneEntities {
  const byId = new Map<string, number>()
  const all: number[] = []
  const rolled = zones.rolled
  zones.list.forEach((z, i) => {
    const e = addEntity(world)
    addComponent(world, e, TrafficArea)
    TrafficArea.index[e] = i
    const d = rolled[i]?.density ?? z.traffic?.density ?? 0
    TrafficArea.density[e] = d
    TrafficArea.target[e] = d
    TrafficArea.rate[e] = 0
    TrafficArea.obeyRate[e] = z.traffic?.obeyRate ?? 0.97
    TrafficArea.speedFactor[e] = z.traffic?.speedFactor ?? 1
    byId.set(z.id, e)
    all.push(e)
  })
  return { byId, all }
}

/**
 * Step every zone toward its target and write the result back into the lookup.
 *
 * Runs once a tick, before anything asks how busy a road is. `dt` in seconds.
 */
export function zoneSystem(world: World, zones: Zones, dt: number): void {
  for (const e of query(world, [TrafficArea])) {
    const d = TrafficArea.density[e]
    const t = TrafficArea.target[e]
    if (d !== t) {
      const rate = TrafficArea.rate[e]
      TrafficArea.density[e] = rate > 0
        ? (t > d ? Math.min(t, d + rate * dt) : Math.max(t, d - rate * dt))
        : t
    }
    zones.setDensity(TrafficArea.index[e], TrafficArea.density[e])
  }
}

/**
 * Ask a zone to become busier, or clearer, over `seconds`.
 *
 * The verb a scenario writes: *"a crash closes the bridge"* is `trigger(ents, 'bridge', 1, 20)`.
 * Zero seconds is immediate, which is what a cutscene wants and what a road does not.
 */
export function trigger(ents: ZoneEntities, id: string, density: number, seconds = 0): boolean {
  const e = ents.byId.get(id)
  if (e === undefined) return false
  const to = Math.max(0, Math.min(1, density))
  TrafficArea.target[e] = to
  TrafficArea.rate[e] = seconds > 0 ? Math.abs(to - TrafficArea.density[e]) / seconds : 0
  return true
}

/** What a zone is doing right now, for a readout or a test. */
export function stateOf(ents: ZoneEntities, id: string): { density: number; target: number; rate: number } | null {
  const e = ents.byId.get(id)
  if (e === undefined) return null
  return { density: TrafficArea.density[e], target: TrafficArea.target[e], rate: TrafficArea.rate[e] }
}

/** The zone document a set of entities came from, for anything that wants both halves. */
export function zoneOf(zones: Zones, e: number): Zone | null {
  return zones.list[TrafficArea.index[e]] ?? null
}
