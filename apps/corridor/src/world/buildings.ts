// The buildings that are actually there: every OSM footprint in the bake, extruded to the height
// the lidar measured over it.
//
// The bake has carried `manifest.buildings` since the autogen work — a simplified ring in site
// metres, the minimum rotated rectangle, and a height from OSM tags → lidar (DSM − DTM over the
// footprint, median of the top quartile) → 6 m. Nothing rendered them, so a neighbourhood the
// pipeline knew about down to the roof height came up empty (Rich, 2026-09-21). This draws them
// as massing: walls from the ring, a gabled roof on anything house-sized and a flat one on the
// rest. It is deliberately NOT the asset library — a catalogue model, when one exists for a
// footprint, is placed over the top of this by `placements.ts` and the editor's autogen; massing
// is what makes a street read as a street in the meantime, and it is honest about being massing.
//
// One merged geometry with vertex colours: a thousand footprints is one draw call.
import * as THREE from 'three'
import type { Manifest } from './site'
import { Budget } from './budget'
import { RoadIndex, type Footprint } from './dressing'
import { BUILDING_DRESSING, DRESS_WINDOW_WALLS, STREAM_LOCAL } from '../tuning'
import { buildMassing, type MassArrays, type MassInput, type MassPool } from './massing'
import { dressBuilding, type DressBuild, type Ground } from './dressingdraw'
import type { FacadeRuntime } from './facadesrt'

export interface BuildingStats {
  count: number
  gabled: number
  fromLidar: number
  /** parts of the dressing kit placed — windows, doors, gutters, the rest */
  dressed: number
}

/**
 * Where the build time goes, accumulated across every cell. A probe reads it to decide what is
 * worth moving off the main thread: the massing loop (walls, the roof carve), the dressing loop,
 * and the final `computeVertexNormals` pass over the merged arrays.
 */
export const buildTiming = { calls: 0, footprints: 0, massMs: 0, dressMs: 0, normMs: 0, workerMass: 0, localMass: 0, workerDress: 0, localDress: 0 }

/* the massing palette/carve and the dressing draw live in massing.ts / dressingdraw.ts now, off the main thread */

/** the merged dressing arrays while one cell is built — `dressingdraw.ts` owns the shape */
type Build = DressBuild

/**
 * The world's building textures (surfacesdoc.ts): the wall and roof materials a building is
 * drawn from, each a tileable albedo at `mpt` metres per tile. Walls first, then roofs, in one
 * texture array; a vertex carries its layer.
 */
export interface TexturePool {
  walls: { id: string; url: string; mpt: number }[]
  roofs: { id: string; url: string; mpt: number }[]
  seed: number
}

/** the building's textures, or nothing: the current triangle's layer while a building is pushed */
/* the massing's `pushTri` and layer cursor live in massing.ts now — this file draws dressing only */

/* ------------------------------------------------------------------------------------------- *
 * DRESSING
 *
 * The massing above is a box with a roof on it. Everything below puts the openings and the trim
 * on it: `dressing.ts` works out WHERE each part of the kit goes (pure geometry, tested headlessly
 * in dressing.test.ts) and this draws it, in the same merged-geometry style as the massing.
 *
 * These are not catalogue models. A window here is two quads — a frame and a pane — and a gutter
 * is a 12 cm box. The point is that a street of blank extrusions reads as unfinished from the
 * pavement at any distance, and the cheapest fix by an order of magnitude is to put the holes in
 * the right places. When the asset library has a real window mesh, `placements.ts` puts it over
 * the top of this exactly as it already does for whole buildings.
 * ------------------------------------------------------------------------------------------- */

/** one texture array per pool, shared by every cell of the site that builds with it */
const poolAtlases = new Map<string, Promise<{ atlas: THREE.DataArrayTexture; mpt: number[] }>>()

/**
 * Draw the textured faces from the pool's albedos, projected by the face normal — walls take
 * the world position along the wall and up, roofs the plan — at each material's metres per
 * tile. UVs are not stored: a building's faces are all planar, and a projection from the world
 * position is right for every one of them without a seam to author.
 */
