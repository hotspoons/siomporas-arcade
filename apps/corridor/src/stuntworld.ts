// Stunt fixtures in a running world: the tarmac you see, the surface you drive on, and the hole
// they leave in the baked road.
//
// Rich, 2026-09-29: *"the stunts are not drivable yet, we need to make them into actual roads."*
//
// THE THREE HALVES HAVE TO AGREE, and the way they are made to agree is that there is one source
// for each thing rather than one source per consumer:
//
//   the SHAPE        `stunts.ts` — poses, in the site frame. Nothing else computes them.
//   the SURFACE      `ribbonGeometry` — positions and indices, from those poses. The renderer and
//                    the physics take the SAME arrays, so what you see is what you hit.
//   the HOLE         the footprint, turned into a run of stations the road builder skips.
//
// WHY THIS IS NOT IN `main.ts`. The viewer needs it, the editor needs it and a probe needs it, and
// the three differ only in where they get the document from. A function that takes a site, a
// physics world and a document is the smallest thing all three can share.

import * as THREE from 'three'
import { connectFixture, fixtureFootprint, fixtureGeometry, linksTo, Stunts, type StuntDoc, type StuntFixture } from './stunts'
import { buildFixture, type Ribbon } from './stuntmesh'
import type { CorridorPhysics } from './physics'
import type { Site } from './scene'
import type { Pose } from './stunts'

/** the lookup grid's cell, metres — wider than any assist radius, so one ring of cells is enough */
const GRID_M = 20

/** A place on a fixture's lane: the pose, how far away it is, and where it sits in its own lane. */
export interface LanePoint {
  pose: Pose
  d: number
  /** the lane it belongs to, so the caller can walk further along it */
  lane: Pose[]
  i: number
}

export interface StuntWorldOpts {
  /** half the drivable width, metres. Defaults to the vocabulary's own */
  halfWidth?: number
  /** the road surface material to wear, so a fixture matches the roads it joins */
  material?: THREE.Material
  /** STUNTIN's red-and-white edging rather than plain tarmac */
  kerbs?: boolean
}

/**
 * The centreline sampler, for any chain.
 *
 * `spineAt` and every `chains()` entry answer in three's frame — x east, y UP, z SOUTH — and
 * everything authored is site metres with y north and z up. ONE CONVERSION, HERE, and it is a
 * module-level function rather than a method because three callers need it and a fourth copy of
 * `y: -pos.z` is a sign error waiting to happen.
 *
 * PER CHAIN RATHER THAN PER FIXTURE, because the two ends of a fixture do not have to be on the
 * same road: a loop can be entered off a driveway and leave onto the highway it crosses.
 */
export function roadSampler(site: Site): (s: number, chain: number) => Pose | null {
  return (s: number, chain: number) => {
    const chains = site.chains()
    const c = chains.find((x) => x.index === chain) ?? chains[0]
    if (!c || s < 0 || s > c.length_m) return null
    const at = c.at(s)
    return { x: at.pos.x, y: -at.pos.z, z: at.pos.y, dx: at.dir.x, dy: -at.dir.z }
  }
}

/** The ground under a SITE point — x east, y north. The terrain, or the height model behind it. */
export function groundSampler(site: Site): (x: number, y: number) => number {
  return (x: number, y: number) => site.groundAt(x, -y) ?? site.heightAt(x, y) ?? 0
}

/**
 * The colliders alone, for somewhere the ribbons are already drawn.
 *
 * THE EDITOR'S PREVIEW IS THAT SOMEWHERE. Its fixtures are on screen — the stunt tool put them
 * there — and what it lacked was anything to hit: Rich, 2026-09-29, *"It doesn't look like that
 * works in the preview from the editor"*. Building a second `StuntWorld` over the top would draw
 * every ribbon twice, so this registers the physics half and nothing else.
 *
 * Returns how many surfaces went in, because "none, silently" is the failure worth catching.
 */
export function addStuntColliders(
  site: Site,
  physics: CorridorPhysics,
  fixtures: readonly StuntFixture[],
  halfWidth = 5,
): number {
  const road = roadSampler(site)
  const ground = groundSampler(site)
  const other = (id: string) => fixtures.find((f) => f.id === id) ?? null
  let n = 0
  for (const f of fixtures) {
    const parts = connectFixture(f, road, { groundAt: ground, fixture: other })
    if (!parts) continue
    const g = fixtureGeometry(parts, halfWidth)
    if (!g.indices.length) continue
    physics.setStuntSurface(f.id, g.positions, g.indices)
    n++
  }
  return n
}

/**
 * Everything a world needs to know about its stunt fixtures.
 *
 * Built once per site load and kept, so the editor can move a fixture and rebuild only that one.
 */
