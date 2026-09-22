// Streamed terrain: the DEM, canopy and imagery of a network-sized site arrive as 1 km tiles
// instead of one image per layer.
//
// A single site is a 2-4 km ribbon and its DEM fits in one PNG. A NETWORK covers everything inside
// a hull — Crofton to Crownsville is tens of square kilometres — and one image at 2 m would be
// enormous, mostly empty (nothing is baked away from the roads), and impossible to load in pieces.
// So the bake cuts it into `size_m` tiles and lists only the ones that have data.
//
// The heights are NOT streamed. `heightAt` is asked for a height wherever a road, a tree, a grass
// blade or the car happens to be, on the first frame, and a height that has not arrived yet is not
// a lower level of detail — it is a hole the car falls through. So every dem/chm tile is decoded at
// boot into ONE mosaic Field covering the hull, pre-filled from the 60 m horizon so the gaps
// between corridors are the coarse landscape rather than nothing. Everything downstream — the
// sampler, the strip, the trees, the grass, the canopy blanket — keeps taking a single Field and
// does not know any of this happened.
//
// The IMAGERY is streamed, because a missing texture is only a blurrier picture: each terrain tile
// starts with the horizon's own NAIP under it (the same pixels the far terrain uses, so the seam is
// invisible) and swaps to its 1 m tile when that arrives.
import * as THREE from 'three'
import { DATA_BASE, decodeHeights, decodeScalar, loadImage, type Layer, type TileIndex } from './site'

export type { TileIndex }

/** A height/scalar raster with the geometry to place it: the one thing the whole viewer samples. */
export interface Field {
  layer: Layer
  data: Float32Array
}

/** Site-frame bbox of one tile: [xmin, ymin, xmax, ymax]. */
export function tileBbox(t: TileIndex, x: number, y: number): [number, number, number, number] {
  const [ox, oy] = t.origin
  return [ox + x * t.size_m, oy + y * t.size_m, ox + (x + 1) * t.size_m, oy + (y + 1) * t.size_m]
}

/** The union of every listed tile, which is the area the mosaic has to cover. */
export function hullBbox(t: TileIndex): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of t.list) {
    const b = tileBbox(t, e.x, e.y)
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1])
    x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3])
  }
  return [x0, y0, x1, y1]
}

const url = (base: string, x: number, y: number, kind: string) => `${base}tiles/0/${x}_${y}.${kind}`

/**
 * Decode every tile of one kind into a single Field over the hull.
 *
 * `fill` seeds the mosaic before any tile is written — bilinear from the horizon for the DEM, and a
 * flat 0 for the canopy (there is no coarse canopy, and "no tile" means "no trees", which is right).
 * Tiles are written on top, so the corridors are sharp and the country between them is the coarse
 * landscape instead of a cliff to zero.
 *
 * `onProgress` is called per tile so the loading status can count them; the caller decides the
 * wording.
 */
export async function buildMosaic(
  base: string,
  tiles: TileIndex,
  kind: 'dem' | 'chm',
  res: number,
  fill: ((x: number, y: number) => number) | null,
  onProgress?: (done: number, total: number) => void,
): Promise<Field> {
  const [x0, y0, x1, y1] = hullBbox(tiles)
  const w = Math.max(1, Math.round((x1 - x0) / res))
  const h = Math.max(1, Math.round((y1 - y0) / res))
  const layer: Layer = { file: `tiles:${kind}`, res, size: [w, h], bbox: [x0, y0, x1, y1] }
  const data = new Float32Array(w * h)
  if (fill) {
    // row 0 is ymax, matching `sampler` and `gridGeometry`
    for (let r = 0; r < h; r++) {
      const yy = y1 - (r + 0.5) * res
      for (let c = 0; c < w; c++) data[r * w + c] = fill(x0 + (c + 0.5) * res, yy)
    }
  }
  const want = tiles.list.filter((e) => (kind === 'dem' ? true : e.chm))
  let done = 0
  for (const e of want) {
    const [tx0, , , ty1] = tileBbox(tiles, e.x, e.y)
    let img: HTMLImageElement
    try {
      img = await loadImage(url(base, e.x, e.y, `${kind}.png`))
    } catch {
      done++
      onProgress?.(done, want.length)
      continue // a listed tile that will not load is a gap, not a crash: the fill stands
    }
    const tw = img.naturalWidth, th = img.naturalHeight
    const tileLayer: Layer = { file: '', res, size: [tw, th], bbox: [tx0, ty1 - th * res, tx0 + tw * res, ty1], zmin: e.dem.zmin, zscale: e.dem.zscale }
    const src = kind === 'dem' ? decodeHeights(img, tileLayer) : decodeScalar(img, tiles.res.chm != null ? 0.25 : 0.25)
    // where this tile's top-left cell lands in the mosaic
    const c0 = Math.round((tx0 - x0) / res)
    const r0 = Math.round((y1 - ty1) / res)
    for (let r = 0; r < th; r++) {
      const mr = r0 + r
      if (mr < 0 || mr >= h) continue
      const srcRow = r * tw
      const dstRow = mr * w
      for (let c = 0; c < tw; c++) {
        const mc = c0 + c
        if (mc < 0 || mc >= w) continue
        data[dstRow + mc] = src[srcRow + c]
      }
    }
    done++
    onProgress?.(done, want.length)
  }
  return { layer, data }
}

