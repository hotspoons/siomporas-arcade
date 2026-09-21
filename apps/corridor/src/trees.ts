// Trees in two levels of detail.
//
//   far   one instanced lollipop per canopy cell (props.ts treesFromCanopy) — tens of thousands
//   near  ez-tree procedural trees (MIT, @dgreenheck/ez-tree): textured bark, billboard leaves —
//         a few hundred, re-assigned to the trees nearest the camera every half second
//
// Every tree has a MEASURED height from the lidar canopy; the near model is scaled so its crown top
// lands at that height.
//
// SPECIES, since 2026-09-21, is measured too. It used to be a documented stand-in — `pickVariant`
// sorted a fixed five presets (oak, ash, aspen) by canopy height alone, so Acadia's spruce-fir and
// Big Sur's redwoods both came out as a Maryland oak wood, and there was no conifer variant at all.
// Now the bake (`tools/corridor/corridor/flora.py`) hands over, per 30 m pixel, the LANDFIRE
// vegetation class and a ranked species mix with weights, and species.ts turns a genus into a
// silhouette. The height is still an input — it chooses between the large and small build of a
// silhouette, and it weights the draw toward the species whose measured canopy height it matches —
// but it is no longer the only one.
//
// Two properties of the old code are kept exactly:
//   * a tree keeps its identity across frames, because the draw is a stable hash of its index;
//   * an adjustment area's `species` override still wins over the data.
import * as THREE from 'three'
import { Budget } from './budget'
import { Tree } from '@dgreenheck/ez-tree'
import { Flora, type FloraSpecies, type SpeciesWeight } from './flora'
import { ARCHETYPES, archetypeFor, optionsFor, type Archetype, type LeafKind } from './species'
import { greyscaleTexture, type SeasonLook } from './season'
import * as T from './tuning'

export interface TreeRecord {
  x: number // world X (east)
  z: number // world Z (south, = -north)
  y: number // ground
  h: number // canopy height, m
  species?: 'oak' | 'ash' | 'aspen' | 'pine' // an adjustment area's override; undefined = from the bake
}

interface Variant {
  name: string
  archetype: Archetype
  leaf: LeafKind
  branches: THREE.InstancedMesh
  leaves: THREE.InstancedMesh
  leavesFull: THREE.InstancedMesh // the sparse (density<1) leaf set is a second geometry with fewer leaves
  leavesSparse: THREE.InstancedMesh
  nativeHeight: number
  leafMat: THREE.MeshStandardMaterial
  srcMap: THREE.Texture | null
  grey: boolean
}

/** The five that stood here before there was any species data: a mid-Atlantic hardwood wood. */
const FALLBACK = ['oak', 'hardwood', 'aspen', 'oak-large', 'hardwood-small']

/**
 * Which silhouettes to build for this site.
 *
 * Building an ez-tree variant costs a full procedural generate (twice — the full and the thinned
 * leaf set), so the list has to be short. It is chosen by AREA-WEIGHTED BASAL AREA: every EVT class
 * in the corridor contributes its species mix scaled by its share of the ground, the species are
 * mapped to silhouettes, and the heaviest `limit` silhouettes are built. A corridor that is 20 %
 * red spruce and 14 % paper birch gets a spruce and a birch; one that is 36 % coastal-plain
 * hardwood gets oaks.
 */
export function paletteFor(flora: Flora | null, heights: number[] = [], limit = 6): Archetype[] {
  const byId = new Map(ARCHETYPES.map((a) => [a.id, a]))
  if (!flora) return FALLBACK.map((id) => byId.get(id)!).filter(Boolean)
  const weight = new Map<string, number>()
  const add = (a: Archetype, w: number) => weight.set(a.id, (weight.get(a.id) ?? 0) + w)
  // The palette is asked at SEVERAL heights, because a species has more than one build and which
  // one a tree gets depends on how tall that tree is. Asking once at the species' mean height put
  // only `oak-large` in Chesterfield Road's palette, so every oak under 22 m — the understorey and
  // the young edge — was drawn as a 28 m open-grown oak. The heights are this corridor's own
  // canopy quartiles, so the question asked is "what silhouettes do the trees that are actually
  // here need", not "what does the average tree of this species look like".
  const hs = heights.length ? heights : [12, 18, 26]
  for (const c of flora.classes) {
    if (c.lifeform !== 'Tree' || !c.species) continue
    for (const s of c.species) {
      const sp = flora.block.canopy.ref[s.key]
      if (!sp) continue
      for (const h of hs) add(archetypeFor(sp, Flora.isBroadleafEvergreen(c), h), (s.weight * c.share) / hs.length)
    }
  }
  if (!weight.size) return FALLBACK.map((id) => byId.get(id)!).filter(Boolean)
  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id)!).filter(Boolean)
  const out = ranked.slice(0, limit)
  // a wood with nothing small in it reads as a plantation; keep one understorey build if the
  // dominant silhouettes are all full-height and there is room
  if (out.length < limit && !out.some((a) => a.id.endsWith('-small'))) out.push(byId.get('hardwood-small')!)
  return out
}

