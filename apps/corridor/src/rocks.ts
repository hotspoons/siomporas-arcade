// Rock on the cut faces and the outcrops: what the bake measured (manifest.cuts from cuts.py,
// manifest.rock from rock.py) dressed with the rock kit.
//
//   faces     every cut face is a strip between its toe and its top, every 10 m along the road.
//             Boulders and ledge blocks are scattered over that strip — denser where the face is
//             taller and steeper, none within ROCK_PAVEMENT_CLEAR of any pavement edge — with the
//             tree instancing pattern: one InstancedMesh per kit variant, matrices set once.
//   outcrops  rock.py's polygons get the same treatment at a density per square metre.
//   kit       catalog.json entries with `category: "rock"`; `rock_type` (shale | sandstone |
//             greenstone | phyllite | schist | granite | limestone | sand) picks the set that
//             matches the face's lithology, `unknown` falls back to whatever exists. Until a GLB
//             lands the variant is a procedural boulder: a displaced icosahedron in the
//             lithology's colour, so the dressing is visible and measurable now and the model is
//             a drop-in later (a catalog `glb` replaces the geometry, nothing else changes).
//
// Everything is placed on `groundAt` (the strip near the road, the DEM beyond) — the face IS the
// ground here, so a boulder sits where the lidar says the rock is. Positions are hashed from the
// face id and station so a reload lands every rock in the same place.
import * as THREE from 'three'
import * as T from './tuning'
import type { CatalogEntry } from './placements'
import { loadAssetModel } from './placements'

export interface CutStation {
  s: number
  toe: [number, number, number] // site x, y (relative to origin), z NAVD88
  top: [number, number, number]
}

export interface CutFace {
  id: string
  side: 'left' | 'right'
  class: 'artificial' | 'natural'
  s_start: number
  s_end: number
  length_m: number
  toe_m: number
  top_m: number
  height_m: number
  height_max_m: number
  slope: number
  rock_type: string
  formation: string | null
  lith: string | null
  stations: CutStation[]
}

export interface RockPolygon {
  id: string
  ring: [number, number][] // site frame relative to origin
  area_m2: number
  slope_deg: number
  rough_m: number
  rock_type: string
  in_cut: boolean
}

export interface CutsLayer { faces: CutFace[]; summary?: Record<string, unknown> }
export interface RockLayer { polygons: RockPolygon[]; summary?: Record<string, unknown> }

/** flat colours per rock type for the procedural stand-in; a GLB brings its own */
const ROCK_COLOUR: Record<string, number> = {
  shale: 0x5c5a55, sandstone: 0x9c8a6a, greenstone: 0x4f5e52, phyllite: 0x6f7178, schist: 0x7a7570,
  granite: 0x8c8a86, limestone: 0x9a968c, sand: 0xc2ad86, unknown: 0x6e6a64,
}

/** stable 0..1 hash */
function h2(a: number, b: number): number {
  let h = (Math.floor(a * 1000) * 73856093) ^ (Math.floor(b * 1000) * 19349663)
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/** a blocky boulder: an icosahedron pushed about by a hash so no two look the same, base at y=0 */
function boulderGeometry(seed: number, blocky: boolean): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 1)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i))
    const k = 0.72 + 0.56 * h2(seed + v.x * 3.1, v.y * 5.3 + v.z * 7.7)
    v.multiplyScalar(k)
    if (blocky) v.set(Math.round(v.x * 6) / 6, Math.round(v.y * 6) / 6, Math.round(v.z * 6) / 6)
    pos.setXYZ(i, v.x, v.y * 0.8, v.z)
  }
  // merge to sharpen: flat shading reads as fractured rock
  const merged = g.toNonIndexed()
  merged.computeVertexNormals()
  merged.computeBoundingBox()
  merged.translate(0, -merged.boundingBox!.min.y, 0)
  return merged
}

interface Variant {
  entry: CatalogEntry | null
  rockType: string
  mesh: THREE.InstancedMesh
  count: number
  /** model height at scale 1 */
  nativeH: number
}

