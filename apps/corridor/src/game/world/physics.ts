// The corridor's physics world: one owner, bound to the site the renderer is already drawing.
//
// docs/corridor/PLAN-PHYSICS.md §2. The engine module (`@apex/engine/physics/*`) knows nothing
// about this app; this file is the whole of what the two know about each other, and it is
// deliberately small.
//
// THE ONE IMPORTANT LINE IS `new Terrain(phys, site.groundAt)`.
//
// `groundAt` is the height function the strip, the grass, the furniture, the buildings and the car
// already stand on — this app's oldest rule is "one surface, one height function", and every bug of
// the form "green stuff on the road" or "the car shakes" has been two meshes modelling the same
// ground at different samplings. Handing the physics the FUNCTION rather than the renderer's mesh
// means the surface the wheels stand on and the surface you can see are the same surface by
// construction, and there is no second sampling that can drift. It also inherits terrain
// exaggeration for free: `relief` is applied to every absolute height at load, so `groundAt` is
// already exaggerated and so, therefore, is the ground the car drives on.
//
// LAZY, AND OFF BY DEFAULT. Rapier's `-compat` build inlines its wasm as base64 — 4.3 MB — so it is
// behind a dynamic import inside `loadRapier()` and behind `PHYS_ENABLED`. A session that never
// turns physics on never downloads it, which matters because this app already loads a city.
//
// WHAT IS NOT HERE YET: the car, the static props, the breakables, the traffic bodies. Step 1 of the
// plan is the ground and nothing else, because the ground is the thing every other piece stands on
// and because "does the physics agree with what I can see" is a question worth answering before
// there is anything else to blame. `probes/corridor-physground.mjs` answers it.
import * as THREE from 'three'
import { loadRapier, rapier } from '@apex/engine/physics/rapier'
import { QUERY } from '@apex/engine/physics/layers'
import { PROFILES, profile, type DriveProfile } from '@apex/engine/physics/profiles'
import { Breakables, explode as blastWorld, type Blast, type BreakEvent } from '@apex/engine/physics/destruction'
import type { Impact } from '@apex/engine/physics/world'
import { addStatic, addSurface, addTree, Terrain } from '@apex/engine/physics/terrain'
import { Vehicle } from '@apex/engine/physics/vehicle'
import { PhysicsWorld } from '@apex/engine/physics/world'
import type { Site } from '../../world/scene'
import { toDriveProfile, toVehicleSpec, type VehicleDoc } from '../vehicle/vehicles'
import { catalogue, detachInstance, detachedOffset, type PropRecord } from './worldbodies'
import * as T from '../../tuning'