function buildVariant(a: Archetype, capacity: number, h: number): Variant {
  const t = new Tree()
  t.loadFromJson(optionsFor(a, h))
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
    t2.loadFromJson(optionsFor(a, h))
    t2.options.leaves.count = Math.max(2, Math.round(fullCount * 0.35))
    t2.options.leaves.size *= 1.3
    t2.generate()
    sparseGeo.copy(t2.leavesMesh.geometry)
  }
  const leavesSparse = new THREE.InstancedMesh(sparseGeo, leafMat, capacity)
  leavesSparse.visible = false
  for (const m of [branches, leavesFull, leavesSparse]) {
    m.count = 0
    m.frustumCulled = false
    m.name = `near-tree:${a.id}`
  }
  return { name: a.id, archetype: a, leaf: a.leaf, branches, leaves: leavesFull, leavesFull, leavesSparse, nativeHeight: Math.max(1, top), leafMat, srcMap: src.map, grey: false }
}

/**
 * How well a measured canopy height matches a species' measured height in this corridor.
 *
 * Both numbers are lidar: `h` is the height of THIS tree from the CHM, `hm` is the mean CHM height
 * over the pixels where the bake found that species' basal area. So "a 40 m stem in a redwood mix
 * is a redwood and an 8 m one is a tanoak" is arithmetic over two measurements, not a rule. A
 * species with no measured height (the EVT-name fallback, where no basal-area raster had data)
 * scores 1 and is chosen on its mix weight alone.
 */
