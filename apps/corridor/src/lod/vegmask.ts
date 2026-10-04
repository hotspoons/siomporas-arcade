// Where the air photo says "vegetation", from the 1 m tile photos the bake already ships.
//
// Rich, 2026-09-26: "parking lots are still overgrown with grass … I think we need to limit grass
// growth to grassy textured areas." This class was the answer then: a grass gate derived from the
// photo. It has since been retired as a gate — Rich, 2026-10-04: "we should be deciding where grass
// grows based on where the grass texture is." The GROUND now decides (strip.ts paints the grass
// texture by edge distance, and grass.ts plants on the same rule), because the photo and the
// rendered turf disagreed over whole grass-textured medians and verges. The mask is still streamed:
// its tiles land near the eye, invalidate the local grass and feed the `vegCover` diagnostic. The
// classifier stays here (and in `classify` below) for probes.
//
// The classifier is excess green, ExG = 2G − R − B, on the normalised photo, with a 3 × 3
// majority: grass and canopy are strongly positive, asphalt and concrete sit at zero, bare soil
// and roofs go negative. Summer NAIP; a dry lawn is still green enough. The honest version of
// this is NDVI from NAIP's near-infrared band, which the BAKE has and the jpg does not — a
// `veg.png` per tile is the follow-up in docs/corridor/PLAN-STREAMING-WORLD.md.
//
// Lazy like everything else near the eye: `update(x, y)` fetches the nearest unloaded tile's
// photo inside VEG_RADIUS_M, at most two in flight, and tells the caller which tile just landed.

import type { Tile } from './tiles'
import * as T from '../tuning'

interface Mask { w: number; h: number; data: Uint8Array }

export class VegCover {
  private masks = new Map<string, Mask>()
  private inFlight = new Set<string>()
  private failed = new Set<string>()
  loaded = 0
  /** per-tile wall time of the last load, ms, split into fetch and classify — for probes */
  lastMs = { fetch: 0, decode: 0, classify: 0 }
  get inFlightCount() { return this.inFlight.size }
  get failedCount() { return this.failed.size }
  private tiles: Tile[]
  private urlOf: (t: Tile) => string
  private onLoaded: (t: Tile) => void
  constructor(tiles: Tile[], urlOf: (t: Tile) => string, onLoaded: (t: Tile) => void) {
    this.tiles = tiles
    this.urlOf = urlOf
    this.onLoaded = onLoaded
  }

  /** 1 where the photo says vegetation, 0 where it does not, null where no tile photo has been read yet */
  at(x: number, y: number): 0 | 1 | null {
    for (const t of this.tiles) {
      if (x < t.bounds[0] || x > t.bounds[2] || y < t.bounds[1] || y > t.bounds[3]) continue
      const m = this.masks.get(`${t.x}_${t.y}`)
      if (!m) return null
      if (!t.dem.rf.contains(x, y, 1)) continue
      const g = t.dem.rf.toGrid(x, y)
      const c = Math.min(m.w - 1, Math.max(0, Math.floor(g[0] * m.w)))
      const r = Math.min(m.h - 1, Math.max(0, Math.floor(g[1] * m.h)))
      return m.data[r * m.w + c] as 0 | 1
    }
    return null
  }

  get total() { return this.tiles.filter((t) => t.hasNaip).length }

  /** site-frame eye: fetch the nearest unread tile photo within VEG_RADIUS_M, two at a time */
  update(x: number, y: number) {
    if (this.inFlight.size >= 2) return
    let best: Tile | null = null, bd = Infinity
    for (const t of this.tiles) {
      if (!t.hasNaip) continue
      const k = `${t.x}_${t.y}`
      if (this.masks.has(k) || this.inFlight.has(k) || this.failed.has(k)) continue
      // to the tile's BOX, not its centre: 1 km tiles' centres are 1 km apart, and a centre test
      // inside VEG_RADIUS_M only ever found the eye's own tile
      const d = Math.hypot(Math.max(0, t.bounds[0] - x, x - t.bounds[2]), Math.max(0, t.bounds[1] - y, y - t.bounds[3]))
      if (d < bd) { bd = d; best = t }
    }
    if (!best || bd > T.VEG_RADIUS_M) return
    void this.load(best)
  }

  private async load(t: Tile) {
    const k = `${t.x}_${t.y}`
    this.inFlight.add(k)
    try {
      const t0 = performance.now()
      const res = await fetch(this.urlOf(t), { cache: 'force-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const t1 = performance.now()
      const full = await createImageBitmap(blob)
      const t2 = performance.now()
      const w = Math.max(64, Math.floor(full.width / 2)), h = Math.max(64, Math.floor(full.height / 2))
      const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })
      const ctx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
      ctx.drawImage(full, 0, 0, w, h)
      full.close?.()
      const px = ctx.getImageData(0, 0, w, h).data
      this.masks.set(k, classify(px, w, h))
      this.lastMs = { fetch: Math.round(t1 - t0), decode: Math.round(t2 - t1), classify: Math.round(performance.now() - t2) }
      this.loaded++
      this.onLoaded(t)
    } catch (e) {
      this.failed.add(k)
      console.warn(`vegmask: tile ${k}: ${(e as Error).message}`)
    } finally {
      this.inFlight.delete(k)
    }
  }
}

/** excess green with a 3 × 3 majority; exported so a probe can run it on any pixels */
export function classify(px: Uint8ClampedArray, w: number, h: number): Mask {
  const raw = new Uint8Array(w * h)
  const thr = T.VEG_EXG_MIN
  for (let i = 0, k = 0; i < raw.length; i++, k += 4) {
    const r = px[k] / 255, g = px[k + 1] / 255, b = px[k + 2] / 255
    raw[i] = 2 * g - r - b > thr ? 1 : 0
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy))
        for (let dx = -1; dx <= 1; dx++) s += raw[yy * w + Math.min(w - 1, Math.max(0, x + dx))]
      }
      out[y * w + x] = s >= 5 ? 1 : 0
    }
  }
  return { w, h, data: out }
}