/** Bilinear read of a Field, for seeding a fine mosaic from the coarse horizon without stair-steps. */
export function bilinear(f: Field): (x: number, y: number) => number {
  const [xmin, ymin, xmax, ymax] = f.layer.bbox
  const [w, h] = f.layer.size
  const res = f.layer.res
  return (x: number, y: number) => {
    if (x < xmin || x > xmax || y < ymin || y > ymax) return 0
    const fc = (x - xmin) / res - 0.5
    const fr = (ymax - y) / res - 0.5
    const c0 = Math.min(w - 1, Math.max(0, Math.floor(fc)))
    const r0 = Math.min(h - 1, Math.max(0, Math.floor(fr)))
    const c1 = Math.min(w - 1, c0 + 1)
    const r1 = Math.min(h - 1, r0 + 1)
    const tx = Math.min(1, Math.max(0, fc - c0))
    const ty = Math.min(1, Math.max(0, fr - r0))
    const a = f.data[r0 * w + c0], b = f.data[r0 * w + c1]
    const c = f.data[r1 * w + c0], d = f.data[r1 * w + c1]
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
  }
}

/** Where a tile's footprint sits inside the horizon imagery, as a texture offset/repeat. */
export function horizonUv(t: TileIndex, x: number, y: number, horizon: Layer): { offset: THREE.Vector2; repeat: THREE.Vector2 } {
  const [bx0, by0, bx1, by1] = tileBbox(t, x, y)
  const [hx0, hy0, hx1, hy1] = horizon.bbox
  const wx = hx1 - hx0, wy = hy1 - hy0
  return {
    offset: new THREE.Vector2((bx0 - hx0) / wx, (by0 - hy0) / wy),
    repeat: new THREE.Vector2((bx1 - bx0) / wx, (by1 - by0) / wy),
  }
}

/**
 * Keeps each terrain tile's imagery in step with where the eye is: 1 m NAIP within `loadWithin`,
 * released beyond `keepWithin`, at most `inFlight` requests at a time so a fast pass along the road
 * does not queue forty textures nobody will see.
 */
export class ImageryStream {
  private readonly base: string
  private readonly tiles: TileIndex
  private readonly loader = new THREE.TextureLoader()
  private readonly loaded = new Map<string, THREE.Texture>()
  private readonly pending = new Set<string>()
  private readonly targets = new Map<string, { mat: THREE.MeshStandardMaterial; fallback: THREE.Texture; centre: THREE.Vector2 }>()
  loadWithin = 2000
  keepWithin = 3500
  inFlight = 2
  loads = 0
  unloads = 0

  constructor(base: string, tiles: TileIndex) {
    this.base = base
    this.tiles = tiles
  }

  /** Register the material that should receive tile (x, y)'s imagery. */
  add(x: number, y: number, mat: THREE.MeshStandardMaterial, fallback: THREE.Texture) {
    const [bx0, by0, bx1, by1] = tileBbox(this.tiles, x, y)
    this.targets.set(`${x}_${y}`, { mat, fallback, centre: new THREE.Vector2((bx0 + bx1) / 2, (by0 + by1) / 2) })
  }

  /** Call from the frame loop with the eye in SITE coordinates (x, y = -z). */
  update(eyeX: number, eyeY: number) {
    for (const [key, t] of this.targets) {
      const d = Math.hypot(t.centre.x - eyeX, t.centre.y - eyeY)
      const have = this.loaded.get(key)
      if (d <= this.loadWithin && !have && !this.pending.has(key) && this.pending.size < this.inFlight) {
        const [x, y] = key.split('_').map(Number)
        if (!this.tiles.list.some((e) => e.x === x && e.y === y && e.naip)) continue
        this.pending.add(key)
        this.loader.load(
          `${DATA_BASE}${url(this.base, x, y, 'naip.jpg')}`,
          (tex) => {
            this.pending.delete(key)
            tex.colorSpace = THREE.SRGBColorSpace
            tex.anisotropy = 8
            tex.generateMipmaps = true
            tex.minFilter = THREE.LinearMipmapLinearFilter
            // the streamed tile IS the tile, so it fills 0..1 — no offset/repeat
            tex.offset.set(0, 0)
            tex.repeat.set(1, 1)
            this.loaded.set(key, tex)
            this.loads++
            const tgt = this.targets.get(key)
            if (tgt) {
              tgt.mat.map = tex
              tgt.mat.color.setRGB(1, 1, 1)
              tgt.mat.needsUpdate = true
            }
          },
          undefined,
          () => this.pending.delete(key), // a missing tile just keeps the coarse imagery
        )
      } else if (d > this.keepWithin && have) {
        t.mat.map = t.fallback
        t.mat.needsUpdate = true
        have.dispose()
        this.loaded.delete(key)
        this.unloads++
      }
    }
  }

  /** For the probe: what is resident right now. */
  get counts() {
    return { resident: this.loaded.size, pending: this.pending.size, tiles: this.targets.size, loads: this.loads, unloads: this.unloads }
  }

  dispose() {
    for (const t of this.loaded.values()) t.dispose()
    this.loaded.clear()
  }
}
