// Building MASSING, off the main thread.
//
// `buildBuildings` draws two things per cell: the massing (a ring extruded to the height lidar
// measured, gabled on anything house-sized) and the dressing (windows, doors, gutters — see
// dressing.ts). The massing is the larger half — 160–240 ms of a ~220–320 ms cell, measured with
// `site.buildingsTiming()` — and it is pure: given a ring, a height and a base, the vertices are a
// closed-form function of the footprint. The one main-thread input is the ground, and that is
// sampled once per ring vertex up front (`bases`), so what crosses to the worker is plain numbers.
//
// This module has NO THREE and no DOM. `build` fills plain arrays (which the worker converts to
// transferables and the fallback path converts to BufferAttributes), and `flatNormals` reproduces
// what `computeVertexNormals` does to the result — the massing pushes three fresh vertices per
// triangle, so every vertex lies in exactly one face and its normal IS the face normal.
//
// The loop is copied verbatim from buildings.ts (same winding, same carve, the same palette and
// pool picks) so a worker cell is identical to a main-thread one. Keep them in step.

import { pickFromPool } from '../assets/surfacesdoc'
import { buildingKey, packLayer, pickWeighted, type PlanClass } from './facades'

/** site x, y (north), z (up) → three.js world; the mapping buildings.ts keeps local too */
const WX = (x: number, _y: number, _z: number) => x
const WY = (_x: number, _y: number, z: number) => z
const WZ = (_x: number, y: number, _z: number) => -y

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

/** A footprint's minimum rotated rectangle, as the bake emits it. */
export interface MassRect {
  yaw_deg: number
  w: number
  d: number
}

/** One building's massing inputs. `base` is the sunk lowest ground under the ring, sampled on the
 * main thread (the only thing the worker cannot compute). */
export interface MassInput {
  ring: [number, number][]
  height: number
  heightSrc?: string
  area: number
  rect?: MassRect | null
  base: number
  /** the building's class slot in `MassPool.facades` (facades.ts), classified on the main thread; -1 or absent is none */
  fslot?: number
}

/** The world's building texture pools, reduced to what the palette pick needs. */
export interface MassPool {
  wallIds: string[]
  roofIds: string[]
  seed: number
  /**
   * The building classes' pools, as texture layers (facades.ts `facadePlan`). When present it is
   * the whole answer — the world's own wall/roof pool is folded into it by `resolveFacades` — and a
   * vertex's layer is `class × 64 + texture` so the class's surface rides with it.
   */
  facades?: { classes: PlanClass[] } | null
}

/** The massing, as transferable typed arrays plus what the caller still has to wrap and count. */
export interface MassArrays {
  pos: Float32Array
  col: Float32Array
  /** which palette entry coloured each vertex: 0..6 a wall, 100 + 0..3 a roof */
  pal: Int16Array
  /** which world texture layer draws each vertex; -1 is the flat palette colour */
  lay: Float32Array
  idx: Uint32Array
  norm: Float32Array
  gabled: number
  fromLidar: number
}