export class StuntWorld {
  readonly group = new THREE.Group()
  private site: Site
  private physics: CorridorPhysics | null
  private opts: StuntWorldOpts
  private built = new Map<string, Ribbon>()
  /** every fixture's lane poses, for `nearestPose` */
  private indexed = new Map<string, Pose[]>()
  private grid = new Map<string, { lane: Pose[]; i: number }[]>()
  private doc: StuntDoc = { version: 1, fixtures: [] }

  constructor(site: Site, physics: CorridorPhysics | null, opts: StuntWorldOpts = {}) {
    this.group.name = 'stunts'
    this.site = site
    this.physics = physics
    this.opts = opts
    this.road = roadSampler(site)
    this.ground = groundSampler(site)
  }

  get count(): number {
    return this.doc.fixtures.length
  }

  /** The fixtures, for a readout or a program. */
  get fixtures(): readonly StuntFixture[] {
    return this.doc.fixtures
  }

  private road: (s: number, chain: number) => Pose | null

  /** The other pieces of this document, so a track can be built out of fixtures joined together. */
  private other = (id: string): StuntFixture | null => this.doc.fixtures.find((f) => f.id === id) ?? null

  private ground: (x: number, y: number) => number

  /** Put a whole document in: the normal path when a site loads. */
  set(doc: StuntDoc): void {
    for (const id of [...this.built.keys()]) this.remove(id)
    this.doc = doc
    for (const f of doc.fixtures) this.build(f)
    this.applyRoadSkip()
    this.applySceneryClear()
  }

  /** Build or rebuild one fixture — its ribbon, and the surface the car drives on. */
  build(f: StuntFixture): void {
    this.remove(f.id, { keepDoc: true })
    if (!this.doc.fixtures.some((x) => x.id === f.id)) this.doc.fixtures.push(f)

    const parts = connectFixture(f, this.road, { groundAt: this.ground, fixture: this.other })
    if (!parts) return

    // the FIXTURE's own style wins; the world's options are the defaults it falls back to
    const stuntin = f.style === 'stuntin' || (f.style === undefined && !!this.opts.kerbs)
    const ribbon = buildFixture(f, parts, {
      halfWidth: this.opts.halfWidth,
      material: this.opts.material,
      kerbs: stuntin,
    })
    this.built.set(f.id, ribbon)
    this.group.add(ribbon.group)
    this.index(f, parts)

    /*
     * THE SAME ARRAYS THE RENDERER USED. `fixtureGeometry` is the one generator; handing the
     * physics a second computation of the same cross products is how a loop ends up looking solid
     * and being empty, and the symptom — falling through a surface you can see — is one of the
     * worst to debug because every screenshot says it is there.
     */
    if (this.physics) {
      const g = fixtureGeometry(parts, this.opts.halfWidth ?? 5)
      if (g.indices.length) this.physics.setStuntSurface(f.id, g.positions, g.indices)
    }
  }

  /**
   * Rebuild a fixture and everything joined to it.
   *
   * ONE LEVEL IS ENOUGH, and that is a property of the model rather than a shortcut: a fixture's
   * own ports depend on its position and yaw alone, never on what it is linked to, so moving A
   * changes A's curves and the curves of whoever names A — and stops there. If ports ever depended
   * on links this would have to be a graph walk with a cycle guard.
   */
  rebuild(f: StuntFixture): void {
    this.build(f)
    for (const other of this.doc.fixtures) {
      if (other.id !== f.id && linksTo(other, f.id)) this.build(other)
    }
  }

