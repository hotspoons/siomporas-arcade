// Streamed terrain for a network site: the DEM, canopy and imagery arrive as 1 km tiles.
//
// A corridor site is a 3 km ribbon and its DEM fits in one PNG. A NETWORK covers a hull —
// Crofton to Crownsville is 19 x 19 km — where one 2 m raster would be 90 million cells, mostly
// of ground nobody baked. So the bake cuts the fine rasters into `size_m` tiles on the projection
// grid and lists only the ones with data, keeping a coarse overview (8 m DEM, 30 m flora) for
// everything in between.
//
// Three things decide the shape of this file.
//
// **Each tile is its own raster.** The tile lattice is the UTM grid, which is rotated from ENU by
// the meridian convergence — 1.02 deg at Crofton. `tiles.origin + x * size_m` is therefore a
// position on THAT grid, not in ENU, and treating it as an ENU box puts a 1 km tile up to 18 m
// out of place and the far corner of a 19 km site a few hundred metres out. Every tile carries its
// own 3x3 geodetic control lattice, so every tile gets its own `RasterFrame` and its own Field.
// That also means `gridGeometry` places a tile correctly with no changes: it already reads the
// frame and already emits 0..1 UVs per field, which is exactly the UV a per-tile texture wants.
//
// **Heights cannot stream.** The car, the road strip, the trees and the grass ask for a height
// wherever they happen to be, on the first frame, and a height that has not arrived yet is not a
// coarser level of detail — it is a hole to fall through. So every tile's DEM and canopy are
// decoded up front; only the imagery streams, because a texture that has not arrived is merely a
// blurrier picture.
//
// **One request per tile.** A tile is a `pack-1` blob — uint32 little-endian header length, a JSON
// header `{rev, files: {name: [offset, length]}}`, then the payloads — so dem and chm come down
// together instead of two round trips each.
import * as THREE from 'three'
import type { Anchor } from '@apex/engine/geo/wgs84'
import { RasterFrame } from '@apex/engine/geo/raster'
import { DATA_BASE, decodeHeights, decodeScalar, type Layer, type TileIndex } from './site'

export type { TileIndex }

/** A height/scalar raster plus how it sits on the ellipsoid — the same shape scene.ts uses. */
export interface TileField {
  layer: Layer
  data: Float32Array
  rf: RasterFrame
}

export interface Tile {
  x: number
  y: number
  dem: TileField
  chm: TileField | null
  /** ENU axis-aligned bounds of the tile's four corners, for the lookup index and for streaming */
  bounds: [number, number, number, number]
  /** ENU centre, for distance-to-eye */
  cx: number
  cy: number
  hasNaip: boolean
}

/** `pack-1`: uint32 LE header length, header JSON, then the blobs at their offsets. */
export function readPack(buf: ArrayBuffer): Map<string, Uint8Array> {
  const view = new DataView(buf)
  const headerLen = view.getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))) as { rev: number; files: Record<string, [number, number]> }
  const body = 4 + headerLen
  const out = new Map<string, Uint8Array>()
  for (const [name, [off, len]] of Object.entries(header.files)) out.set(name, new Uint8Array(buf, body + off, len))
  return out
}

/** Decode bytes into an image. The object URL is revoked as soon as the bitmap is in hand. */
function imageFrom(bytes: Uint8Array, mime: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }))
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      ok(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      fail(new Error('tile image'))
    }
    img.src = url
  })
}

/** scratch for the containment round trip; `at` runs in every height lookup */
const SCRATCH = [0, 0, 0]

/** The four ENU corners of a raster, as an axis-aligned box. */
function enuBounds(rf: RasterFrame): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const e = [0, 0, 0]
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]) {
    rf.toEnu(u, v, 0, e)
    x0 = Math.min(x0, e[0]); x1 = Math.max(x1, e[0])
    y0 = Math.min(y0, e[1]); y1 = Math.max(y1, e[1])
  }
  return [x0, y0, x1, y1]
}

/**
 * Every tile's heights and canopy, decoded, with a coarse ENU index over them.
 *
 * `heightAt` / `canopyAt` fall back to the overview when a point is outside every tile, which is
 * most of a network hull. The index is a hash of ~`size_m` ENU cells holding the tiles whose ENU
 * box touches them, so a lookup tests one or two candidates instead of all four hundred.
 */
export class TileSet {
  readonly tiles: Tile[] = []
  private readonly cell: number
  private readonly grid = new Map<string, Tile[]>()
  private readonly baseHeight: (x: number, y: number) => number
  private readonly baseCanopy: ((x: number, y: number) => number) | null