function heightAffinity(h: number, hm: number | null | undefined): number {
  if (!hm || hm <= 0) return 1
  const d = (h - hm) / Math.max(4, hm * 0.7)
  return Math.exp(-d * d)
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
  private flora: Flora | null
  /** memoised variant per tree index: the draw is stable, so it is worth computing once */
  private chosen: Int16Array
  /** the site's typical canopy height, which tunes the archetypes that scale with it */
  private median = 18
  /** 20th / 55th / 90th percentile canopy height, the sizes the palette has to cover */
  private quantiles: number[] = []
  /** which tree index is currently drawn as a near model, so the far set can skip it */
  near = new Set<number>()

  constructor(trees: TreeRecord[], radius = 220, capacity = 240, flora: Flora | null = null) {
    this.trees = trees
    this.flora = flora
    void radius // live radius is the knob TREE_NEAR_RADIUS
    this.capacity = capacity
    this.group.name = 'near-trees'
    // this corridor's own canopy quartiles: the archetypes are tuned for the wood they are in, and
    // the palette is chosen for the range of tree sizes that are actually standing in it
    const hs = trees.map((t) => t.h).sort((a, b) => a - b)
    const q = (f: number) => (hs.length ? hs[Math.min(hs.length - 1, Math.floor(hs.length * f))] : 18)
    this.median = q(0.6)
    this.quantiles = hs.length ? [q(0.2), q(0.55), q(0.9)] : []
    this.chosen = new Int16Array(trees.length).fill(-1)
    this.indexTrees(trees)
  }

  /**
   * Generate the procedural tree variants, yielding between them.
   *
   * An earlier version of this comment claimed `t.generate()` costs ~800 ms a variant and that the
   * variants were the largest phase of the build. Both were wrong: they were inferred from the
   * `growing…` phase total, and that phase builds the grass too. Timed on their own through the
   * dev bridge (crofton-triangle, Rich's machine, 2026-09-21) five variants — ten `generate()`
   * calls, full and sparse — cost **83 ms** and yield 3.2 MB. The grass is the other four seconds.
   *
   * So the yielding here is not buying much, and it is not where to look for load time. It stays
   * because it is free and a large palette is allowed to grow; it is not a saving.
   *
   * WHICH variants is `paletteFor`: the site's own species mix, not a fixed five.
   */
  async grow(sliceMs = 8): Promise<this> {
    const b = new Budget(sliceMs)
    for (const a of paletteFor(this.flora, this.quantiles)) {
      const v = buildVariant(a, this.capacity, this.median)
      this.variants.push(v)
      this.group.add(v.branches, v.leavesFull, v.leavesSparse)
      await b.tick()
    }
    b.finish()
    return this
  }

  private indexTrees(trees: TreeRecord[]) {
    trees.forEach((t, i) => {
      const k = `${Math.floor(t.x / this.cell)},${Math.floor(t.z / this.cell)}`
      const arr = this.grid.get(k)
      if (arr) arr.push(i)
      else this.grid.set(k, [i])
    })
  }

  /** What was built, for the F6 panel and the probes. */
  get palette(): { id: string; after: string; leaf: LeafKind; evergreen: boolean }[] {
    return this.variants.map((v) => ({ id: v.archetype.id, after: v.archetype.after, leaf: v.leaf, evergreen: v.archetype.evergreen }))
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
      const leaf = look.leaves[v.leaf] ?? look.leaves.oak
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

  /**
   * Pick a silhouette for one tree: a stable draw from the species mix of the 30 m pixel it stands
   * on, weighted by how well its measured height matches each species' measured height.
   *
   * Stability is the whole game here. The hash is of the tree INDEX, exactly as before, so a tree
   * keeps its identity across frames, across re-picks and across a change of near radius; only the
   * data underneath it can change what it is.
   */
  variantFor(t: TreeRecord, i: number): number {
    const memo = this.chosen[i]
    if (memo >= 0) return memo
    const hash = (i * 2654435761) >>> 0
    const pick = this.compute(t, hash)
    this.chosen[i] = pick
    return pick
  }

  private compute(t: TreeRecord, hash: number): number {
    // an adjustment area's override is a leaf kind, and it still wins
    if (t.species) {
      const want: LeafKind = t.species
      const idx = this.variants.map((v, k) => (v.leaf === want ? k : -1)).filter((k) => k >= 0)
      if (idx.length) return idx[hash % idx.length]
    }
    const mix: SpeciesWeight[] = this.flora ? this.flora.mixAt(t.x, -t.z) : []
    if (mix.length) {
      const evergreenBroadleaf = this.flora!.broadleafEvergreenAt(t.x, -t.z)
      const scores: number[] = []
      const wants: Archetype[] = []
      let total = 0
      for (const s of mix) {
        const sp: FloraSpecies = s.species
        const w = s.weight * heightAffinity(t.h, sp.canopy_h_m)
        if (w <= 0) continue
        wants.push(archetypeFor(sp, evergreenBroadleaf, t.h))
        scores.push(w)
        total += w
      }
      if (total > 0) {
        // a stable uniform in [0,1) from the same hash, then a cumulative draw
        let u = ((hash >>> 8) / 0x01000000) * total
        for (let k = 0; k < scores.length; k++) {
          u -= scores[k]
          if (u <= 0) return this.nearest(wants[k], hash)
        }
        return this.nearest(wants[wants.length - 1], hash)
      }
    }
    // no flora: the old behaviour, so a bake from before this layer still looks like it did
    if (t.h > 22) return hash % 2 === 0 ? Math.min(3, this.variants.length - 1) : 0
    if (t.h < 8) return Math.min(4, this.variants.length - 1)
    return hash % Math.min(3, this.variants.length)
  }

  /** The built variant closest to a wanted silhouette: itself, else one with the same leaf kind. */
  private nearest(a: Archetype, hash: number): number {
    const exact = this.variants.findIndex((v) => v.archetype.id === a.id)
    if (exact >= 0) return exact
    const same = this.variants.map((v, k) => (v.leaf === a.leaf ? k : -1)).filter((k) => k >= 0)
    if (same.length) return same[hash % same.length]
    const ever = this.variants.map((v, k) => (v.archetype.evergreen === a.evergreen ? k : -1)).filter((k) => k >= 0)
    return ever.length ? ever[hash % ever.length] : 0
  }

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