  /**
   * The nearest point of any fixture's lane to a place in the world, and how far away it is.
   *
   * WHAT IT IS FOR: holding a car onto a loop. A ray-cast vehicle feels the road along its own down
   * axis, so it cannot climb a surface that has stood up in front of it until it is already turned
   * to face it — the car has to be told what "down" is here, and this is where that comes from.
   *
   * A UNIFORM GRID, because it is asked once a frame while driving and a linear scan over a
   * thousand-sample loop is a thousand distance tests per frame per fixture. The cell is twenty
   * metres, which is wider than any assist radius, so one ring of cells around the query is always
   * enough.
   */
  nearestPose(at: { x: number; y: number; z: number }, within = 12): LanePoint | null {
    let best: LanePoint | null = null
    const cx = Math.floor(at.x / GRID_M)
    const cy = Math.floor(at.y / GRID_M)
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const cell = this.grid.get(`${cx + i}:${cy + j}`)
        if (!cell) continue
        for (const c of cell) {
          const pose = c.lane[c.i]
          const d = Math.hypot(pose.x - at.x, pose.y - at.y, pose.z - at.z)
          if (d <= within && (!best || d < best.d)) best = { pose, d, lane: c.lane, i: c.i }
        }
      }
    }
    return best
  }

  /**
   * The lane, `metres` further along from a point on it — in the direction the car is travelling.
   *
   * ALONG THE LANE, NOT THROUGH SPACE, and that distinction is the whole reason a loop was still
   * stopping the car. A loop passes over itself, so the nearest lane point to somewhere ten metres
   * in front of you on the run-in is the run-in, not the wall above it: sampled in space, the assist
   * read "flat" and held the car flat right up to the point where it hit the climb. Measured at the
   * stop — the car level, all four wheels down, the track under it reading straight up.
   *
   * Walking the lane's own samples gives the surface the car is ABOUT TO BE ON, which is the only
   * thing worth aligning to.
   */
  /**
   * The surface the car is about to be on, averaged over the next stretch of lane.
   *
   * ONE SAMPLE AHEAD IS NOT ENOUGH, and the loop shows why: its lane runs flat for the first forty
   * metres and only then stands up. A car at 48 m/s looking 0.45 s ahead is looking 21 m ahead — at
   * more flat road — so the assist aimed the car dead level right up to the point where it hit the
   * wall, which is what four runs measured (car up 0.07, 1, 0.05; the track under it reading
   * straight up; two hundred assists applied, all of them no-ops).
   *
   * Averaging the whole window instead means a climb forty metres off starts tilting the target as
   * soon as it is in range and tilts it further as it approaches — the car rotates INTO the loop
   * over its whole run-up, the way a driver's line does, rather than being asked for a quarter turn
   * at the last moment.
   *
   * Weighted toward the near end, so the surface you are on still dominates and the assist does not
   * pitch a car for a wall it is nowhere near.
   */
  upAhead(hit: LanePoint, metres: number, forward?: { x: number; y: number }): { x: number; y: number; z: number } {
    const lane = hit.lane
    let step = 1
    if (forward) {
      const t = lane[hit.i]
      if (t.dx * forward.x + t.dy * forward.y < 0) step = -1
    }
    let run = 0
    let i = hit.i
    let ux = 0
    let uy = 0
    let uz = 0
    let total = 0
    while (run < metres) {
      const p = lane[i]
      const u = p.up ?? { x: 0, y: 0, z: 1 }
      // linear falloff: the far end of the window counts for a fifth of the near end
      const w = 1 - 0.8 * (run / metres)
      ux += u.x * w
      uy += u.y * w
      uz += u.z * w
      total += w
      const next = i + step
      if (next < 0 || next >= lane.length) break
      run += Math.hypot(lane[next].x - lane[i].x, lane[next].y - lane[i].y, lane[next].z - lane[i].z)
      i = next
    }
    if (!total) return { x: 0, y: 0, z: 1 }
    const len = Math.hypot(ux, uy, uz) || 1
    return { x: ux / len, y: uy / len, z: uz / len }
  }

  aheadOf(hit: LanePoint, metres: number, forward?: { x: number; y: number }): Pose {
    const lane = hit.lane
    // which way along the lane the car is going; default is the lane's own direction of travel
    let step = 1
    if (forward) {
      const t = lane[hit.i]
      if (t.dx * forward.x + t.dy * forward.y < 0) step = -1
    }
    let run = 0
    let i = hit.i
    while (run < metres) {
      const next = i + step
      if (next < 0 || next >= lane.length) break
      run += Math.hypot(lane[next].x - lane[i].x, lane[next].y - lane[i].y, lane[next].z - lane[i].z)
      i = next
    }
    return lane[i]
  }

  /** Put a fixture's lane into the lookup grid. */
  private index(f: StuntFixture, parts: { approach: Pose[]; through: Pose[]; departure: Pose[] }) {
    const poses = [...parts.approach, ...parts.through, ...parts.departure]
    this.indexed.set(f.id, poses)
    this.regrid()
  }

  private regrid() {
    this.grid.clear()
    for (const lane of this.indexed.values()) {
      for (let i = 0; i < lane.length; i++) {
        const p = lane[i]
        const key = `${Math.floor(p.x / GRID_M)}:${Math.floor(p.y / GRID_M)}`
        const cell = this.grid.get(key)
        const entry = { lane, i }
        if (cell) cell.push(entry)
        else this.grid.set(key, [entry])
      }
    }
  }

  /** Take one out of the world entirely. */
  remove(id: string, opts: { keepDoc?: boolean } = {}): void {
    const r = this.built.get(id)
    if (r) {
      this.group.remove(r.group)
      r.dispose()
      this.built.delete(id)
    }
    this.physics?.clearStuntSurface(id)
    if (this.indexed.delete(id)) this.regrid()
    if (!opts.keepDoc) this.doc.fixtures = this.doc.fixtures.filter((f) => f.id !== id)
  }

  /**
   * Stop the baked road being drawn where a fixture stands.
   *
   * BY STATION, computed once when the fixtures change, because the road builder emits quads along
   * a chain and knows the `s` of each — asking a polygon per quad per rebuild would be the same
   * answer computed thousands of times.
   */
  /**
   * Clear whatever is standing inside a fixture: trees, and the props that line a road.
   *
   * Rich, 2026-09-29, having painted an area to zero tree density to make room for a loop: *"if
   * there is still invisible geometry, that's a problem and that needs to be rectified."* Right on
   * both counts — and you should not have to paint anything. A fixture already suppresses the baked
   * road under it; this is the rest of the same idea, and it is the difference between a loop you
   * can drive and one with a fence post inside it.
   */
  private applySceneryClear(): void {
    this.site.setSceneryClear(this.doc.fixtures.map((f) => fixtureFootprint(f)))
  }

  applyRoadSkip(): void {
    const site = this.site
    /*
     * EVERY CHAIN, NOT JUST THE SPINE. A fixture on a branch used to be listed with "the baked
     * road under a branch is not hidden yet" — Rich, 2026-09-30, with his loop on Patuxent River
     * Road and the tarmac drawn straight through it. Each chain's fixtures are looked up on that
     * chain alone, so a loop over a crossroads holes both roads and nothing else.
     */
    const chains = site.chains()
    const byChain = new Map<number, [number, number][]>()
    const STEP = 4
    for (const c of chains) {
      const here = this.doc.fixtures.filter((f) => (f.chain ?? 0) === c.index)
      if (!here.length) continue
      const lookup = new Stunts()
      lookup.set(here)
      const covered: [number, number][] = []
      let from: number | null = null
      for (let s = 0; s <= c.length_m; s += STEP) {
        const p = c.at(s).pos
        const hit = lookup.coversRoad(p.x, -p.z)
        if (hit && from === null) from = s
        else if (!hit && from !== null) { covered.push([from, s]); from = null }
      }
      if (from !== null) covered.push([from, c.length_m])
      if (covered.length) byChain.set(c.index, covered)
    }
    site.setRoadSkip(byChain.size
      ? (chain: number, s: number) => (byChain.get(chain)?.some(([a, b]) => s >= a && s <= b) ?? false)
      : null)
  }

  dispose(): void {
    for (const id of [...this.built.keys()]) this.remove(id)
    this.site.setRoadSkip(null)
    this.site.setSceneryClear([])
  }
}

