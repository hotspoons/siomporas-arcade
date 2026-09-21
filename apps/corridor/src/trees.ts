// Trees in two levels of detail.
//
//   far   one instanced lollipop per canopy cell (props.ts treesFromCanopy) — tens of thousands
//   near  ez-tree procedural trees (MIT, @dgreenheck/ez-tree): textured bark, billboard leaves —
//         a few hundred, re-assigned to the trees nearest the camera every half second
//
// Every tree has a MEASURED height from the lidar canopy; the near model is scaled so its crown top
// lands at that height. Species is a stand-in until something reads it off the imagery: oaks on
// the ridges and roadside, ash in the bottoms, aspen for the thin tall ones.
import * as THREE from 'three'
import { Tree } from '@dgreenheck/ez-tree'
import { greyscaleTexture, type SeasonLook } from './season'
import * as T from './tuning'

export interface TreeRecord {
  x: number // world X (east)
  z: number // world Z (south, = -north)
  y: number // ground
  h: number // canopy height, m
  species?: 'oak' | 'ash' | 'aspen' | 'pine' // an adjustment area's override; undefined = by height
}

interface Variant {
  name: string
  species: 'oak' | 'ash' | 'aspen' | 'pine'
  branches: THREE.InstancedMesh
  leaves: THREE.InstancedMesh
  leavesFull: THREE.InstancedMesh // the sparse (density<1) leaf set is a second geometry with fewer leaves
  leavesSparse: THREE.InstancedMesh
  nativeHeight: number
  leafMat: THREE.MeshStandardMaterial
  srcMap: THREE.Texture | null
  grey: boolean
}

const PRESETS = ['Oak Medium', 'Ash Medium', 'Aspen Medium', 'Oak Large', 'Ash Small']

function buildVariant(preset: string, capacity: number): Variant {
  const t = new Tree()
  t.loadPreset(preset)
  // the presets carry ~20k leaf vertices a tree; with hundreds of instances that is the whole
  // frame budget. Half the leaves, a third bigger, reads the same from the road.
  const fullCount = Math.max(4, Math.round(t.options.leaves.count * 0.5))
  t.options.leaves.count = fullCount
  t.options.leaves.size *= 1.3
  t.generate()
  t.branchesMesh.geometry.computeBoundingBox()
  t.leavesMesh.geometry.computeBoundingBox()
  const top = Math.max(t.branchesMesh.geometry.boundingBox!.max.y, t.leavesMesh.geometry.boundingBox!.max.y)
  const branches = new THREE.InstancedMesh(t.branchesMesh.geometry, t.branchesMesh.material, capacity)
  // ez-tree's leaf material patches the vertex shader for wind; under instancing the leaves did not
  // draw at all. A plain material with the same leaf texture and alpha test does. The texture is
  // swapped for a greyscale mask on the first season change so the season tint IS the colour.
  const src = t.leavesMesh.material as THREE.MeshPhongMaterial
  const leafMat = new THREE.MeshStandardMaterial({ map: src.map, color: src.color, side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.9, metalness: 0 })
  const leavesFull = new THREE.InstancedMesh(t.leavesMesh.geometry, leafMat, capacity)
  // a thinner canopy for spring and autumn: same tree, a third of the leaves, same seed
  const sparseGeo = t.leavesMesh.geometry.clone()
  {
    const t2 = new Tree()
    t2.loadPreset(preset)
    t2.options.leaves.count = Math.max(2, Math.round(fullCount * 0.35))
    t2.options.leaves.size *= 1.3
    t2.generate()
    sparseGeo.copy(t2.leavesMesh.geometry)
  }
  const leavesSparse = new THREE.InstancedMesh(sparseGeo, leafMat, capacity)
  leavesSparse.visible = false
  const species = (t.options.leaves.type as Variant['species']) ?? 'oak'
  for (const m of [branches, leavesFull, leavesSparse]) {
    m.count = 0
    m.frustumCulled = false
    m.name = `near-tree:${preset}`
  }
  return { name: preset, species, branches, leaves: leavesFull, leavesFull, leavesSparse, nativeHeight: Math.max(1, top), leafMat, srcMap: src.map, grey: false }
}

export class NearTrees {
  group = new THREE.Group()
  private variants: Variant[] = []
  private trees: TreeRecord[]
  private grid = new Map<string, number[]>()
  private cell = 50
  private last = new THREE.Vector3(Infinity, Infinity, Infinity)
  private lastHeading = 0
  private capacity: number
  /** which tree index is currently drawn as a near model, so the far set can skip it */
  near = new Set<number>()

  constructor(trees: TreeRecord[], radius = 220, capacity = 240) {
    this.trees = trees
    void radius // live radius is the knob TREE_NEAR_RADIUS
    this.capacity = capacity
    this.group.name = 'near-trees'
    for (const p of PRESETS) {
      const v = buildVariant(p, capacity)
      this.variants.push(v)
      this.group.add(v.branches, v.leavesFull, v.leavesSparse)
    }
    trees.forEach((t, i) => {
      const k = `${Math.floor(t.x / this.cell)},${Math.floor(t.z / this.cell)}`
      const arr = this.grid.get(k)
      if (arr) arr.push(i)
      else this.grid.set(k, [i])
    })
  }

