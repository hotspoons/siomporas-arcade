// Traffic in a running world: the cars a level asks for, on the roads, in the jams the zones paint.
//
// Rich, 2026-09-29: *"place them on a map with traffic (route 3 in crofton map is good since it is
// always jammed), set a handful of waypoints, and write a racing game with goals and requiring
// driving around jammed traffic."*
//
// Everything under this existed and nothing ran it. `trafficplan.ts` turns zone densities into car
// positions, `traffic.ts` drives cars with a following model, `zones.ts` reads the painted areas,
// `trafficsets.ts` says which vehicle builds a jam is made of — each tested on its own, and the
// level loader said *"the simulation layer is the next step"*. This is that layer: it plans, spawns,
// steps, draws and collides. It owns nothing another module already owns; it is the glue.
//
// FOUR THINGS PER CAR, and where each one lives:
//
//   the SIMULATION   an ECS entity: Transform, Vehicle, OnRoad, Driver (traffic.ts)
//   the ROAD         `OnRoad.s` along a site chain; `followRoad` turns that into x, y and yaw
//   the PICTURE      a clone of the vehicle build's model, fitted to its chassis (carmodel.ts)
//   the BODY         a kinematic box in the physics world, moved each frame — so the player hits
//                    a moving car and not a ghost
//
// The frame is the SITE's: x east, y north, metres, yaw counter-clockwise from east. Three's is
// x east, y up, z south, which is why every sync line has a `-y` in it. One conversion per line,
// written out, because a second helper for "site to three" is a sign error waiting to happen.

import * as THREE from 'three'
import { addComponent } from 'bitecs'
import { ActorWorld, spawnVehicle } from './actorworld'
import { OnRoad, Transform, Vehicle } from './actors'
import { driveSystem, makeDriver, rng, SpeedLimit } from './traffic'
import { lanesPerDirection, planTraffic, type RoadChain, type TrafficSlot } from './trafficplan'
import { TRAFFIC_LEVELS, Zones, type ZoneDoc } from './zones'
import { loadZones } from './editor/zonestore'
import { assetsvc, type Build } from './assetsvc'
import { EMPTY_SET, pick, type TrafficSetDoc } from './trafficsets'
import { loadCarModel } from './carmodel'
import { defaultVehicle, type VehicleDoc } from './vehicles'
import type { Site } from './scene'
import type { CorridorPhysics } from './physics'
import * as T from './tuning'

/** What a level's `simulations` entry may say. Everything is optional; a bare `{ kind: 'traffic' }` runs. */
export interface TrafficSpec {
  kind: 'traffic'
  /** a traffic SET build id (which cars, how common). Absent: one anonymous saloon */
  set?: string
  /**
   * A density for the whole world where the zones say nothing: 0…1, or one of the map's words
   * (clear, light, heavy, slow, jammed; `rush` reads as slow). Absent: only the painted zones
   * carry traffic, which is the normal case — a jam is somewhere, not everywhere.
   */
  density?: number | string
  /** never more cars than this; the knob `TRAFFIC_MAX` caps it again */
  max?: number
  seed?: number
  /** the share of drivers who stop for a red; the set's own value wins if it has one */
  obeyRate?: number
  /** a multiplier on the speed limit; the set's own wins */
  speedFactor?: number
}

/** Where a car is on screen and in the solver, for one entity. */
interface Shown {
  e: number
  mesh: THREE.Object3D
  body: { move: (x: number, y: number, z: number, yaw: number) => void; free: () => void } | null
}

/** a chain the planner can use, plus what the follower needs that the planner does not */
interface Road extends RoadChain {
  twoWay: boolean
  half: number
  highway: string | null
  dir: (s: number) => { x: number; y: number }
}

/**
 * Posted limits by road class, m/s. OSM `maxspeed` is not baked into the chains, so this is the
 * best that can be said — and it is what a driver does on an unsigned road anyway.
 */