export interface CorridorPhysics {
  readonly phys: PhysicsWorld
  readonly terrain: Terrain
  /**
   * Once a frame, with the eye and the real delta.
   *
   * Tiles are built here and NOT inside the physics step: building one is `cells²` calls into the
   * site's height function, which walks the station grid and may pump the lazy grading, and that
   * has no business happening between two integrations.
   */
  update(eye: THREE.Vector3, dt: number): void
  /**
   * The ground the PHYSICS thinks is there at a world x, z — by casting a ray down at it, which is
   * the only honest way to ask (the heightfield interpolates between samples, so reading the
   * sampler back would only prove the sampler agrees with itself).
   *
   * Null where no tile has been built, which is not the same as "no ground": a caller wanting to
   * know whether the two surfaces agree must ask `site.groundAt` too and compare only where both
   * answer.
   */
  groundUnder(x: number, z: number): number | null
  /**
   * Put a car on the ground at a world x, z, facing `yaw`.
   *
   * The surface hook is wired here rather than by the caller, because "what is pavement" is the
   * site's question and `edgeDistance` is its answer — a caller that had to remember to attach it
   * would sooner or later not, and the symptom is a car with tarmac grip on grass, which feels like
   * a tyre model problem rather than a missing line.
   *
   * It does NOT build a mesh or drive a camera. Swapping `car.ts` out is the next step of
   * PLAN-PHYSICS; this is the half that can be driven headlessly and measured, which is the half
   * worth having first.
   */
  /**
   * Put a car on the ground.
   *
   * `doc` is the vehicle document off the ASSET (`AssetItem.vehicle`, schema in `vehicles.ts`) — the
   * mass, wheelbase, track, CG height, gearing and brakes that are facts about that car. `profileId`
   * is the LEVEL's choice of game. They layer, and the order is the point:
   *
   *   the profile decides how the game feels        `yawAssist`, grip, the assists
   *   the document decides what the car is          power, gearing, top speed, brakes, mass, CG
   *
   * So the same hatchback is a hatchback in `sim` and in `taxi`, and swapping the level's profile
   * does not quietly give it somebody else's engine. Without a `doc` it is the engine's default
   * chassis, which is what every level built before today gets.
   */
  spawnCar(at: { x: number; z: number; yaw?: number }, profileId?: string, doc?: VehicleDoc): Vehicle
  /**
   * A body the simulation MOVES rather than the solver: a traffic car.
   *
   * Kinematic, position-based — Rapier reads where it was put each step and works out the
   * velocity, so a player who hits one is hit back with the momentum a moving car has, and the
   * traffic model keeps driving it without knowing physics exists. `move` takes the car's floor
   * point and heading in three's frame; the box is lifted by half its height to sit on it.
   */
  spawnKinematic(half: { x: number; y: number; z: number }): TrafficBody
  /**
   * A blast: everything dynamic within `radius` is thrown away from it, scaled by its mass
   * (`impulse` is metres per second at the centre), breakables break. A KINEMATIC traffic car is
   * not moved by this — wake it first (`TrafficLayer.wakeNear`), which `main.ts` does.
   */
  explode(at: { x: number; y: number; z: number }, opts: { radius: number; impulse: number; lift?: number; breakAt?: number; exclude?: number }): number
  /** every impact the world reports, for whoever wants to dent, wake or score on it */
  onImpact(fn: (im: Impact) => void): () => void
  /** the first solid thing along a ray, as a distance, or null; `exclude` is a collider handle to look past */
  rayHit(from: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxM: number, exclude?: number): number | null
  /**
   * The first solid thing a ball of `radius` sweeps into along a direction, as a distance, or
   * null. A missile is not a line: a ray a metre from a car's flank misses it, a ball does not.
   */
  sweepHit(from: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxM: number, radius: number, exclude?: number): number | null
  /**
   * The breakables register, for whatever the game wants to knock down.
   *
   * Empty until something registers with it — trees deliberately are NOT in it. A mature trunk
   * should end your run, not fold over, and that is a design decision rather than an omission.
   */
  readonly breakables: Breakables
  onBreak(fn: (e: BreakEvent) => void): () => void
  /**
   * The nearest catalogued prop whose kind contains one of `include` and none of `exclude`.
   *
   * For a probe that wants to drive at a sign rather than at whatever happens to be closest, and for
   * the editor, which will want "show me the nearest thing of this sort" sooner or later.
   */
  nearestProp(x: number, z: number, include?: string[], exclude?: string[]): PropRecord | null
  /**
   * What everything weighs, by kind: the answer to "did the geometry give sensible masses".
   *
   * A summary rather than the list, because the list is thousands long and the question is always
   * "is anything absurd" — a 0 kg sign or a four-tonne one.
   */
  /**
   * Give a stunt fixture a surface you can actually drive on.
   *
   * Rich, 2026-09-29: *"the stunts are not drivable yet, we need to make them into actual roads"*.
   * The heightfield cannot carry one — it is one height per column and a loop is above itself — so
   * a fixture's road is a TRIMESH, which is the only shape that can be its own ceiling.
   *
   * Idempotent per id: calling it again with a moved fixture replaces the old collider, so the
   * editor can drag one about without leaving invisible walls behind it.
   */
  setStuntSurface(id: string, positions: Float32Array, indices: Uint32Array): void
  /** Take one away — the fixture was deleted. */
  clearStuntSurface(id: string): void
  /** How many fixtures currently have a collider, for a readout and for a probe. */
  stuntSurfaces(): string[]
  propMasses(): Record<string, { count: number; min: number; max: number; mean: number; breakable: boolean }>
  /** what has come off and where it is now — the renderer half, for a probe to check end to end */
  detachedProps(): { kind: string; x: number; y: number; z: number }[]
  stats(): PhysicsStats
  free(): void
}

/** A traffic car's body: moved along the road while it drives, a loose body once it is hit. */
export interface TrafficBody {
  /** the collider's handle — the Collider itself would type as the repo root's Rapier, not the engine's */
  readonly colliderHandle: number
  /** true once `wake` has made it dynamic */
  readonly loose: boolean
  move: (x: number, y: number, z: number, yaw: number) => void
  wake: (massKg: number) => void
  /** back on rails: kinematic again, still, undamaged as far as the solver knows */
  rest: () => void
  /** in or out of the solver. A car 600 m away costs a broad-phase update a step for nothing */
  enable: (on: boolean) => void
  /** the floor point and rotation, for a mesh that follows a loose body */
  pose: () => { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }
  /** what the solver thinks of it, for a probe */
  state: () => { dynamic: boolean; mass: number; vx: number; vy: number; vz: number }
  /**
   * Add to its velocity, m/s, with a tumble. A VELOCITY, not an impulse: Rapier recomputes a
   * body's mass on the next step, so an impulse in the step that woke it is divided by whatever
   * mass it had as a kinematic — measured, a 1500 kg car left a blast at under a metre a second.
   */
  kick: (dvx: number, dvy: number, dvz: number, spin?: number) => void
  free: () => void
}

