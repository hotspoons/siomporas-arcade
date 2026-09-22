// Parking lots: the asphalt a strip mall is mostly made of, and the paint on it.
//
// Crofton has 233 `amenity=parking` polygons, from a 34 m² pull-in to a 64 000 m² park-and-ride,
// and we drew none of them — so every shopping centre on the site was a row of buildings standing
// in grass with a road going past. A lot is not a texture problem; what makes one read as a car
// park at any distance is the STALL GRID, the regular ladder of white bays either side of an
// aisle, and that is what most of this file is about.
//
// The aisles are not invented. OSM maps them as `highway=service, service=parking_aisle` and the
// bake already carries them, as `driveways` — 895 of them on Crofton. So a bay is laid at right
// angles to a real aisle, on both sides, clipped to the lot, which puts the rows where the rows
// actually are and makes them bend when the aisle bends. Only where a lot has no aisle mapped at
// all does it fall back to a grid squared to the lot's own longest edge.
//
// Two meshes for every lot on the site: one for the asphalt, one for the paint. The paint sits a
// couple of centimetres above the surface rather than being blended into it, which is the cheap
// way and also the one that survives the lot being on a slope.
import * as THREE from 'three'
import { BoundsIndex } from './strip'
import type { Manifest } from './site'
import * as T from './tuning'

export interface ParkingResult {
  group: THREE.Group
  counts: { lots: number; stalls: number; skippedOnRoad: number; skippedKind: number; fromAisles: number; fromFallback: number }
}

type Pt = [number, number] // world x, z

const EPS = 1e-6

/** Even-odd point in polygon, on world x/z. */
function inside(poly: Pt[], x: number, z: number): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]
    const [xj, zj] = poly[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + EPS) + xi) c = !c
  }
  return c
}

function ringArea(poly: Pt[]): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
  return Math.abs(a) / 2
}

/**
 * The lot's surface, triangulated.
 *
 * `THREE.Shape` does the ear clipping and handles the holes an OSM multipolygon brings with it
 * (an island in the middle of a car park is usually a building or a planter). The shape is built
 * in x/z and the height comes afterwards, per vertex, from the ground — a lot on a slope is still
 * a flat plane in OSM and very much is not one on the site.
 */
function lotGeometry(ring: Pt[], holes: Pt[][], groundAt: (x: number, z: number) => number | null, fallbackY: number): THREE.BufferGeometry | null {
  if (ring.length < 3) return null
  const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, z)))
  for (const h of holes) {
    if (h.length >= 3) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, z))))
  }
  let geo: THREE.ShapeGeometry
  try {
    geo = new THREE.ShapeGeometry(shape)
  } catch {
    return null
  }
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  if (!pos || pos.count < 3) {
    geo.dispose()
    return null
  }
  // ShapeGeometry lays the shape in the XY plane; lift it into XZ and put it on the ground
  const out = new THREE.BufferGeometry()
  const n = pos.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i)
    const z = pos.getY(i)
    arr[i * 3] = x
    arr[i * 3 + 1] = (groundAt(x, z) ?? fallbackY) + T.PARKING_LIFT
    arr[i * 3 + 2] = z
  }
  out.setAttribute('position', new THREE.BufferAttribute(arr, 3))
  const idx = geo.index
  if (idx) {
    // ShapeGeometry winds for the XY plane; moving Y→Z flips the facing, so reverse it
    const src = idx.array
    const flipped = new Uint32Array(src.length)
    for (let i = 0; i < src.length; i += 3) {
      flipped[i] = src[i]
      flipped[i + 1] = src[i + 2]
      flipped[i + 2] = src[i + 1]
    }
    out.setIndex(new THREE.BufferAttribute(flipped, 1))
  }
  out.computeVertexNormals()
  geo.dispose()
  return out
}

