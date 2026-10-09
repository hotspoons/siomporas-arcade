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

/**
 * How far a tile's stored sample may differ from the live ground function before the tile is
 * considered stale and rebuilt, metres. An unchanged field matches exactly; a road that streamed in
 * moves it by a metre or more. The slack only absorbs the odd centimetre a re-slide can wobble.
 */
const STALE_M = 0.25

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
  /**
   * Milliseconds of ground sampling per `update` for the tiles AHEAD. Sampling a 65 × 65 tile
   * through the corridor's graded ground is 17–23 ms (Rich's machine, the DC Beltway, 2026-10-08),
   * and it landed whole on one frame every few hundred metres — most of the 25–30 ms frames under
   * the test rig. With a slice, a tile's rows are sampled across frames and the collider is made
   * when the last row is in. The tile under the wheels and the next one over are never deferred: a
   * missing one there is a hole, so it is built whole on the spot. 0 = whole tiles, `budget` of
   * them per call.
   */
  sliceMs?: number
}

/** a tile whose rows are still being sampled */
interface Partial {
  key: string
  i: number
  j: number
  x0: number
  z0: number
  heights: Float32Array
  has: Uint8Array
  /** the next row to sample */
  a: number
  good: number
  sum: number
}

interface Tile {
  key: string
  body: RigidBody
  collider: Collider
  cx: number
  cz: number
  /** tile origin (its lower corner in x,z), so a stored sample's world point can be recomputed */
  x0: number
  z0: number
  /** the sampled heights and their validity, kept so a tile can be checked against the live ground */
  heights: Float32Array
  has: Uint8Array
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
  readonly stats = { tiles: 0, built: 0, dropped: 0, skipped: 0, rebuilt: 0 }
  private partial: Partial | null = null

  constructor(phys: PhysicsWorld, height: HeightAt, opts: TerrainOptions = {}) {
    this.phys = phys
    this.height = height
    this.opts = {
      tile: opts.tile ?? 64,
      cells: opts.cells ?? 32,
      radius: opts.radius ?? 180,
      minCoverage: opts.minCoverage ?? 0.25,
      friction: opts.friction ?? 1,
      sliceMs: opts.sliceMs ?? 0,
    }
  }