export function limitFor(highway: string | null): number {
  switch (highway) {
    case 'motorway': return 29
    case 'motorway_link': return 20
    case 'trunk': return 25
    case 'trunk_link': return 18
    case 'primary': return 20
    case 'secondary': return 18
    case 'tertiary': return 15.6
    case 'residential': return 11
    case 'living_street':
    case 'service': return 8
    default: return 13.4
  }
}

/**
 * Where across the road a lane runs, metres right of the centreline for a car travelling `dir`.
 *
 * Right-hand traffic: on a two-way road each direction keeps to its own side, lane 0 nearest the
 * centre. On a one-way road every lane runs the same way and they share the whole width, centred.
 */
export function laneOffset(lane: number, perDir: number, twoWay: boolean): number {
  if (twoWay) return (lane + 0.5) * T.LANE_WIDTH
  return (lane + 0.5 - perDir / 2) * T.LANE_WIDTH
}

export class TrafficLayer {
  readonly group = new THREE.Group()
  readonly zones = new Zones()
  private site: Site
  private actors: ActorWorld
  private physics: CorridorPhysics | null
  private roads: Road[] = []
  private shown: Shown[] = []
  private models = new Map<string, { object: THREE.Object3D; doc: VehicleDoc }>()
  private drive: ((world: ActorWorld['world'], dt: number) => void) | null = null
  private slots: TrafficSlot[] = []
  private built = false
  /** how many cars exist, for the HUD and for a probe */
  count = 0
  /** what could not be done, in words — a level with a set that names no built vehicle should say so */
  problems: string[] = []

  constructor(site: Site, actors: ActorWorld, physics: CorridorPhysics | null) {
    this.site = site
    this.actors = actors
    this.physics = physics
    this.group.name = 'traffic'
  }

  /**
   * Plan and spawn. Returns how many cars went in.
   *
   * ZONES FIRST, THEN THE SET, THEN THE MODELS, and each failure downgrades rather than aborts: no
   * zones and no density is a world with no traffic (which is a valid answer, reported), a set
   * naming a vehicle with no build is that vehicle skipped (reported), a model that will not load
   * is a car drawn as a box (reported). A level that says "traffic" gets traffic.
   */
  async load(slug: string, spec: TrafficSpec): Promise<number> {
    const rand = rng((spec.seed ?? 1) * 2654435761 + 7)
    const doc: ZoneDoc = await loadZones(slug).catch(() => ({ version: 1, zones: [] }) as ZoneDoc)
    const zones = [...doc.zones]
    const floor = typeof spec.density === 'string' ? (TRAFFIC_LEVELS.find((l) => l.id === spec.density)?.density ?? (spec.density === 'rush' ? 0.8 : 0)) : spec.density ?? 0
    if (floor > 0) {
      // the whole world as one zone, UNDER the painted ones: `Zones.at` takes the first hit
      const b = this.site.manifest.bbox
      if (b) zones.push({ id: '__everywhere', name: 'the level', kind: 'traffic', polygon: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], traffic: { density: floor } })
    }
    this.zones.set(zones, rand)

