// The world to drive on: heightfield tiles that follow the player, and the static shapes that stand
// on them.
//
// WHY TILES AND NOT ONE COLLIDER. A corridor site is a couple of kilometres of road. At the 1 m
// sampling the car needs to feel a kerb, one heightfield over 2 km square is four million cells and
// about 16 MB of heights, built at load time, for a car that can see two hundred metres. Tiles of
// 64 m built on demand around the eye cost a few thousand cells each and go away behind you. The
// same argument the renderer already made for its terrain strip, for the same reason.
//
// WHY A SAMPLER AND NOT THE RENDERER'S MESH. The physics ground and the drawn ground have to be the
// same surface or the car floats and sinks in ways nothing explains — this repo has a rule about it
// already ("One surface, one height function"). So this takes the height FUNCTION, not the geometry:
// whatever `site.groundAt` answers is what the wheels stand on, by construction, and there is no
// second sampling to drift.
//
// THE HOLE CASE IS REAL. A sampler answers `null` off its data — beyond the baked strip, inside a
// tunnel, over a hole somebody cut. A heightfield has no concept of a missing cell, so a tile that
// is mostly null is simply not built, and one with a few nulls fills them from its neighbours. The
// alternative — a 0 — is a cliff to sea level at the edge of the bake, which a car finds at speed.

import type { Collider, RigidBody } from '@dimforge/rapier3d-compat'
import type { Layer } from './layers'
import { rapier } from './rapier'
import type { PhysicsWorld } from './world'

/** Ground height at a world x, z, or null where there is no data. */
export type HeightAt = (x: number, z: number) => number | null

export interface TerrainOptions {
  /** metres across one tile */
  tile?: number
  /** samples along one edge of a tile. `tile / (cells)` is the resolution the car feels */
  cells?: number
  /** tiles are kept within this many metres of the interest point */
  radius?: number
  /** a tile with fewer than this fraction of real samples is not built at all */
  minCoverage?: number
  friction?: number
}

interface Tile {
  key: string
  body: RigidBody
  collider: Collider
  cx: number
  cz: number
}

/**
 * Heightfield tiles that follow whoever is driving.
 *
 * Call `update(x, z)` once a frame with the player's position; it builds what came into range and
 * drops what went out. Building a tile is `cells²` sampler calls, so it is deliberately not done in
 * the physics step.
 */
export class Terrain {
  private tiles = new Map<string, Tile>()
  private readonly opts: Required<TerrainOptions>
  private phys: PhysicsWorld
  private height: HeightAt
  /** what a probe reads: how many tiles exist, and how many were built or dropped last update */
  readonly stats = { tiles: 0, built: 0, dropped: 0, skipped: 0 }

  constructor(phys: PhysicsWorld, height: HeightAt, opts: TerrainOptions = {}) {
    this.phys = phys
    this.height = height
    this.opts = {
      tile: opts.tile ?? 64,
      cells: opts.cells ?? 32,
      radius: opts.radius ?? 180,
      minCoverage: opts.minCoverage ?? 0.25,
      friction: opts.friction ?? 1,
    }
  }

