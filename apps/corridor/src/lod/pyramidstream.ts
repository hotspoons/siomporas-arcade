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
import { childrenOf, diff, holdWhileRefining, tileBoundsOf, tileKey, tileMetres, type TileId } from '@apex/engine/geo/pyramid'
import { PyramidSet, loadPyrTile, type PyrEntry, type PyrIndex, type PyrTile } from './tiles'
import * as T from '../tuning'

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
  /**
   * The tile's own photo, or null when the bake has none. The mesh is born wearing the overview
   * and this replaces it — the same split trailworks uses, where the coarse ring paints first
   * and the leaf's texture arrives with the tile.
   */
  textureFor?: (t: PyrTile) => string | null
}

/** A tile that has left the wanted set stays this many metres of travel, so the boundary does not flap. */
const HYSTERESIS_M = 220

/** Coarse levels are red, fine levels are blue — one colour per pyramid slot, shared with the legend. */
function levelColor(z: number, zmin: number, zmax: number): string {
  const t = zmax === zmin ? 1 : (z - zmin) / (zmax - zmin)
  const hue = t * 0.66
  const i = Math.floor(hue * 6)
  const f = hue * 6 - i
  const s = 0.75
  const v = 1
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const tt = v * (1 - (1 - f) * s)
  const lut: [number, number, number][] = [
    [v, tt, p], [q, v, p], [p, v, tt], [p, q, v], [tt, p, v], [v, p, q],
  ]
  const [r, g, b] = lut[((i % 6) + 6) % 6]
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

interface Held {
  tile: PyrTile
  mesh: THREE.Mesh
  geo: THREE.BufferGeometry
  mat: THREE.MeshStandardMaterial
  /** the tile's own photo, disposed with the mesh. The overview map is shared and is not. */
  photo: THREE.Texture | null
  /** which child quadrants are currently dropped, so a repeat seat is a no-op */
  mask: number
  /** the drop distance last written into this mesh, so the knob can move it again */
  drop: number
  /** vertex positions before any drop, so a quadrant can come back up to the metre */
  basePos: Float32Array | null
}

export class PyramidStream {
  private readonly o: Required<Omit<PyramidStreamOpts, 'index' | 'anchor' | 'set' | 'group' | 'geometryFor' | 'materialFor' | 'base' | 'textureFor'>> & PyramidStreamOpts
  private readonly entries = new Map<string, PyrEntry>()
  private readonly roots: TileId[] = []
  private readonly held = new Map<string, Held>()
  private readonly pending = new Map<string, AbortController>()
  private readonly places = new Map<string, { x: number; z: number; radius: number }>()
  private readonly failed = new Set<string>()
  private lastEye = { x: Infinity, z: Infinity }
  /** metres the eye travelled on the update that just ran; the first one has no previous eye */
  private lastMoved = 0
  /** how far the eye has travelled since a held tile left the wanted set */
  private readonly sticky = new Map<string, number>()
  /** the tiles the last update asked for, so the panel can say how many leaves are in view */
  private lastWant: TileId[] = []
  /** the performance panel's tile tint: each level wears one colour so a seam is readable */
  private tintOn = false
  /** camera height and look, so a view from altitude does not refine every tile under the nadir */
  private view: { agl: number; fx: number; fy: number; fz: number } | null = null
  /** the height and look the last walk used. A newer look is stored every frame and does not, by itself, walk again */
  private aimed: { agl: number; fx: number; fy: number; fz: number } | null = null
  private tunedDrop = Number.NaN
  private tunedError = Number.NaN
  private tunedCone = Number.NaN
  /**
   * What a tile costs, for budgeting a fetch before it lands. Seeded from a measured crownsville
   * tile (213 KiB pack + a 512x512 float32 DEM + the same for canopy) and then replaced by this
   * bake's own running mean, because a site with no canopy costs half of that.
   */
  private typicalBytes = 2.21 * 1024 * 1024
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

  /** A listed tile that carries a raster. Empty markers keep the quad closed and are not drawn. */
  private drawable = (t: TileId) => {
    const e = this.entries.get(tileKey(t))
    return !!e && !e.empty
  }

  /**
   * Leaves to fetch, plus any ancestor that still has to cover an empty quadrant.
   *
   * `wanted()` in the engine splits a quad only when all four children exist, which is right for a
   * missing file and wrong for this bake: crofton's roots are three-quarters nodata, so that rule
   * never leaves z10. A child with a raster is refined on its own. A child without one leaves its
   * parent in the set, and the parent shows through that quadrant. A full quad of rasters replaces
   * the parent, which `holdWhileRefining` keeps until the children have arrived.
   */
  private select(eyeX: number, eyeZ: number): TileId[] {
    const out: TileId[] = []
    const stack = [...this.roots]
    while (stack.length) {
      const t = stack.pop()!
      if (out.length >= this.o.maxTiles) break
      if (!this.drawable(t)) continue
      const kids = childrenOf(t).filter((c) => this.drawable(c))
      if (t.z >= this.o.index.zmax || !kids.length) {
        out.push(t)
        continue
      }
      const p = this.place(t)
      // Outside the view cone a tile stays at whatever level the walk has already reached.
      // The tile under the camera is never "outside": its centre can sit behind you when you
      // are near the far edge, and treating that as outside the cone drops the ground you are
      // on to the parent until you turn around or cross into a tile whose centre is ahead.
      if (this.outsideCone(p, eyeX, eyeZ)) {
        out.push(t)
        continue
      }
      // Slant range, not the ground distance. A tile under the camera used to count as 1 m away,
      // so a view from a few miles up asked for z14 across the whole disc.
      const horiz = Math.max(0, Math.hypot(p.x - eyeX, p.z - eyeZ) - p.radius)
      const d = Math.max(1, Math.hypot(horiz, this.view?.agl ?? 0))
      const gsd = (p.radius * 2) / Math.SQRT2 / (this.o.index.px || 512)
      if (gsd <= this.mpp(d)) {
        out.push(t)
        continue
      }
      if (kids.length < 4) out.push(t)
      stack.push(...kids)
    }
    return out
  }

  /**
   * One pixel covers this many metres at `d`. Straight from the projection: the view is
   * 2*d*tan(fov/2) metres tall at that range, spread over `viewportH` pixels.
   */
  private mpp = (d: number) => (2 * d * Math.tan(this.o.fovY / 2) * T.PYR_ERROR_PX) / this.o.viewportH

  /**
   * True when the tile's footprint sits outside the high-detail cone around the look direction.
   *
   * The angular-radius test is only valid from outside the tile. Inside it, the centre can be
   * directly behind you while you are still standing on the tile, and `angle − 90°` is then
   * larger than a tight cone, so the tile you are on would never refine.
   */
  private outsideCone(p: { x: number; z: number; radius: number }, eyeX: number, eyeZ: number): boolean {
    const cone = T.PYR_CONE_DEG
    const v = this.view
    if (cone >= 179 || !v) return false
    if (Math.hypot(p.x - eyeX, p.z - eyeZ) <= p.radius) return false
    const dx = p.x - eyeX
    const dy = -v.agl
    const dz = -(p.z - eyeZ)
    const len = Math.hypot(dx, dy, dz)
    if (len < 1) return false
    const dot = (dx * v.fx + dy * v.fy + dz * v.fz) / len
    const ang = Math.acos(Math.max(-1, Math.min(1, dot)))
    const tileAng = Math.asin(Math.min(1, p.radius / len))
    return ang - tileAng > (cone * Math.PI) / 180
  }

  /** Ask for the next batch at the eye we already have. A finished fetch is what starts it. */
  private pump() {
    if (this.disposed || !Number.isFinite(this.lastEye.x)) return
    this.update(this.lastEye.x, this.lastEye.z, true)
  }

  /**
   * Call once a frame with the camera in ENU metres. Cheap when the eye has not moved.
   * `view.agl` is metres above the ground; `fx, fy, fz` is the look direction in world space
   * (x east, y up, z south). Both are what the cone and the slant range read.
   */
  update(eyeX: number, eyeZ: number, force = false, view?: { agl: number; fx: number; fy: number; fz: number }) {
    if (this.disposed) return
    // The top-down camera (and a climb straight up) keeps the same east/north. The walk used to
    // wait for an 8 m move on the ground, so the cone stayed aimed down the road you had been
    // driving and the map stayed coarse until a cone-knob change forced the walk to run.
    let reaim = false
    if (view) {
      const prev = this.aimed
      if (prev) {
        const turn = Math.hypot(view.fx - prev.fx, view.fy - prev.fy, view.fz - prev.fz)
        const climb = Math.abs(view.agl - prev.agl)
        reaim = turn > 0.08 || climb > Math.max(40, prev.agl * 0.25)
      }
      this.view = view
    }
    const dropM = T.PYR_DROP_M
    const retune = T.PYR_ERROR_PX !== this.tunedError || T.PYR_CONE_DEG !== this.tunedCone
    const redrop = dropM !== this.tunedDrop
    this.tunedError = T.PYR_ERROR_PX
    this.tunedCone = T.PYR_CONE_DEG
    this.tunedDrop = dropM
    if (redrop) this.seat()
    const moved = Number.isFinite(this.lastEye.x) ? Math.hypot(eyeX - this.lastEye.x, eyeZ - this.lastEye.z) : Infinity
    if (!force && !retune && !reaim && moved < 8) return
    if (this.view) this.aimed = { agl: this.view.agl, fx: this.view.fx, fy: this.view.fy, fz: this.view.fz }
    this.lastMoved = Number.isFinite(moved) ? moved : 0
    this.lastEye = { x: eyeX, z: eyeZ }

    const want = this.select(eyeX, eyeZ)
    this.lastWant = want

    const heldFor = new Map<string, { bytes: number; dist: number }>()
    for (const [k, h] of this.held) {
      const p = this.place(h.tile)
      heldFor.set(k, { bytes: h.tile.bytes, dist: Math.hypot(p.x - eyeX, p.z - eyeZ) })
    }
    const { load, drop } = diff(want, heldFor, this.o.budgetBytes)
    const wantKeys = new Set(want.map(tileKey))

    // Trailworks keeps a few tiles past the cap so the boundary does not load, evict, and load
    // again as the view rolls a few metres. A second, finer `wanted()` walk cannot be that pad:
    // it asks for children the fetch set has not asked for, and the two sets then share nothing,
    // so nothing loads. The pad is time-in-saddle instead: a tile that has left the fetch set
    // stays until the eye has travelled past it.
    for (const k of [...this.sticky.keys()]) {
      if (!this.held.has(k) || wantKeys.has(k)) this.sticky.delete(k)
    }
    for (const k of this.held.keys()) {
      if (wantKeys.has(k)) continue
      this.sticky.set(k, (this.sticky.get(k) ?? 0) + this.lastMoved)
    }
    const dropNow = drop.filter((k) => (this.sticky.get(k) ?? HYSTERESIS_M) >= HYSTERESIS_M)

    // A tile whose children are wanted is being REFINED, not abandoned: hold it until they are
    // all resident, or the terrain shows a hole for the length of a fetch. The rule is in the
    // engine beside `diff`, with a negative proving it can fail.
    for (const k of holdWhileRefining(dropNow, want, (key) => this.held.has(key))) this.release(k)

    // The budget bounds the HELD set at the moment diff() ran. Tiles in flight are not in it yet,
    // so issuing every wanted load would sail past the ceiling and only come back under it on the
    // next update — a jump-cut to a new part of the world would spike well over. Count what is
    // already in the air against the same budget.
    let inFlight = this.pending.size * this.typicalBytes
    let resident = 0
    for (const h of this.held.values()) resident += h.tile.bytes
    for (const t of load) {
      const k = tileKey(t)
      if (this.pending.size >= this.o.maxPending) break
      if (resident + inFlight + this.typicalBytes > this.o.budgetBytes) break
      if (this.pending.has(k) || this.held.has(k) || this.failed.has(k)) continue
      this.fetch(k)
      inFlight += this.typicalBytes
    }
  }

  private fetch(k: string) {
    const e = this.entries.get(k)
    if (!e || e.empty) return
    const ac = new AbortController()
    this.pending.set(k, ac)
    loadPyrTile(this.o.base, this.o.index, e, this.o.anchor, ac.signal)
      .then((tile) => {
        this.pending.delete(k)
        // An `empty` tile resolves null. It exists so quad closure can see the quad is complete;
        // there is nothing to draw and nothing to hold.
        if (!tile || this.disposed) {
          // null is an empty marker. Remember it so the next update does not spend a slot on it.
          if (!tile && !this.disposed) this.failed.add(k)
          return
        }
        const geo = this.o.geometryFor(tile)
        const mat = this.o.materialFor(tile)
        const mesh = new THREE.Mesh(geo, mat)
        mesh.name = `pyr:${k}`
        // Finer tiles draw first. A parent that is only covering an empty quadrant then fails the
        // depth test where a child already wrote the ground, instead of shading that ground again.
        mesh.renderOrder = -tile.z
        this.o.group.add(mesh)
        this.o.set.add(tile)
        const held: Held = { tile, mesh, geo, mat, photo: null, mask: 0, drop: -1, basePos: null }
        this.held.set(k, held)
        this.loads++
        this.paint(held)
        // A child arriving drops the coarse ground under it; a parent arriving after its
        // children arrives already dropped. Both are the same walk.
        this.seat()
        // The walk bails when the eye has not moved, which is correct for the selection and wrong
        // for the queue: a car parked at the spawn would take one batch of tiles and then leave
        // the rest of the ground to the coarse overview, which stands up through the road.
        this.pump()
        const url = this.o.textureFor?.(tile) ?? null
        if (url) {
          new THREE.TextureLoader().load(url, (tex) => {
            if (this.disposed || this.held.get(k) !== held) {
              tex.dispose()
              return
            }
            tex.colorSpace = THREE.SRGBColorSpace
            tex.anisotropy = 8
            tex.generateMipmaps = true
            tex.minFilter = THREE.LinearMipmapLinearFilter
            tex.needsUpdate = true
            held.photo = tex
            mat.map = tex
            mat.color.setRGB(1, 1, 1)
            this.paint(held)
          })
        }
        // running mean, so the budget learns this bake's real cost rather than trusting the seed
        this.typicalBytes += (tile.bytes - this.typicalBytes) / Math.min(this.loads, 32)
      })
      .catch((err) => {
        this.pending.delete(k)
        if (ac.signal.aborted || this.disposed) return
        // A tile that will not load is a gap covered by its parent, which strict
        // child-replaces-parent guarantees is still resident. Remember it so we do not spin.
        this.failed.add(k)
        this.errors++
        if (this.errors <= 3) console.warn(`pyramid: ${k} failed to load — parent stands in`, err)
        this.pump()
      })
  }

  private release(k: string) {
    const h = this.held.get(k)
    if (!h) return
    this.o.group.remove(h.mesh)
    h.geo.dispose()
    h.photo?.dispose()
    h.mat.map = null
    h.mat.dispose()
    this.o.set.remove(k)
    this.held.delete(k)
    this.drops++
    this.seat()
  }

  /**
   * Drop each coarse quadrant that a finer tile is drawn on, and bring it back when the last
   * such tile is gone.
   *
   * The whole mesh cannot move: a parent often stays up to cover an empty quadrant, and sinking
   * that quadrant would open a pit beside the road. So only the vertices inside a
   * quadrant that has a resident descendant move, and they move back to the stored positions
   * the moment that descendant is released.
   */
  private seat() {
    const masks = new Map<string, number>()
    for (const h of this.held.values()) {
      let z = h.tile.z
      let x = h.tile.x
      let y = h.tile.y
      while (z > this.o.index.zmin) {
        const pz = z - 1
        const px = x >> 1
        const py = y >> 1
        const pk = `${pz}/${px}/${py}`
        if (this.held.has(pk)) {
          const shift = h.tile.z - pz - 1
          const cx = h.tile.x >> shift
          const cy = h.tile.y >> shift
          const qi = (cx === px * 2 ? 0 : 1) + (cy === py * 2 ? 0 : 2)
          masks.set(pk, (masks.get(pk) ?? 0) | (1 << qi))
        }
        z = pz
        x = px
        y = py
      }
    }
    const drop = T.PYR_DROP_M
    for (const [k, h] of this.held) {
      const mask = masks.get(k) ?? 0
      if (mask === h.mask && h.drop === drop && (mask === 0 || h.basePos)) continue
      this.dropQuadrants(h, mask, drop)
    }
  }

  private dropQuadrants(h: Held, mask: number, drop: number) {
    const pos = h.geo.getAttribute('position') as THREE.BufferAttribute
    const uv = h.geo.getAttribute('uv') as THREE.BufferAttribute | undefined
    if (!uv) return
    if (!h.basePos) h.basePos = new Float32Array(pos.array as Float32Array)
    const src = h.basePos
    const dst = pos.array as Float32Array
    dst.set(src)
    if (mask !== 0) {
      // Stay off the cross at u = 0.5 / v = 0.5. Those vertices are shared with a quadrant
      // that may still be the only ground, and dropping them opens a ditch along the seam.
      const inset = 0.012
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i)
        const v = 1 - uv.getY(i)
        const east = u >= 0.5
        const south = v >= 0.5
        const qi = (east ? 1 : 0) + (south ? 2 : 0)
        if (!(mask & (1 << qi))) continue
        const uIn = east ? u > 0.5 + inset : u < 0.5 - inset
        const vIn = south ? v > 0.5 + inset : v < 0.5 - inset
        if (uIn && vIn) dst[i * 3 + 1] = src[i * 3 + 1] - drop
      }
    }
    pos.needsUpdate = true
    h.geo.computeVertexNormals()
    h.mask = mask
    h.drop = drop
  }

  /** Turn the legend tint on. The colour is applied in the terrain shader, not as a material multiply. */
  setTint(on: boolean) {
    this.tintOn = on
    for (const h of this.held.values()) this.paint(h)
  }

  /**
   * One swatch per level the bake has, finest first. The colour is the same one `setTint` puts
   * on the mesh, so the legend and the ground cannot disagree.
   */
  legend(): { color: string; text: string }[] {
    const { zmin, zmax } = this.o.index
    const lat = this.o.anchor.lat
    const levels = this.counts.levels
    const rows: { color: string; text: string }[] = []
    for (let z = zmax; z >= zmin; z--) {
      const edge = tileMetres(z, lat).ns
      const size = edge >= 1000 ? `${(edge / 1000).toFixed(edge >= 10000 ? 0 : 1)} km` : `${Math.round(edge)} m`
      rows.push({ color: levelColor(z, zmin, zmax), text: `z${z} · ${size} · ${levels[z] ?? 0}` })
    }
    return rows
  }

  private paint(h: Held) {
    const on = h.mat.userData.lodOn as { value: number } | undefined
    const tint = h.mat.userData.lodTint as THREE.Color | undefined
    if (!on || !tint) return
    on.value = this.tintOn ? 1 : 0
    if (this.tintOn) tint.set(levelColor(h.tile.z, this.o.index.zmin, this.o.index.zmax))
  }

  /**
   * Finest tile the last selection asked for whose footprint contains this point.
   * Null when nothing wanted covers it. Finer than whatever is resident when the leaf
   * has been asked for and has not arrived yet.
   */
  wantedZ(eyeX: number, eyeZ: number): number | null {
    let best: number | null = null
    for (const t of this.lastWant) {
      const p = this.place(t)
      if (Math.hypot(p.x - eyeX, p.z - eyeZ) > p.radius) continue
      if (best === null || t.z > best) best = t.z
    }
    return best
  }

  /**
   * What the performance panel prints about the stream.
   *
   * The tile is the finest one actually resident under the eye — a coarse id there means the
   * leaf has not arrived and the ground you see is the parent. Leaf held can exceed the view:
   * tiles you have driven past stay until you are well clear of them.
   */
  hudLines(eyeX: number, eyeZ: number): string[] {
    const here = this.o.set.tileAt(eyeX, eyeZ)
    const zmax = this.o.index.zmax
    const counts = this.counts
    let leafHeld = 0
    for (const h of this.held.values()) if (h.tile.z === zmax) leafHeld++
    let leafWanted = 0
    for (const t of this.lastWant) if (t.z === zmax) leafWanted++
    const id = here ? `z${here.z} ${here.x}/${here.y}` : 'none'
    const leaf = here && here.z < zmax ? ` · under z${zmax}` : ''
    const photo = here && !this.held.get(`${here.z}/${here.x}/${here.y}`)?.photo ? ' · no photo' : ''
    const levels = Object.keys(counts.levels)
      .map(Number)
      .sort((a, b) => a - b)
      .map((z) => `z${z}:${counts.levels[z]}`)
      .join(' ')
    return [
      `tile ${id}${leaf}${photo}`,
      `leaf ${leafHeld} held · ${leafWanted} in view · ${this.held.size} tiles · pend ${this.pending.size}`,
      levels,
    ]
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
