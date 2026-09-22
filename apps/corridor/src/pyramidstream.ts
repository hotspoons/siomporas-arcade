// Load and evict pyramid tiles against the camera, so a world can be larger than memory.
//
// The flat loader decodes every tile in the index before the first frame and builds a mesh for
// each. That is correct and it does not scale: crownsville is 33.8 MB at boot and a Maryland-sized
// world would be 8.7 GB. The pyramid replaces "all of it, once" with "the right detail, near the
// eye, continuously".
//
// Three things decide the shape of this file.
//
// **A tile is dropped only when something else already covers its ground.** `diff` will happily
// evict a parent the moment its children are wanted, but the children are only being REQUESTED at
// that moment — dropping the parent then leaves a hole in the terrain for as long as the fetch
// takes. So a drop is deferred whenever any of the tile's children are in the wanted set, and
// taken immediately when the tile simply left the view. Those are the only two reasons a tile is
// ever dropped and they need opposite treatment.
//
// **Placement is computed once per tile and cached.** `place()` is called for every candidate on
// every update, and it needs a geodetic-to-ENU transform per corner. Caching it turns the walk
// into arithmetic on numbers we already have.
//
// **A fetch in flight outlives the decision that started it.** Pan away and back and the same tile
// can be asked for twice; pan away and stay away and a tile arrives that nobody wants. Both are
// handled by keeping the promise in `pending` and checking wantedness again on arrival.

import * as THREE from 'three'
import type { Anchor } from '@apex/engine/geo/wgs84'
import { diff, holdWhileRefining, tileBoundsOf, tileKey, wanted, type TileId } from '@apex/engine/geo/pyramid'
import { PyramidSet, loadPyrTile, type PyrEntry, type PyrIndex, type PyrTile } from './tiles'

export interface PyramidStreamOpts {
  base: string
  index: PyrIndex
  anchor: Anchor
  set: PyramidSet
  group: THREE.Group
  /** builds the mesh geometry for a tile — scene.ts owns gridGeometry, so it is passed in */
  geometryFor: (t: PyrTile) => THREE.BufferGeometry
  materialFor: (t: PyrTile) => THREE.MeshStandardMaterial
  /** vertical field of view in radians, and the viewport height in pixels */
  fovY: number
  viewportH: number
  /** how many decoded bytes may be resident before the farthest tiles are evicted */
  budgetBytes?: number
  /** how many fetches may be in the air at once */
  maxPending?: number
  maxTiles?: number
  /** a tile may cover this many metres per screen pixel before it must subdivide */
  errorPixels?: number
}

interface Held {
  tile: PyrTile
  mesh: THREE.Mesh
  geo: THREE.BufferGeometry
  mat: THREE.MeshStandardMaterial
}

export class PyramidStream {
  private readonly o: Required<Omit<PyramidStreamOpts, 'index' | 'anchor' | 'set' | 'group' | 'geometryFor' | 'materialFor' | 'base'>> & PyramidStreamOpts
  private readonly entries = new Map<string, PyrEntry>()
  private readonly roots: TileId[] = []
  private readonly held = new Map<string, Held>()
  private readonly pending = new Map<string, AbortController>()
  private readonly places = new Map<string, { x: number; z: number; radius: number }>()
  private readonly failed = new Set<string>()
  private lastEye = { x: Infinity, z: Infinity }
  private disposed = false
  /** counters, so "the pyramid is working" is measurable rather than asserted */
  loads = 0
  drops = 0
  errors = 0

  constructor(opts: PyramidStreamOpts) {
    this.o = {
      budgetBytes: 256 * 1024 * 1024,
      maxPending: 6,
      maxTiles: 512,
      errorPixels: 1.6,
      ...opts,
    }
    for (const e of opts.index.list) this.entries.set(`${e.z}/${e.x}/${e.y}`, e)
    for (const e of opts.index.list) {
      if (e.z === opts.index.zmin) this.roots.push({ z: e.z, x: e.x, y: e.y })
    }
  }

  /** ENU centre and half-diagonal of a tile. Cached: this is called for every candidate. */
  private place = (t: TileId) => {
    const k = tileKey(t)
    const hit = this.places.get(k)
    if (hit) return hit
    const b = tileBoundsOf(t.z, t.x, t.y)
    const c: number[] = [0, 0, 0]
    const nw: number[] = [0, 0, 0]
    this.o.anchor.toLocal((b.w + b.e) / 2, (b.s + b.n) / 2, 0, c)
    this.o.anchor.toLocal(b.w, b.n, 0, nw)
    const p = { x: c[0], z: c[1], radius: Math.hypot(nw[0] - c[0], nw[1] - c[1]) }
    this.places.set(k, p)
    return p
  }