export interface RocksResult {
  group: THREE.Group
  /** how many instances were placed per rock type, for the probe */
  counts: Record<string, number>
  faces: number
  polygons: number
}

/**
 * Build the rock dressing. `groundAt(x, z)` and `edgeDistance(x, z)` are world-frame (site y = −z).
 */
export async function buildRocks(
  cuts: CutsLayer | null | undefined,
  rock: RockLayer | null | undefined,
  catalog: Map<string, CatalogEntry>,
  groundAt: (x: number, z: number) => number | null,
  edgeDistance: (x: number, z: number) => number,
): Promise<RocksResult> {
  const group = new THREE.Group()
  group.name = 'rocks'
  const counts: Record<string, number> = {}
  const faces = cuts?.faces ?? []
  const polys = rock?.polygons ?? []
  if (!faces.length && !polys.length) return { group, counts, faces: 0, polygons: 0 }

  // --- the kit: catalog rock entries by type, procedural stand-ins where there is none ----------
  const kitEntries = [...catalog.values()].filter((e) => e.category === 'rock')
  const byType = new Map<string, CatalogEntry[]>()
  for (const e of kitEntries) {
    const t = (e as CatalogEntry & { rock_type?: string }).rock_type ?? 'unknown'
    const arr = byType.get(t)
    if (arr) arr.push(e)
    else byType.set(t, [e])
  }

  // budget: count candidate placements first so instance capacities are exact
  type Place = { x: number; z: number; y: number; size: number; yaw: number; type: string; seed: number }
  const places: Place[] = []
  const clear = T.ROCK_PAVEMENT_CLEAR

  for (const f of faces) {
    const st = f.stations
    if (st.length < 2) continue
    for (let i = 0; i < st.length - 1; i++) {
      const a = st[i], b = st[i + 1]
      const along = Math.hypot(b.toe[0] - a.toe[0], b.toe[1] - a.toe[1])
      // how much rock: per metre of face, more when taller and steeper, scaled by the knob
      const hgt = Math.max(0, a.top[2] - a.toe[2])
      const n = Math.round(along * T.ROCK_PER_M * Math.min(3, 0.5 + hgt / 6) * (f.slope > 0.9 ? 1.3 : 1))
      for (let k = 0; k < n; k++) {
        const u = h2(f.s_start + i * 17.3, k * 1.7 + 0.3)     // along the segment
        const w = Math.pow(h2(k * 3.7 + 0.1, f.s_start + i), 0.7) // across: toe→top, biased to the lower face
        const tx = a.toe[0] + (b.toe[0] - a.toe[0]) * u, ty = a.toe[1] + (b.toe[1] - a.toe[1]) * u
        const px = a.top[0] + (b.top[0] - a.top[0]) * u, py = a.top[1] + (b.top[1] - a.top[1]) * u
        const x = tx + (px - tx) * w, ySite = ty + (py - ty) * w
        const z = -ySite
        if (edgeDistance(x, z) < clear) continue
        const y = groundAt(x, z)
        if (y === null) continue
        // size: talus at the toe is bigger; blocks up the face smaller; the knob scales all of it
        const size = T.ROCK_SIZE * (0.4 + 1.6 * h2(x, ySite)) * (1.2 - 0.5 * w)
        places.push({ x, z, y: y - size * 0.15, size, yaw: h2(ySite, x) * Math.PI * 2, type: f.rock_type, seed: i * 31 + k })
      }
    }
  }
  for (const p of polys) {
    if (p.ring.length < 3) continue
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of p.ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
    const n = Math.round(p.area_m2 * T.ROCK_OUTCROP_PER_M2)
    let tries = 0
    for (let k = 0; k < n && tries < n * 6; tries++) {
      const x = x0 + (x1 - x0) * h2(p.area_m2 + tries, x0), ySite = y0 + (y1 - y0) * h2(y0, tries * 2.3 + p.area_m2)
      if (!inside(p.ring, x, ySite)) continue
      k++
      const z = -ySite
      if (edgeDistance(x, z) < clear) continue
      const y = groundAt(x, z)
      if (y === null) continue
      const size = T.ROCK_SIZE * (0.5 + 1.2 * h2(x, ySite))
      places.push({ x, z, y: y - size * 0.15, size, yaw: h2(ySite, x) * Math.PI * 2, type: p.rock_type, seed: tries })
    }
  }

  // --- variants: per (type, model) one InstancedMesh -----------------------------------------
  const variants = new Map<string, Variant[]>()
  const wanted = new Set(places.map((p) => p.type))
  for (const type of wanted) {
    const entries = byType.get(type) ?? byType.get('unknown') ?? []
    const list: Variant[] = []
    const cap = places.filter((p) => p.type === type).length
    if (entries.length) {
      for (const e of entries) {
        const model = await loadAssetModel(e)
        if (!model) continue
        // one InstancedMesh per mesh in the model (a TRELLIS glb is one mesh); scale so height_m = 1 unit
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        model.traverse((o) => {
          const m = o as THREE.Mesh
          if (!m.isMesh) return
          const geo = m.geometry.clone()
          geo.applyMatrix4(m.matrixWorld)
          geo.scale(1 / size.y, 1 / size.y, 1 / size.y)
          geo.computeBoundingBox()
          geo.translate(-(geo.boundingBox!.min.x + geo.boundingBox!.max.x) / 2, -geo.boundingBox!.min.y, -(geo.boundingBox!.min.z + geo.boundingBox!.max.z) / 2)
          const im = new THREE.InstancedMesh(geo, m.material, Math.max(1, Math.ceil(cap / Math.max(1, entries.length))))
          im.name = `rock:${type}:${e.id}`
          im.frustumCulled = false
          list.push({ entry: e, rockType: type, mesh: im, count: 0, nativeH: 1 })
        })
      }
    }
    if (!list.length) {
      // procedural stand-ins: three shapes per type
      const mat = new THREE.MeshStandardMaterial({ color: ROCK_COLOUR[type] ?? ROCK_COLOUR.unknown, roughness: 0.95, metalness: 0, flatShading: true })
      for (let v = 0; v < 3; v++) {
        const im = new THREE.InstancedMesh(boulderGeometry(v * 101 + type.length, type === 'shale' || type === 'sandstone' || type === 'limestone'), mat, Math.max(1, Math.ceil(cap / 3) + 1))
        im.name = `rock:${type}:procedural-${v}`
        im.frustumCulled = false
        list.push({ entry: null, rockType: type, mesh: im, count: 0, nativeH: 1 })
      }
    }
    variants.set(type, list)
  }

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s3 = new THREE.Vector3()
  const p3 = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  for (const p of places) {
    const list = variants.get(p.type)
    if (!list?.length) continue
    const v = list[Math.floor(h2(p.seed, p.x) * list.length) % list.length]
    if (v.count >= v.mesh.instanceMatrix.count) continue
    q.setFromAxisAngle(up, p.yaw)
    s3.set(p.size * (0.85 + 0.3 * h2(p.z, p.seed)), p.size, p.size * (0.85 + 0.3 * h2(p.seed, p.z)))
    p3.set(p.x, p.y, p.z)
    m.compose(p3, q, s3)
    v.mesh.setMatrixAt(v.count++, m)
    counts[p.type] = (counts[p.type] ?? 0) + 1
  }
  for (const list of variants.values()) {
    for (const v of list) {
      v.mesh.count = v.count
      v.mesh.instanceMatrix.needsUpdate = true
      v.mesh.userData = { rock: v.rockType, asset: v.entry?.id ?? 'procedural' }
      group.add(v.mesh)
    }
  }
  return { group, counts, faces: faces.length, polygons: polys.length }
}

/** even-odd point in polygon, site frame */
function inside(poly: [number, number][], x: number, y: number): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