  /**
   * Bring the tiles around (x, z) into being and let the far ones go.
   *
   * `budget` caps how many tiles may be BUILT in one call, because building eight at once on the
   * frame somebody drives over a tile boundary is a visible hitch. The ones that did not get built
   * are built next frame; the car is never near enough to the edge of the ring for that to matter.
   */
  update(x: number, z: number, budget = 2, sliceMs = this.opts.sliceMs ?? 0, focus?: { x: number; z: number }): void {
    const { tile, radius } = this.opts
    this.stats.built = 0
    this.stats.dropped = 0
    this.stats.rebuilt = 0
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
        // ranked by distance to the FOCUS (ahead of the car) when there is one, so the tiles the
        // car is about to need are sampled first; the ring itself is still around the car
        if (!this.tiles.has(key)) todo.push({ i, j, d: focus ? Math.hypot(cx - focus.x, cz - focus.z) : d })
      }
    }
    todo.sort((a, b) => a.d - b.d)
    // the tiles under and beside the wheels first, and whole: a hole there is a fall
    const near = tile * 1.5
    const ahead: typeof todo = []
    for (const t of todo) {
      const dCar = Math.hypot((t.i + 0.5) * tile - x, (t.j + 0.5) * tile - z)
      if (sliceMs > 0 && dCar > near) { ahead.push(t); continue }
      if (this.stats.built >= budget) break
      if (this.build(t.i, t.j)) this.stats.built++
      else this.stats.skipped++
    }
    if (sliceMs > 0 && ahead.length && this.stats.built < budget) {
      // keep sampling the tile already begun while it is still wanted, else start the nearest
      let p = this.partial && want.has(this.partial.key) ? this.partial : null
      const deadline = performance.now() + sliceMs
      const tried = new Set<string>()
      while (this.stats.built < budget) {
        if (!p) {
          const t = ahead.find((c) => { const k = `${c.i},${c.j}`; return !tried.has(k) && !this.tiles.has(k) })
          if (!t) break
          p = this.start(t.i, t.j)
        }
        if (!this.sampleRows(p, deadline)) break
        tried.add(p.key)
        if (this.commit(p)) this.stats.built++
        else this.stats.skipped++
        p = null
      }
      this.partial = p
    }
    /*
     * A TILE BUILT BEFORE A ROAD STREAMED IN IS STALE, and the car — standing on the heightfield —
     * sinks through asphalt that is drawn at the true height (Rich, 2026-10-07, "drop through the
     * asphalt and grass onto the underlying terrain"). The corridor's ground is live: the spine
     * window slides and branch cells adopt as you drive. Re-check the tile the wheel is over against
     * the function it was built from and rebuild it in place when the ground has moved under it.
     * Only that one tile, and only when it has actually changed, so this is a rare synchronous
     * rebuild rather than a per-frame cost — and it happens before the step, with the new collider
     * registered before the old one is removed, so the ground is never absent under the wheels.
     */
    const ci = Math.floor(x / tile), cj = Math.floor(z / tile)
    const here = this.tiles.get(`${ci},${cj}`)
    if (here && this.stale(here, x, z)) {
      if (this.build(ci, cj)) this.stats.rebuilt++
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
    const p = this.start(i, j)
    this.sampleRows(p, Infinity)
    return this.commit(p)
  }

  private start(i: number, j: number): Partial {
    const { tile, cells } = this.opts
    const n = cells + 1
    return { key: `${i},${j}`, i, j, x0: i * tile, z0: j * tile, heights: new Float32Array(n * n), has: new Uint8Array(n * n), a: 0, good: 0, sum: 0 }
  }

  /**
   * Sample rows until the deadline. At least one row per call, so a tiny slice still makes
   * progress; returns true once the last row is in.
   */
  private sampleRows(p: Partial, deadline: number): boolean {
    const { tile, cells } = this.opts
    const n = cells + 1
    const first = p.a
    for (; p.a < n; p.a++) {
      if (p.a > first && performance.now() >= deadline) return false
      const wx = p.x0 + (p.a / cells) * tile
      for (let b = 0; b < n; b++) {
        const wz = p.z0 + (b / cells) * tile
        const h = this.height(wx, wz)
        const k = p.a * n + b
        if (h === null || !Number.isFinite(h)) continue
        p.heights[k] = h
        p.has[k] = 1
        p.good++
        p.sum += h
      }
    }
    return true
  }

  /** The sampled tile into the world, or false when there was not enough ground to be worth it. */
  private commit(p: Partial): boolean {
    const R = rapier()
    const { tile, cells, minCoverage, friction } = this.opts
    const n = cells + 1
    const { x0, z0, heights, has, good, sum } = p
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
    const key = p.key
    // A rebuild replaces a live tile; drop the old body AFTER the new one exists so the ground under
    // the wheels is never absent, not even for the rest of this call.
    const existing = this.tiles.get(key)
    this.tiles.set(key, { key, body, collider, cx: x0 + tile / 2, cz: z0 + tile / 2, x0, z0, heights, has })
    if (existing) this.phys.world.removeRigidBody(existing.body)
    return true
  }

  /**
   * Has the ground under this tile moved since it was built?
   *
   * The physics ground is `site.physGroundAt` — a FUNCTION, not a bake — and the corridor feeds it
   * new roads as they stream in (the spine window slides, branch cells adopt). A tile sampled before
   * one arrived holds the bare earth where the drawn surface is now pavement, and the car, standing
   * on the heightfield, sinks through it. Re-sample the tile's OWN grid points and compare them to
   * what it stored: an unchanged field matches to the bit, a road that appeared does not, and
   * because the comparison is at the stored coordinates there is no interpolation error to trip on.
   */
  private stale(t: Tile, x: number, z: number): boolean {
    const { tile, cells } = this.opts
    const n = cells + 1
    const a0 = Math.min(cells, Math.max(0, Math.floor(((x - t.x0) / tile) * cells)))
    const b0 = Math.min(cells, Math.max(0, Math.floor(((z - t.z0) / tile) * cells)))
    // +/- 2 cells: a couple of metres, enough to include the wheels when the body centre is between
    // samples and the ground a frame ahead at speed. Wider would be a per-frame cost for ground the
    // car is not on; narrower would miss the front axle on a fast approach.
    for (let da = -2; da <= 2; da++) {
      for (let db = -2; db <= 2; db++) {
        const a = Math.min(cells, Math.max(0, a0 + da))
        const b = Math.min(cells, Math.max(0, b0 + db))
        const k = a * n + b
        if (!t.has[k]) continue
        const h = this.height(t.x0 + (a / cells) * tile, t.z0 + (b / cells) * tile)
        if (h === null || !Number.isFinite(h)) continue
        if (Math.abs(h - t.heights[k]) > STALE_M) return true
      }
    }
    return false
  }

  /** Throw every tile away — a new site, or a bake that changed under us. */
  clear() {
    for (const t of this.tiles.values()) this.phys.world.removeRigidBody(t.body)
    this.tiles.clear()
    this.partial = null
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

/**
 * A driveable surface from a triangle mesh: a stunt fixture's road.
 *
 * WHY THE HEIGHTFIELD CANNOT DO THIS. `Terrain` streams a heightfield, which is a function of x and
 * z — one height per column — and the whole point of a loop is that the road is above itself. A
 * trimesh is the only shape that can be its own ceiling, so it is what a stunt stands on.
 *
 * ONE-SIDED IS NOT AN OPTION EITHER. A car inside a loop is under the surface for half of it, and
 * Rapier's trimesh is double-sided by default — which is exactly right here and is the reason a
 * loop can be driven at all.
 *
 * NO CONTACT EVENTS BY DEFAULT. A road generates a contact every frame for every wheel; wiring
 * those into the impact system would report the car crashing into the ground continuously. The
 * profile's landing and grip machinery is what reads a road, not `onImpact`.
 *
 * `positions` and `indices` are the corridor's site frame — x east, y north, z up — because that is
 * the frame the geometry is authored in. The conversion into the physics world's (x east, y up,
 * z south) happens HERE, once, so no caller has to remember it.
 */
export function addSurface(
  phys: PhysicsWorld,
  positions: Float32Array,
  indices: Uint32Array,
  opts: { friction?: number; layer?: Layer; events?: boolean; flags?: number } = {},
): Collider | null {
  const R = rapier()
  if (positions.length < 9 || indices.length < 3) return null
  // site (x east, y north, z up) -> physics (x east, y up, z south)
  const v = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    v[i] = positions[i]
    v[i + 1] = positions[i + 2]
    v[i + 2] = -positions[i + 1]
  }
  const body = phys.world.createRigidBody(R.RigidBodyDesc.fixed())
  /*
   * INTERNAL EDGES ARE FIXED, and this is the line that made a loop drivable.
   *
   * A ribbon is a strip of thin quads, so a car standing on it straddles a triangle edge every
   * half metre. Left alone, a convex shape sliding across those edges catches on them: the
   * narrow phase sees the shape's corner past the edge of one triangle's plane and pushes it out
   * the short way — sideways along the surface, not up out of it. Measured on the loop's entry
   * with the chassis resting on the ribbon: the contact normal flipped from the road's up
   * (−0.14, 0.99, 0) to straight backward (−1, −0.09, 0.04) and the car lost 29 m/s in a single
   * physics step. Rich has been describing this since the first loop as *"weird friction"* and
   * *"stops dead at the loop entry"*, and it is neither friction nor the entry — it is a ghost
   * collision with an edge that only exists because the surface is tessellated.
   *
   * `FIX_INTERNAL_EDGES_TWO_SIDED` makes Rapier clamp each contact normal to the fan of the
   * triangles' real normals around a shared edge (which needs `MERGE_DUPLICATE_VERTICES`, which
   * the flag includes), and keeps contacts from the back of a triangle — a loop is driven on the
   * INSIDE, so at the top the car is standing on what is the underside of the ribbon's winding.
   */
  const desc = R.ColliderDesc.trimesh(v, indices, opts.flags ?? R.TriMeshFlags.FIX_INTERNAL_EDGES_TWO_SIDED)
  desc.setFriction(opts.friction ?? 1)
  phys.describe(desc, opts.layer ?? 'terrain', { events: opts.events ?? false })
  return phys.world.createCollider(desc, body)
}