  constructor(cell: number, baseHeight: (x: number, y: number) => number, baseCanopy: ((x: number, y: number) => number) | null) {
    this.cell = cell
    this.baseHeight = baseHeight
    this.baseCanopy = baseCanopy
  }

  add(t: Tile) {
    this.tiles.push(t)
    const [x0, y0, x1, y1] = t.bounds
    for (let cy = Math.floor(y0 / this.cell); cy <= Math.floor(y1 / this.cell); cy++) {
      for (let cx = Math.floor(x0 / this.cell); cx <= Math.floor(x1 / this.cell); cx++) {
        const k = `${cx},${cy}`
        const arr = this.grid.get(k)
        if (arr) arr.push(t)
        else this.grid.set(k, [t])
      }
    }
  }

  /**
   * The tile containing this ENU point, and its NORMALISED grid coordinates, or null.
   *
   * `RasterFrame.toGrid` returns u,v in 0..1 and CLAMPS them, so it cannot be asked whether a point
   * is inside — every point comes back looking inside, pinned to the nearest edge. Containment is
   * therefore a round trip: map to the grid, map back to ENU, and if the answer moved, the clamp
   * moved it and the point was outside. A point on a shared edge is claimed by whichever tile is
   * tested first, which is harmless because neighbours agree there.
   */
  private at(x: number, y: number): { t: Tile; u: number; v: number } | null {
    const arr = this.grid.get(`${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`)
    if (!arr) return null
    const e = SCRATCH
    for (const t of arr) {
      if (x < t.bounds[0] || x > t.bounds[2] || y < t.bounds[1] || y > t.bounds[3]) continue
      const g = t.dem.rf.toGrid(x, y)
      t.dem.rf.toEnu(g[0], g[1], 0, e)
      const tol = t.dem.layer.res
      if (Math.abs(e[0] - x) > tol || Math.abs(e[1] - y) > tol) continue
      return { t, u: g[0], v: g[1] }
    }
    return null
  }

  /** u,v are normalised; a raster's row 0 is its NORTH edge, which is what toGrid's v already is. */
  private static cellOf(f: TileField, u: number, v: number): number {
    const [w, h] = f.layer.size
    const c = Math.min(w - 1, Math.max(0, Math.floor(u * w)))
    const r = Math.min(h - 1, Math.max(0, Math.floor(v * h)))
    return r * w + c
  }

  heightAt = (x: number, y: number): number => {
    const hit = this.at(x, y)
    if (!hit) return this.baseHeight(x, y)
    return hit.t.dem.data[TileSet.cellOf(hit.t.dem, hit.u, hit.v)]
  }

  canopyAt = (x: number, y: number): number => {
    const hit = this.at(x, y)
    if (!hit?.t.chm) return this.baseCanopy ? this.baseCanopy(x, y) : 0
    return hit.t.chm.data[TileSet.cellOf(hit.t.chm, hit.u, hit.v)]
  }

  /** Is this ENU point inside any tile? The horizon is cut to exactly this. */
  covers = (x: number, y: number): boolean => this.at(x, y) !== null
}

/**
 * Fetch and decode every tile listed in the manifest.
 *
 * `budget` is awaited between tiles so a four-hundred-tile network does not freeze the tab — the
 * frame budget yields on requestAnimationFrame, which does NOT fire in a background tab, so the
 * caller passes one that is safe to await while hidden.
 */
