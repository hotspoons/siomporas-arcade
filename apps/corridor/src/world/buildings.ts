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
import { BUILDING_DRESSING, DRESS_WINDOW_WALLS } from '../tuning'
import { pickFromPool } from '../assets/surfacesdoc'
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

/** Palette: siding by a stable hash of position, roofs darker, so a street is not one colour. */
const WALLS: [number, number, number][] = [
  [0.82, 0.78, 0.70], // cream
  [0.72, 0.73, 0.68], // sage grey
  [0.68, 0.60, 0.52], // tan
  [0.55, 0.42, 0.36], // brick
  [0.80, 0.80, 0.80], // white
  [0.48, 0.52, 0.50], // slate green
  [0.64, 0.56, 0.44], // clapboard
]
const ROOFS: [number, number, number][] = [
  [0.28, 0.26, 0.25],
  [0.34, 0.30, 0.27],
  [0.24, 0.24, 0.26],
  [0.38, 0.28, 0.24],
]

/**
 * Carve a footprint into rectangles, in the footprint's own frame.
 *
 * Rich: "steepled roofs don't follow the OSM data for the house layout." The first roof was one
 * ridge along the minimum rotated rectangle of the whole ring, so an L-shaped house wore a
 * bounding-box hat. A straight skeleton is the proper answer and a lot of code; suburban
 * footprints are rectilinear in practice, so this rasterises the ring at `cell` metres in the
 * frame of its long axis and pulls out the largest all-inside rectangle repeatedly (the
 * histogram-and-stack maximal rectangle, O(cells) a pass) until the ring is covered or the next
 * piece would be too narrow to roof. Each rectangle gets its own gable. An L is two gables that
 * meet; a T is three; a plain box is still one.
 */
function carveRects(ring: [number, number][], cx: number, cy: number, ux: number, uy: number, cell: number): { u0: number; u1: number; v0: number; v1: number }[] {
  // the ring in the local frame: u along the long axis, v across
  const loc = ring.map(([x, y]) => [(x - cx) * ux + (y - cy) * uy, -(x - cx) * uy + (y - cy) * ux] as [number, number])
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
  for (const [u, v] of loc) { if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v }
  const cols = Math.max(1, Math.ceil((u1 - u0) / cell)), rows = Math.max(1, Math.ceil((v1 - v0) / cell))
  if (cols * rows > 12000) return []
  const inside = new Uint8Array(cols * rows)
  let total = 0
  for (let r = 0; r < rows; r++) {
    const v = v0 + (r + 0.5) * cell
    for (let c = 0; c < cols; c++) {
      const u = u0 + (c + 0.5) * cell
      // even-odd point in polygon
      let hit = false
      for (let i = 0, j = loc.length - 1; i < loc.length; j = i++) {
        const [ui, vi] = loc[i], [uj, vj] = loc[j]
        if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) hit = !hit
      }
      if (hit) { inside[r * cols + c] = 1; total++ }
    }
  }
  const out: { u0: number; u1: number; v0: number; v1: number }[] = []
  let covered = 0
  const heights = new Int32Array(cols)
  for (let pass = 0; pass < 6 && covered < total * 0.94; pass++) {
    // largest rectangle of uncovered inside cells
    let best = { area: 0, r0: 0, r1: 0, c0: 0, c1: 0 }
    heights.fill(0)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) heights[c] = inside[r * cols + c] ? heights[c] + 1 : 0
      const stack: number[] = []
      for (let c = 0; c <= cols; c++) {
        const h = c < cols ? heights[c] : 0
        while (stack.length && heights[stack[stack.length - 1]] >= h) {
          const top = stack.pop()!
          const hh = heights[top]
          const left = stack.length ? stack[stack.length - 1] + 1 : 0
          const area = hh * (c - left)
          if (area > best.area) best = { area, r0: r - hh + 1, r1: r, c0: left, c1: c - 1 }
        }
        stack.push(c)
      }
    }
    const w = (best.c1 - best.c0 + 1) * cell, d = (best.r1 - best.r0 + 1) * cell
    if (best.area === 0 || Math.min(w, d) < 2.4) break
    for (let r = best.r0; r <= best.r1; r++) for (let c = best.c0; c <= best.c1; c++) { inside[r * cols + c] = 0; covered++ }
    out.push({ u0: u0 + best.c0 * cell, u1: u0 + (best.c1 + 1) * cell, v0: v0 + best.r0 * cell, v1: v0 + (best.r1 + 1) * cell })
  }
  return out
}