  /** Geometry + materials of each variant, for the impostor baker (the leaf set the season shows). */
  sources() {
    return this.variants.map((v) => ({ branches: new THREE.Mesh(v.branches.geometry, v.branches.material), leaves: new THREE.Mesh(v.leaves.visible ? v.leaves.geometry : new THREE.BufferGeometry(), v.leafMat), nativeHeight: v.nativeHeight }))
  }

  /** Recolour and thin the canopy for a season. Returns false if leaf textures are not decoded yet. */
  setSeason(look: SeasonLook): boolean {
    let ok = true
    for (const v of this.variants) {
      if (!v.grey && v.srcMap) {
        const g = greyscaleTexture(v.srcMap)
        if (g) {
          v.leafMat.map = g
          v.leafMat.needsUpdate = true
          v.grey = true
        } else ok = false
      }
      const leaf = look.leaves[v.species] ?? look.leaves.oak
      v.leafMat.color.copy(leaf.tint)
      const bare = leaf.density <= 0.05
      const sparse = !bare && leaf.density < 0.85
      v.leavesFull.visible = !bare && !sparse
      v.leavesSparse.visible = sparse
      v.leaves = sparse ? v.leavesSparse : v.leavesFull
      if (bare) v.leaves.visible = false
    }
    return ok
  }

  /** Pick a species by height and a stable hash of position, so a tree keeps its shape. */
  variantFor(t: TreeRecord, i: number): number {
    const hash = (i * 2654435761) >>> 0
    if (t.species) {
      const idx = this.variants.map((v, k) => (v.species === t.species ? k : -1)).filter((k) => k >= 0)
      if (idx.length) return idx[hash % idx.length]
    }
    if (t.h > 22) return hash % 2 === 0 ? 3 : 0 // tall: big oaks
    if (t.h < 8) return 4 // short: small ash
    return hash % 3 // mid: oak / ash / aspen
  }

  /** Re-assign near models around `eye`. Cheap: only cells within the radius are visited. Returns true when the set changed. */
  /** Force a re-pick on the next update (a knob changed). */
  invalidate() {
    this.last.set(Infinity, Infinity, Infinity)
  }

  update(eye: THREE.Vector3, force = false, fwd = new THREE.Vector3(1, 0, 0), pitch = 0): boolean {
    const heading = Math.atan2(fwd.x, fwd.z)
    const turned = Math.abs(heading - this.lastHeading) > 0.44
    if (!force && !turned && eye.distanceTo(this.last) < 15) return false
    this.last.copy(eye)
    this.lastHeading = heading
    // radius and capacity are knobs (F6 → trees); the footprint is stretched behind the view
    const radius = T.TREE_NEAR_RADIUS
    const cap = Math.min(this.capacity, Math.round(T.TREE_NEAR_CAPACITY))
    const cands: { i: number; d2: number }[] = []
    const c0 = Math.floor(eye.x / this.cell), c1 = Math.floor(eye.z / this.cell)
    const n = Math.ceil((radius * (1 + T.LOD_BEHIND_PENALTY)) / this.cell)
    for (let a = -n; a <= n; a++) {
      for (let b = -n; b <= n; b++) {
        const arr = this.grid.get(`${c0 + a},${c1 + b}`)
        if (!arr) continue
        for (const i of arr) {
          const t = this.trees[i]
          const d = T.lodDistance(t.x - eye.x, t.z - eye.z, fwd.x, fwd.z, pitch)
          if (d <= radius) cands.push({ i, d2: d * d })
        }
      }
    }
    cands.sort((p, q) => p.d2 - q.d2)
    const total = Math.min(cands.length, cap * this.variants.length)
    const counts = this.variants.map(() => 0)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const p = new THREE.Vector3()
    this.near.clear()
    for (let k = 0; k < total; k++) {
      const { i } = cands[k]
      const t = this.trees[i]
      let vi = this.variantFor(t, i)
      if (counts[vi] >= cap) vi = counts.indexOf(Math.min(...counts))
      if (counts[vi] >= cap) break
      const v = this.variants[vi]
      const scale = t.h / v.nativeHeight
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((i * 137) % 360) * (Math.PI / 180))
      s.set(scale, scale, scale)
      p.set(t.x, t.y, t.z)
      m.compose(p, q, s)
      v.branches.setMatrixAt(counts[vi], m)
      v.leavesFull.setMatrixAt(counts[vi], m)
      v.leavesSparse.setMatrixAt(counts[vi], m)
      counts[vi]++
      this.near.add(i)
    }
    this.variants.forEach((v, vi) => {
      v.branches.count = counts[vi]
      v.leavesFull.count = counts[vi]
      v.leavesSparse.count = counts[vi]
      v.branches.instanceMatrix.needsUpdate = true
      v.leavesFull.instanceMatrix.needsUpdate = true
      v.leavesSparse.instanceMatrix.needsUpdate = true
    })
    return true
  }

  dispose() {
    for (const v of this.variants) {
      v.branches.dispose()
      v.leaves.dispose()
    }
  }
}