  /** A tile exists if the bake listed it. An `empty` tile still EXISTS — see loadPyrTile. */
  private has = (t: TileId) => this.entries.has(tileKey(t))

  /**
   * One pixel covers this many metres at `d`. Straight from the projection: the view is
   * 2*d*tan(fov/2) metres tall at that range, spread over `viewportH` pixels.
   */
  private mpp = (d: number) => (2 * d * Math.tan(this.o.fovY / 2) * this.o.errorPixels) / this.o.viewportH

  /** Call once a frame with the camera in ENU metres. Cheap when the eye has not moved. */
  update(eyeX: number, eyeZ: number, force = false) {
    if (this.disposed) return
    if (!force && Math.hypot(eyeX - this.lastEye.x, eyeZ - this.lastEye.z) < 8) return
    this.lastEye = { x: eyeX, z: eyeZ }

    const want = wanted(this.roots, {
      eye: { x: eyeX, z: eyeZ },
      metresPerPixel: this.mpp,
      maxTiles: this.o.maxTiles,
      has: this.has,
      place: this.place,
    }, this.o.index.zmax)

    const heldFor = new Map<string, { bytes: number; dist: number }>()
    for (const [k, h] of this.held) {
      const p = this.place(h.tile)
      heldFor.set(k, { bytes: h.tile.bytes, dist: Math.hypot(p.x - eyeX, p.z - eyeZ) })
    }
    const { load, drop } = diff(want, heldFor, this.o.budgetBytes)

    // A tile whose children are wanted is being REFINED, not abandoned: hold it until they are
    // all resident, or the terrain shows a hole for the length of a fetch. The rule is in the
    // engine beside `diff`, with a negative proving it can fail.
    for (const k of holdWhileRefining(drop, want, (key) => this.held.has(key))) this.release(k)

    for (const t of load) {
      const k = tileKey(t)
      if (this.pending.size >= this.o.maxPending) break
      if (this.pending.has(k) || this.held.has(k) || this.failed.has(k)) continue
      this.fetch(k)
    }
  }

  private fetch(k: string) {
    const e = this.entries.get(k)
    if (!e) return
    const ac = new AbortController()
    this.pending.set(k, ac)
    loadPyrTile(this.o.base, this.o.index, e, this.o.anchor, ac.signal)
      .then((tile) => {
        this.pending.delete(k)
        // An `empty` tile resolves null. It exists so quad closure can see the quad is complete;
        // there is nothing to draw and nothing to hold.
        if (!tile || this.disposed) return
        const geo = this.o.geometryFor(tile)
        const mat = this.o.materialFor(tile)
        const mesh = new THREE.Mesh(geo, mat)
        mesh.name = `pyr:${k}`
        this.o.group.add(mesh)
        this.o.set.add(tile)
        this.held.set(k, { tile, mesh, geo, mat })
        this.loads++
      })
      .catch((err) => {
        this.pending.delete(k)
        if (ac.signal.aborted || this.disposed) return
        // A tile that will not load is a gap covered by its parent, which strict
        // child-replaces-parent guarantees is still resident. Remember it so we do not spin.
        this.failed.add(k)
        this.errors++
        if (this.errors <= 3) console.warn(`pyramid: ${k} failed to load — parent stands in`, err)
      })
  }

  private release(k: string) {
    const h = this.held.get(k)
    if (!h) return
    this.o.group.remove(h.mesh)
    h.geo.dispose()
    h.mat.dispose()
    this.o.set.remove(k)
    this.held.delete(k)
    this.drops++
  }

  get counts() {
    let bytes = 0
    for (const h of this.held.values()) bytes += h.tile.bytes
    const levels: Record<number, number> = {}
    for (const h of this.held.values()) levels[h.tile.z] = (levels[h.tile.z] ?? 0) + 1
    return { held: this.held.size, pending: this.pending.size, bytes, levels, loads: this.loads, drops: this.drops, errors: this.errors }
  }

  dispose() {
    this.disposed = true
    for (const ac of this.pending.values()) ac.abort()
    this.pending.clear()
    for (const k of [...this.held.keys()]) this.release(k)
  }
}
