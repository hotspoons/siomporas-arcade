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
import { RoadIndex, planDressing, type DressingPart, type DressingSite, type Footprint } from './dressing'
import { BUILDING_DRESSING, DRESS_WINDOW_WALLS, STREAM_LOCAL } from '../tuning'
import { buildMassing, type MassArrays, type MassInput, type MassPool } from './massing'
import kitSpec from '../../../../tools/assetlib/specs/buildings-dressing.json'

/** site x, y (north), z (up) → three.js world; the same mapping scene.ts uses, kept local to avoid an import cycle */
const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y)

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
export const buildTiming = { calls: 0, footprints: 0, massMs: 0, dressMs: 0, normMs: 0, workerMass: 0, localMass: 0 }

/* the massing palette, carve and pushTri live in massing.ts now, off the main thread */

interface Build {
  pos: number[]
  col: number[]
  /** which palette entry coloured each vertex: 0..6 a wall, 100 + 0..3 a roof — so a style can recolour in place */
  pal: number[]
  /** which layer of the world's texture pool draws each vertex; -1 is the flat palette colour */
  lay: number[]
  idx: number[]
}

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

type Anchor = 'bottom' | 'below' | 'centre'
interface Draw {
  /**
   * 'panel' is a flush pane with a frame round it, 'strip' a single quad standing off the wall (a
   * gutter, a ridge vent — a line, not a solid), 'box' stands proud, 'slab' lies on the ground.
   */
  kind: 'panel' | 'strip' | 'box' | 'slab'
  colour: [number, number, number]
  /** frame colour, panels only */
  trim?: [number, number, number]
  /** how far it stands off the wall, boxes only; the spec's own depth wins where it has one */
  depth?: number
  /** what `site.at[2]` means for this part */
  anchor?: Anchor
}

const DRESS: Record<string, Draw> = {
  'window-double-hung-white': { kind: 'panel', colour: [0.10, 0.13, 0.17], trim: [0.93, 0.93, 0.91] },
  'window-picture-large': { kind: 'panel', colour: [0.11, 0.14, 0.18], trim: [0.93, 0.93, 0.91] },
  'window-commercial-storefront': { kind: 'panel', colour: [0.13, 0.17, 0.21], trim: [0.26, 0.26, 0.27] },
  'door-front-panelled': { kind: 'panel', colour: [0.36, 0.20, 0.14], trim: [0.90, 0.90, 0.88] },
  'door-garage-sectional': { kind: 'panel', colour: [0.80, 0.79, 0.76], trim: [0.88, 0.88, 0.86] },
  // FLAT, not a box: a gutter is a horizontal line under the eaves and nothing sees its back or
  // its ends. As boxes, 68,322 of them cost 820k triangles on crofton-triangle — 40% of the whole
  // dressing budget for the one part that is a line.
  'gutter-half-round-run': { kind: 'strip', colour: [0.86, 0.86, 0.83], anchor: 'below' },
  'downpipe-round': { kind: 'box', colour: [0.86, 0.86, 0.83], depth: 0.09 },  // flush: 4 quads
  'driveway-concrete-apron': { kind: 'slab', colour: [0.63, 0.62, 0.60] },
  'porch-step-concrete': { kind: 'box', colour: [0.72, 0.70, 0.68] },
  'meter-box-utility': { kind: 'panel', colour: [0.76, 0.76, 0.73] },
  'ac-condenser-unit': { kind: 'box', colour: [0.60, 0.62, 0.61] },
  'roof-vent-ridge': { kind: 'strip', colour: [0.30, 0.29, 0.28], anchor: 'centre' },
  'chimney-brick-residential': { kind: 'box', colour: [0.48, 0.33, 0.28] },
  'mailbox-wall-mounted': { kind: 'panel', colour: [0.24, 0.25, 0.28] },
  'awning-fabric-shop': { kind: 'box', colour: [0.50, 0.16, 0.16], anchor: 'below' },
  'fire-escape-landing': { kind: 'box', colour: [0.28, 0.28, 0.30], depth: 1, anchor: 'below' },
}

