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
import { ActorWorld, setPhysical, spawnVehicle } from '../actors/actorworld'
import { hasComponent, removeComponent } from 'bitecs'
import { Driver } from './traffic'
import { dentObject, releaseObject, repairObject } from '../vehicle/dents'
import type { Impact } from '@apex/engine/physics/world'
import type { TrafficBody } from '../world/physics'
import { Doomed, OnRoad, Transform, Vehicle } from '../actors/actors'
import { Driver as DriverC, driveSystem, makeDriver, rng, SpeedLimit } from './traffic'
import { lanesPerDirection, planTraffic, type RoadChain, type TrafficSlot } from './trafficplan'
import { TRAFFIC_LEVELS, Zones, type Zone, type ZoneDoc } from '../world/zones'
import { loadZones } from '../../editor/store/zonestore'
import { assetsvc, type Build } from '../../assets/assetsvc'
import { EMPTY_SET, pick, type TrafficSetDoc } from './trafficsets'
import { loadCarModel } from '../vehicle/carmodel'
import { defaultVehicle, lampCounts, lampOffsets, type VehicleDoc } from '../vehicle/vehicles'
import type { Site } from '../../world/scene'
import type { CorridorPhysics } from '../world/physics'
import * as T from '../../tuning'

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
  /** nobody brakes for anybody: a pile-up as a game (Rich, 2026-09-30: "this is hilarious") */
  blind?: boolean
}

/** `OnRoad.chain` of a wreck that has left the road: no chain has this index (the field is u16), so nobody follows it */
const OFF_ROAD = 0xffff

/** Where a car is on screen and in the solver, for one entity. */
interface Shown {
  e: number
  mesh: THREE.Object3D
  body: TrafficBody | null
  massKg: number
  /** knocked loose: driven by the solver now, not the road */
  wrecked: boolean
  /** off the road, waiting for somewhere out of sight to come back */
  hidden: boolean
  /** the chain it was planned on, for when a wreck comes back as a car */
  chain: number
  limit: number
  obey: number
  /** night beams, parented to the mesh. Hidden in daylight. */
  lamps: THREE.Group
  /** a swerve in progress: metres right of the lane line, and how fast that is changing */
  swerve: number
  swerveV: number
  /** gunfire soaked up lately, m/s, decaying: a burst escalates a swerve into a knock */
  heat: number
  heatAt: number
}

/** What a hit did to a car, mildest first. */
export type HitEffect = 'swerve' | 'loose' | 'launched'

/** One hit on one car, as the layer reports it. `at` and `dir` are the world (three) frame. */
export interface TrafficHitEvent {
  /** the car's entity */
  e: number
  effect: HitEffect
  /** how hard, m/s: what graded it */
  force: number
  /** who did it: 'gun', 'missile', 'program', … */
  weapon: string
  /** where the car is */
  at: { x: number; y: number; z: number }
}