interface Build {
  pos: number[]
  col: number[]
  pal: number[]
  /** which layer of the world's texture pool draws each vertex; -1 is the flat palette colour */
  lay: number[]
  idx: number[]
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

/**
 * Carve a footprint into rectangles, in the footprint's own frame.
 *
 * Rich: "steepled roofs don't follow the OSM data for the house layout." A straight skeleton is
 * the proper answer and a lot of code; suburban footprints are rectilinear in practice, so this
 * rasterises the ring at `cell` metres in the frame of its long axis and pulls out the largest
 * all-inside rectangle repeatedly (the histogram-and-stack maximal rectangle, O(cells) a pass)
 * until the ring is covered or the next piece would be too narrow to roof.
 */
function carveRects(ring: [number, number][], cx: number, cy: number, ux: number, uy: number, cell: number): { u0: number; u1: number; v0: number; v1: number }[] {
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

/** A fresh-vertex triangle in SITE coords, projected to world. Every massing vertex is unique. */
function pushTri(b: Build, ax: number, ay: number, az: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, colour: [number, number, number], pal: number, layer: number) {
  const k = b.pos.length / 3
  const textured = layer >= 0
  const v = [[ax, ay, az], [cx, cy, cz], [dx, dy, dz]]
  for (const [x, y, z] of v) {
    b.pos.push(WX(x, y, z), WY(x, y, z), WZ(x, y, z))
    // a textured face is drawn white under its map; the palette colour would tint the bricks
    if (textured) b.col.push(1, 1, 1)
    else b.col.push(colour[0], colour[1], colour[2])
    b.pal.push(pal)
    b.lay.push(layer)
  }
  b.idx.push(k, k + 1, k + 2)
}

/**
 * Build the massing for a cell. `yieldFn`, when given, is awaited between buildings so the
 * main-thread fallback can hand the frame back; the worker passes nothing.
 */
export async function buildMassing(list: MassInput[], pool: MassPool | null, yieldFn?: () => Promise<void>): Promise<MassArrays> {
  const b: Build = { pos: [], col: [], pal: [], lay: [], idx: [] }
  let gabled = 0
  let fromLidar = 0
  for (const bd of list) {
    if (yieldFn) await yieldFn()
    const ring = (bd.ring ?? []) as [number, number][]
    if (ring.length < 3) continue
    const h = Math.max(2.4, bd.height ?? 6)
    if (bd.heightSrc === 'lidar' || bd.heightSrc === 'osm') fromLidar++
    const base = bd.base

    // wind the ring counter-clockwise so wall quads face outward
    const cw = signedArea(ring) < 0
    const r = cw ? [...ring].reverse() : ring
    const seed = hash2(r[0][0], r[0][1])
    const wi = Math.floor(seed * WALLS.length) % WALLS.length
    const ri = Math.floor(hash2(r[0][1], r[0][0]) * ROOFS.length) % ROOFS.length
    const wall = WALLS[wi]
    const roof = ROOFS[ri]
    let wallLayer = -1
    let roofLayer = -1
    const fc = pool?.facades && bd.fslot !== undefined && bd.fslot >= 0 ? pool.facades.classes[bd.fslot] : null
    if (pool?.facades) {
      // ONE WALL AND ONE ROOF PER BUILDING, from its class's pools, by its own key: the same
      // building draws the same bricks on every load and in whichever tile holds it
      if (fc) {
        const key = buildingKey(r)
        const w = pickWeighted(fc.walls.map((e) => e.weight), key, 0x5bd1e995)
        const f = pickWeighted(fc.roofs.map((e) => e.weight), key, 0x27d4eb2f)
        if (w >= 0) wallLayer = packLayer(bd.fslot!, fc.walls[w].layer)
        if (f >= 0) roofLayer = packLayer(bd.fslot!, fc.roofs[f].layer)
      }
    } else {
      wallLayer = pool?.wallIds.length ? pool.wallIds.findIndex((id) => id === pickFromPool(pool.wallIds, Math.floor(seed * 65536), pool.seed)) : -1
      roofLayer = pool?.roofIds.length ? pool.wallIds.length + pool.roofIds.findIndex((id) => id === pickFromPool(pool.roofIds, Math.floor(hash2(r[0][1], r[0][0]) * 65536), pool.seed + 7)) : -1
    }

    // house-sized things get a gable; sheds, strip malls, warehouses and towers stay flat
    const area = bd.area ?? 0
    const rect = bd.rect
    const gable = !!rect && area > 25 && area < 500 && h < 12 && rect.d > 3
    const eaves = gable ? base + h * 0.7 : base + h

    for (let i = 0; i < r.length; i++) {
      const [x0, y0] = r[i]
      const [x1, y1] = r[(i + 1) % r.length]
      pushTri(b, x0, y0, base, x1, y1, base, x1, y1, eaves, wall, wi, wallLayer)
      pushTri(b, x0, y0, base, x1, y1, eaves, x0, y0, eaves, wall, wi, wallLayer)
    }

    if (gable && rect) {
      // rect.yaw_deg is a MATH angle counter-clockwise from east describing the long axis — the
      // long axis is (cos, sin) of it, in SITE coordinates. The ring is carved into rectangles in
      // that frame and each one gets a gable along ITS long side; a ring that carves to nothing (a
      // round or diagonal footprint) falls back to one ridge over the bounding rectangle.
      const cxs = r.reduce((s, p) => s + p[0], 0) / r.length
      const cys = r.reduce((s, p) => s + p[1], 0) / r.length
      const a2 = (rect.yaw_deg * Math.PI) / 180
      const ux = Math.cos(a2), uy = Math.sin(a2) // along the long axis
      const vx = -uy, vy = ux // across it
      const cell = Math.max(0.5, Math.sqrt(area) / 40)
      let pieces = carveRects(r, cxs, cys, ux, uy, cell)
      if (!pieces.length) pieces = [{ u0: -rect.w / 2, u1: rect.w / 2, v0: -rect.d / 2, v1: rect.d / 2 }]
      const OVER = 0.3 // eaves overhang past the wall
      const at = (u: number, v: number, y: number): [number, number, number] => [cxs + ux * u + vx * v, cys + uy * u + vy * v, y]
      for (const q of pieces) {
        const w = q.u1 - q.u0, d = q.v1 - q.v0
        const alongU = w >= d // the ridge runs along the longer side
        const pu0 = q.u0 - OVER, pu1 = q.u1 + OVER, pv0 = q.v0 - OVER, pv1 = q.v1 + OVER
        // the ridge line, at the piece's centre across its short axis; a narrow piece stays lower
        // so a porch roof does not tower over the house it is attached to
        const rise = Math.min(h - (eaves - base), Math.min(w, d) * 0.45)
        const ry = eaves + rise
        const um = (pu0 + pu1) / 2, vm = (pv0 + pv1) / 2
        const e00 = at(pu0, pv0, eaves), e10 = at(pu1, pv0, eaves), e11 = at(pu1, pv1, eaves), e01 = at(pu0, pv1, eaves)
        if (alongU) {
          const rA = at(pu0, vm, ry), rB = at(pu1, vm, ry)
          pushTri(b, e00[0], e00[1], e00[2], e10[0], e10[1], e10[2], rB[0], rB[1], rB[2], roof, 100 + ri, roofLayer)
          pushTri(b, e00[0], e00[1], e00[2], rB[0], rB[1], rB[2], rA[0], rA[1], rA[2], roof, 100 + ri, roofLayer)
          pushTri(b, e11[0], e11[1], e11[2], e01[0], e01[1], e01[2], rA[0], rA[1], rA[2], roof, 100 + ri, roofLayer)
          pushTri(b, e11[0], e11[1], e11[2], rA[0], rA[1], rA[2], rB[0], rB[1], rB[2], roof, 100 + ri, roofLayer)
          pushTri(b, e00[0], e00[1], e00[2], rA[0], rA[1], rA[2], e01[0], e01[1], e01[2], wall, wi, wallLayer)
          pushTri(b, e10[0], e10[1], e10[2], e11[0], e11[1], e11[2], rB[0], rB[1], rB[2], wall, wi, wallLayer)
        } else {
          const rA = at(um, pv0, ry), rB = at(um, pv1, ry)
          pushTri(b, e10[0], e10[1], e10[2], e11[0], e11[1], e11[2], rB[0], rB[1], rB[2], roof, 100 + ri, roofLayer)
          pushTri(b, e10[0], e10[1], e10[2], rB[0], rB[1], rB[2], rA[0], rA[1], rA[2], roof, 100 + ri, roofLayer)
          pushTri(b, e01[0], e01[1], e01[2], e00[0], e00[1], e00[2], rA[0], rA[1], rA[2], roof, 100 + ri, roofLayer)
          pushTri(b, e01[0], e01[1], e01[2], rA[0], rA[1], rA[2], rB[0], rB[1], rB[2], roof, 100 + ri, roofLayer)
          pushTri(b, e00[0], e00[1], e00[2], e10[0], e10[1], e10[2], rA[0], rA[1], rA[2], wall, wi, wallLayer)
          pushTri(b, e11[0], e11[1], e11[2], e01[0], e01[1], e01[2], rB[0], rB[1], rB[2], wall, wi, wallLayer)
        }
      }
      gabled++
    } else {
      // flat roof: fan from the centroid, which is exact for convex rings and close enough for
      // the simplified L-shapes the bake emits
      const cxs = r.reduce((s, p) => s + p[0], 0) / r.length
      const cys = r.reduce((s, p) => s + p[1], 0) / r.length
      for (let i = 0; i < r.length; i++) {
        const [x0, y0] = r[i]
        const [x1, y1] = r[(i + 1) % r.length]
        pushTri(b, cxs, cys, eaves, x0, y0, eaves, x1, y1, eaves, roof, 100 + ri, roofLayer)
      }
    }
  }

  const pos = Float32Array.from(b.pos)
  const col = Float32Array.from(b.col)
  const pal = Int16Array.from(b.pal)
  const lay = Float32Array.from(b.lay)
  const idx = Uint32Array.from(b.idx)
  const norm = new Float32Array(pos.length)
  flatNormals(pos, idx, norm)
  return { pos, col, pal, lay, idx, norm, gabled, fromLidar }
}

/**
 * Indexed normals for a mesh whose vertices are never shared. Each index appears in exactly one
 * triangle, so the accumulated normal is the face normal — the same result `computeVertexNormals`
 * gives this geometry.
 */
export function flatNormals(pos: Float32Array, idx: Uint32Array, out: Float32Array): void {
  out.fill(0)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2]
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2]
    let nx = aby * acz - abz * acy
    let ny = abz * acx - abx * acz
    let nz = abx * acy - aby * acx
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= len; ny /= len; nz /= len
    out[a] = nx; out[a + 1] = ny; out[a + 2] = nz
    out[b] = nx; out[b + 1] = ny; out[b + 2] = nz
    out[c] = nx; out[c + 1] = ny; out[c + 2] = nz
  }
}