/** the kit's placement rules, as `tools/assetlib/specs/buildings-dressing.json` declares them */
const KIT: DressingPart[] = (kitSpec as { assets: DressingPart[] }).assets
const KIT_BY_ID = new Map(KIT.map((p) => [p.id, p]))

/** What `site.at[2]` measures for a part, resolved to the bottom of the thing drawn. */
function anchorZ(s: DressingSite, anchor: Anchor): number {
  return anchor === 'below' ? s.at[2] - s.height : anchor === 'centre' ? s.at[2] - s.height / 2 : s.at[2]
}

/** A wall part's two axes in SITE metres: along its face, and out of it. */
function axes(yaw: number): { ax: number; ay: number; nx: number; ny: number } {
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  // the normal is (sin, cos) by the yaw convention in dressing.ts; along the wall is that turned
  // a quarter the other way, so a positive `w` runs the way the ring is wound
  return { ax: -c, ay: s, nx: s, ny: c }
}

/**
 * One quad in site metres, given its four corners. Wound so the outward face is the front.
 *
 * FOUR vertices and two triangles, unlike the massing's `pushTri`, which pushes three fresh
 * vertices per triangle. The massing can afford that; the dressing cannot — it is an order of
 * magnitude more geometry, and sharing the two vertices of the shared edge is a third of the
 * memory for nothing.
 */
function pushQuad(b: Build, p: [number, number, number][], colour: [number, number, number]) {
  const k = b.pos.length / 3
  for (const [x, y, z] of p) {
    const v = toWorld(x, y, z)
    b.pos.push(v.x, v.y, v.z)
    b.col.push(colour[0], colour[1], colour[2])
    b.pal.push(-1)
    b.lay.push(-1)
  }
  b.idx.push(k, k + 1, k + 2, k, k + 2, k + 3)
}

/**
 * A box in site metres, centred on (cx, cy) across `w`, spanning `z0..z1`, `d0..d1` off the face.
 *
 * FOUR OR FIVE FACES, NOT SIX. The bottom of every one of these sits on the ground, on a roof or
 * against the wall, so it is never the visible face — and when the box is flush against a wall the
 * back is not either. That is a third of the geometry of the second-biggest item in the dressing
 * budget for no visible difference.
 */
function pushBoxSite(b: Build, cx: number, cy: number, yaw: number, w: number, z0: number, z1: number, d0: number, d1: number, colour: [number, number, number], { flush = false } = {}) {
  const { ax, ay, nx, ny } = axes(yaw)
  const at = (u: number, v: number, z: number): [number, number, number] => [cx + ax * u + nx * v, cy + ay * u + ny * v, z]
  const h = w / 2
  const c: [number, number, number][][] = [
    [at(-h, d1, z0), at(h, d1, z0), at(h, d1, z1), at(-h, d1, z1)], // front
    [at(h, d1, z0), at(h, d0, z0), at(h, d0, z1), at(h, d1, z1)], // one end
    [at(-h, d0, z0), at(-h, d1, z0), at(-h, d1, z1), at(-h, d0, z1)], // the other
    [at(-h, d0, z1), at(h, d0, z1), at(h, d1, z1), at(-h, d1, z1)], // top
  ]
  if (!flush) c.push([at(h, d0, z0), at(-h, d0, z0), at(-h, d0, z1), at(h, d0, z1)]) // back
  for (const q of c) pushQuad(b, q, colour)
}

/**
 * Draw one building's dressing into the merged geometry.
 *
 * `base` is the same sunk ground level the massing used, so a door stands on the same floor the
 * walls start from — computing it twice is how a porch ends up hovering on a slope.
 */
