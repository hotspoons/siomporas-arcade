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

/** site x, y (north), z (up) → three.js world; the same mapping scene.ts uses, kept local to avoid an import cycle */
const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y)

export interface BuildingStats {
  count: number
  gabled: number
  fromLidar: number
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
  idx: number[]
}

function pushTri(b: Build, a: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, colour: [number, number, number], pal: number) {
  const k = b.pos.length / 3
  for (const v of [a, c, d]) {
    b.pos.push(v.x, v.y, v.z)
    b.col.push(colour[0], colour[1], colour[2])
    b.pal.push(pal)
  }
  b.idx.push(k, k + 1, k + 2)
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
export async function buildBuildings(manifest: Manifest, groundAt: (x: number, z: number) => number | null, sliceMs = 8): Promise<{ group: THREE.Group; stats: BuildingStats; recolour: (walls: [number, number, number][], roofs: [number, number, number][]) => void }> {
  const group = new THREE.Group()
  group.name = 'buildings'
  const list = manifest.buildings ?? []
  const b: Build = { pos: [], col: [], pal: [], idx: [] }
  let gabled = 0
  let fromLidar = 0

  const budget = new Budget(sliceMs)
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
          pushTri(b, e00, e10, rB, roof, 100 + ri)
          pushTri(b, e00, rB, rA, roof, 100 + ri)
          pushTri(b, e11, e01, rA, roof, 100 + ri)
          pushTri(b, e11, rA, rB, roof, 100 + ri)
          pushTri(b, e00, rA, e01, wall, wi)
          pushTri(b, e10, e11, rB, wall, wi)
        } else {
          const rA = at(um, pv0, ry), rB = at(um, pv1, ry)
          pushTri(b, e10, e11, rB, roof, 100 + ri)
          pushTri(b, e10, rB, rA, roof, 100 + ri)
          pushTri(b, e01, e00, rA, roof, 100 + ri)
          pushTri(b, e01, rA, rB, roof, 100 + ri)
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
      for (let i = 0; i < r.length; i++) {
        const [x0, y0] = r[i]
        const [x1, y1] = r[(i + 1) % r.length]
        pushTri(b, mid, toWorld(x0, y0, eaves), toWorld(x1, y1, eaves), roof, 100 + ri)
      }
    }
  }

  let recolour = (_w: [number, number, number][], _r: [number, number, number][]) => {}
  if (b.idx.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3))
    const colAttr = new THREE.Float32BufferAttribute(b.col, 3)
    geo.setAttribute('color', colAttr)
    geo.setIndex(b.idx)
    geo.computeVertexNormals()
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'buildings:massing'
    group.add(mesh)
    // a style swaps the palettes: every vertex remembers which entry it drew, so this is one
    // pass over the colour attribute and no geometry
    const pal = Int16Array.from(b.pal)
    recolour = (walls, roofs) => {
      const arr = colAttr.array as Float32Array
      for (let i = 0; i < pal.length; i++) {
        const k = pal[i]
        const e = k >= 100 ? roofs[(k - 100) % roofs.length] : walls[k % walls.length]
        arr[i * 3] = e[0]
        arr[i * 3 + 1] = e[1]
        arr[i * 3 + 2] = e[2]
      }
      colAttr.needsUpdate = true
    }
  }
  return { group, stats: { count: list.length, gabled, fromLidar }, recolour }
}
