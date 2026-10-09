/**
 * PNG decode for one pyramid pack, off the main thread.
 *
 * The height formula is the same as decodeHeights / decodeScalar in world/site.ts: R is the high
 * byte, G the low byte, then zmin + sample * zscale. Relief (the exaggeration knob) stays on the
 * main thread, because that knob is process state the worker does not have.
 *
 * It also builds the terrain GRID now. The per-vertex `RasterFrame.toEnu` walk and the vertex
 * normals used to run in the main thread's `gridGeometry` when the decoded arrays came back — the
 * ~100 ms `Worker.onmessage@tiles.ts` stall in the long-animation-frame log on every pack arrival.
 * Passing the anchor and the level is enough to rebuild the same `RasterFrame` here, so the arrays
 * arrive ready to wrap and the main thread never touches a vertex.
 *
 * The bytes are copies. The main thread still owns the pack buffer.
 */

import { latticeFor } from '@apex/engine/geo/pyramid'
import { RasterFrame } from '@apex/engine/geo/raster'
import { Anchor } from '@apex/engine/geo/wgs84'
import { gridArrays, gridStrideFor } from './gridarrays'

interface Job {
  id: number
  dem: ArrayBuffer
  zmin: number
  zscale: number
  chm: ArrayBuffer | null
  chmScale: number
  /** the bare-earth twin of `dem` on a graded tile (bare.png), with its own encoding */
  bare: ArrayBuffer | null
  bareZmin: number
  bareZscale: number
  /** the site's geodetic anchor: [lon, lat, h] */
  anchor: [number, number, number]
  /** the tile's level: [z, x, y] */
  level: [number, number, number]
  /** vertex ceiling for the terrain grid, so the stride matches the main thread's */
  maxVerts: number
  /** the terrain-relief transform [k, z0], so the grid matches the reliefed DEM the main thread keeps */
  relief: [number, number]
}

async function raster(bytes: ArrayBuffer): Promise<{ w: number; h: number; px: Uint8ClampedArray }> {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const w = bmp.width
  const h = bmp.height
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d')
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  return { w, h, px: ctx.getImageData(0, 0, w, h).data }
}

self.onmessage = async (ev: MessageEvent<Job>) => {
  const job = ev.data
  try {
    const dem = await raster(job.dem)
    const heights = new Float32Array(dem.w * dem.h)
    const zmin = job.zmin
    const zs = job.zscale
    for (let i = 0; i < heights.length; i++) heights[i] = zmin + ((dem.px[i * 4] << 8) | dem.px[i * 4 + 1]) * zs
    // the bare earth, decoded like the DEM; it never takes relief (the main thread does that once)
    let bare: Float32Array | null = null
    if (job.bare) {
      const b = await raster(job.bare)
      bare = new Float32Array(b.w * b.h)
      for (let i = 0; i < bare.length; i++) bare[i] = job.bareZmin + ((b.px[i * 4] << 8) | b.px[i * 4 + 1]) * job.bareZscale
    }
    let canopy: Float32Array | null = null
    let cw = 0
    let ch = 0
    if (job.chm) {
      const c = await raster(job.chm)
      cw = c.w
      ch = c.h
      canopy = new Float32Array(cw * ch)
      const scale = job.chmScale
      for (let i = 0; i < canopy.length; i++) canopy[i] = c.px[i * 4] * scale
    }
    const anchor = new Anchor(job.anchor[0], job.anchor[1], job.anchor[2])
    const geo = latticeFor(job.level[0], job.level[1], job.level[2])
    const size: [number, number] = [dem.w, dem.h]
    const rf = new RasterFrame({ size, geo }, anchor)
    const stride = gridStrideFor(size, job.maxVerts)
    // The main thread exaggerates terrain relief (`reliefHeights`) on the DEM it keeps, so the grid
    // has to be lifted the same way or the mesh would stand below its own collider. Done on a copy:
    // the raw heights travel back untouched and the main thread applies relief exactly once, as it
    // always did.
    const [k, z0] = job.relief
    let gridData = heights
    if (k !== 1) {
      gridData = new Float32Array(heights.length)
      for (let i = 0; i < heights.length; i++) gridData[i] = z0 + k * (heights[i] - z0)
    }
    const grid = gridArrays({ data: gridData, size, res: 0, bbox: [0, 0, 0, 0], rf }, stride)
    const transfer: Transferable[] = [heights.buffer, grid.pos.buffer, grid.uv.buffer, grid.idx.buffer, grid.norm.buffer]
    if (canopy) transfer.push(canopy.buffer)
    if (bare) transfer.push(bare.buffer)
    self.postMessage({ id: job.id, demW: dem.w, demH: dem.h, dem: heights, bare, chmW: cw, chmH: ch, chm: canopy, grid }, { transfer })
  } catch (err) {
    self.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) })
  }
}