function dressBuilding(b: Build, bd: Footprint, base: number, street: [number, number] | null, groundAt: (x: number, z: number) => number | null): number {
  let n = 0
  for (const s of planDressing(bd, KIT, { street, base, windowWalls: DRESS_WINDOW_WALLS })) {
    const d = DRESS[s.part]
    if (!d) continue
    n += 1
    const spec = KIT_BY_ID.get(s.part)?.attach
    if (d.kind === 'slab') {
      // a driveway: `width` across, `height` along the normal, lying on the ground
      const { ax, ay, nx, ny } = axes(s.yaw)
      const hw = s.width / 2
      const hl = s.height / 2
      // a 13 m apron laid at the building's floor level cuts into a sloped garden, so each
      // corner takes its own ground height — the one part of the kit long enough for that to show
      const corner = (u: number, v: number): [number, number, number] => {
        const x = s.at[0] + ax * u + nx * v
        const y = s.at[1] + ay * u + ny * v
        const g = groundAt(x, -y)
        return [x, y, (g === null ? s.at[2] : Math.max(g, s.at[2] - 0.6)) + 0.03]
      }
      pushQuad(b, [corner(-hw, -hl), corner(hw, -hl), corner(hw, hl), corner(-hw, hl)], d.colour)
      continue
    }
    if (d.kind === 'panel' || d.kind === 'strip') {
      const { ax, ay, nx, ny } = axes(s.yaw)
      const face = (w: number, h: number, z0: number, out: number, colour: [number, number, number]) => {
        const hw = w / 2
        const at = (u: number, z: number): [number, number, number] => [s.at[0] + ax * u + nx * out, s.at[1] + ay * u + ny * out, z]
        pushQuad(b, [at(-hw, z0), at(hw, z0), at(hw, z0 + h), at(-hw, z0 + h)], colour)
      }
      if (d.kind === 'strip') {
        // a line under the eaves or along the ridge: one quad, standing 8 cm off so it catches a
        // different amount of light than the wall behind it and reads as a separate thing
        const z0 = anchorZ(s, d.anchor ?? 'bottom')
        face(s.width, Math.max(0.1, s.height), z0, 0.08, d.colour)
        continue
      }
      // THE FRAME COSTS AS MUCH AS THE PANE, so it is spent on the elevation somebody looks at.
      // On the street side: frame 2 cm proud, pane 3 cm further out, and the reveal between the
      // two is what makes it read as a hole rather than a sticker. Everywhere else: just the pane.
      if (d.trim && s.front) face(s.width + 0.14, s.height + 0.14, s.at[2] - 0.07, 0.02, d.trim)
      face(s.width, s.height, s.at[2], 0.05, d.colour)
      continue
    }
    // a box: depth from the spec where it has one, `anchor` says what at[2] measures
    const depth = spec?.depthM ?? spec?.projectionM ?? spec?.diameterM ?? d.depth ?? 0.3
    const z0 = anchorZ(s, d.anchor ?? 'bottom')
    // a part standing on the wall face sits just off it so it never z-fights the wall behind it
    const standoff = s.part === 'ac-condenser-unit' ? 0.25 : -0.02
    // flush against a wall: its back face is buried in the wall and nothing can see it
    const flush = s.wall >= 0 && standoff <= 0
    pushBoxSite(b, s.at[0], s.at[1], s.yaw, s.width, z0, z0 + s.height, standoff, standoff + depth, d.colour, { flush })
  }
  return n
}

/**
 * Build the massing.
 *
 * `groundAt` takes WORLD x, z (the strip near the road, the DEM beyond). A footprint sits on the
 * LOWEST ground under its ring, sunk 0.3 m, because a house on a slope is cut into the hill and a
 * house floating on its high corner is the thing everyone notices.
 */
/**
 * Every building on the site, as one merged mesh.
 *
 * ASYNC because it is 3.9 s of work on crofton-triangle (measured on a real machine through the
 * dev bridge) and it used to run in one call stack, inside a single frame. The `Budget` hands the
 * frame back every few milliseconds so the page paints and the progress message moves; the total
 * work is unchanged.
 */
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
 * MASSING WORKER
 *
 * `buildMassing` (massing.ts) is pure; this is only the plumbing that runs it on a worker. The
 * worker returns the merged arrays as transferables and the main thread wraps them, so none of
 * the per-vertex work — or the massing's allocation — happens on the main thread. With
 * STREAM_LOCAL = 0 (or no Worker) it falls back to building on the budgeted main thread.
 * ------------------------------------------------------------------------------------------- */

let massWorker: Worker | null = null
let massSeq = 0
const massPending = new Map<number, { ok: (v: MassArrays) => void; fail: (e: Error) => void }>()
let massWorkerBroken = false

