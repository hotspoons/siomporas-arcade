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
      // a ridge along the long axis of the minimum rotated rectangle, over a flat eaves plane.
      // rect.yaw_deg is a MATH angle counter-clockwise from east describing the long axis (see
      // buildings.py) — the long axis is therefore (cos, sin) of it, in SITE coordinates.
      const cxs = r.reduce((s, p) => s + p[0], 0) / r.length
      const cys = r.reduce((s, p) => s + p[1], 0) / r.length
      const a2 = (rect.yaw_deg * Math.PI) / 180
      const ux = Math.cos(a2), uy = Math.sin(a2) // along the ridge
      const vx = -uy, vy = ux // across it
      const hw = rect.w / 2, hd = rect.d / 2
      const ridgeY = base + h
      const corner = (su: number, sv: number, y: number) => toWorld(cxs + ux * hw * su + vx * hd * sv, cys + uy * hw * su + vy * hd * sv, y)
      const rEnd = (su: number) => toWorld(cxs + ux * hw * su, cys + uy * hw * su, ridgeY)
      const e00 = corner(-1, -1, eaves), e10 = corner(1, -1, eaves), e11 = corner(1, 1, eaves), e01 = corner(-1, 1, eaves)
      const rA = rEnd(-1), rB = rEnd(1)
      // two slopes
      pushTri(b, e00, e10, rB, roof, 100 + ri)
      pushTri(b, e00, rB, rA, roof, 100 + ri)
      pushTri(b, e11, e01, rA, roof, 100 + ri)
      pushTri(b, e11, rA, rB, roof, 100 + ri)
      // two gable ends
      pushTri(b, e00, rA, e01, wall, wi)
      pushTri(b, e10, e11, rB, wall, wi)
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