/**
 * Load a site's fixtures and put them in the world. Resolves to null when the site has none.
 *
 * A MISSING FILE IS THE NORMAL CASE and must not be an error: most worlds have no stunts, and a
 * console full of 404s is a console nobody reads.
 */
export async function loadStuntWorld(
  site: Site,
  physics: CorridorPhysics | null,
  opts: StuntWorldOpts & { base?: string } = {},
): Promise<StuntWorld | null> {
  const doc = await fetchStuntDoc(site.manifest.slug, opts.base ?? '')
  return makeStuntWorld(site, physics, doc, opts)
}

/**
 * Just the document, without building anything.
 *
 * SEPARATE BECAUSE THE ANSWER IS NEEDED EARLIER THAN THE WORLD. A fixture's collider is a trimesh,
 * and a trimesh needs a physics world, and the physics world is built before anything is loaded —
 * so "does this site have stunts on it" has to be answerable BEFORE the decision to start physics
 * at all. Rich, 2026-09-29: *"stunts still not drivable"*. They were solid in a probe and scenery
 * in the game, because the game starts with physics off and the hand-written car follows a
 * heightfield: one height per column, and a loop is above itself.
 */
export async function fetchStuntDoc(slug: string, base = ''): Promise<StuntDoc | null> {
  try {
    const r = await fetch(`${base}/sites/${slug}/stunts.json`, { cache: 'no-cache' })
    if (!r.ok) return null
    const text = (await r.text()).trimStart()
    if (!text.startsWith('{')) return null
    const doc = JSON.parse(text) as StuntDoc
    return doc.fixtures?.length ? doc : null
  } catch {
    return null
  }
}

/** Stand a document up in a world. Null for a world with no fixtures, which is most of them. */
export function makeStuntWorld(
  site: Site,
  physics: CorridorPhysics | null,
  doc: StuntDoc | null,
  opts: StuntWorldOpts = {},
): StuntWorld | null {
  if (!doc?.fixtures?.length) return null
  const w = new StuntWorld(site, physics, opts)
  w.set(doc)
  return w
}