    // the set: which cars, and how common
    let set: TrafficSetDoc = EMPTY_SET
    if (spec.set) {
      try {
        const sets = await assetsvc.builds<Build<TrafficSetDoc>>('traffic')
        const found = sets.find((s) => s.id === spec.set)
        if (found) set = found.doc
        else this.problems.push(`no traffic set "${spec.set}" — using the default saloon`)
      } catch (e) {
        this.problems.push(`could not read traffic sets (${String((e as Error).message ?? e)}) — using the default saloon`)
      }
    }
    // the vehicle builds the set names, and their models
    const builds = new Map<string, Build<VehicleDoc>>()
    if (set.mix.length) {
      try {
        for (const b of await assetsvc.builds<Build<VehicleDoc>>('vehicles')) builds.set(b.id, b)
      } catch (e) {
        this.problems.push(`could not read vehicle builds (${String((e as Error).message ?? e)})`)
      }
    }
    for (const m of set.mix) {
      const b = builds.get(m.vehicle)
      if (!b) { this.problems.push(`traffic set names "${m.vehicle}", which is not a vehicle build`); continue }
      const doc = b.doc ?? defaultVehicle('traffic')
      const model = b.asset ? await loadCarModel(b.asset, doc.spec).catch(() => null) : null
      this.models.set(m.vehicle, { object: model?.object ?? placeholderCar(doc), doc })
      if (!model) this.problems.push(`"${m.vehicle}" has no usable model — drawn as a box`)
    }
    const usable = { mix: set.mix.filter((m) => this.models.has(m.vehicle)), obeyRate: set.obeyRate, speedFactor: set.speedFactor }
    if (!usable.mix.length) this.models.set('__default', { object: placeholderCar(defaultVehicle('traffic')), doc: defaultVehicle('traffic') })

    // the roads, in the planner's frame
    this.roads = this.site.chains().map((c) => ({
      index: c.index,
      length_m: c.length_m,
      lanes: c.lanes,
      twoWay: c.twoWay,
      half: c.half,
      highway: c.highway,
      limit_ms: limitFor(c.highway),
      at: (s: number) => { const p = c.at(s).pos; return { x: p.x, y: -p.z } },
      dir: (s: number) => { const d = c.at(s).dir; return { x: d.x, y: -d.z } },
    }))
    const max = Math.min(spec.max ?? Infinity, Math.round(T.TRAFFIC_MAX))
    this.slots = planTraffic(this.roads, this.zones, rand, { max })
    // a one-way road runs every lane the same way: the planner's against-the-chain slots become
    // the outer lanes of the with-the-chain set
    for (const s of this.slots) {
      const r = this.roads[s.chain]
      if (r && !r.twoWay && s.dir === 1) { s.dir = 0; s.lane += lanesPerDirection(r.lanes) }
    }