function hash2(x: number, y: number): number {
  let n = Math.imul(Math.round(x * 7.3) | 0, 374761393) ^ Math.imul(Math.round(y * 7.3) | 0, 668265263)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

/** Signed area of a ring in site coords; positive is counter-clockwise. */
function signedArea(ring: [number, number][]): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return a / 2
}

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
let currentLayer = -1

function pushTri(b: Build, a: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, colour: [number, number, number], pal: number) {
  const k = b.pos.length / 3
  const textured = currentLayer >= 0
  for (const v of [a, c, d]) {
    b.pos.push(v.x, v.y, v.z)
    // a textured face is drawn white under its map; the palette colour would tint the bricks
    if (textured) b.col.push(1, 1, 1)
    else b.col.push(colour[0], colour[1], colour[2])
    b.pal.push(pal)
    b.lay.push(currentLayer)
  }
  b.idx.push(k, k + 1, k + 2)
}

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

export async function buildBuildings(manifest: Manifest, groundAt: (x: number, z: number) => number | null, sliceMs = 8, opts: { roads?: RoadIndex | null; dress?: boolean; pool?: TexturePool | null; budget?: Budget } = {}): Promise<{ group: THREE.Group; stats: BuildingStats; recolour: (walls: [number, number, number][], roofs: [number, number, number][]) => void }> {
  const group = new THREE.Group()
  group.name = 'buildings'
  const list = manifest.buildings ?? []
  const b: Build = { pos: [], col: [], pal: [], lay: [], idx: [] }
  // the dressing is its own geometry, not more triangles in the massing: a style's `recolour`
  // sweeps every massing vertex through the wall and roof palettes, and a window swept to a
  // siding colour is a hole that fills itself in
  const dg: Build = { pos: [], col: [], pal: [], lay: [], idx: [] }
  const roads = opts.roads ?? buildRoadIndex(manifest)
  const dress = opts.dress !== false && BUILDING_DRESSING > 0
  let gabled = 0
  let fromLidar = 0
  let dressed = 0

  const budget = opts.budget ?? new Budget(sliceMs)
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

    // wind the ring counter-clockwise so wall quads face outward
    const cw = signedArea(ring) < 0
    const r = cw ? [...ring].reverse() : ring
    const seed = hash2(r[0][0], r[0][1])
    const wi = Math.floor(seed * WALLS.length) % WALLS.length
    const ri = Math.floor(hash2(r[0][1], r[0][0]) * ROOFS.length) % ROOFS.length
    const wall = WALLS[wi]
    const roof = ROOFS[ri]
    // the world's pools, when it has them: a wall material and a roof material per building,
    // stable for the building and the seed (surfacesdoc.ts)
    const pool = opts.pool ?? null
    const wallLayer = pool?.walls.length ? pool.walls.findIndex((w) => w.id === pickFromPool(pool.walls.map((w) => w.id), Math.floor(seed * 65536), pool.seed)) : -1
    const roofLayer = pool?.roofs.length ? pool.walls.length + pool.roofs.findIndex((w) => w.id === pickFromPool(pool.roofs.map((w) => w.id), Math.floor(hash2(r[0][1], r[0][0]) * 65536), pool.seed + 7)) : -1
    currentLayer = wallLayer

    // house-sized things get a gable; sheds, strip malls, warehouses and towers stay flat
    const area = bd.area_m2 ?? 0
    const rect = bd.rect
    const gable = !!rect && area > 25 && area < 500 && h < 12 && rect.d > 3
    const eaves = gable ? base + h * 0.7 : base + h

    for (let i = 0; i < r.length; i++) {
      const [x0, y0] = r[i]
      const [x1, y1] = r[(i + 1) % r.length]
      const a = toWorld(x0, y0, base)
      const c = toWorld(x1, y1, base)
      const d = toWorld(x1, y1, eaves)
      const e = toWorld(x0, y0, eaves)
      pushTri(b, a, c, d, wall, wi)
      pushTri(b, a, d, e, wall, wi)
    }

    if (gable && rect) {
      // rect.yaw_deg is a MATH angle counter-clockwise from east describing the long axis (see
      // buildings.py) — the long axis is therefore (cos, sin) of it, in SITE coordinates. The
      // ring is carved into rectangles in that frame and each one gets a gable along ITS long
      // side; a ring that carves to nothing (a round or diagonal footprint) falls back to one
      // ridge over the bounding rectangle, as before.
      const cxs = r.reduce((s, p) => s + p[0], 0) / r.length
      const cys = r.reduce((s, p) => s + p[1], 0) / r.length
      const a2 = (rect.yaw_deg * Math.PI) / 180
      const ux = Math.cos(a2), uy = Math.sin(a2) // along the long axis
      const vx = -uy, vy = ux // across it
      const cell = Math.max(0.5, Math.sqrt(area) / 40)
      let pieces = carveRects(r, cxs, cys, ux, uy, cell)
      if (!pieces.length) pieces = [{ u0: -rect.w / 2, u1: rect.w / 2, v0: -rect.d / 2, v1: rect.d / 2 }]
      const ridgeY = base + h
      const OVER = 0.3 // eaves overhang past the wall
      const at = (u: number, v: number, y: number) => toWorld(cxs + ux * u + vx * v, cys + uy * u + vy * v, y)
      for (const q of pieces) {
        const w = q.u1 - q.u0, d = q.v1 - q.v0
        const alongU = w >= d // the ridge runs along the longer side
        const pu0 = q.u0 - OVER, pu1 = q.u1 + OVER, pv0 = q.v0 - OVER, pv1 = q.v1 + OVER
        // the ridge line, at the piece's centre across its short axis; a narrow piece stays
        // lower so a porch roof does not tower over the house it is attached to
        const rise = Math.min(h - (eaves - base), Math.min(w, d) * 0.45)
        const ry = eaves + rise
        const um = (pu0 + pu1) / 2, vm = (pv0 + pv1) / 2
        const e00 = at(pu0, pv0, eaves), e10 = at(pu1, pv0, eaves), e11 = at(pu1, pv1, eaves), e01 = at(pu0, pv1, eaves)
        if (alongU) {
          const rA = at(pu0, vm, ry), rB = at(pu1, vm, ry)
          currentLayer = roofLayer
          pushTri(b, e00, e10, rB, roof, 100 + ri)
          pushTri(b, e00, rB, rA, roof, 100 + ri)
          pushTri(b, e11, e01, rA, roof, 100 + ri)
          pushTri(b, e11, rA, rB, roof, 100 + ri)
          currentLayer = wallLayer
          pushTri(b, e00, rA, e01, wall, wi)
          pushTri(b, e10, e11, rB, wall, wi)
        } else {
          const rA = at(um, pv0, ry), rB = at(um, pv1, ry)
          currentLayer = roofLayer
          pushTri(b, e10, e11, rB, roof, 100 + ri)
          pushTri(b, e10, rB, rA, roof, 100 + ri)
          pushTri(b, e01, e00, rA, roof, 100 + ri)
          pushTri(b, e01, rA, rB, roof, 100 + ri)
          currentLayer = wallLayer
          pushTri(b, e00, e10, rA, wall, wi)
          pushTri(b, e11, e01, rB, wall, wi)
        }
      }
      void ridgeY
      gabled++
    } else {
      // flat roof: fan from the centroid, which is exact for convex rings and close enough for
      // the simplified L-shapes the bake emits
      const cxs = r.reduce((s, p) => s + p[0], 0) / r.length
      const cys = r.reduce((s, p) => s + p[1], 0) / r.length
      const mid = toWorld(cxs, cys, eaves)
      currentLayer = roofLayer
      for (let i = 0; i < r.length; i++) {
        const [x0, y0] = r[i]
        const [x1, y1] = r[(i + 1) % r.length]
        pushTri(b, mid, toWorld(x0, y0, eaves), toWorld(x1, y1, eaves), roof, 100 + ri)
      }
    }
    currentLayer = -1

    if (dress) {
      const c: [number, number] = [r.reduce((t, q) => t + q[0], 0) / r.length, r.reduce((t, q) => t + q[1], 0) / r.length]
      dressed += dressBuilding(dg, bd as Footprint, base, roads?.nearest(c[0], c[1]) ?? null, groundAt)
    }
  }

  let recolour = (_w: [number, number, number][], _r: [number, number, number][]) => {}
  if (b.idx.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3))
    const colAttr = new THREE.Float32BufferAttribute(b.col, 3)
    geo.setAttribute('color', colAttr)
    geo.setAttribute('layer', new THREE.Float32BufferAttribute(b.lay, 1))
    geo.setIndex(b.idx)
    geo.computeVertexNormals()
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide })
    if (opts.pool && b.lay.some((l) => l >= 0)) await texturePoolMaterial(mat, opts.pool)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'buildings:massing'
    group.add(mesh)
    // a style swaps the palettes: every vertex remembers which entry it drew, so this is one
    // pass over the colour attribute and no geometry — and a textured vertex is left alone
    const pal = Int16Array.from(b.pal)
    const lay = Int16Array.from(b.lay)
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
  return { group, stats: { count: list.length, gabled, fromLidar, dressed }, recolour }
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