/** How to hit a car. World (three) frame; `dir` is the way the hit travels. */
export interface HitOpts {
  /** m/s. Below TRAFFIC_KNOCK_MS a driven car swerves and drives on; above, it is knocked loose */
  force: number
  dir: { x: number; y: number; z: number }
  /** how much of the throw goes up, added to `dir.y` before normalising */
  lift?: number
  /** 0…1, the dent. Absent: scaled from the force */
  damage?: number
  weapon?: string
  /** m/s given to a car that is already loose, when that should differ from `force` (a gun round) */
  kick?: number
  /** tumble per m/s of kick */
  spin?: number
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
const HEAD_BULB = new THREE.BoxGeometry(0.07, 0.1, 0.22)
const TAIL_BULB = new THREE.BoxGeometry(0.05, 0.08, 0.16)
const HEAD_BULB_MAT = new THREE.MeshBasicMaterial({ color: 0xfff1c9 })
const TAIL_BULB_MAT = new THREE.MeshBasicMaterial({ color: 0xff1c14 })

/** The spots a car may switch on. The bulbs are always in the group; the spots stay off until a frame spends budget on them. */
interface LampRig { heads: THREE.SpotLight[]; tails: THREE.SpotLight[] }

/**
 * One lamp per side of the front, and red lamps across the tail, in the model's frame (nose is +X).
 *
 * The bulbs sit just proud of the body. A spot buried inside the mesh reads as a single glow in
 * the middle, which is what a centred beam was doing. Only the nearest cars switch the spots on;
 * the rest still show the bulbs.
 */
function trafficLamps(mesh: THREE.Object3D, doc: VehicleDoc): THREE.Group {
  const g = new THREE.Group()
  g.name = 'headlights'
  g.visible = false
  const spec = doc.spec
  const length = spec.length ?? 4.4
  const width = spec.width ?? 1.8
  const height = spec.height ?? 1.4
  const counts = lampCounts(spec)
  const nose = length / 2 + 0.04
  const up = Math.max(0.45, height * 0.42)
  const heads: THREE.SpotLight[] = []
  const tails: THREE.SpotLight[] = []
  for (const z of lampOffsets(counts.headlights, width)) {
    const bulb = new THREE.Mesh(HEAD_BULB, HEAD_BULB_MAT)
    bulb.position.set(nose, up, z)
    const spot = new THREE.SpotLight(0xfff1c9, 0, 32, 0.34, 0.45, 1.5)
    spot.position.set(nose, up, z)
    spot.target.position.set(nose + 18, up * 0.25, z)
    spot.visible = false
    spot.castShadow = false
    spot.userData.family = 'traffic-head' // the lighting panel's per-light dump reads this
    g.add(bulb, spot, spot.target)
    heads.push(spot)
  }
  for (const z of lampOffsets(counts.taillights, width)) {
    const bulb = new THREE.Mesh(TAIL_BULB, TAIL_BULB_MAT)
    bulb.position.set(-nose, up, z)
    const spot = new THREE.SpotLight(0xff180c, 0, T.TAILLIGHT_RANGE, T.TAILLIGHT_ANGLE, 0.55, 2)
    spot.position.set(-nose, up, z)
    spot.target.position.set(-nose - Math.max(1.2, T.TAILLIGHT_RANGE * 0.65), 0.05, z)
    spot.visible = false
    spot.castShadow = false
    spot.userData.family = 'traffic-tail'
    g.add(bulb, spot, spot.target)
    tails.push(spot)
  }
  g.userData.lamps = { heads, tails } satisfies LampRig
  mesh.add(g)
  return g
}

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
  /** the zone file as authored, before the world floor; a live reseed rebuilds from these */
  private fileZones: Zone[] = []
  /** the level's own world floor (`spec.density`), 0 when it asked for none */
  private levelFloor = 0
  /** the live world floor from TRAFFIC_DENSITY: >0 overrides the level and puts traffic on every road */
  private worldDensity = 0
  /** what the knob last asked for; `tick` applies it on a throttle so a drag does not respawn per frame */
  private pendingDensity = 0
  private densityAt = 0
  /** the level's own car cap, before TRAFFIC_MAX caps it again */
  private maxSpec = Infinity
  /** what to spawn from, kept so a reseed needs no asset reads */
  private usable: { mix: TrafficSetDoc['mix']; obeyRate?: number; speedFactor?: number } = { mix: [] }
  private obey = 0.97
  private speedFactor = 1
  private built = false
  private byCollider = new Map<number, Shown>()
  private offImpact: (() => void) | null = null
  /** how many cars have been knocked loose, for the HUD and for a probe */
  wrecked = 0
  /** how many cars exist, for the HUD and for a probe */
  count = 0
  /**
   * The player, for the drivers to see: site metres and velocity. Set by the app each frame;
   * null when nobody is driving. A car whose lane the player sits in ahead brakes for him.
   */
  player: { x: number; y: number; vx: number; vy: number; length: number } | null = null
  /** where the camera is, in the site frame — what a respawn keeps away from when nobody is driving */
  private eyeSite = { x: 0, y: 0 }
  /**
   * THE SIMULATION FOOTPRINT — the speed-aware cone `driveSystem` and `followRoad` cull against,
   * rebuilt once a frame from the eye's motion. See `TRAFFIC_SIM_*` for the shape. Cars outside it
   * are not stepped; they hold their place on the road until the eye comes back to them.
   */
  private simX = 0
  private simY = 0
  /** unit heading of the cone, in the site frame (x east, y north) */
  private simFx = 1
  private simFy = 0
  /** squared radii: the always-on near circle, and the cone's reach */
  private simNear2 = 0
  private simReach2 = 0
  /** cosine of (half-angle + feather); -1 means the all-round circle */
  private simConeCos = -1
  /** the eye last frame, for the speed and heading the shape morphs from */
  private prevEyeX = Number.NaN
  private prevEyeY = Number.NaN
  /** live footprint state, for the perf panel and a probe */
  simSpeedFrac = 0
  simTightenFrac = 0
  simConeDeg = 180
  simReachM = 0
  /** how many cars were inside the footprint on the last step — the sim's real cost, a probe reads it */
  simCars = 0
  /** cars that ran off a road and were put back somewhere out of sight; a probe reads it */
  respawned = 0
  /** the closest to the player any respawn has been, m: the proof that none came from thin air */
  respawnMin = Infinity
  /** cars waiting, hidden, for a place to respawn that is far enough from the player */
  parked = 0
  /** the loose wrecks, oldest first; past `TRAFFIC_WRECKS_MAX` the oldest is recycled */
  private wrecks: Shown[] = []
  /**
   * Cars wearing a dent clone. A dent is a private copy of the car's geometry (three copies of its
   * vertices and the GPU buffers), so this set is what the traffic costs in memory beyond the
   * shared models; `sweepDents` keeps it near the player and under `TRAFFIC_DENTS_MAX`.
   */
  private dentedCars = new Set<Shown>()
  /** who wants to hear about hits: the program, the HUD */
  private hitFns = new Set<(ev: TrafficHitEvent) => void>()
  private sinceDentSweep = 0
  /** wrecks straightened out and sent back into traffic; a probe reads it */
  recycled = 0
  /** cars knocked loose, ever: `woken - recycled` is what is loose now */
  woken = 0
  /** the last twenty wakes and why, newest last — what a probe reads when a jam wakes itself */
  readonly wakes: { index: number; why: 'blast' | 'impact'; impulse: number }[] = []
  /** live: nobody brakes for anybody. Set from the level's traffic spec, or flipped from the bridge */
  blind = false
  private rand: () => number = rng(7)
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
    this.rand = rand
    this.blind = !!spec.blind
    const doc: ZoneDoc = await loadZones(slug).catch(() => ({ version: 1, zones: [] }) as ZoneDoc)
    this.fileZones = doc.zones
    this.levelFloor = typeof spec.density === 'string' ? (TRAFFIC_LEVELS.find((l) => l.id === spec.density)?.density ?? (spec.density === 'rush' ? 0.8 : 0)) : spec.density ?? 0
    // a knob already up is the world floor: it puts traffic everywhere, whether or not the level asked
    this.worldDensity = T.TRAFFIC_DENSITY
    this.pendingDensity = this.worldDensity
    this.rebuildZones()

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
      const model = b.asset ? await loadCarModel(b.asset, doc.spec, doc.mesh, doc.finish).catch(() => null) : null
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
    this.usable = usable
    this.obey = usable.obeyRate ?? spec.obeyRate ?? 0.97
    this.speedFactor = usable.speedFactor ?? spec.speedFactor ?? 1
    this.maxSpec = spec.max ?? Infinity
    // the planner knows a carriageway from a two-way road (`twoWay` on the chain) and lanes it
    this.replan()
    this.spawnSlots()
    this.count = this.shown.length
    /*
     * A HARD HIT KNOCKS A CAR LOOSE, AND DENTS IT. The world reports every impact above the
     * physics threshold; one on a traffic car's collider harder than `TRAFFIC_WAKE_NS` turns it
     * from a car on rails into a loose body that goes where it was sent, and both cars in the
     * collision take a dent where they met.
     */
    if (this.physics) {
      this.offImpact = this.physics.onImpact((im) => this.onImpact(im))
    }
    // no signal heads yet: the lights are not in the ECS in the viewer, so every driver sees green
    this.drive = driveSystem({
      heads: [],
      blind: () => this.blind,
      inRange: (x, y) => this.inSim(x, y),
      obstacle: (x, y, yaw, speed) => {
        const p = this.player
        if (!p) return null
        const dx = p.x - x
        const dy = p.y - y
        if (dx * dx + dy * dy > 90 * 90) return null
        const cos = Math.cos(yaw), sin = Math.sin(yaw)
        const along = dx * cos + dy * sin
        const across = Math.abs(-dx * sin + dy * cos)
        // ahead, and in this lane (a lane and a half wide, so a car straddling the line still counts)
        if (along <= 0 || across > T.LANE_WIDTH * 0.75) return null
        const gap = along - p.length / 2 - 2.2
        const playerAlong = p.vx * cos + p.vy * sin
        return { gap: Math.max(0, gap), dv: speed - playerAlong }
      },
    })
    this.actors.add('traffic:drive', this.drive).add('traffic:follow', this.followRoad)
    this.built = true
    this.place(true)
    return this.count
  }

  /**
   * The TRAFFIC_DENSITY knob moved. Stored, not applied: `tick` reconciles it on a throttle, so
   * dragging the slider does not respawn six hundred cars on every frame of the drag.
   */
  setWorldDensity(d: number): void {
    this.pendingDensity = d
  }

  /**
   * The zones to plan from: the file's own, PLUS the world floor as one zone UNDER them. `Zones.at`
   * takes the first hit, so a painted jam still wins over the floor wherever it covers.
   */
  private rebuildZones(): void {
    const zones = [...this.fileZones]
    const floor = this.worldDensity > 0 ? this.worldDensity : this.levelFloor
    if (floor > 0) {
      const b = this.site.manifest.bbox
      if (b) zones.push({ id: '__everywhere', name: 'the level', kind: 'traffic', polygon: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], traffic: { density: floor } })
    }
    this.zones.set(zones, this.rand)
  }

  /** Plan the cars for the current zones and density. */
  private replan(): void {
    const max = Math.min(this.maxSpec, Math.round(T.TRAFFIC_MAX))
    this.slots = planTraffic(this.roads, this.zones, this.rand, { max })
  }

  /**
   * Drop every car and put the plan back on the road. Entities are marked `Doomed` (the world reaps
   * them at the end of its step) and their meshes and bodies are released now, so a density change
   * costs one re-plan and one spawn, not a level reload.
   */
  private reseed(): void {
    for (const s of this.shown) {
      addComponent(this.actors.world, s.e, Doomed)
      s.body?.free()
      releaseObject(s.mesh)
      s.mesh.removeFromParent()
    }
    this.dentedCars.clear()
    this.shown = []
    this.wrecks = []
    this.byCollider.clear()
    this.wrecked = 0
    this.count = 0
    this.replan()
    this.spawnSlots()
    this.count = this.shown.length
  }

  /** Spawn one car per planned slot. The body of `load`'s spawn loop, now callable again. */
  private spawnSlots(): void {
    const { usable, rand } = this
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
      const obey = usable.mix.find((x) => x.vehicle === which)?.obeyRate ?? this.obey
      makeDriver(this.actors.world, e, rand, { obeyRate: obey })
      SpeedLimit.v[e] = (road.limit_ms ?? 13.4) * this.speedFactor
      // a jam's cars start slow, an open road's at the limit — otherwise the first seconds are a pile-up
      Vehicle.speed[e] = SpeedLimit.v[e] * (1 - slot.density) * 0.8

      const mesh = m.object.clone(true)
      mesh.name = `traffic:${which}`
      this.group.add(mesh)
      const half = { x: (m.doc.spec.length ?? 4.4) / 2, y: (m.doc.spec.height ?? 1.4) / 2, z: (m.doc.spec.width ?? 1.8) / 2 }
      const body = this.physics ? this.physics.spawnKinematic(half) : null
      const shown: Shown = { e, mesh, body, massKg: m.doc.spec.mass ?? 1500, wrecked: false, hidden: false, chain: slot.chain, limit: SpeedLimit.v[e], obey, lamps: trafficLamps(mesh, m.doc), swerve: 0, swerveV: 0, heat: 0, heatAt: 0 }
      if (body) this.byCollider.set(body.colliderHandle, shown)
      this.shown.push(shown)
    }
  }

  private onImpact(im: Impact): void {
    const a = this.byCollider.get(im.a.handle)
    const b = this.byCollider.get(im.b.handle)
    if (!a && !b) return
    this.stats.impacts++
    for (const [s, other] of [[a, true], [b, false]] as const) {
      if (!s) continue
      if (im.impulse >= T.TRAFFIC_WAKE_NS) this.wake(s, 'impact', im.impulse)
      const n = dentObject(s.mesh, im, !other)
      if (n) this.dentedCars.add(s)
      this.stats.dents += n
    }
  }

  /** Knock one car loose: the solver owns it from here, the driver is gone, the wreck blocks its lane. */
  private wake(s: Shown, why: 'blast' | 'impact' = 'blast', impulse = 0): void {
    if (s.wrecked || !s.body) return
    // no ground under it means no physics tile there yet: a loose body would fall through the
    // world. It stays on rails — a blast that far from the player has nobody to see it anyway.
    if (this.physics && this.physics.groundUnder(s.mesh.position.x, s.mesh.position.z) === null) return
    s.wrecked = true
    this.wrecked++
    this.woken++
    this.wakes.push({ index: this.shown.indexOf(s), why, impulse: Math.round(impulse) })
    if (this.wakes.length > 20) this.wakes.shift()
    s.body.enable(true)
    s.body.wake(s.massKg)
    // no longer driven: other drivers still see it, at its last place in the lane, which is a wreck
    removeComponent(this.actors.world, s.e, Driver)
    Vehicle.speed[s.e] = 0
    setPhysical(this.actors, s.e, 'dynamic', { mass: s.massKg })
    this.wrecks.push(s)
    while (this.wrecks.length > Math.max(1, T.TRAFFIC_WRECKS_MAX)) this.recycle(this.wrecks.shift()!)
  }

  /**
   * A wreck becomes a car again: straightened, back on rails, driven, and hidden until the road
   * has a place for it out of the player's sight. The pile-up can go on for ever this way and
   * the solver and the renderer only ever carry `TRAFFIC_WRECKS_MAX` of it.
   */
  private recycle(s: Shown): void {
    if (!s.wrecked || !s.body) return
    s.wrecked = false
    this.wrecked--
    this.recycled++
    s.body.rest()
    repairObject(s.mesh)
    this.dentedCars.delete(s)
    s.mesh.rotation.set(0, 0, 0)
    const e = s.e
    makeDriver(this.actors.world, e, this.rand, { obeyRate: s.obey })
    SpeedLimit.v[e] = s.limit
    setPhysical(this.actors, e, 'kinematic')
    OnRoad.chain[e] = s.chain
    OnRoad.s[e] = 0
    Vehicle.speed[e] = 0
    s.hidden = true
    s.mesh.visible = false
    s.swerve = s.swerveV = s.heat = 0
  }

  /**
   * A blast, as the traffic feels it: every car within reach is knocked loose and thrown away
   * from it — `impulse` metres per second at the centre, falling off to nothing at the radius,
   * swung upward by `lift`. Returns how many cars flew. The physics world's own `explode` cannot
   * do this for a car that was kinematic a moment ago (see `TrafficBody.kick`), so the traffic
   * does it for its own; `main.ts` calls this and then `physics.explode` for everything else.
   */
  /**
   * A bullet landed here, going that way: the nearest car within reach is knocked loose and shoved
   * along the shot, with some lift so it lifts and tumbles rather than skids. False when nothing
   * was near enough.
   */
  /** The car whose body is nearest a world point, within `within` metres, or null. */
  private carNear(at: { x: number; y: number; z: number }, within = 3.2): Shown | null {
    let best: Shown | null = null
    let bd = within
    for (const s of this.shown) {
      if (s.hidden) continue
      const p = s.mesh.position
      const d = Math.hypot(p.x - at.x, p.y + 0.7 - at.y, p.z - at.z)
      if (d < bd) { bd = d; best = s }
    }
    return best
  }

  /** the entity of the car nearest a world point, or null — what a shot that landed hit */
  entityNear(at: { x: number; y: number; z: number }, within = 3.2): number | null {
    return this.carNear(at, within)?.e ?? null
  }

  /**
   * A round landed at `at`. The car it hit SOAKS IT UP: each round adds `impulse` to the car's heat,
   * which decays over TRAFFIC_HEAT_S, and the heat is what grades the hit — a single round makes a
   * car swerve, a burst knocks it loose. A car already loose takes each round as a shove of
   * `impulse`, as it always did. False when no car was near enough.
   */
  shoot(at: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, impulse: number, lift = 0.35, damage?: number): boolean {
    const s = this.carNear(at)
    if (!s) return false
    const now = performance.now() / 1000
    s.heat = s.heat * Math.exp(-(now - s.heatAt) / Math.max(0.05, T.TRAFFIC_HEAT_S)) + impulse
    s.heatAt = now
    this.hitCar(s, { force: s.heat, kick: impulse, dir, lift, damage, weapon: 'gun', spin: 0.5 })
    return true
  }

  /**
   * A blast: every car within `radius` is hit with `impulse` m/s at the centre, falling off to
   * nothing at the edge, thrown away from the centre and swung up by `lift`. Graded like any hit —
   * the edge of a blast makes cars swerve, the middle throws them. `damage` is the dent at the
   * centre, 0…1, falling off the same way; absent, it is scaled from the force. Returns how many
   * cars it touched.
   */
  blast(at: { x: number; y: number; z: number }, radius: number, impulse: number, lift = 0.55, opts: { damage?: number; weapon?: string } = {}): number {
    let n = 0
    for (const s of this.shown) {
      if (s.hidden) continue
      const p = s.mesh.position
      let dx = p.x - at.x, dy = p.y + 0.7 - at.y, dz = p.z - at.z
      const d = Math.hypot(dx, dy, dz)
      const falloff = Math.max(0, 1 - d / radius)
      if (falloff <= 0) continue
      if (d < 1e-3) { dx = 0; dy = 1; dz = 0 } else { dx /= d; dy /= d; dz /= d }
      // the tumble scales with the throw: a nudge that spun a car at full tilt swung its corners
      // into the cars beside it and woke half the jam
      const hit = this.hitCar(s, { force: impulse * falloff, dir: { x: dx, y: dy, z: dz }, lift, damage: opts.damage === undefined ? undefined : opts.damage * falloff, weapon: opts.weapon ?? 'blast', spin: 0.35 })
      if (hit) n++
    }
    return n
  }

  /**
   * Hit one car by entity, as a program does: along `dir`, or away from `from` (world frame). Null
   * when there is no such car, or it is out of sight.
   */
  hitEntity(e: number, o: Omit<HitOpts, 'dir'> & { dir?: HitOpts['dir']; from?: { x: number; y: number; z: number } }): HitEffect | null {
    const s = this.shown.find((x) => x.e === e)
    if (!s) return null
    let dir = o.dir
    if (!dir) {
      const p = s.mesh.position
      const f = o.from ?? { x: p.x, y: p.y + 0.7, z: p.z + 1 }
      const dx = p.x - f.x, dy = p.y + 0.7 - f.y, dz = p.z - f.z
      const l = Math.hypot(dx, dy, dz) || 1
      dir = { x: dx / l, y: dy / l, z: dz / l }
    }
    return this.hitCar(s, { ...o, dir })
  }

  /** The cars within `radius` of a world (x, z), nearest first, at most `max`. World frame; yaw is the site's. */
  carsNear(x: number, z: number, radius: number, max: number): { e: number; x: number; y: number; z: number; yaw: number; speed: number; loose: boolean }[] {
    const r2 = radius * radius
    const out: { d2: number; s: Shown }[] = []
    for (const s of this.shown) {
      if (s.hidden) continue
      const p = s.mesh.position
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2
      if (d2 <= r2) out.push({ d2, s })
    }
    out.sort((a, b) => a.d2 - b.d2)
    return out.slice(0, max).map(({ s }) => ({ e: s.e, x: s.mesh.position.x, y: s.mesh.position.y, z: s.mesh.position.z, yaw: Transform.yaw[s.e], speed: s.wrecked ? 0 : Vehicle.speed[s.e], loose: s.wrecked }))
  }

  /**
   * THE ONE PLACE A CAR IS HIT. Rich, 2026-10-08: a gun round should make a car swerve and a
   * missile should blow it into the sky — "$20 for making a car swerve to $200 for blowing it into
   * the sky" — and a program pays out by which. So a hit is graded, not a switch:
   *
   *   - under TRAFFIC_KNOCK_MS a driven car SWERVES: it is shoved across its lane, brakes, wobbles
   *     back and drives on. No physics needed, so it works on a world with physics off;
   *   - over it the car is KNOCKED LOOSE (`wake`) and thrown — LAUNCHED when the throw leaves it
   *     climbing faster than TRAFFIC_LAUNCH_MS.
   *
   * Every hit dents (a swerve is a scrape) and every hit is reported to `onHit`.
   */
  private hitCar(s: Shown, o: HitOpts): HitEffect | null {
    if (s.hidden || !(o.force > 0)) return null
    const dmg = o.damage ?? Math.min(1, o.force / Math.max(1, T.TRAFFIC_DAMAGE_MS))
    if (dmg > 0) this.dentFrom(s, o.dir, dmg)
    let effect: HitEffect = 'swerve'
    if (!s.wrecked && o.force >= T.TRAFFIC_KNOCK_MS && s.body) this.wake(s, 'impact', o.force * s.massKg)
    if (s.wrecked && s.body) {
      const v = o.kick ?? o.force
      const ly = o.dir.y + (o.lift ?? 0.55)
      const l = Math.hypot(o.dir.x, ly, o.dir.z) || 1
      s.body.kick((o.dir.x / l) * v, (ly / l) * v, (o.dir.z / l) * v, Math.min(4, v * (o.spin ?? 0.35)))
      effect = s.body.state().vy >= T.TRAFFIC_LAUNCH_MS ? 'launched' : 'loose'
    } else {
      // driven, under the knock or with no ground to be loose on: a swerve
      this.swerveCar(s, o.dir, o.force)
    }
    if (this.hitFns.size) {
      const p = s.mesh.position
      const ev: TrafficHitEvent = { e: s.e, effect, force: o.force, weapon: o.weapon ?? 'program', at: { x: p.x, y: p.y, z: p.z } }
      for (const fn of this.hitFns) fn(ev)
    }
    return effect
  }

  /** be told about every hit; returns the unsubscribe */
  onHit(fn: (ev: TrafficHitEvent) => void): () => void {
    this.hitFns.add(fn)
    return () => this.hitFns.delete(fn)
  }

  /**
   * Shove a driven car across its lane. The sideways speed is the hit's component across the car
   * (a shot from behind still picks a side), the car brakes in proportion, and `stepSwerve` springs
   * it back to the lane line — one wobble and it drives on.
   */
  private swerveCar(s: Shown, dir: { x: number; y: number; z: number }, force: number): void {
    const yaw = Transform.yaw[s.e]
    // right of travel in the site frame is (sin, -cos); the world frame's z is -north
    let lat = dir.x * Math.sin(yaw) + dir.z * Math.cos(yaw)
    if (Math.abs(lat) < 0.2) lat = (s.e & 1 ? 1 : -1) * 0.5
    s.swerveV += Math.sign(lat) * Math.min(T.TRAFFIC_SWERVE_VMAX, force * T.TRAFFIC_SWERVE_GAIN * Math.min(1, Math.abs(lat) * 2))
    Vehicle.speed[s.e] *= Math.max(0.35, 1 - force / Math.max(1, 2 * T.TRAFFIC_KNOCK_MS))
  }

  /** advance one car's swerve by `dt`: a damped spring back to the lane line. Returns the offset, m */
  private stepSwerve(s: Shown, dt: number): number {
    if (s.swerve === 0 && s.swerveV === 0) return 0
    const k = T.TRAFFIC_SWERVE_K
    const c = 2 * Math.sqrt(k) * T.TRAFFIC_SWERVE_DAMP
    s.swerveV += (-k * s.swerve - c * s.swerveV) * dt
    s.swerve += s.swerveV * dt
    const max = T.TRAFFIC_SWERVE_MAX_M
    if (s.swerve > max) { s.swerve = max; s.swerveV = Math.min(0, s.swerveV) }
    if (s.swerve < -max) { s.swerve = -max; s.swerveV = Math.max(0, s.swerveV) }
    if (Math.abs(s.swerve) < 1e-3 && Math.abs(s.swerveV) < 1e-3) s.swerve = s.swerveV = 0
    return s.swerve
  }

  /** Dent a car where a hit travelling along `dir` would land on it. `damage` 0…1 */
  private dentFrom(s: Shown, dir: { x: number; y: number; z: number }, damage: number): void {
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1
    const p = s.mesh.position
    // the panel facing the hit: a metre back along the way it came, at door height
    const im = {
      a: null, b: null,
      x: p.x - (dir.x / l) * 1.0, y: p.y + 0.7 - (dir.y / l) * 0.3, z: p.z - (dir.z / l) * 1.0,
      // the normal points out of the panel, back at the shooter; a dent goes in, along the hit
      nx: -dir.x / l, ny: -dir.y / l, nz: -dir.z / l,
      impulse: 800 + Math.max(0, Math.min(1, damage)) * 19_000,
      peak: 0,
    } as unknown as Impact
    if (dentObject(s.mesh, im, false)) this.dentedCars.add(s)
  }

  /**
   * `OnRoad.s` to a place in the world, every step.
   *
   * THE END OF A CHAIN IS A RESPAWN, NOT A WRAP. The first version put a car that ran off the end
   * back at the start, which is a teleport — and on Route 3 the chains are junction to junction,
   * so the start was often twenty metres in front of the player. Rich: "there will be a car just
   * appear out of thin air". Now a car that runs off is put back at the first place along its
   * chain that is `TRAFFIC_RESPAWN_M` from the player and clear of the car already there, at the
   * lane's speed rather than standing still. A chain with no such place (short, and the player is
   * on it) keeps the car hidden until there is one. Turning round would be better and needs the
   * network, which `site.chains()` does not hand over.
   */
  private followRoad = (world: ActorWorld['world'], dt: number) => {
    void world
    this.parked = 0
    for (const s of this.shown) {
      if (s.wrecked) continue
      const e = s.e
      // outside the sim cone: hold the place on the road, step nothing. It is beyond the draw
      // distance, so the freeze is invisible, and the step comes back when the eye does.
      if (!this.inSim(Transform.x[e], Transform.y[e])) continue
      const road = this.roads[OnRoad.chain[e]]
      if (!road) continue
      let at = OnRoad.s[e]
      if (at >= road.length_m || at < 0 || s.hidden) {
        const spot = this.respawnSpot(s, road)
        if (spot === null) { s.hidden = true; this.parked++; continue }
        if (s.hidden) s.hidden = false
        at = spot
        OnRoad.s[e] = at
        Vehicle.speed[e] = SpeedLimit.v[e] * 0.8
        this.respawned++
        const q = road.at(OnRoad.dir[e] ? road.length_m - at : at)
        const px = this.player?.x ?? this.eyeSite.x, py = this.player?.y ?? this.eyeSite.y
        this.respawnMin = Math.min(this.respawnMin, Math.hypot(q.x - px, q.y - py))
      }
      const dir = OnRoad.dir[e]
      // against the chain, the car reads the road backwards
      const along = dir ? road.length_m - at : at
      const p = road.at(along)
      const d = road.dir(along)
      const dx = dir ? -d.x : d.x
      const dy = dir ? -d.y : d.y
      // right of travel is (dy, -dx) in a y-north frame
      const off = laneOffset(OnRoad.lane[e], road.twoWay ? lanesPerDirection(road.lanes) : Math.max(1, Math.round(road.lanes)), road.twoWay)
      // a swerve rides on top of the lane: across it, and the nose turned into the slide
      const sw = this.stepSwerve(s, dt)
      Transform.x[e] = p.x + dy * (off + sw)
      Transform.y[e] = p.y - dx * (off + sw)
      Transform.yaw[e] = Math.atan2(dy, dx) - (sw === 0 ? 0 : Math.atan2(s.swerveV, Math.max(4, Vehicle.speed[e])))
    }
  }

  /**
   * Somewhere on `road` to put a car back: at least `TRAFFIC_RESPAWN_M` from the player (or the
   * camera, when nobody is driving), and with nobody in the same lane within a car's length and
   * a bit. Walks the chain from the start in 15 m steps; null when nowhere on it qualifies.
   */
  private respawnSpot(s: Shown, road: Road): number | null {
    const px = this.player?.x ?? this.eyeSite.x
    const py = this.player?.y ?? this.eyeSite.y
    const far2 = T.TRAFFIC_RESPAWN_M * T.TRAFFIC_RESPAWN_M
    const e = s.e
    const dir = OnRoad.dir[e]
    const chain = OnRoad.chain[e]
    const lane = OnRoad.lane[e]
    const clear = Vehicle.lengthM[e] + 6
    for (let at = 8; at < road.length_m - 8; at += 15) {
      const along = dir ? road.length_m - at : at
      const p = road.at(along)
      if ((p.x - px) ** 2 + (p.y - py) ** 2 < far2) continue
      let taken = false
      for (const o of this.shown) {
        if (o === s || o.hidden) continue
        const f = o.e
        if (OnRoad.chain[f] !== chain || OnRoad.lane[f] !== lane || OnRoad.dir[f] !== dir) continue
        if (Math.abs(OnRoad.s[f] - at) < clear) { taken = true; break }
      }
      if (!taken) return at
    }
    return null
  }

  /**
   * A wreck is a leader while it is IN its lane. Once the solver has thrown it somewhere else it
   * is scenery, and the drivers behind its old place should not queue for a car that is in a
   * field. Every half second, each wreck is re-projected on to its chain near where it was: still
   * within a lane's width of the lane line, `OnRoad.s` follows it; further than that, it leaves
   * the road (`chain` = `OFF_ROAD`) until it is recycled.
   */
  private reprojectWrecks(): void {
    for (const s of this.shown) {
      if (!s.wrecked) continue
      const e = s.e
      const chain = OnRoad.chain[e]
      const road = this.roads[chain]
      if (!road) continue
      const dir = OnRoad.dir[e]
      const off = laneOffset(OnRoad.lane[e], road.twoWay ? lanesPerDirection(road.lanes) : Math.max(1, Math.round(road.lanes)), road.twoWay)
      const wx = Transform.x[e]
      const wy = Transform.y[e]
      let best = Infinity
      let bestS = OnRoad.s[e]
      const s0 = OnRoad.s[e]
      for (let at = s0 - 40; at <= s0 + 40; at += 2.5) {
        if (at < 0 || at > road.length_m) continue
        const along = dir ? road.length_m - at : at
        const p = road.at(along)
        const d = road.dir(along)
        const dx = dir ? -d.x : d.x
        const dy = dir ? -d.y : d.y
        const lx = p.x + dy * off
        const ly = p.y - dx * off
        const d2 = (lx - wx) ** 2 + (ly - wy) ** 2
        if (d2 < best) { best = d2; bestS = at }
      }
      if (best < 2.6 * 2.6) OnRoad.s[e] = bestS
      else OnRoad.chain[e] = OFF_ROAD
    }
  }
  private sinceReproject = 0

  /** what the last frame cost, ms, by part — for the perf panel and the bridge */
  readonly stats = { actorsMs: 0, placeMs: 0, steps: 0, systems: {} as Record<string, number>, dents: 0, dentsReleased: 0, impacts: 0 }
  /** 0 day, 1 full night. Beams are only drawn on the nearest handful of cars. */
  night = 0
  setNight(n: number): void {
    this.night = n
  }

  /**
   * Rebuild the simulation footprint from the eye's motion: the same morphing cone the grass uses
   * (GRASS_CONE_*), with the traffic's own `TRAFFIC_SIM_*` dials. Called once a frame, before the
   * fixed steps, so every step of a catch-up burst culls against the same shape.
   *
   * The heading is taken from the PLAYER's velocity when there is one, not the eye's, because the
   * chase camera lags, swings and orbits and a cone aimed down the camera's look would drop the
   * lane the car is actually driving into. With nobody driving (flying the orbit camera) the eye's
   * own motion is the only heading there is.
   */
  private updateSimCone(dt: number, eye: THREE.Vector3): void {
    const x = eye.x
    const y = -eye.z
    const step = Math.min(0.2, Math.max(1e-3, dt))
    let speed = 0
    let fx = this.simFx
    let fy = this.simFy
    const p = this.player
    if (p) {
      speed = Math.hypot(p.vx, p.vy)
      if (speed > 0.3) { fx = p.vx / speed; fy = p.vy / speed }
    } else if (Number.isFinite(this.prevEyeX)) {
      const ex = x - this.prevEyeX
      const ey = y - this.prevEyeY
      speed = Math.hypot(ex, ey) / step
      if (speed > 0.3) { fx = ex / (speed * step); fy = ey / (speed * step) }
    }
    this.prevEyeX = x
    this.prevEyeY = y
    this.simX = x
    this.simY = y
    this.simFx = fx
    this.simFy = fy
    this.simSpeedFrac = THREE.MathUtils.smoothstep(speed, T.TRAFFIC_SIM_CONE_SPEED - Math.max(0.1, T.TRAFFIC_SIM_FADE), Math.max(0.2, T.TRAFFIC_SIM_CONE_SPEED))
    this.simTightenFrac = T.TRAFFIC_SIM_TIGHTEN_SPEED > T.TRAFFIC_SIM_CONE_SPEED
      ? THREE.MathUtils.smoothstep(speed, T.TRAFFIC_SIM_CONE_SPEED, T.TRAFFIC_SIM_TIGHTEN_SPEED)
      : 0
    const reachFrac = THREE.MathUtils.smoothstep(speed, Math.max(0.2, T.TRAFFIC_SIM_REACH_SPEED - Math.max(0.1, T.TRAFFIC_SIM_REACH_FADE)), Math.max(0.4, T.TRAFFIC_SIM_REACH_SPEED))
    this.simConeDeg =
      T.TRAFFIC_SIM_STILL_DEG +
      (T.TRAFFIC_SIM_CONE_DEG - T.TRAFFIC_SIM_STILL_DEG) * this.simSpeedFrac +
      (T.TRAFFIC_SIM_CONE_DEG_VMAX - T.TRAFFIC_SIM_CONE_DEG) * this.simTightenFrac
    this.simReachM = T.TRAFFIC_SIM_RADIUS * (1 + (T.TRAFFIC_SIM_REACH - 1) * reachFrac)
    this.simConeCos = this.simConeDeg >= 179.5 ? -1 : Math.cos(Math.min(Math.PI, ((this.simConeDeg + T.TRAFFIC_SIM_FEATHER) * Math.PI) / 180))
    this.simNear2 = T.TRAFFIC_SIM_NEAR * T.TRAFFIC_SIM_NEAR
    this.simReach2 = this.simReachM * this.simReachM
  }

  /** Is this car inside the simulation footprint? Everything else holds its place on the road. */
  private inSim(x: number, y: number): boolean {
    const dx = x - this.simX
    const dy = y - this.simY
    const d2 = dx * dx + dy * dy
    if (d2 <= this.simNear2) return true
    if (d2 > this.simReach2) return false
    if (this.simConeCos <= -1) return true
    const d = Math.sqrt(d2)
    return (dx * this.simFx + dy * this.simFy) / d >= this.simConeCos
  }

  /**
   * LET GO OF DENTS NOBODY CAN SEE. A dented car keeps a private copy of its geometry, and with a
   * four-thousand-car level and an armed player that copy was made for every car ever touched and
   * never given back — the DC metro tab passed 5 GB (Rich, 2026-10-07). A dent on a car beyond
   * `TRAFFIC_DENTS_KEEP_M` from the eye, or hidden for a respawn, is invisible: release it. Past
   * `TRAFFIC_DENTS_MAX` the farthest go too, so a pile-up at the player's feet is bounded as well.
   * A released car is whole again when it next comes into view, which reads as the body shop.
   */
  private sweepDents(): void {
    const ex = this.eyeSite.x
    const ey = this.eyeSite.y
    const keep2 = T.TRAFFIC_DENTS_KEEP_M * T.TRAFFIC_DENTS_KEEP_M
    const near: { s: Shown; d2: number }[] = []
    for (const s of this.dentedCars) {
      const dx = s.mesh.position.x - ex
      const dy = -s.mesh.position.z - ey
      const d2 = dx * dx + dy * dy
      if (s.hidden || d2 > keep2) {
        releaseObject(s.mesh)
        this.dentedCars.delete(s)
        this.stats.dentsReleased++
      } else near.push({ s, d2 })
    }
    const max = Math.max(0, Math.round(T.TRAFFIC_DENTS_MAX))
    if (near.length <= max) return
    near.sort((a, b) => b.d2 - a.d2)
    for (let i = 0; i < near.length - max; i++) {
      releaseObject(near[i].s.mesh)
      this.dentedCars.delete(near[i].s)
      this.stats.dentsReleased++
    }
  }

  /** cars wearing a dent clone right now — a probe reads it */
  get dented(): number {
    return this.dentedCars.size
  }

  /** Step the simulation and put every car where it now is. */
  tick(dt: number, eye: THREE.Vector3): void {
    if (!this.built) return
    // the TRAFFIC_DENSITY knob, applied on a throttle: a drag re-plans a few times a second, not per frame
    if (this.pendingDensity !== this.worldDensity && performance.now() - this.densityAt > 200) {
      this.densityAt = performance.now()
      this.worldDensity = this.pendingDensity
      this.rebuildZones()
      this.reseed()
    }
    const t0 = performance.now()
    this.eyeSite.x = eye.x
    this.eyeSite.y = -eye.z
    // the footprint first: the steps below cull against it, so a catch-up burst all uses one shape
    this.updateSimCone(dt, eye)
    let inside = 0
    for (const s of this.shown) if (this.inSim(Transform.x[s.e], Transform.y[s.e])) inside++
    this.simCars = inside
    this.sinceReproject += dt
    this.sinceDentSweep += dt
    if (this.dentedCars.size && this.sinceDentSweep > 0.5) { this.sinceDentSweep = 0; this.sweepDents() }
    if (this.wrecked && this.sinceReproject > 0.5) { this.sinceReproject = 0; this.reprojectWrecks() }
    this.stats.steps = this.actors.tick(dt)
    const t1 = performance.now()
    this.place(false, eye)
    this.stats.actorsMs = t1 - t0
    this.stats.placeMs = performance.now() - t1
    this.stats.systems = { ...this.actors.stats.systems }
  }

  /**
   * IN THE GRAPH ONLY WHILE IT CAN BE SEEN. three walks every object under the scene on every
   * render call — `updateMatrixWorld` visits a hidden object exactly as it does a visible one — and
   * a car is ~16 objects with its lamps. On the DC Beltway's 4,000 cars that walk was 64,000
   * objects and 5.9 ms a render, twice a frame (the view and a probe face), for the four cars on
   * screen (Rich, 2026-10-08: "21 ms of CPU … on an empty scene we are 2-4 ms"). So a car out of
   * draw range, or hidden for a respawn, is taken OUT of the group, not just made invisible, and put
   * back when it is near again. Nothing reads a far car's world matrix: hits, dents and the sweep
   * all go by `mesh.position`.
   */
  private attach(s: Shown, on: boolean): void {
    if (on) { if (s.mesh.parent !== this.group) this.group.add(s.mesh) }
    else if (s.mesh.parent) s.mesh.removeFromParent()
  }

  private place(all: boolean, eye?: THREE.Vector3): void {
    const drawM = T.TRAFFIC_DRAW_M
    const glow: { s: Shown; d2: number }[] = []
    for (const s of this.shown) {
      const e = s.e
      if (s.wrecked && s.body) {
        // a loose body: the mesh follows the solver, and the entity follows the mesh
        const q = s.body.pose()
        this.attach(s, true)
        s.mesh.visible = true
        s.lamps.visible = false
        s.mesh.position.set(q.x, q.y, q.z)
        s.mesh.quaternion.set(q.qx, q.qy, q.qz, q.qw)
        Transform.x[e] = q.x
        Transform.y[e] = -q.z
        Transform.z[e] = q.y
        continue
      }
      if (s.hidden) { this.attach(s, false); s.lamps.visible = false; continue }
      const x = Transform.x[e]
      const y = Transform.y[e]
      const yaw = Transform.yaw[e]
      // three: x east, y up, z south — the site's y is north
      const near = all || !eye || (eye.x - x) ** 2 + (eye.z + y) ** 2 < drawM * drawM
      // a far car costs nothing once it is out: detach, lamps off and body off happen on the way out,
      // not every frame (4,000 wasm `enable` calls a frame were most of `placeMs`)
      if (!near) {
        if (s.mesh.parent) { this.attach(s, false); s.lamps.visible = false; s.body?.enable(false) }
        continue
      }
      const g = this.site.groundAt(x, -y) ?? this.site.heightAt(x, y) ?? 0
      Transform.z[e] = g
      this.attach(s, true)
      s.mesh.visible = true
      s.mesh.position.set(x, g, -y)
      // the model's nose is +X; three's rotation about +Y takes +X toward -Z, which is NORTH here
      s.mesh.rotation.set(0, yaw, 0)
      const dist2 = eye ? (eye.x - x) ** 2 + (eye.z + y) ** 2 : 0
      // bulbs on anything close enough to read; the spots are spent afterwards, nearest first
      const showLamps = this.night > 0.08 && dist2 < 80 * 80
      s.lamps.visible = showLamps
      if (showLamps) glow.push({ s, d2: dist2 })
      if (s.body) {
        // a body only near the player: the rest of the solver's work on a kinematic car is a
        // broad-phase update a step, and there were six hundred of them
        const physM = T.TRAFFIC_PHYS_M
        const near = !eye || (eye.x - x) ** 2 + (eye.z + y) ** 2 < physM * physM
        s.body.enable(near)
        if (near) s.body.move(x, g, -y, -yaw)
      }
    }
    this.lightCars(glow)
  }

  /**
   * Switch on the nearest cars' beams, and leave the rest as bulbs.
   *
   * Every visible spot lands in the standard shader, so a jam of pairs would be dozens of lights
   * on every road fragment. Twelve is about what the old single centre beam was spending, now
   * split across headlights and the red tails. A car is lit whole or not at all — half a pair
   * is the one-headlight bug again.
   */
  private lightCars(glow: { s: Shown; d2: number }[]): void {
    glow.sort((a, b) => a.d2 - b.d2)
    // mode 1 = real spot lights (budgeted); mode 2 = fake, so no real spots at all (the flood in
    // main.ts picks them up); mode 0 = off. Only mode 1 can put a light in three's forward loop.
    const real = Math.round(T.TRAFFIC_LIGHTS_MODE) === 1
    let budget = Math.max(0, Math.round(T.TRAFFIC_LIGHTS))
    const night = this.night
    // Same knob as the pool on the road, three times brighter on the lamp itself.
    const lens = (T.TAILLIGHT / 0.025) * 3 * night
    TAIL_BULB_MAT.color.setRGB(0.35 * lens, 0.045 * lens, 0.03 * lens)
    for (const { s } of glow) {
      const rig = s.lamps.userData.lamps as LampRig | undefined
      const heads = rig?.heads ?? []
      const tails = rig?.tails ?? []
      const need = heads.length + tails.length
      const on = need > 0 && need <= budget
      if (on) budget -= need
      // `visible`, not just intensity: an intensity-0 light still sits in the forward shader's light
      // loop and costs ground shading, so the daytime must remove it, not dim it (measured 2026-10-04).
      const lit = real && on && night > 0.02
      for (const spot of heads) {
        spot.visible = lit && T.HEADLIGHT > 0.001
        spot.intensity = lit ? 9 * night * T.HEADLIGHT : 0
      }
      for (const spot of tails) {
        spot.visible = lit && T.TAILLIGHT > 0.001
        spot.intensity = lit ? 9 * night * T.TAILLIGHT : 0
        spot.distance = T.TAILLIGHT_RANGE
        spot.angle = T.TAILLIGHT_ANGLE
        spot.target.position.x = spot.position.x - Math.max(1.2, T.TAILLIGHT_RANGE * 0.65)
        spot.target.position.y = 0.05
      }
    }
  }

  /**
   * Fill the analytic flood with the nearest cars' lamps (TRAFFIC_LIGHTS_MODE 2).
   *
   * The fake counterpart of `lightCars`: no real spots at all, just positions handed to the pool
   * every material on the fast path reads. The rig spots exist either way, so this reads their
   * world transform exactly as `fillWet` does. Nearest-first up to `limit` lamps; the pool drops
   * any overflow itself.
   */
  feedFlood(
    pool: { count: number; add(pos: THREE.Vector3, dir: THREE.Vector3, r: number, g: number, b: number, range: number, angle: number): void },
    eye: THREE.Vector3,
    limit: number,
  ): void {
    if (this.night < 0.08) return
    const cand: { d2: number; spot: THREE.SpotLight; tail: boolean }[] = []
    for (const s of this.shown) {
      if (!s.lamps.visible) continue
      const rig = s.lamps.userData.lamps as LampRig | undefined
      if (!rig) continue
      const d2 = (s.mesh.position.x - eye.x) ** 2 + (s.mesh.position.z - eye.z) ** 2
      if (d2 > 80 * 80) continue
      for (const spot of rig.heads) cand.push({ d2, spot, tail: false })
      for (const spot of rig.tails) cand.push({ d2, spot, tail: true })
    }
    cand.sort((a, b) => a.d2 - b.d2)
    const p = new THREE.Vector3()
    const aim = new THREE.Vector3()
    const headAngle = Math.min(1.45, T.HEADLIGHT_ANGLE * T.RETRO_SPREAD)
    for (const c of cand) {
      if (pool.count >= limit) break
      c.spot.getWorldPosition(p)
      c.spot.target.getWorldPosition(aim)
      aim.sub(p)
      aim.y = 0
      if (aim.lengthSq() < 1e-8) aim.set(1, 0, 0)
      else aim.normalize()
      const gain = c.tail ? T.TAILLIGHT / 0.025 : T.HEADLIGHT / 2.7
      if (gain < 0.02) continue
      if (c.tail) pool.add(p, aim, 1 * gain, 0.06 * gain, 0.03 * gain, T.TAILLIGHT_RANGE, T.TAILLIGHT_ANGLE)
      else pool.add(p, aim, 1 * gain, 0.93 * gain, 0.72 * gain, T.HEADLIGHT_RANGE, headAngle)
    }
  }

  /**
   * Lamps that are on, nearest first, for the wet-road streaks.
   * Fills `into` up to `limit`. The pool on the road stays the spot; this is only the mirror line.
   */
  fillWet(into: { x: number; y: number; z: number; dx: number; dz: number; r: number; g: number; b: number; gain: number }[], limit: number, eye: THREE.Vector3): void {
    if (into.length >= limit || this.night < 0.08) return
    const cand: { d2: number; spot: THREE.SpotLight; tail: boolean }[] = []
    for (const s of this.shown) {
      if (!s.lamps.visible) continue
      const rig = s.lamps.userData.lamps as LampRig | undefined
      if (!rig) continue
      const d2 = (s.mesh.position.x - eye.x) ** 2 + (s.mesh.position.z - eye.z) ** 2
      if (d2 > 80 * 80) continue
      for (const spot of rig.heads) if (spot.visible) cand.push({ d2, spot, tail: false })
      for (const spot of rig.tails) if (spot.visible) cand.push({ d2, spot, tail: true })
    }
    cand.sort((a, b) => a.d2 - b.d2)
    const p = new THREE.Vector3()
    const aim = new THREE.Vector3()
    for (const c of cand) {
      if (into.length >= limit) break
      c.spot.getWorldPosition(p)
      c.spot.target.getWorldPosition(aim)
      aim.sub(p)
      aim.y = 0
      if (aim.lengthSq() < 1e-8) aim.set(1, 0, 0)
      else aim.normalize()
      const gain = c.tail ? T.TAILLIGHT / 0.025 : T.HEADLIGHT / 2.7
      if (gain < 0.02) continue
      into.push({
        x: p.x, y: p.y, z: p.z,
        dx: aim.x, dz: aim.z,
        r: c.tail ? 1 : 1, g: c.tail ? 0.06 : 0.93, b: c.tail ? 0.03 : 0.72,
        gain,
      })
    }
  }

  /**
   * One car as the simulation sees it, by index — for a probe. THROUGH THE LAYER, not through a
   * dynamic import of `traffic.ts`: after an HMR update the page's copy of that module is
   * `/src/game/traffic.ts?t=…` and a probe's `import('/src/game/traffic.ts')` is a second instance with its
   * own empty component arrays (the tuning-knob trap again).
   */
  view(i: number) {
    const s = this.shown[i]
    if (!s) return null
    const e = s.e
    const w = this.actors.world
    return {
      e, x: Transform.x[e], y: Transform.y[e], yaw: Transform.yaw[e], chain: OnRoad.chain[e], s: OnRoad.s[e], lane: OnRoad.lane[e], dir: OnRoad.dir[e],
      speed: Vehicle.speed[e], length: Vehicle.lengthM[e], limit: SpeedLimit.v[e], driven: hasComponent(w, e, DriverC), gap: DriverC.gap[e], leader: DriverC.leader[e] ? this.shown.findIndex((o) => o.e === DriverC.leader[e] - 1) : -1,
      wrecked: s.wrecked, hidden: s.hidden, visible: s.mesh.visible,
    }
  }

  /** the solver's view of one car's body, by index, for a probe */
  bodyState(i: number) {
    return this.shown[i]?.body?.state() ?? null
  }

  /** which cars (by index in `entities`/the group) have been knocked loose, for a probe */
  wreckedIds(): number[] {
    return this.shown.map((s, i) => (s.wrecked ? i : -1)).filter((i) => i >= 0)
  }

  /** The cars as the program sees them: entity ids, for `api.actors` queries. */
  get entities(): number[] {
    return this.shown.map((s) => s.e)
  }

  dispose(): void {
    this.offImpact?.()
    this.offImpact = null
    for (const s of this.shown) {
      s.body?.free()
      releaseObject(s.mesh)
      s.mesh.removeFromParent()
    }
    this.dentedCars.clear()
    this.shown = []
    this.wrecks = []
    this.byCollider.clear()
    this.wrecked = 0
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