  /**
   * Bring the tiles around (x, z) into being and let the far ones go.
   *
   * `budget` caps how many tiles may be BUILT in one call, because building eight at once on the
   * frame somebody drives over a tile boundary is a visible hitch. The ones that did not get built
   * are built next frame; the car is never near enough to the edge of the ring for that to matter.
   */
  update(x: number, z: number, budget = 2): void {
    const { tile, radius } = this.opts
    this.stats.built = 0
    this.stats.dropped = 0
    const i0 = Math.floor((x - radius) / tile)
    const i1 = Math.floor((x + radius) / tile)
    const j0 = Math.floor((z - radius) / tile)
    const j1 = Math.floor((z + radius) / tile)
    const want = new Set<string>()
    // nearest first, so the tile under the car is the one that gets the budget
    const todo: { i: number; j: number; d: number }[] = []
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cx = (i + 0.5) * tile
        const cz = (j + 0.5) * tile
        const d = Math.hypot(cx - x, cz - z)
        if (d > radius + tile) continue
        const key = `${i},${j}`
        want.add(key)
        if (!this.tiles.has(key)) todo.push({ i, j, d })
      }
    }
    todo.sort((a, b) => a.d - b.d)
    for (const t of todo) {
      if (this.stats.built >= budget) break
      if (this.build(t.i, t.j)) this.stats.built++
      else this.stats.skipped++
    }
    for (const [key, t] of this.tiles) {
      // hysteresis: a tile is dropped only once it is a whole tile past the radius, so driving back
      // and forth across a boundary does not rebuild the same ground every other frame
      if (want.has(key)) continue
      if (Math.hypot(t.cx - x, t.cz - z) < radius + tile * 1.5) continue
      this.phys.world.removeRigidBody(t.body)
      this.tiles.delete(key)
      this.stats.dropped++
    }
    this.stats.tiles = this.tiles.size
  }

  /**
   * Build one tile. Returns false if there is not enough ground there to be worth a collider.
   *
   * THE LAYOUT IS THE THING TO GET RIGHT, and it is not what reading Rapier's signature suggests.
   * A heightfield of `nrows × ncols` takes `(nrows+1) × (ncols+1)` heights and is centred on the
   * collider's translation with `scale` as its full extent. The index that MOVES FASTEST is the one
   * along local **Z**, so the height of the sample at (x index `a`, z index `b`) goes at
   * `heights[a * n + b]`. Measured, by building a field whose value is its own fast index and
   * casting rays at it: it varied along z. Writing it the other way round builds a terrain that is
   * the real one TRANSPOSED — which on a road running east is a perfectly smooth surface at the
   * wrong height, and looks like a bug in the bake rather than in this line. The two ramp tests in
   * `test/physics-world.test.ts` exist for exactly this and would each pass on their own.
   */
  private build(i: number, j: number): boolean {
    const R = rapier()
    const { tile, cells, minCoverage, friction } = this.opts
    const n = cells + 1
    const x0 = i * tile
    const z0 = j * tile
    const heights = new Float32Array(n * n)
    const has = new Uint8Array(n * n)
    let good = 0
    let sum = 0
    for (let a = 0; a < n; a++) {
      const wx = x0 + (a / cells) * tile
      for (let b = 0; b < n; b++) {
        const wz = z0 + (b / cells) * tile
        const h = this.height(wx, wz)
        const k = a * n + b
        if (h === null || !Number.isFinite(h)) continue
        heights[k] = h
        has[k] = 1
        good++
        sum += h
      }
    }
    if (good < n * n * minCoverage) return false
    // Fill the holes with the tile's own mean rather than with zero. A zero is sea level, and a
    // cliff to sea level at the edge of the data is what a car drives off at 30 m/s.
    if (good < n * n) {
      const mean = sum / good
      for (let k = 0; k < n * n; k++) if (!has[k]) heights[k] = mean
    }

    const body = this.phys.world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(x0 + tile / 2, 0, z0 + tile / 2),
    )
    const desc = R.ColliderDesc.heightfield(cells, cells, heights, { x: tile, y: 1, z: tile }).setFriction(friction)
    this.phys.describe(desc, 'terrain', { events: false })
    const collider = this.phys.world.createCollider(desc, body)
    this.tiles.set(`${i},${j}`, { key: `${i},${j}`, body, collider, cx: x0 + tile / 2, cz: z0 + tile / 2 })
    return true
  }

  /** Throw every tile away — a new site, or a bake that changed under us. */
  clear() {
    for (const t of this.tiles.values()) this.phys.world.removeRigidBody(t.body)
    this.tiles.clear()
    this.stats.tiles = 0
  }

  free() {
    this.clear()
  }
}

/* ================================================================================================
 * Static shapes: everything that stands on the ground
 * ============================================================================================= */

export interface StaticShape {
  kind: 'box' | 'cylinder' | 'capsule' | 'ball'
  x: number
  y: number
  z: number
  /** yaw about +Y, rad */
  yaw?: number
  /** box: half-extents. cylinder/capsule: [radius, halfHeight]. ball: [radius] */
  size: [number, number, number] | [number, number] | [number]
  layer?: Layer
  friction?: number
  restitution?: number
  /** contact events, so this thing can be broken or can dent a car. Off for scenery */
  events?: boolean
}

/**
 * One immovable thing. Trees, posts, walls, building shells, bollards.
 *
 * One body per shape, deliberately. Rapier is happy with a single fixed body carrying thousands of
 * colliders, and it is tempting because it is fewer objects — but a breakable has to become dynamic
 * ON ITS OWN, and a collider cannot leave its parent. Every prop that might ever come down needs
 * its own body, and the ones that never will are cheap enough that having two rules is worse than
 * having one.
 */
export function addStatic(phys: PhysicsWorld, s: StaticShape): Collider {
  const R = rapier()
  const half = s.yaw ? s.yaw * 0.5 : 0
  const body = phys.world.createRigidBody(
    R.RigidBodyDesc.fixed()
      .setTranslation(s.x, s.y, s.z)
      .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }),
  )
  let desc
  if (s.kind === 'box') desc = R.ColliderDesc.cuboid(s.size[0], s.size[1] ?? s.size[0], s.size[2] ?? s.size[0])
  else if (s.kind === 'cylinder') desc = R.ColliderDesc.cylinder(s.size[1] ?? s.size[0], s.size[0])
  else if (s.kind === 'capsule') desc = R.ColliderDesc.capsule(s.size[1] ?? s.size[0], s.size[0])
  else desc = R.ColliderDesc.ball(s.size[0])
  desc.setFriction(s.friction ?? 0.8).setRestitution(s.restitution ?? 0)
  phys.describe(desc, s.layer ?? 'prop', { events: s.events ?? true })
  return phys.world.createCollider(desc, body)
}

/**
 * A trunk, from the numbers the corridor already has: `treesNear` gives x, z and a trunk radius,
 * and the canopy raster gives the height.
 *
 * A cylinder and not a capsule: a capsule's rounded bottom lets a car ride up the base of a tree,
 * which reads as the tree being made of jelly. Trees are not registered as breakable by default —
 * hitting a mature trunk at speed should end your run, and that is the profile's `landingTolerance`
 * and the impact's business, not the tree's.
 */
export function addTree(phys: PhysicsWorld, x: number, groundY: number, z: number, radius: number, height: number): Collider {
  return addStatic(phys, {
    kind: 'cylinder',
    x,
    y: groundY + height / 2,
    z,
    size: [Math.max(0.08, radius), height / 2],
    layer: 'prop',
    friction: 0.9,
  })
}
