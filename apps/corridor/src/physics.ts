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
import { Breakables, type BreakEvent } from '@apex/engine/physics/destruction'
import { addStatic, addTree, Terrain } from '@apex/engine/physics/terrain'
import { Vehicle } from '@apex/engine/physics/vehicle'
import { PhysicsWorld } from '@apex/engine/physics/world'
import type { Site } from './scene'
import { catalogue, detachInstance, detachedOffset, type PropRecord } from './worldbodies'
import * as T from './tuning'

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
  spawnCar(at: { x: number; z: number; yaw?: number }, profileId?: string): Vehicle
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
  propMasses(): Record<string, { count: number; min: number; max: number; mean: number; breakable: boolean }>
  /** what has come off and where it is now — the renderer half, for a probe to check end to end */
  detachedProps(): { kind: string; x: number; y: number; z: number }[]
  stats(): PhysicsStats
  free(): void
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
    solverIterations: T.PHYS_ITERATIONS,
    impactThreshold: T.PHYS_IMPACT_N,
  })
  const terrain = new Terrain(phys, site.groundAt, {
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
  let props: PropRecord[] | null = null
  const standing = new Map<number, { rec: PropRecord; collider: ReturnType<typeof addStatic> }>()
  const detached: { mesh: THREE.Object3D; rec: PropRecord; collider: ReturnType<typeof addStatic> }[] = []
  let propsAt = { x: Infinity, z: Infinity }
  let brokenCount = 0

  function refreshProps(x: number, z: number) {
    if (T.PHYS_PROPS <= 0) return
    if (!props) props = catalogue(site, { max: T.PHYS_PROP_CATALOGUE })
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
      if (p.breakAt > 0) breakables.add(collider, { threshold: p.breakAt, mass: p.mass, transfer: 0.35, tag: i })
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
      standing.delete(i)
    }
  }

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

  return {
    phys,
    terrain,

    spawnCar(at, profileId) {
      // `?profile=stunts` beats the knob, like `?phys=` and `?car=` — and this is the one that
      // matters most, because driving the Stunts PROFILE against the kinematic model it was ported
      // from is the only real test of the port, and it should not need a panel to set up.
      const fromUrl = new URLSearchParams(location.search).get('profile')
      const id = profileId ?? (fromUrl && PROFILES[fromUrl] ? fromUrl : T.physProfileId())
      const p: DriveProfile = PROFILES[id] ? profile(id) : profile('street')
      const v = new Vehicle(phys, {}, p)
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
      v.setSurface((x, _y, z) => {
        const d = site.edgeDistance(x, z)
        if (!Number.isFinite(d)) return 1
        return 1 - Math.max(0, Math.min(1, (d - T.CAR_GRASS_EDGE) / 1))
      })
      const y = site.groundAt(at.x, at.z)
      v.place(at.x, (y ?? 0) + 1.2, at.z, at.yaw ?? 0)
      return v
    },

    breakables,
    onBreak: (fn) => breakables.onBreak(fn),

    nearestProp(x, z, include = [], exclude = []) {
      if (!props) props = catalogue(site, { max: T.PHYS_PROP_CATALOGUE })
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

    detachedProps() {
      return detached.map((d) => ({ kind: d.rec.kind, x: d.mesh.position.x, y: d.mesh.position.y, z: d.mesh.position.z }))
    },

    propMasses() {
      if (!props) props = catalogue(site, { max: T.PHYS_PROP_CATALOGUE })
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
      standing.clear()
      props = null
      trees.clear()
      breakables.free()
      terrain.free()
      phys.free()
    },
  }
}
