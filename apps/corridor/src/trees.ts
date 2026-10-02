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
import { leafShadowDepth, linearShadowDepth } from './shading'
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
  /** canopy cell that grew this tree. A patch replant keeps the slot, so the index stays put. */
  ci?: number
  cj?: number
  /** past the draw radius: the matrix is on the GPU and the card is hidden until the eye gets closer */
  spare?: boolean
}

interface Variant {
  name: string
  archetype: Archetype
  leaf: LeafKind
  branches: THREE.InstancedMesh
  leaves: THREE.InstancedMesh
  leavesFull: THREE.InstancedMesh // the sparse (density<1) leaf set is a second geometry with fewer leaves
  leavesSparse: THREE.InstancedMesh
  /** the canopy a tree wears beyond `TREE_LEAF_LOD_M`: a few big leaves instead of many small ones */
  leavesFar: THREE.InstancedMesh
  nativeHeight: number
  leafMat: THREE.MeshLambertMaterial
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
  // F6 → trees → palette: force one archetype everywhere (to look at one species), and cap how
  // many the site's own mix may produce
  if (T.TREE_SPECIES >= 0) return [ARCHETYPES[Math.min(ARCHETYPES.length - 1, Math.round(T.TREE_SPECIES))]]
  limit = Math.max(1, Math.min(limit, Math.round(T.TREE_SPECIES_LIMIT)))
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
  /*
   * LAMBERT, NOT STANDARD, and it is the single biggest frame-time decision in this app.
   *
   * Every leaf is an alpha-tested card, and the discard means the GPU shades every card fragment
   * before it can reject it — so the cost of a canopy is its screen area times the price of the
   * fragment shader, many layers deep. Measured on Rich's machine, stopped in the woods on
   * arrowhead at 2560 × 1323: the same leaves with `MeshStandardMaterial` (roughness 0.9,
   * metalness 0 — which is to say, Lambert with a PBR shader wrapped round it) cost 41.5 ms a
   * frame; with `MeshLambertMaterial` 22.7 ms. Nothing else that was tried came close: single-sided
   * cards saved 15 ms and lost half the leaves, a depth pre-pass made it worse, and halving the
   * pixel count saved what halving the pixel count saves. A leaf has no specular worth the money.
   */
  const leafMat = new THREE.MeshLambertMaterial({ map: src.map, color: src.color, side: THREE.DoubleSide, alphaTest: 0.5 })
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
  /*
   * THE FAR CANOPY, and this is where the frame budget was going.
   *
   * Measured on Rich's machine (arrowhead, 2560 × 1323, 700 near trees): hiding the leaf meshes
   * took the frame from 22.7 ms to the display's 16.7 ms floor, while hiding the BRANCHES — which
   * are five million triangles to the leaves' three — saved 2.2 ms. Leaves are dear per triangle
   * because each one is an alpha-tested, double-sided card: the discard defeats early depth
   * rejection, so every leaf behind every other leaf is shaded and thrown away. That cost scales
   * with how many cards there are, not with how big they are — and at a hundred metres a tree is
   * fifty pixels tall, where forty big leaves and four hundred small ones are the same picture.
   *
   * So a tree past `TREE_LEAF_LOD_M` wears this set: `TREE_FAR_LEAF_SHARE` of the leaves at
   * `TREE_FAR_LEAF_SIZE` times the size, same seed, same silhouette. The material is shared, so
   * the season tints all three canopies at once.
   */
  const farGeo = t.leavesMesh.geometry.clone()
  {
    const t3 = new Tree()
    t3.loadFromJson(optionsFor(a, h))
    t3.options.leaves.count = Math.max(2, Math.round(fullCount * T.TREE_FAR_LEAF_SHARE))
    t3.options.leaves.size *= 1.3 * T.TREE_FAR_LEAF_SIZE
    t3.generate()
    farGeo.copy(t3.leavesMesh.geometry)
  }
  const leavesFar = new THREE.InstancedMesh(farGeo, leafMat, capacity)
  for (const m of [branches, leavesFull, leavesSparse, leavesFar]) {
    m.count = 0
    m.frustumCulled = false
    m.castShadow = true
    m.receiveShadow = true
    m.name = `near-tree:${a.id}`
  }
  // regrow throws these meshes away. Arming them here, not in a one-time scene walk, is what
  // keeps a tree-detail change from silently dropping the shadows.
  branches.customDepthMaterial = linearShadowDepth
  const leafDepth = leafShadowDepth(leafMat.map, leafMat.alphaTest)
  for (const m of [leavesFull, leavesSparse, leavesFar]) m.customDepthMaterial = leafDepth
  leavesFar.name = `near-tree:${a.id}:far`
  return { name: a.id, archetype: a, leaf: a.leaf, branches, leaves: leavesFull, leavesFull, leavesSparse, leavesFar, nativeHeight: Math.max(1, top), leafMat, srcMap: src.map, grey: false }
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
  /**
   * How far the procedural models ACTUALLY reach this frame, in lodDistance.
   *
   * Not the same as TREE_NEAR_RADIUS. The near set takes the closest `capacity x variants`
   * candidates inside that radius, so in woodland it runs out of capacity long before it runs out
   * of radius and the real model horizon is much closer in — and a dissolve band anchored to the
   * radius then covers trees the near set never drew, i.e. nobody, which is why the impostor
   * cards were popping rather than fading (Rich, 2026-09-27: "design a cross fading mechanism for
   * trees and sprites, where imposters fade out as full detail trees fade in"). `cands` is sorted
   * by distance, so the last one seated is the farthest, and that is where the handover is.
   */
  horizon = 0
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
      this.group.add(v.branches, v.leavesFull, v.leavesSparse, v.leavesFar)
      await b.tick()
    }
    b.finish()
    return this
  }

  /**
   * The record array was replanted in place (props.treesFromCanopy's `plant`): rebuild the grid
   * and the memoised variant choice. The array OBJECT is the same one this was constructed with —
   * it is mutated, never replaced, so nothing else has to be rewired.
   */
  reindex() {
    this.grid.clear()
    if (this.chosen.length < this.trees.length) this.chosen = new Int16Array(this.trees.length)
    this.chosen.fill(-1)
    this.last.set(Infinity, Infinity, Infinity)
    this.indexTrees(this.trees)
  }

  /**
   * One slot the crescent fill just wrote. The full grid rebuild happens when the centre jumps;
   * between jumps the new trees are added here so a reused index does not keep the variant it
   * had for the tree that left.
   */
  remember(i: number) {
    const t = this.trees[i]
    if (!t || !Number.isFinite(t.x)) return
    if (i >= this.chosen.length) {
      const next = new Int16Array(Math.max(this.trees.length, i + 1))
      next.set(this.chosen)
      next.fill(-1, this.chosen.length)
      this.chosen = next
    }
    this.chosen[i] = -1
    const k = `${Math.floor(t.x / this.cell)},${Math.floor(t.z / this.cell)}`
    const arr = this.grid.get(k)
    if (arr) {
      if (!arr.includes(i)) arr.push(i)
    } else this.grid.set(k, [i])
  }

  private indexTrees(trees: TreeRecord[]) {
    trees.forEach((t, i) => {
      if (!Number.isFinite(t.x)) return
      const k = `${Math.floor(t.x / this.cell)},${Math.floor(t.z / this.cell)}`
      const arr = this.grid.get(k)
      if (arr) arr.push(i)
      else this.grid.set(k, [i])
    })
  }

  /**
   * Trees past the models, down the view, for the card and canopy shadows.
   *
   * Nothing inside `minDist` and nothing this set is already drawing: those trees cast from
   * their own meshes, and a second caster there stacks a shadow on the same trunk. Slots are
   * spread from that line out to `maxDist`, and each band keeps the trees closest to the view
   * so the shade falls on the road.
   */
  shadowAhead(eye: THREE.Vector3, fwdX: number, fwdZ: number, minDist: number, maxDist: number, limit: number): number[] {
    if (!(maxDist > minDist) || limit <= 0) return []
    const fl = Math.hypot(fwdX, fwdZ) || 1
    const ux = fwdX / fl
    const uz = fwdZ / fl
    const minD = Math.max(0, minDist)
    const maxD = maxDist
    const bands = 16
    const buckets: { i: number; lat: number }[][] = []
    for (let b = 0; b < bands; b++) buckets.push([])
    const c0 = Math.floor(eye.x / this.cell)
    const c1 = Math.floor(eye.z / this.cell)
    const n = Math.ceil(maxD / this.cell)
    for (let a = -n; a <= n; a++) {
      for (let b = -n; b <= n; b++) {
        const arr = this.grid.get(`${c0 + a},${c1 + b}`)
        if (!arr) continue
        for (const i of arr) {
          if (this.near.has(i)) continue
          const t = this.trees[i]
          if (!t || !Number.isFinite(t.x) || t.spare) continue
          const dx = t.x - eye.x
          const dz = t.z - eye.z
          const d = Math.hypot(dx, dz)
          if (d <= minD || d > maxD) continue
          const along = dx * ux + dz * uz
          if (along <= 0) continue
          const lat = Math.abs(dx * uz - dz * ux)
          if (lat > 80 && lat > along * 0.55) continue
          const u = (d - minD) / (maxD - minD)
          buckets[Math.min(bands - 1, Math.floor(u * bands))].push({ i, lat })
        }
      }
    }
    const per = Math.max(1, Math.ceil(limit / bands))
    const out: number[] = []
    const rest: { i: number; lat: number }[] = []
    for (const bucket of buckets) {
      bucket.sort((p, q) => p.lat - q.lat)
      const take = Math.min(per, bucket.length, limit - out.length)
      for (let k = 0; k < take; k++) out.push(bucket[k].i)
      for (let k = take; k < bucket.length; k++) rest.push(bucket[k])
    }
    rest.sort((p, q) => p.lat - q.lat)
    for (let k = 0; k < rest.length && out.length < limit; k++) out.push(rest[k].i)
    return out
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
      v.leavesFar.visible = !bare
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

  /**
   * Throw the species models away and build them again — what a SHAPE knob needs (F6 → trees →
   * shape), since every variant's geometry came out of ez-tree with the old numbers. ~100 ms for
   * five variants, which is why the panel debounces it. The caller re-bakes the impostors after,
   * or the cards still show the old tree.
   */
  async regrow(): Promise<this> {
    for (const v of this.variants) { v.branches.dispose(); v.leaves.dispose(); v.leavesSparse.geometry.dispose() }
    this.group.clear()
    this.variants.length = 0
    this.chosen.fill(-1)
    await this.grow()
    this.invalidate()
    return this
  }

  /** was the simple style on last time `update` ran, so switching it rebuilds the far set once */
  private wasSimple = false

  update(eye: THREE.Vector3, force = false, fwd = new THREE.Vector3(1, 0, 0), pitch = 0): boolean {
    /*
     * LOLLIPOPS EVERYWHERE. `TREE_SIMPLE` drops the near set entirely — the far LOD then draws
     * every tree, because it skips exactly the ones this set has claimed. Returning `true` on the
     * frame the style CHANGES is what makes the far set rebuild its instances; returning it every
     * frame would rebuild tens of thousands of matrices for ever.
     */
    // 0 on the detail slider is the same picture as cards-everywhere: no models, every tree a card.
    const simple = T.TREE_DETAIL <= 0 || T.TREE_SIMPLE >= 0.5 || T.TREE_LOLLIPOP >= 0.5
    if (simple) {
      this.group.visible = false
      const changed = !this.wasSimple || this.near.size > 0
      this.near.clear()
      this.horizon = 0
      this.wasSimple = true
      return changed
    }
    if (this.wasSimple) {
      this.group.visible = true
      this.wasSimple = false
      force = true // the near set has to be rebuilt from nothing
    }
    const heading = Math.atan2(fwd.x, fwd.z)
    // with a view cone the set has to be refilled as the camera turns, well before the cone's edge shows
    let dh = Math.abs(heading - this.lastHeading)
    if (dh > Math.PI) dh = 2 * Math.PI - dh
    const turned = dh > T.TREE_REFRESH_TURN
    if (!force && !turned && eye.distanceTo(this.last) < 15) return false
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
    // The ring fills after the first look, far to near. Latching an empty pick here is what made
    // the models wait until the car had rolled far enough to break the 15 m gate.
    if (cands.length === 0 && this.near.size === 0) return false
    this.last.copy(eye)
    this.lastHeading = heading
    cands.sort((p, q) => p.d2 - q.d2)
    const total = Math.min(cands.length, cap * this.variants.length)
    const counts = this.variants.map(() => 0)
    // the near canopy and the far canopy are separate instance lists; the branches carry both
    const nearCounts = this.variants.map(() => 0)
    const farCounts = this.variants.map(() => 0)
    const lodM = T.TREE_LEAF_LOD_M
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const p = new THREE.Vector3()
    this.near.clear()
    this.horizon = 0
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
      if (Math.sqrt(cands[k].d2) > lodM) {
        v.leavesFar.setMatrixAt(farCounts[vi], m)
        farCounts[vi]++
      } else {
        v.leavesFull.setMatrixAt(nearCounts[vi], m)
        v.leavesSparse.setMatrixAt(nearCounts[vi], m)
        nearCounts[vi]++
      }
      counts[vi]++
      this.near.add(i)
      this.horizon = Math.sqrt(cands[k].d2)
    }
    this.variants.forEach((v, vi) => {
      v.branches.count = counts[vi]
      v.leavesFull.count = nearCounts[vi]
      v.leavesSparse.count = nearCounts[vi]
      v.leavesFar.count = farCounts[vi]
      v.branches.instanceMatrix.needsUpdate = true
      v.leavesFull.instanceMatrix.needsUpdate = true
      v.leavesSparse.instanceMatrix.needsUpdate = true
      v.leavesFar.instanceMatrix.needsUpdate = true
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