function massWorkerFor(): Worker | null {
  if (massWorkerBroken || STREAM_LOCAL <= 0) return null
  if (typeof Worker === 'undefined') return null
  if (!massWorker) {
    try {
      massWorker = new Worker(new URL('./buildings.worker.ts', import.meta.url), { type: 'module' })
    } catch (err) {
      massWorkerBroken = true
      console.warn('building massing worker unavailable; building on the main thread', err)
      return null
    }
    massWorker.onmessage = (ev: MessageEvent) => {
      const p = massPending.get(ev.data.id as number)
      if (!p) return
      massPending.delete(ev.data.id as number)
      if (ev.data.error) p.fail(new Error(String(ev.data.error)))
      else p.ok({
        pos: ev.data.pos as Float32Array,
        col: ev.data.col as Float32Array,
        pal: ev.data.pal as Int16Array,
        lay: ev.data.lay as Float32Array,
        idx: ev.data.idx as Uint32Array,
        norm: ev.data.norm as Float32Array,
        gabled: ev.data.gabled as number,
        fromLidar: ev.data.fromLidar as number,
      })
    }
    massWorker.onerror = (ev) => {
      massWorkerBroken = true
      console.warn('building massing worker failed; building on the main thread', ev.message)
      for (const p of massPending.values()) p.fail(new Error(ev.message || 'massing worker'))
      massPending.clear()
      massWorker?.terminate()
      massWorker = null
    }
  }
  return massWorker
}

function massOffThread(list: MassInput[], pool: MassPool | null): Promise<MassArrays> {
  const worker = massWorkerFor()
  if (!worker) return Promise.reject(new Error('no massing worker'))
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
    worker.postMessage({ id, list, pool })
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

export async function buildBuildings(manifest: Manifest, groundAt: (x: number, z: number) => number | null, sliceMs = 8, opts: { roads?: RoadIndex | null; dress?: boolean; pool?: TexturePool | null; budget?: Budget } = {}): Promise<{ group: THREE.Group; stats: BuildingStats; recolour: (walls: [number, number, number][], roofs: [number, number, number][]) => void }> {
  const group = new THREE.Group()
  group.name = 'buildings'
  const list = manifest.buildings ?? []
  // the dressing is its own geometry, not more triangles in the massing: a style's `recolour`
  // sweeps every massing vertex through the wall and roof palettes, and a window swept to a
  // siding colour is a hole that fills itself in
  const dg: Build = { pos: [], col: [], pal: [], lay: [], idx: [] }
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
  const dressList: { bd: Footprint; base: number; cx: number; cy: number }[] = []
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
    sites.push({ ring, height: h, heightSrc: bd.height_src, area: bd.area_m2 ?? 0, rect: bd.rect ?? null, base })
    if (dress) {
      let cx = 0, cy = 0
      for (const p of ring) { cx += p[0]; cy += p[1] }
      dressList.push({ bd: bd as Footprint, base, cx: cx / ring.length, cy: cy / ring.length })
    }
  }
  buildTiming.massMs += performance.now() - tGround0

  const pool: MassPool | null = opts.pool
    ? { wallIds: opts.pool.walls.map((w) => w.id), roofIds: opts.pool.roofs.map((w) => w.id), seed: opts.pool.seed }
    : null
  const mass = await massArrays(sites, pool, budget)

  // PASS 2 — the dressing. Its one main-thread input beyond the massing's is the street facing,
  // which comes from the road index, so it stays here for now (moving it means precomputing the
  // driveway slabs' corner ground samples — a follow-up).
  const tDress0 = performance.now()
  if (dress) {
    for (const d of dressList) {
      await budget.tick()
      dressed += dressBuilding(dg, d.bd, d.base, roads?.nearest(d.cx, d.cy) ?? null, groundAt)
    }
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
    if (opts.pool && mass.lay.some((l) => l >= 0)) await texturePoolMaterial(mat, opts.pool)
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
  if (dg.idx.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(dg.pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(dg.col, 3))
    geo.setIndex(dg.idx)
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