async function texturePoolMaterial(mat: THREE.MeshStandardMaterial, pool: TexturePool): Promise<void> {
  const layers = [...pool.walls, ...pool.roofs]
  if (!layers.length) return
  const key = layers.map((l) => `${l.id}@${l.mpt}`).join('|')
  let p = poolAtlases.get(key)
  if (!p) {
    p = import('../visuals/hextile').then(async ({ arrayTexture }) => {
      const atlas = await arrayTexture(layers.map((l) => l.url), true)
      atlas.colorSpace = THREE.SRGBColorSpace
      return { atlas, mpt: layers.map((l) => l.mpt) }
    })
    poolAtlases.set(key, p)
  }
  let atlas: { atlas: THREE.DataArrayTexture; mpt: number[] }
  try {
    atlas = await p
  } catch {
    return // a map that would not load: the palette colours stand
  }
  const mpt = new Array<number>(32).fill(1)
  atlas.mpt.forEach((m, i) => { if (i < 32) mpt[i] = m })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.poolMap = { value: atlas.atlas }
    shader.uniforms.poolMpt = { value: mpt }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float layer;\nvarying float vLayer;\nvarying vec3 vPoolPos;\nvarying vec3 vPoolNrm;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvLayer = layer;\nvPoolPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvPoolNrm = normalize(mat3(modelMatrix) * objectNormal);')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2DArray poolMap;\nuniform float poolMpt[32];\nvarying float vLayer;\nvarying vec3 vPoolPos;\nvarying vec3 vPoolNrm;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        if (vLayer >= 0.0) {
          int L = int(vLayer + 0.5);
          float m = poolMpt[L];
          vec3 n = abs(normalize(vPoolNrm));
          vec2 puv = n.y > 0.5 ? vPoolPos.xz : (n.x > n.z ? vec2(vPoolPos.z, vPoolPos.y) : vec2(vPoolPos.x, vPoolPos.y));
          vec4 pc = texture(poolMap, vec3(puv / m, vLayer));
          diffuseColor *= vec4(pc.rgb, 1.0);
        }`,
      )
  }
  mat.needsUpdate = true
}

/* ------------------------------------------------------------------------------------------- *
 * BUILDING WORKER
 *
 * `buildMassing` (massing.ts) and the dressing draw (dressingdraw.ts) are pure; this is only the
 * plumbing that runs them on a worker. It returns merged arrays as transferables and the main
 * thread wraps them, so none of the per-vertex work — or its allocation — happens on the main
 * thread. Dressing needs one round trip, for the driveway slabs' ground samples (see the worker).
 * With STREAM_LOCAL = 0 (or no Worker) it falls back to building on the budgeted main thread.
 * ------------------------------------------------------------------------------------------- */

interface DressArrays {
  pos: Float32Array
  col: Float32Array
  idx: Uint32Array
  dressed: number
}

let massWorker: Worker | null = null
let massSeq = 0
const massPending = new Map<number, { ok: (v: MassArrays) => void; fail: (e: Error) => void }>()
const dressPending = new Map<number, { ok: (v: DressArrays) => void; fail: (e: Error) => void; ground: Ground }>()
let massWorkerBroken = false

function massWorkerFor(): Worker | null {
  if (massWorkerBroken || STREAM_LOCAL <= 0) return null
  if (typeof Worker === 'undefined') return null
  if (!massWorker) {
    try {
      massWorker = new Worker(new URL('./buildings.worker.ts', import.meta.url), { type: 'module' })
    } catch (err) {
      massWorkerBroken = true
      console.warn('building worker unavailable; building on the main thread', err)
      return null
    }
    massWorker.onmessage = (ev: MessageEvent) => {
      const d = ev.data as { kind?: string; id: number; error?: string }
      if (d.kind === 'ground') {
        // the worker planned the dressing and needs the ground under each driveway slab: sample
        // the site-space ground once here and hand the values back
        const p = dressPending.get(d.id)
        if (!p) return
        const q = (d as unknown as { q: Float64Array }).q
        if (!q) return
        const vals = new Float32Array(q.length / 2)
        for (let i = 0, k = 0; i < q.length; i += 2, k++) {
          const g = p.ground(q[i], q[i + 1])
          vals[k] = g === null ? NaN : g
        }
        massWorker!.postMessage({ kind: 'ground', id: d.id, values: vals }, [vals.buffer])
        return
      }
      if (d.kind === 'dress') {
        const p = dressPending.get(d.id)
        if (!p) return
        dressPending.delete(d.id)
        if (d.error) p.fail(new Error(String(d.error)))
        else {
          const r = d as unknown as DressArrays
          p.ok({ pos: r.pos, col: r.col, idx: r.idx, dressed: r.dressed })
        }
        return
      }
      const p = massPending.get(d.id)
      if (!p) return
      massPending.delete(d.id)
      if (d.error) p.fail(new Error(String(d.error)))
      else p.ok({
        pos: (d as unknown as { pos: Float32Array }).pos,
        col: (d as unknown as { col: Float32Array }).col,
        pal: (d as unknown as { pal: Int16Array }).pal,
        lay: (d as unknown as { lay: Float32Array }).lay,
        idx: (d as unknown as { idx: Uint32Array }).idx,
        norm: (d as unknown as { norm: Float32Array }).norm,
        gabled: (d as unknown as { gabled: number }).gabled,
        fromLidar: (d as unknown as { fromLidar: number }).fromLidar,
      })
    }
    massWorker.onerror = (ev) => {
      massWorkerBroken = true
      console.warn('building worker failed; building on the main thread', ev.message)
      for (const p of massPending.values()) p.fail(new Error(ev.message || 'building worker'))
      for (const p of dressPending.values()) p.fail(new Error(ev.message || 'building worker'))
      massPending.clear()
      dressPending.clear()
      massWorker?.terminate()
      massWorker = null
    }
  }
  return massWorker
}

function massOffThread(list: MassInput[], pool: MassPool | null): Promise<MassArrays> {
  const worker = massWorkerFor()
  if (!worker) return Promise.reject(new Error('no building worker'))
  const id = ++massSeq
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      if (!massPending.has(id)) return
      massPending.delete(id)
      fail(new Error('building massing timed out'))
    }, 30000)
    massPending.set(id, {
      ok: (v) => { clearTimeout(timer); ok(v) },
      fail: (e) => { clearTimeout(timer); fail(e) },
    })
    worker.postMessage({ kind: 'mass', id, list, pool })
  })
}

function dressOffThread(list: { bd: Footprint; base: number; street: [number, number] | null }[], windowWalls: number, ground: Ground): Promise<DressArrays> {
  const worker = massWorkerFor()
  if (!worker) return Promise.reject(new Error('no building worker'))
  const id = ++massSeq
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      if (!dressPending.has(id)) return
      dressPending.delete(id)
      fail(new Error('building dressing timed out'))
    }, 30000)
    dressPending.set(id, {
      ok: (v) => { clearTimeout(timer); ok(v) },
      fail: (e) => { clearTimeout(timer); fail(e) },
      ground,
    })
    worker.postMessage({ kind: 'dress', id, buildings: list, windowWalls })
  })
}

/** The massing arrays: the worker when there is one, else `buildMassing` on the budget. */
async function massArrays(list: MassInput[], pool: MassPool | null, budget: Budget): Promise<MassArrays> {
  if (massWorkerFor()) {
    try {
      const r = await massOffThread(list, pool)
      buildTiming.workerMass++
      return r
    } catch (err) {
      console.warn('building massing worker failed; building on the main thread', err)
    }
  }
  buildTiming.localMass++
  return buildMassing(list, pool, () => budget.tick())
}

/** The dressing arrays: the worker when there is one, else `dressBuilding` on the budget. */
async function dressArrays(list: { bd: Footprint; base: number; street: [number, number] | null }[], windowWalls: number, ground: Ground, budget: Budget): Promise<DressArrays> {
  if (massWorkerFor()) {
    try {
      const r = await dressOffThread(list, windowWalls, ground)
      buildTiming.workerDress++
      return r
    } catch (err) {
      console.warn('building dressing worker failed; building on the main thread', err)
    }
  }
  buildTiming.localDress++
  const dg: Build = { pos: [], col: [], pal: [], lay: [], idx: [] }
  let dressed = 0
  for (const d of list) {
    await budget.tick()
    dressed += dressBuilding(dg, d.bd, d.base, d.street, ground, windowWalls)
  }
  return { pos: Float32Array.from(dg.pos), col: Float32Array.from(dg.col), idx: Uint32Array.from(dg.idx), dressed }
}

export async function buildBuildings(manifest: Manifest, groundAt: (x: number, z: number) => number | null, sliceMs = 8, opts: { roads?: RoadIndex | null; dress?: boolean; pool?: TexturePool | null; facades?: FacadeRuntime | null; budget?: Budget } = {}): Promise<{ group: THREE.Group; stats: BuildingStats; recolour: (walls: [number, number, number][], roofs: [number, number, number][]) => void }> {
  const group = new THREE.Group()
  group.name = 'buildings'
  const list = manifest.buildings ?? []
  // the dressing is its own geometry, not more triangles in the massing: a style's `recolour`
  // sweeps every massing vertex through the wall and roof palettes, and a window swept to a
  // siding colour is a hole that fills itself in
  const roads = opts.roads ?? buildRoadIndex(manifest)
  const dress = opts.dress !== false && BUILDING_DRESSING > 0
  let fromLidar = 0
  let dressed = 0

  const budget = opts.budget ?? new Budget(sliceMs)
  buildTiming.calls++
  buildTiming.footprints += list.length

  // PASS 1 — the ground, and the massing inputs. `groundAt` (a strip near the road, the DEM
  // beyond) is the one main-thread sampler, and it is sampled once per ring vertex; the massing
  // is a pure function of these numbers, so it runs in the worker and only the merged arrays
  // come back.
  const sites: MassInput[] = []
  const dressList: { bd: Footprint; base: number; street: [number, number] | null }[] = []
  const tGround0 = performance.now()
  for (const bd of list) {
    await budget.tick()
    const ring = (bd.ring ?? []) as [number, number][]
    if (ring.length < 3) continue
    const h = Math.max(2.4, bd.height_m ?? 6)
    if (bd.height_src === 'lidar' || bd.height_src === 'osm') fromLidar++

    // ground: the lowest sample under the ring, so nothing floats on a slope
    let base = Infinity
    for (const [x, y] of ring) {
      const g = groundAt(x, -y)
      if (g !== null && g < base) base = g
    }
    if (!Number.isFinite(base)) continue
    base -= 0.3
    // the building's CLASS (facades.ts): read off its tags here, where they are, so the worker
    // gets a number rather than every footprint's tag dictionary
    const fslot = opts.facades ? opts.facades.slotOf(bd) : -1
    sites.push({ ring, height: h, heightSrc: bd.height_src, area: bd.area_m2 ?? 0, rect: bd.rect ?? null, base, fslot })
    // a curtain wall is its own windows: dressing one draws a grid of house windows over the glass
    if (dress && !(fslot >= 0 && opts.facades!.glazed(fslot))) {
      let cx = 0, cy = 0
      for (const p of ring) { cx += p[0]; cy += p[1] }
      // the street facing, from the road index — the only other main-thread input the dressing
      // needs besides the ground, so it is resolved here and sent with the building
      dressList.push({ bd: bd as Footprint, base, street: roads?.nearest(cx / ring.length, cy / ring.length) ?? null })
    }
  }
  buildTiming.massMs += performance.now() - tGround0

  const pool: MassPool | null = opts.facades
    ? { wallIds: [], roofIds: [], seed: 1, facades: { classes: opts.facades.plan.classes } }
    : opts.pool
      ? { wallIds: opts.pool.walls.map((w) => w.id), roofIds: opts.pool.roofs.map((w) => w.id), seed: opts.pool.seed }
      : null
  const mass = await massArrays(sites, pool, budget)

  // PASS 2 — the dressing. The worker plans and draws it; only the driveway slabs need the
  // ground, so the worker asks for those corners and this is where they are sampled.
  let dressPos: Float32Array | null = null
  let dressCol: Float32Array | null = null
  let dressIdx: Uint32Array | null = null
  const tDress0 = performance.now()
  if (dress) {
    const r = await dressArrays(dressList, DRESS_WINDOW_WALLS, (x, y) => groundAt(x, -y), budget)
    dressed = r.dressed
    dressPos = r.pos
    dressCol = r.col
    dressIdx = r.idx
  }
  buildTiming.dressMs += performance.now() - tDress0

  let recolour = (_w: [number, number, number][], _r: [number, number, number][]) => {}
  const tn = performance.now()
  if (mass.idx.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(mass.pos, 3))
    const colAttr = new THREE.BufferAttribute(mass.col, 3)
    geo.setAttribute('color', colAttr)
    geo.setAttribute('layer', new THREE.BufferAttribute(mass.lay, 1))
    // the worker already computed the faces' normals — the massing shares no vertices, so each
    // vertex's normal is its face normal, and there is no computeVertexNormals pass here
    geo.setAttribute('normal', new THREE.BufferAttribute(mass.norm, 3))
    geo.setIndex(new THREE.BufferAttribute(mass.idx, 1))
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide })
    if (opts.facades && mass.lay.some((l) => l >= 0)) await opts.facades.apply(mat)
    else if (opts.pool && mass.lay.some((l) => l >= 0)) await texturePoolMaterial(mat, opts.pool)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'buildings:massing'
    group.add(mesh)
    // a style swaps the palettes: every vertex remembers which entry it drew, so this is one
    // pass over the colour attribute and no geometry — and a textured vertex is left alone
    const pal = mass.pal
    const lay = mass.lay
    recolour = (walls, roofs) => {
      const arr = colAttr.array as Float32Array
      for (let i = 0; i < pal.length; i++) {
        if (lay[i] >= 0) continue
        const k = pal[i]
        const e = k >= 100 ? roofs[(k - 100) % roofs.length] : walls[k % walls.length]
        arr[i * 3] = e[0]
        arr[i * 3 + 1] = e[1]
        arr[i * 3 + 2] = e[2]
      }
      colAttr.needsUpdate = true
    }
  }
  if (dressIdx && dressIdx.length && dressPos && dressCol) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(dressPos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(dressCol, 3))
    geo.setIndex(new THREE.BufferAttribute(dressIdx, 1))
    // the dressing shares vertices between a box's faces, so unlike the massing its normals are
    // smooth: computeVertexNormals runs here rather than in the worker (tens of ms a cell)
    geo.computeVertexNormals()
    // FrontSide, unlike the massing: every part here is a closed box or a pane with a wall behind
    // it, and double-siding them doubles the overdraw on the densest geometry in the scene
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'buildings:dressing'
    group.add(mesh)
  }
  buildTiming.normMs += performance.now() - tn
  return { group, stats: { count: list.length, gabled: mass.gabled, fromLidar, dressed }, recolour }
}

/**
 * Every road on the site as one searchable index, for "which way is the street".
 *
 * Spine, siblings, service roads and the stubs that lead off the edge — a house on a cul-de-sac
 * faces the service road, not the arterial 200 m away, so the small stuff has to be in here too.
 */
export function buildRoadIndex(manifest: Manifest): RoadIndex {
  const lines: [number, number][][] = []
  const add = (coords: [number, number, number][] | undefined | null) => {
    if (coords?.length) lines.push(coords.map(([x, y]) => [x, y] as [number, number]))
  }
  add(manifest.spine?.coords)
  for (const sib of manifest.siblings ?? []) if (sib.length) lines.push(sib)
  for (const d of manifest.driveways ?? []) add(d.coords)
  for (const st of manifest.stubs ?? []) add(st.coords)
  return new RoadIndex(lines)
}