export interface PhysicsStats {
  on: boolean
  hz: number
  /** fixed steps run since the world was made, and what the last frame's stepping cost */
  steps: number
  stepMs: number
  /** steps thrown away because a stall exceeded the cap — a non-zero here explains a jump */
  dropped: number
  bodies: number
  colliders: number
  impacts: number
  /** heightfield tiles alive, and what the last `update` did */
  tiles: number
  built: number
  skipped: number
  /** static prop colliders standing near the player right now */
  trees: number
  /** signs, masts, poles, fences and houses standing near the player */
  props: number
  /** how many props the site has altogether, and how many have come off */
  catalogued: number
  broken: number
  /** merged batches skipped because a box around one is a wall across a neighbourhood */
  merged: number
  /** milliseconds the last tile build cost, which is the one cost this file can hitch a frame with */
  buildMs: number
}

const DOWN = { x: 0, y: -1, z: 0 }

/**
 * Build the physics world for a site.
 *
 * Returns null when physics is off, rather than an object whose methods do nothing: a caller
 * holding a live-looking physics world that is not simulating is exactly how "the car falls through
 * the floor" becomes a thirty-minute question.
 *
 * `enabled` overrides the knob, and exists because `PHYS_ENABLED` is read once, when the site is
 * built. A knob that only takes effect on the next load needs a way to be set BEFORE a load, and
 * the F6 panel is not it — measured: `tune.set` moves the live value and persists nothing, so
 * setting the knob and reloading comes back to the default and the physics never starts. `?phys=1`
 * is that way, and it matches how `relief`, `season` and `level` are already chosen.
 */
