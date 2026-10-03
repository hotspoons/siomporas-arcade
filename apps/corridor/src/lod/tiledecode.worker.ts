/**
 * PNG decode for one pyramid pack, off the main thread.
 *
 * The height formula is the same as decodeHeights / decodeScalar in world/site.ts: R is the high
 * byte, G the low byte, then zmin + sample * zscale. Relief (the exaggeration knob) stays on the
 * main thread, because that knob is process state the worker does not have.
 *
 * The bytes are copies. The main thread still owns the pack buffer.
 */

interface Job {
  id: number
  dem: ArrayBuffer
  zmin: number
  zscale: number
  chm: ArrayBuffer | null
  chmScale: number
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
    const transfer: Transferable[] = [heights.buffer]
    if (canopy) transfer.push(canopy.buffer)
    self.postMessage({ id: job.id, demW: dem.w, demH: dem.h, dem: heights, chmW: cw, chmH: ch, chm: canopy }, { transfer })
  } catch (err) {
    self.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) })
  }
}