/** A painted stripe on the ground: a thin quad from a to b, `w` wide, at the given heights. */
function stripe(into: { pos: number[]; idx: number[] }, ax: number, az: number, bx: number, bz: number, ya: number, yb: number, w: number) {
  const dx = bx - ax
  const dz = bz - az
  const l = Math.hypot(dx, dz)
  if (l < 1e-3) return
  const nx = (-dz / l) * w * 0.5
  const nz = (dx / l) * w * 0.5
  const base = into.pos.length / 3
  into.pos.push(ax - nx, ya, az - nz, ax + nx, ya, az + nz, bx + nx, yb, bz + nz, bx - nx, yb, bz - nz)
  into.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
}

/**
 * Build every parking lot on the site.
 *
 * `edgeDistance` decides which lots are real: a polygon that lies over a carriageway is either an
 * OSM lot that includes its own access road, or one whose road we have drawn straight through, and
 * paving it puts a second surface on top of the one the car drives on.
 */
/**
 * Is this world point on a parking surface?
 *
 * Built from the manifest alone, so `scene.ts` can have it BEFORE the grass is planted — the
 * parking meshes are made much later and the grass needs the answer first. Without it the verge
 * planter only knows `roadDistance`, so it happily grows turf across a supermarket car park:
 * visible as green tufts scattered over the asphalt in any open lot.
 *
 * Rings are bucketed by bounds, because a network site has hundreds of lots and this is called
 * once per candidate blade.
 */
export function parkingCover(manifest: Manifest, margin = 3): (x: number, z: number) => boolean {
  const lots = (manifest.parking ?? []).filter((l) => (l.ring?.length ?? 0) >= 3)
  if (!lots.length) return () => false
  const rings = lots.map((l) => {
    const ring = l.ring.map(([x, y]) => [x, -y] as Pt)
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    for (const [x, z] of ring) {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (z < z0) z0 = z
      if (z > z1) z1 = z
    }
    return { ring, bounds: [x0, z0, x1, z1] as [number, number, number, number] }
  })
  const index = new BoundsIndex(rings, 250, margin + 1)

  /** distance from (x, z) to the nearest ring edge — the ring is dilated by `margin` */
  const nearEdge = (ring: Pt[], x: number, z: number): boolean => {
    const m2 = margin * margin
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[j], [bx, bz] = ring[i]
      const dx = bx - ax, dz = bz - az
      const len2 = dx * dx + dz * dz
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0
      const qx = ax + t * dx - x, qz = az + t * dz - z
      if (qx * qx + qz * qz < m2) return true
    }
    return false
  }

  // DILATED BY `margin`, and that is not belt-and-braces. The grass tests a 1 m CELL CENTRE and
  // then places the blade up to cell/2 + scatter/2 away from it — about 1.6 m with Rich's saved
  // GRASS_SCATTER of 1.9 — so testing the bare polygon leaked blades over the edge of every lot.
  // Measured: the undilated version still put 52 of 10 224 sampled blades on asphalt.
  return (x, z) => index.firstAt(x, z, (r) => (inside(r.ring, x, z) || nearEdge(r.ring, x, z) ? true : null)) === true
}