export async function loadTiles(
  base: string,
  index: TileIndex,
  anchor: Anchor,
  set: TileSet,
  onProgress?: (done: number, total: number) => void,
  budget?: () => Promise<void>,
): Promise<TileSet> {
  const dir = index.dir ?? 'tiles/0'
  let done = 0
  for (const e of index.list) {
    try {
      const res = await fetch(`${DATA_BASE}${base}${dir}/${e.x}_${e.y}.pack`, { cache: 'force-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const files = readPack(await res.arrayBuffer())
      const demBytes = files.get('dem.png')
      if (!demBytes) throw new Error('pack has no dem.png')
      const demImg = await imageFrom(demBytes, 'image/png')
      const demLayer: Layer = { file: `${e.x}_${e.y}.dem.png`, res: index.res.dem, size: [demImg.naturalWidth, demImg.naturalHeight], bbox: [0, 0, 0, 0], zmin: e.dem.zmin, zscale: e.dem.zscale, geo: e.geo }
      const rf = new RasterFrame({ size: demLayer.size, geo: e.geo! }, anchor)
      const dem: TileField = { layer: demLayer, data: decodeHeights(demImg, demLayer), rf }
      let chm: TileField | null = null
      const chmBytes = files.get('chm.png')
      if (chmBytes) {
        const chmImg = await imageFrom(chmBytes, 'image/png')
        const chmLayer: Layer = { file: `${e.x}_${e.y}.chm.png`, res: index.res.chm ?? index.res.dem, size: [chmImg.naturalWidth, chmImg.naturalHeight], bbox: [0, 0, 0, 0], scale: 0.25, geo: e.geo }
        // its own frame: the canopy raster may not be the same size as the DEM's
        chm = { layer: chmLayer, data: decodeScalar(chmImg, 0.25), rf: new RasterFrame({ size: chmLayer.size, geo: e.geo! }, anchor) }
      }
      const bounds = enuBounds(rf)
      set.add({ x: e.x, y: e.y, dem, chm, bounds, cx: (bounds[0] + bounds[2]) / 2, cy: (bounds[1] + bounds[3]) / 2, hasNaip: !!e.naip })
    } catch {
      // a tile that will not load is a gap, not a crash: the overview stands in for it
    }
    done++
    onProgress?.(done, index.list.length)
    if (budget) await budget()
  }
  return set
}

/**
 * Keeps each tile's imagery in step with the eye: the 1 m NAIP loads within `loadWithin`, is
 * released beyond `keepWithin`, and at most `inFlight` are in the air so a fast pass along a road
 * does not queue forty textures nobody will see. Nearest-first, because the tile you are standing
 * on matters more than the one at the edge of the ring.
 */
export class ImageryStream {
  private readonly base: string
  private readonly dir: string
  private readonly texture: string
  private readonly loader = new THREE.TextureLoader()
  private readonly loaded = new Map<string, THREE.Texture>()
  private readonly pending = new Set<string>()
  private readonly targets = new Map<string, { tile: Tile; mat: THREE.MeshStandardMaterial; fallback: THREE.Texture | null }>()
  loadWithin = 2000
  keepWithin = 3500
  inFlight = 2
  loads = 0
  unloads = 0
  fails = 0

  constructor(base: string, index: TileIndex) {
    this.base = base
    this.dir = index.dir ?? 'tiles/0'
    this.texture = index.texture ?? 'naip.jpg'
  }

  add(tile: Tile, mat: THREE.MeshStandardMaterial, fallback: THREE.Texture | null) {
    if (tile.hasNaip) this.targets.set(`${tile.x}_${tile.y}`, { tile, mat, fallback })
  }

  /** Call per frame with the eye in SITE coordinates (x, y = -z). */
  update(eyeX: number, eyeY: number) {
    let best: { key: string; d: number } | null = null
    for (const [key, t] of this.targets) {
      const d = Math.hypot(t.tile.cx - eyeX, t.tile.cy - eyeY)
      if (d > this.keepWithin && this.loaded.has(key)) {
        const tex = this.loaded.get(key)!
        t.mat.map = t.fallback
        t.mat.needsUpdate = true
        tex.dispose()
        this.loaded.delete(key)
        this.unloads++
        continue
      }
      if (d <= this.loadWithin && !this.loaded.has(key) && !this.pending.has(key) && (!best || d < best.d)) best = { key, d }
    }
    if (best && this.pending.size < this.inFlight) this.fetch(best.key)
  }

  private fetch(key: string) {
    const t = this.targets.get(key)
    if (!t) return
    this.pending.add(key)
    this.loader.load(
      `${DATA_BASE}${this.base}${this.dir}/${key}.${this.texture}`,
      (tex) => {
        this.pending.delete(key)
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = 8
        tex.generateMipmaps = true
        tex.minFilter = THREE.LinearMipmapLinearFilter
        this.loaded.set(key, tex)
        this.loads++
        t.mat.map = tex
        t.mat.color.setRGB(1, 1, 1)
        t.mat.needsUpdate = true
      },
      undefined,
      () => {
        this.pending.delete(key)
        this.fails++
      },
    )
  }

  get counts() {
    return { resident: this.loaded.size, pending: this.pending.size, tiles: this.targets.size, loads: this.loads, unloads: this.unloads, fails: this.fails }
  }

  dispose() {
    for (const t of this.loaded.values()) t.dispose()
    this.loaded.clear()
  }
}