export async function buildPhysics(site: Site, opts: { enabled?: boolean } = {}): Promise<CorridorPhysics | null> {
  if (!(opts.enabled ?? T.PHYS_ENABLED > 0)) return null
  await loadRapier()

  const phys = new PhysicsWorld({
    hz: T.PHYS_HZ,
    maxSteps: T.PHYS_MAX_STEPS,
    budgetMs: T.PHYS_STEP_BUDGET_MS,
    solverIterations: T.PHYS_ITERATIONS,
    impactThreshold: T.PHYS_IMPACT_N,
  })
  const terrain = new Terrain(phys, site.physGroundAt, {
    tile: T.PHYS_TILE_M,
    cells: T.PHYS_TILE_CELLS,
    radius: T.PHYS_RADIUS_M,
    // A corridor bake is a ribbon: most of a tile grid over it is off the data, and a tile that is
    // a quarter ground is still worth a collider because the quarter is the road. Lower than the
    // engine's own default for that reason.
    minCoverage: 0.15,
    friction: T.PHYS_GROUND_FRICTION,
  })

  const R = rapier()
  const breakables = new Breakables(phys)
  let buildMs = 0

  /*
   * THE TRUNKS YOU CAN HIT.
   *
   * The hand-written car has collided with trees since the beginning — a circle against a trunk,
   * pushed out, keeping a share of the speed reversed — and a car on Rapier that drove straight
   * through them would be a step backwards however good the suspension was.
   *
   * STREAMED, like everything else near the eye. `site.treesNear` is a grid lookup over the tree
   * records in world metres, so asking for everything within a radius is cheap; what is NOT cheap is
   * a fixed body per trunk over a whole site, so they come and go with the player and there is a
   * ceiling on how many may stand at once.
   *
   * NOT BREAKABLE. A cylinder, not a capsule — a capsule's rounded base lets a car ride up the foot
   * of a tree, which reads as the tree being made of jelly — and not registered with `breakables`,
   * because hitting a mature trunk at speed should end your run.
   */
  /*
   * `ReturnType<typeof addTree>` RATHER THAN NAMING RAPIER'S TYPE, and this is not style.
   *
   * There are two copies of `@dimforge/rapier3d-compat` in this repo: 0.21 under
   * `packages/engine/node_modules`, which the engine uses, and 0.12 at the root, which `@types/three`
   * drags in. An `import('@dimforge/rapier3d-compat').Collider` written HERE resolves to the root's
   * 0.12 and is a DIFFERENT TYPE from the one the engine hands back — tsc says "types have separate
   * declarations of a private property", which is the good outcome. The bad outcome is the same
   * mistake at runtime: handles from one wasm heap passed to the other.
   *
   * The engine's README says nothing outside `packages/engine/src/physics/` may name that package.
   * This line is what obeying it looks like.
   */
  const trees = new Map<string, { collider: ReturnType<typeof addTree>; x: number; z: number }>()
  let treesAt = { x: Infinity, z: Infinity }

  function refreshTrees(x: number, z: number) {
    const radius = T.PHYS_PROP_RADIUS_M
    if (T.PHYS_TREES <= 0) {
      if (trees.size) { for (const t of trees.values()) phys.world.removeRigidBody(t.collider.parent()!) ; trees.clear() }
      return
    }
    // Only when the eye has actually moved. A grid query per frame is affordable; building and
    // destroying a few hundred bodies per frame is not, and nothing has changed in between.
    if (Math.hypot(x - treesAt.x, z - treesAt.z) < radius * 0.25) return
    treesAt = { x, z }

    const near = site.treesNear(x, z, radius)
    // nearest first, so the budget is spent on the trunks that can actually be hit next
    near.sort((a, b) => Math.hypot(a[0] - x, a[1] - z) - Math.hypot(b[0] - x, b[1] - z))
    const want = new Set<string>()
    for (const [tx, tz, r] of near.slice(0, T.PHYS_TREE_BUDGET)) {
      const key = `${tx.toFixed(2)},${tz.toFixed(2)}`
      want.add(key)
      if (trees.has(key)) continue
      const g = site.groundAt(tx, tz)
      if (g === null) continue
      // `canopyAt` is in the SITE frame — x east, y NORTH — and this is the world frame, where north
      // is -z. Passing `z` straight in samples the canopy mirrored across the road, which puts tall
      // trunks where the tall trees are not.
      const h = Math.max(3, site.canopyAt(tx, -tz))
      trees.set(key, { collider: addTree(phys, tx, g, tz, Math.max(0.08, r), h), x: tx, z: tz })
    }
    for (const [key, t] of trees) {
      if (want.has(key)) continue
      // hysteresis, same as the terrain's: a trunk is dropped once it is well outside, so driving
      // back and forth past one does not rebuild it every frame
      if (Math.hypot(t.x - x, t.z - z) < radius * 1.3) continue
      const body = t.collider.parent()
      if (body) phys.world.removeRigidBody(body)
      trees.delete(key)
    }
  }

  /*
   * EVERYTHING ELSE YOU CAN HIT — signs, signal masts, power poles, fences, houses.
   *
   * Catalogued once (`worldbodies.ts` walks the built scene and the manifest) and streamed from that
   * list the way the trunks are. A record carries its own mass, worked out from its geometry, and
   * the impulse that detaches it; a sign that comes off becomes a dynamic body AND leaves its
   * instance buffer for a standalone mesh, or it would topple invisibly.
   */
  /**
   * Is this point on a stunt fixture's drivable surface?
   *
   * The same footprints the site is told to clear of scenery — a fixture registers them when it
   * builds — so there is one answer to "is there a fixture here" rather than two that can drift.
   */
  const onStuntSurface = (x: number, z: number): boolean => site.sceneryCleared(x, -z)

  let props: PropRecord[] | null = null
  /**
   * The props that may have colliders — everything the world placed, less whatever is standing
   * inside a stunt fixture.
   *
   * FENCE POSTS, POLES, MAILBOXES AND SIGNS ALL GET COLLIDERS, and not one of them is touched by an
   * area's tree density — so a loop dropped along a fence line has a row of invisible posts inside
   * it, each a vertical face that stops a car dead at any speed. The road is already suppressed
   * under a fixture and now so is everything growing or standing there.
   *
   * Three callers asked for this list and each built it for itself; they now share one, which is
   * how the filter can be in a single place.
   */
  const propList = (): PropRecord[] =>
    catalogue(site, { max: T.PHYS_PROP_CATALOGUE }).filter((p) => !site.sceneryCleared(p.x, -p.z))
  const standing = new Map<number, { rec: PropRecord; collider: ReturnType<typeof addStatic> }>()
  /** the soft breakables, by collider handle: what breaks them is a touch, not an impulse */
  const soft = new Map<number, { rec: PropRecord; spec: { threshold: number; mass: number; transfer: number; tag: number } }>()
  const detached: { mesh: THREE.Object3D; rec: PropRecord; collider: ReturnType<typeof addStatic> }[] = []
  let propsAt = { x: Infinity, z: Infinity }
  let brokenCount = 0

  function refreshProps(x: number, z: number) {
    if (T.PHYS_PROPS <= 0) return
    if (!props) props = propList()
    const radius = T.PHYS_PROP_RADIUS_M
    if (Math.hypot(x - propsAt.x, z - propsAt.z) < radius * 0.25) return
    propsAt = { x, z }

    // nearest first, and only what is in range: the budget goes where it can be hit
    const near: { i: number; d: number }[] = []
    for (let i = 0; i < props.length; i++) {
      const p = props[i]
      const d = Math.hypot(p.x - x, p.z - z)
      if (d <= radius) near.push({ i, d })
    }
    near.sort((a, b) => a.d - b.d)
    const want = new Set<number>()
    for (const { i } of near.slice(0, T.PHYS_PROP_BUDGET)) {
      want.add(i)
      if (standing.has(i)) continue
      const p = props[i]
      const collider = addStatic(phys, {
        kind: 'box',
        x: p.x, y: p.y, z: p.z,
        size: [p.hx, p.hy, p.hz],
        layer: p.kind === 'building' ? 'structure' : 'prop',
        events: true,
      })
      // the record's own orientation, which `addStatic` only knows how to take as a yaw
      collider.parent()?.setRotation({ x: p.qx, y: p.qy, z: p.qz, w: p.qw }, false)
      if (p.breakAt > 0) {
        const spec = { threshold: p.breakAt, mass: p.mass, transfer: 0.35, tag: i }
        breakables.add(collider, spec)
        /*
         * SOFT: a sign or a post is a sensor until something touches it. Solid, it stopped the car
         * dead in the step before it could break — and with the sled's raked nose, "stopped" meant
         * "launched". As a sensor it takes no part in the solver; the touch breaks it, it becomes
         * a solid dynamic body with its own small mass, and the car it hit sends it flying. The
         * threshold decides: under `PHYS_SOFT_BREAK_NS` is soft, a signal mast is not.
         */
        if (p.breakAt <= T.PHYS_SOFT_BREAK_NS) {
          collider.setSensor(true)
          collider.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS)
          soft.set(collider.handle, { rec: p, spec })
        }
      }
      standing.set(i, { rec: p, collider })
    }
    for (const [i, held] of standing) {
      if (want.has(i)) continue
      const p = held.rec
      if (Math.hypot(p.x - x, p.z - z) < radius * 1.3) continue
      // A prop that has BROKEN is a dynamic body somebody is looking at; letting the streamer
      // reclaim it would make wreckage vanish as you drove away from it mid-tumble.
      if (breakables.isBroken(held.collider)) continue
      const body = held.collider.parent()
      if (body) phys.world.removeRigidBody(body)
      soft.delete(held.collider.handle)
      standing.delete(i)
    }
  }

  /*
   * THE BRIDGE DECKS YOU DRIVE ON.
   *
   * The physics ground is one height per column, so at a grade-separated crossing it follows the
   * LOWER carriageway (site.physGroundAt) and the upper one has no ground at all. It has a surface
   * instead: `site.decksNear` hands back the elevated carriageways as trimesh ribbons around the
   * eye, and this streams them like the trees and props — built when one comes into range, dropped
   * when it goes, replacing the ground the heightfield had to give up. The geometry is cached per
   * carriageway, so a rebuild is only ever a new key arriving or an old one leaving, never a
   * remove-and-replace under a car that is standing on it.
   */
  const deckCols = new Map<string, NonNullable<ReturnType<typeof addSurface>>>()
  let decksAt = { x: Infinity, z: Infinity }
  function refreshDecks(x: number, z: number) {
    if (Math.hypot(x - decksAt.x, z - decksAt.z) < T.DECK_REFRESH_M) return
    decksAt = { x, z }
    const decks = site.decksNear(x, z, T.DECK_RADIUS_M)
    const want = new Set<string>()
    for (const d of decks) {
      want.add(d.key)
      if (deckCols.has(d.key)) continue
      const c = addSurface(phys, d.positions, d.indices, { friction: T.PHYS_GROUND_FRICTION })
      if (c) deckCols.set(d.key, c)
    }
    for (const [k, c] of deckCols) {
      if (want.has(k)) continue
      const body = c.parent()
      if (body) phys.world.removeRigidBody(body)
      deckCols.delete(k)
    }
  }

  /*
   * THE TOUCH THAT BREAKS A SOFT ONE. Whatever dynamic body reaches a soft breakable breaks it
   * with the momentum a thing of the breakable's mass would take from it — enough to fly, not
   * enough to slow a car — and from then on it is solid and loose.
   */
  phys.onTouch((a, b, started) => {
    if (!started) return
    for (const [c, other] of [[a, b], [b, a]] as const) {
      const s = soft.get(c.handle)
      if (!s) continue
      const ob = other.parent()
      if (!ob || !ob.isDynamic()) continue
      soft.delete(c.handle)
      const v = ob.linvel()
      const speed = Math.hypot(v.x, v.y, v.z)
      const d = speed > 1e-3 ? { x: v.x / speed, y: v.y / speed, z: v.z / speed } : { x: 0, y: 1, z: 0 }
      const at = c.translation()
      c.setSensor(false)
      breakables.break(c, s.spec, s.spec.mass * Math.max(2, speed), at.x, at.y, at.z, d.x, d.y + 0.35, d.z)
      // and the VELOCITY outright: the impulse `break` applied met a body whose mass the solver
      // has not recomputed yet (it was fixed a moment ago), so it did next to nothing. The post
      // leaves at most of the car's speed, a little upward, tumbling.
      const pb = c.parent()
      if (pb) {
        const k = Math.max(2, speed) * 0.8
        pb.setLinvel({ x: d.x * k, y: (d.y + 0.35) * k, z: d.z * k }, true)
        pb.setAngvel({ x: d.z * 3, y: 1, z: -d.x * 3 }, true)
      }
      return
    }
  })

  /*
   * WHEN SOMETHING COMES OFF, TAKE IT OUT OF THE INSTANCE BUFFER.
   *
   * `Breakables` has already flipped the body to dynamic and shoved it; this is the renderer's half.
   * Without it the collider topples while the drawn sign stands exactly where it was, which reads as
   * the physics not working rather than as a missing swap.
   */
  const offset = new THREE.Vector3()
  breakables.onBreak((e) => {
    brokenCount++
    const i = e.spec.tag as number
    const rec = props?.[i]
    if (!rec) return
    const mesh = detachInstance(rec)
    if (!mesh) return
    detachedOffset(rec, offset)
    mesh.userData.offset = offset.clone()
    site.group.add(mesh)
    detached.push({ mesh, rec, collider: e.collider })
    /*
     * A BROKEN PROP IS DEBRIS, AND DEBRIS IS BOUNDED. Every sign or post a blast knocks loose became
     * a mesh of its own with a dynamic body, kept for the rest of the level and synced to that body
     * every frame — so a session of rockets made the street a growing pile the frame paid for on
     * each tick (Rich, 2026-10-08, "see if we are leaking anything"). Past PHYS_LOOSE_MAX the oldest
     * piece goes: out of the scene, out of the breakables, its body out of the world. Its geometry is
     * the instanced batch's, shared, so there is nothing to dispose.
     */
    const cap = Math.max(0, Math.round(T.PHYS_LOOSE_MAX))
    while (detached.length > cap) {
      const old = detached.shift()!
      old.mesh.removeFromParent()
      breakables.remove(old.collider)
      const body = old.collider.parent()
      if (body) phys.world.removeRigidBody(body)
    }
  })

  /** Keep the detached meshes on their bodies. One frame of lag is a sign that skates. */
  const dq = new THREE.Quaternion()
  const dv = new THREE.Vector3()
  function syncDetached() {
    for (const d of detached) {
      const body = d.collider.parent()
      if (!body) continue
      const t = body.translation()
      const r = body.rotation()
      dq.set(r.x, r.y, r.z, r.w)
      dv.copy(d.mesh.userData.offset as THREE.Vector3).applyQuaternion(dq)
      d.mesh.position.set(t.x + dv.x, t.y + dv.y, t.z + dv.z)
      d.mesh.quaternion.copy(dq)
    }
  }

  /*
   * The trimesh collider of each stunt fixture, by id. A map rather than a list because the editor
   * moves one fixture at a time and every move has to replace exactly that surface.
   */
  const stuntCols = new Map<string, NonNullable<ReturnType<typeof addSurface>>>()

  return {
    phys,
    terrain,

    spawnCar(at, profileId, doc) {
      // `?profile=stunts` beats the knob, like `?phys=` and `?car=` — and this is the one that
      // matters most, because driving the Stunts PROFILE against the kinematic model it was ported
      // from is the only real test of the port, and it should not need a panel to set up.
      const fromUrl = new URLSearchParams(location.search).get('profile')
      const id = profileId ?? (fromUrl && PROFILES[fromUrl] ? fromUrl : T.physProfileId())
      /*
       * THE DOCUMENT'S OWN NUMBERS, ON THE LEVEL'S CHOICE OF PROFILE.
       *
       * `toDriveProfile` reads the base named IN THE DOCUMENT and then lays the car's real
       * drivetrain over it — power per kilo from the gearing, top speed from redline in top gear,
       * brake force from the brake torque. Swapping the base to the LEVEL's profile before calling
       * it keeps that layering: the level decides the game, the car keeps its engine.
       *
       * Doing it the other way round — taking the level's profile whole — would mean putting a
       * hatchback in `taxi` gave it the taxi's power and gearbox, which is not what anybody means
       * by choosing a handling model.
       */
      const p: DriveProfile = doc
        ? toDriveProfile({ ...doc, profile: { ...doc.profile, base: PROFILES[id] ? id : doc.profile.base } })
        : (PROFILES[id] ? profile(id) : profile('street'))
      const v = new Vehicle(phys, doc ? toVehicleSpec(doc, p) : {}, p)
      /*
       * WHAT THE TYRES ARE STANDING ON, from the site's own distance field.
       *
       * `edgeDistance` returns a NUMBER — the signed distance to the nearest pavement edge, negative
       * ON the pavement. (`edgeInfo` is the record; reading `.d` off the number silently reports
       * zero problems, which is a trap this codebase has hit before.) Anything past
       * `CAR_GRASS_EDGE` is verge, and the profile's `offroadGrip` decides what that costs.
       *
       * It is a RAMP rather than a step, over a metre either side of the edge, because two wheels
       * on tarmac and two on grass is the interesting case and a hard step makes the car snatch as
       * it crosses a line it cannot see.
       */
      /*
       * WHAT THE TYRES ARE STANDING ON.
       *
       * `edgeDistance` is the signed distance to the nearest pavement edge of the BAKED ROAD
       * NETWORK, and a stunt fixture's ribbon is not in that network — so the moment a car drove
       * onto a loop the hook said "you have left the road" and cut its grip to about seventy per
       * cent. Measured at the foot of the loop: friction slip 1.57 where the profile says 2.24, the
       * car sliding sideways at 8.9 m/s with 8.6 kN through each front tyre and 75 N of forward
       * force. Rich has been describing this all along as *"some weird friction"*, and it is: the
       * game thought a loop-the-loop was a grass verge.
       *
       * A fixture IS road — better than road, since it is the surface the piece was drawn with — so
       * standing on one reports full grip and the verge model is left for the verge.
       */
      v.setSurface((x, _y, z) => {
        if (onStuntSurface(x, z)) return 1
        const d = site.edgeDistance(x, z)
        if (!Number.isFinite(d)) return 1
        return 1 - Math.max(0, Math.min(1, (d - T.CAR_GRASS_EDGE) / 1))
      })
      const y = site.groundAt(at.x, at.z)
      v.place(at.x, (y ?? 0) + 1.2, at.z, at.yaw ?? 0)
      return v
    },

    spawnKinematic(half) {
      const body = phys.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setCcdEnabled(true))
      const desc = R.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(0.6).setRestitution(0.3)
      // events on, so a hit on a traffic car is reported: that is what knocks it loose and dents it
      phys.describe(desc, 'vehicle', { events: true })
      const collider = phys.world.createCollider(desc, body)
      let alive = true
      let loose = false
      return {
        colliderHandle: collider.handle,
        get loose() { return loose },
        move(x, y, z, yaw) {
          if (!alive || loose) return
          const h = yaw * 0.5
          // the same sign as `Vehicle.place`: yaw increases to the right, rotation about +Y does not
          body.setNextKinematicTranslation({ x, y: y + half.y, z })
          body.setNextKinematicRotation({ x: 0, y: Math.sin(-h), z: 0, w: Math.cos(-h) })
        },
        /*
         * FROM A CAR ON RAILS TO A CAR. Kinematic while it drives — immovable, the solver pushes
         * everything else out of its way — and dynamic once something hits it hard: it now has a
         * mass, it bounces (Rich: "elastic collisions"), and it goes where the impulse sends it.
         */
        wake(massKg) {
          if (!alive || loose) return
          loose = true
          body.setBodyType(R.RigidBodyType.Dynamic, true)
          // the MASS HAS TO BE ON THE BODY NOW: a collider's mass reaches its body at the next step,
          // and a blast in this step would find a body that weighs nothing and give it nothing
          body.setAdditionalMass(massKg, true)
          collider.setMass(0)
          collider.setRestitution(0.45)
          collider.setFriction(0.9)
          body.setAngularDamping(0.6)
          body.setLinearDamping(0.05)
        },
        rest() {
          if (!alive || !loose) return
          loose = false
          body.setLinvel({ x: 0, y: 0, z: 0 }, false)
          body.setAngvel({ x: 0, y: 0, z: 0 }, false)
          body.setBodyType(R.RigidBodyType.KinematicPositionBased, true)
          collider.setRestitution(0.3)
          collider.setFriction(0.6)
        },
        enable(on) {
          if (!alive || loose) return
          if (body.isEnabled() !== on) body.setEnabled(on)
        },
        kick(dvx, dvy, dvz, spin = 4) {
          if (!alive || !loose) return
          const v = body.linvel()
          body.setLinvel({ x: v.x + dvx, y: v.y + dvy, z: v.z + dvz }, true)
          // a deterministic tumble from the handle, so the same blast throws the same car the same way
          const h = Math.imul(collider.handle | 0, 2654435761)
          body.setAngvel({ x: (((h >>> 3) & 255) / 255 - 0.5) * spin, y: (((h >>> 11) & 255) / 255 - 0.5) * spin, z: (((h >>> 19) & 255) / 255 - 0.5) * spin }, true)
        },
        state() {
          const v = body.linvel()
          return { dynamic: body.isDynamic(), mass: body.mass(), vx: v.x, vy: v.y, vz: v.z }
        },
        pose() {
          const t = body.translation()
          const r = body.rotation()
          return { x: t.x, y: t.y - half.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w }
        },
        free() {
          if (!alive) return
          alive = false
          phys.world.removeRigidBody(body)
        },
      }
    },

    explode(at, opts) {
      const blast: Blast = { x: at.x, y: at.y, z: at.z, radius: opts.radius, impulse: opts.impulse, lift: opts.lift ?? 0.55, breakAt: opts.breakAt ?? 1, exclude: opts.exclude }
      return blastWorld(phys, blast, breakables)
    },

    onImpact: (fn) => phys.onImpact(fn),

    sweepHit(from, dir, maxM, radius, exclude) {
      const hit = phys.world.castShape(from, { x: 0, y: 0, z: 0, w: 1 }, dir, new R.Ball(radius), 0, maxM, true, undefined, QUERY.solid, undefined, undefined, exclude === undefined ? undefined : (c) => c.handle !== exclude)
      return hit ? hit.time_of_impact : null
    },

    rayHit(from, dir, maxM, exclude) {
      const hit = phys.world.castRay(new R.Ray(from, dir), maxM, true, undefined, QUERY.solid, undefined, undefined, exclude === undefined ? undefined : (c) => c.handle !== exclude)
      return hit ? hit.timeOfImpact : null
    },

    breakables,
    onBreak: (fn) => breakables.onBreak(fn),

    nearestProp(x, z, include = [], exclude = []) {
      if (!props) props = propList()
      let best: PropRecord | null = null
      let bestD = Infinity
      for (const p of props) {
        if (include.length && !include.some((k) => p.kind.includes(k))) continue
        if (exclude.some((k) => p.kind.includes(k))) continue
        const d = Math.hypot(p.x - x, p.z - z)
        if (d < bestD) { bestD = d; best = p }
      }
      return best
    },

    setStuntSurface(id, positions, indices) {
      const had = stuntCols.get(id)
      if (had) {
        // the BODY goes with it: `addSurface` makes one per surface, and removing only the collider
        // would leave a fixed body behind for every drag of every fixture
        const body = had.parent()
        if (body) phys.world.removeRigidBody(body)
        stuntCols.delete(id)
      }
      /*
       * SOLID TO THE BODY AS WELL AS TO THE WHEELS.
       *
       * This was briefly on the `track` layer, which the chassis cannot touch — the theory being
       * that a loop is a wall from the outside and a car should not be stopped by its own bumper.
       * It fixed that and broke something worse: the moment the wheels lost the surface for a step
       * the car sank THROUGH the track and could never find it again, because the rays point down
       * and the road was now above them. Rich, 2026-09-29: *"I drive straight through the ramp
       * approaching the loop… a little friction then I fall straight through."*
       *
       * So the surface is solid again, and the wall problem is solved where it actually lives — in
       * `stuntassist.ts`, which pitches the car to match the track it is ABOUT to reach, so the
       * nose rises with the ramp instead of into it.
       */
      const c = addSurface(phys, positions, indices, { friction: 1.1 })
      if (c) stuntCols.set(id, c)
    },
    clearStuntSurface(id) {
      const had = stuntCols.get(id)
      if (!had) return
      const body = had.parent()
      if (body) phys.world.removeRigidBody(body)
      stuntCols.delete(id)
    },
    stuntSurfaces() {
      return [...stuntCols.keys()]
    },
    detachedProps() {
      return detached.map((d) => ({ kind: d.rec.kind, x: d.mesh.position.x, y: d.mesh.position.y, z: d.mesh.position.z }))
    },

    propMasses() {
      if (!props) props = propList()
      const out: Record<string, { count: number; min: number; max: number; mean: number; breakable: boolean }> = {}
      for (const p of props) {
        // by the batch's own name minus its index, so `furniture:signal:2` and `:3` are one row
        const key = p.kind.replace(/:\d+[A-Za-z]*$/, '')
        const r = (out[key] ??= { count: 0, min: Infinity, max: -Infinity, mean: 0, breakable: false })
        if (p.breakAt > 0) r.breakable = true
        r.count++
        r.min = Math.min(r.min, p.mass)
        r.max = Math.max(r.max, p.mass)
        r.mean += p.mass
      }
      for (const r of Object.values(out)) {
        r.mean = +(r.mean / r.count).toFixed(1)
        r.min = +r.min.toFixed(1)
        r.max = +r.max.toFixed(1)
      }
      return out
    },

    update(eye, dt) {
      const t0 = performance.now()
      terrain.update(eye.x, eye.z, T.PHYS_TILE_BUDGET)
      refreshTrees(eye.x, eye.z)
      refreshProps(eye.x, eye.z)
      refreshDecks(eye.x, eye.z)
      buildMs = terrain.stats.built ? performance.now() - t0 : 0
      phys.step(dt)
      syncDetached()
    },

    groundUnder(x, z) {
      // The broad phase has to have seen the tile, which it has if `update` has run since the tile
      // was built — a collider is invisible to a query until the world has stepped, silently. A
      // caller that builds tiles and asks in the same breath gets null, and that is Rapier's
      // documented trap rather than a bug here.
      const from = T.PHYS_RAY_FROM_M
      const hit = phys.world.castRay(new R.Ray({ x, y: from, z }, DOWN), from * 2, true, undefined, QUERY.ground)
      return hit ? from - hit.timeOfImpact : null
    },

    stats() {
      return {
        on: true,
        hz: phys.hz,
        steps: phys.stats.steps,
        stepMs: +phys.stats.stepMs.toFixed(3),
        dropped: phys.stats.dropped,
        bodies: phys.stats.bodies,
        colliders: phys.stats.colliders,
        impacts: phys.stats.impacts,
        tiles: terrain.stats.tiles,
        built: terrain.stats.built,
        skipped: terrain.stats.skipped,
        rebuilt: terrain.stats.rebuilt,
        trees: trees.size,
        props: standing.size,
        catalogued: props?.length ?? 0,
        broken: brokenCount,
        merged: (props as (PropRecord[] & { merged?: number }) | null)?.merged ?? 0,
        buildMs: +buildMs.toFixed(2),
      }
    },

    free() {
      for (const d of detached) d.mesh.removeFromParent()
      detached.length = 0
      for (const c of deckCols.values()) {
        const body = c.parent()
        if (body) phys.world.removeRigidBody(body)
      }
      deckCols.clear()
      standing.clear()
      props = null
      trees.clear()
      breakables.free()
      terrain.free()
      phys.free()
    },
  }
}