    const obey = usable.obeyRate ?? spec.obeyRate
    const speedFactor = usable.speedFactor ?? spec.speedFactor ?? 1
    for (const slot of this.slots) {
      const road = this.roads[slot.chain]
      if (!road) continue
      const p = road.at(slot.s)
      const d = road.dir(slot.s)
      const which = usable.mix.length ? (pick(usable, rand) ?? usable.mix[0].vehicle) : '__default'
      const m = this.models.get(which)!
      const e = spawnVehicle(this.actors, { x: p.x, y: p.y, yaw: Math.atan2(d.y, d.x) }, { maxSpeed: road.limit_ms ?? 13.4 })
      addComponent(this.actors.world, e, OnRoad)
      OnRoad.chain[e] = slot.chain
      OnRoad.s[e] = slot.s
      OnRoad.lane[e] = slot.lane
      OnRoad.dir[e] = slot.dir
      Vehicle.lengthM[e] = m.doc.spec.length ?? 4.4
      Vehicle.widthM[e] = m.doc.spec.width ?? 1.8
      makeDriver(this.actors.world, e, rand, { obeyRate: usable.mix.find((x) => x.vehicle === which)?.obeyRate ?? obey })
      SpeedLimit.v[e] = (road.limit_ms ?? 13.4) * speedFactor
      // a jam's cars start slow, an open road's at the limit — otherwise the first seconds are a pile-up
      Vehicle.speed[e] = SpeedLimit.v[e] * (1 - slot.density) * 0.8

      const mesh = m.object.clone(true)
      mesh.name = `traffic:${which}`
      this.group.add(mesh)
      const half = { x: (m.doc.spec.length ?? 4.4) / 2, y: (m.doc.spec.height ?? 1.4) / 2, z: (m.doc.spec.width ?? 1.8) / 2 }
      const body = this.physics ? this.physics.spawnKinematic(half) : null
      this.shown.push({ e, mesh, body })
    }
    this.count = this.shown.length
    // no signal heads yet: the lights are not in the ECS in the viewer, so every driver sees green
    this.drive = driveSystem({ heads: [] })
    this.actors.add('traffic:drive', this.drive).add('traffic:follow', this.followRoad)
    this.built = true
    this.place(true)
    return this.count
  }

  /**
   * `OnRoad.s` to a place in the world, every step.
   *
   * THE END OF A CHAIN IS ITS BEGINNING: a car that runs off the end comes back at the start,
   * which on a road with two ends is a teleport nobody sees (the ends are the edge of the world)
   * and on a loop is simply a lap. The alternative — turning round — needs the network, which
   * `site.chains()` does not hand over. Noted, and enough for a jam.
   */
  private followRoad = (world: ActorWorld['world'], _dt: number) => {
    void world
    for (const s of this.shown) {
      const e = s.e
      const road = this.roads[OnRoad.chain[e]]
      if (!road) continue
      let at = OnRoad.s[e]
      if (at >= road.length_m) { at -= road.length_m; OnRoad.s[e] = at }
      if (at < 0) { at += road.length_m; OnRoad.s[e] = at }
      const dir = OnRoad.dir[e]
      // against the chain, the car reads the road backwards
      const along = dir ? road.length_m - at : at
      const p = road.at(along)
      const d = road.dir(along)
      const dx = dir ? -d.x : d.x
      const dy = dir ? -d.y : d.y
      // right of travel is (dy, -dx) in a y-north frame
      const off = laneOffset(OnRoad.lane[e], lanesPerDirection(road.lanes), road.twoWay)
      Transform.x[e] = p.x + dy * off
      Transform.y[e] = p.y - dx * off
      Transform.yaw[e] = Math.atan2(dy, dx)
    }
  }

  /** Step the simulation and put every car where it now is. */
  tick(dt: number, eye: THREE.Vector3): void {
    if (!this.built) return
    this.actors.tick(dt)
    this.place(false, eye)
  }

  private place(all: boolean, eye?: THREE.Vector3): void {
    const drawM = T.TRAFFIC_DRAW_M
    for (const s of this.shown) {
      const e = s.e
      const x = Transform.x[e]
      const y = Transform.y[e]
      const yaw = Transform.yaw[e]
      // three: x east, y up, z south — the site's y is north
      const near = all || !eye || (eye.x - x) ** 2 + (eye.z + y) ** 2 < drawM * drawM
      if (!near) { s.mesh.visible = false; continue }
      const g = this.site.groundAt(x, -y) ?? this.site.heightAt(x, y) ?? 0
      Transform.z[e] = g
      s.mesh.visible = true
      s.mesh.position.set(x, g, -y)
      // the model's nose is +X; three's rotation about +Y takes +X toward -Z, which is NORTH here
      s.mesh.rotation.set(0, yaw, 0)
      s.body?.move(x, g, -y, -yaw)
    }
  }

  /** The cars as the program sees them: entity ids, for `api.actors` queries. */
  get entities(): number[] {
    return this.shown.map((s) => s.e)
  }

  dispose(): void {
    for (const s of this.shown) {
      s.body?.free()
      s.mesh.removeFromParent()
    }
    this.shown = []
    this.count = 0
    this.built = false
    this.group.removeFromParent()
  }
}

/** A box the size of the chassis, for a build with no model. It is honest, and it is visible. */
function placeholderCar(doc: VehicleDoc): THREE.Object3D {
  const l = doc.spec.length ?? 4.4
  const w = doc.spec.width ?? 1.8
  const h = doc.spec.height ?? 1.4
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(l, h, w), new THREE.MeshLambertMaterial({ color: 0x8899aa }))
  mesh.position.y = h / 2
  const g = new THREE.Group()
  g.add(mesh)
  return g
}