export function buildParking(
  manifest: Manifest,
  groundAt: (x: number, z: number) => number | null,
  edgeDistance: (x: number, z: number) => number,
): ParkingResult {
  const group = new THREE.Group()
  group.name = 'parking'
  const counts = { lots: 0, stalls: 0, skippedOnRoad: 0, skippedKind: 0, fromAisles: 0, fromFallback: 0 }
  const lots = manifest.parking ?? []
  if (!lots.length) return { group, counts }

  // the aisles, already in the manifest as driveways — no need to carry them twice
  const aisles: { pts: Pt[]; half: number }[] = []
  for (const d of manifest.driveways ?? []) {
    if (d.service !== 'parking_aisle') continue
    aisles.push({ pts: d.coords.map((c) => [c[0], -c[1]] as Pt), half: (d.width_m || 5) / 2 })
  }

  const surf: THREE.BufferGeometry[] = []
  const paint = { pos: [] as number[], idx: [] as number[] }

  for (const lot of lots) {
    // a roof or a basement is not ground to pave
    if (lot.kind === 'multi-storey' || lot.kind === 'underground' || lot.kind === 'rooftop') {
      counts.skippedKind++
      continue
    }
    const ring: Pt[] = lot.ring.map(([x, y]) => [x, -y] as Pt)
    if (ring.length < 3) continue

    // Does it lie over a carriageway? On a LATTICE over the lot's interior, not on ring midpoints:
    // a lot is rarely convex, so the midpoint of a vertex and the centroid is often outside it,
    // and the test was measuring points the lot does not contain.
    let cx = 0
    let cz = 0
    let x0 = Infinity
    let x1 = -Infinity
    let z0 = Infinity
    let z1 = -Infinity
    for (const [x, z] of ring) {
      cx += x
      cz += z
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      z0 = Math.min(z0, z)
      z1 = Math.max(z1, z)
    }
    cx /= ring.length
    cz /= ring.length
    let onRoad = 0
    let samples = 0
    const gstep = Math.max(2, Math.min(12, Math.hypot(x1 - x0, z1 - z0) / 12))
    for (let x = x0; x <= x1; x += gstep) {
      for (let z = z0; z <= z1; z += gstep) {
        if (!inside(ring, x, z)) continue
        samples++
        if (edgeDistance(x, z) < 0) onRoad++
      }
    }
    if (samples >= 4 && onRoad / samples > T.PARKING_ROAD_OVERLAP) {
      counts.skippedOnRoad++
      continue
    }

    const holes: Pt[][] = (lot.holes ?? []).map((h) => h.map(([x, y]) => [x, -y] as Pt))
    const geo = lotGeometry(ring, holes, groundAt, lot.z)
    if (!geo) continue
    surf.push(geo)
    counts.lots++

    // --- the stalls ----------------------------------------------------------------------------
    const W = T.PARKING_STALL_W
    const D = T.PARKING_STALL_D
    const yAt = (x: number, z: number) => (groundAt(x, z) ?? lot.z) + T.PARKING_LIFT + T.PARKING_PAINT_LIFT
    /**
     * Lay bays along a line, on both sides.
     *
     * `half` is how far out the bay STARTS. An OSM aisle is a centreline and the aisle itself is
     * drawn as asphalt about five metres wide, so bays that start at the centreline are painted
     * down the middle of the lane cars drive along — 36 % of the paint was over a carriageway
     * before this, almost all of it the aisle's own.
     */
    let nearAisle: ((x: number, z: number) => boolean) | null = null
    const bayAlong = (ax: number, az: number, bx: number, bz: number, half: number) => {
      const dx = bx - ax
      const dz = bz - az
      const len = Math.hypot(dx, dz)
      if (len < W) return
      const ux = dx / len
      const uz = dz / len
      const px = -uz
      const pz = ux
      const n = Math.floor(len / W)
      for (let i = 0; i <= n; i++) {
        const t = i * W
        const sx = ax + ux * t
        const sz = az + uz * t
        for (const sgn of [1, -1]) {
          // the bay runs from the aisle EDGE outward; keep it only if both ends are in the lot and
          // off the road, which is what stops a row running out across the verge
          const nx = sx + px * sgn * half
          const nz = sz + pz * sgn * half
          const fx = sx + px * sgn * (half + D)
          const fz = sz + pz * sgn * (half + D)
          if (!inside(ring, fx, fz) || !inside(ring, nx, nz)) continue
          if (holes.some((h) => inside(h, fx, fz) || inside(h, nx, nz))) continue
          if (edgeDistance(fx, fz) < 0 || edgeDistance(nx, nz) < 0) continue
          if (nearAisle && nearAisle(nx, nz)) continue
          stripe(paint, nx, nz, fx, fz, yAt(nx, nz), yAt(fx, fz), T.PARKING_PAINT_W)
          counts.stalls++
        }
      }
    }

    let used = 0
    const mine: { ax: number; az: number; bx: number; bz: number }[] = []
    const before = counts.stalls
    for (const a of aisles) {
      for (let i = 0; i + 1 < a.pts.length; i++) {
        const [ax, az] = a.pts[i]
        const [bx, bz] = a.pts[i + 1]
        // the segment has to be in this lot
        if (!inside(ring, (ax + bx) / 2, (az + bz) / 2)) continue
        mine.push({ ax, az, bx, bz })
        bayAlong(ax, az, bx, bz, a.half + T.PARKING_AISLE_GAP)
        used++
      }
    }
    if (used) counts.fromAisles++
    // Aisles are mapped patchily, and a 64 000 m² park-and-ride with its aisles drawn only round
    // the rim comes out as a lake of asphalt with one ladder of bays at the top. So if what the
    // aisles produced is thin for the lot's size, fill the rest with the squared grid as well —
    // keeping clear of the aisles that ARE mapped, so the two do not paint over each other.
    const area = ringArea(ring)
    const got = counts.stalls - before
    const thin = area > T.PARKING_MIN_GRID_M2 && got * T.PARKING_FILL_M2 < area
    if (!used || thin) {
      // rows squared to the lot's longest edge, which is the direction a lot is almost always
      // laid out along
      counts.fromFallback++
      nearAisle = (x: number, z: number) => {
        for (const m of mine) {
          const dx = m.bx - m.ax
          const dz = m.bz - m.az
          const l2 = dx * dx + dz * dz
          const t = l2 < 1e-6 ? 0 : Math.max(0, Math.min(1, ((x - m.ax) * dx + (z - m.az) * dz) / l2))
          if (Math.hypot(x - (m.ax + dx * t), z - (m.az + dz * t)) < T.PARKING_STALL_D + T.PARKING_AISLE_W * 0.5) return true
        }
        return false
      }
      let lx = 1
      let lz = 0
      let best = 0
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const dx = ring[i][0] - ring[j][0]
        const dz = ring[i][1] - ring[j][1]
        const l = Math.hypot(dx, dz)
        if (l > best) {
          best = l
          lx = dx / l
          lz = dz / l
        }
      }
      let x0 = Infinity
      let x1 = -Infinity
      let z0 = Infinity
      let z1 = -Infinity
      for (const [x, z] of ring) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        z0 = Math.min(z0, z)
        z1 = Math.max(z1, z)
      }
      const span = Math.hypot(x1 - x0, z1 - z0)
      const pitch = D * 2 + T.PARKING_AISLE_W
      for (let o = -span / 2; o <= span / 2; o += pitch) {
        const mx = cx - lz * o
        const mz = cz + lx * o
        bayAlong(mx - lx * span * 0.5, mz - lz * span * 0.5, mx + lx * span * 0.5, mz + lz * span * 0.5, T.PARKING_AISLE_W / 2)
      }
    }
  }

  if (surf.length) {
    // one merged mesh: 231 lots is 231 draw calls otherwise, for what is conceptually one surface
    const pos: number[] = []
    const nor: number[] = []
    const idx: number[] = []
    for (const g of surf) {
      const gp = g.getAttribute('position') as THREE.BufferAttribute
      const gn = g.getAttribute('normal') as THREE.BufferAttribute
      const gi = g.index
      const base = pos.length / 3
      for (let i = 0; i < gp.count; i++) {
        pos.push(gp.getX(i), gp.getY(i), gp.getZ(i))
        nor.push(gn.getX(i), gn.getY(i), gn.getZ(i))
      }
      if (gi) for (let i = 0; i < gi.count; i++) idx.push(base + gi.getX(i))
      g.dispose()
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
    geo.setIndex(idx)
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4a4a4c, roughness: 0.96, metalness: 0 }))
    mesh.name = 'parking:surface'
    mesh.frustumCulled = false
    group.add(mesh)
  }
  if (paint.pos.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(paint.pos, 3))
    geo.setIndex(paint.idx)
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcfcfc6, roughness: 0.85, metalness: 0 }))
    mesh.name = 'parking:paint'
    mesh.frustumCulled = false
    group.add(mesh)
  }
  return { group, counts }
}
