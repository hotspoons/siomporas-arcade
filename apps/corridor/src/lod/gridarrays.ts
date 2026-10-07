// The terrain grid: heights and a raster frame in, position/uv/index/normal arrays out.
//
// This is the per-vertex body of `gridGeometry` in world/scene.ts, lifted out so the tile worker
// can run it. It has no THREE and no DOM — only a `RasterFrame` (type-only) and plain typed
// arrays — which is what lets `tiledecode.worker.ts` import it. `gridGeometry` stays for the other
// fields (water, overview, colour); terrain is the one that runs on every pack arrival and is
// therefore the one worth moving off the main thread.
//
// The loop is copied verbatim from `gridGeometry` (same stride/rim handling, same `toEnu` then
// east/up/-south swizzle, same `1 - v` flip, same triangle winding) so a worker tile is
// pixel-identical to a main-thread one. Keep them in step.

import type { RasterFrame } from '@apex/engine/geo/raster'

export interface GridSource {
  data: Float32Array
  size: [number, number]
  /** metres per texel, used only on the flat (no-frame) path */
  res: number
  bbox: [number, number, number, number]
  rf?: RasterFrame
}

export interface GridArrays {
  pos: Float32Array
  uv: Float32Array
  idx: Uint32Array
  norm: Float32Array
  cols: number
  rows: number
}

/** Pick a stride so a grid stays under `maxVerts` vertices. Same rule as scene.ts `strideFor`. */
export function gridStrideFor(size: [number, number], maxVerts: number): number {
  return Math.max(1, Math.ceil(Math.sqrt((size[0] * size[1]) / maxVerts)))
}

export function gridArrays(f: GridSource, stride: number): GridArrays {
  const [xmin, , , ymax] = f.bbox
  const [w, h] = f.size
  const rf = f.rf
  const enu = [0, 0, 0]
  const cols = Math.ceil((w - 1) / stride) + 1
  const rows = Math.ceil((h - 1) / stride) + 1
  const pos = new Float32Array(cols * rows * 3)
  const uv = new Float32Array(cols * rows * 2)
  let k = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rr = r === rows - 1 ? h - 1 : Math.min(h - 1, r * stride)
      const cc = c === cols - 1 ? w - 1 : Math.min(w - 1, c * stride)
      const i = rr * w + cc
      // cell centres inside; the raster's own edge on the rim
      const u = c === 0 ? 0 : c === cols - 1 ? 1 : (cc + 0.5) / w
      const v = r === 0 ? 0 : r === rows - 1 ? 1 : (rr + 0.5) / h
      const z = f.data[i]
      if (rf) {
        // geodetic from the lattice, then the ellipsoid: the curvature is not a correction added
        // afterwards, it is what the transform returns
        rf.toEnu(u, v, z, enu)
        pos[k * 3] = enu[0]
        pos[k * 3 + 1] = enu[2]
        pos[k * 3 + 2] = -enu[1]
      } else {
        pos[k * 3] = xmin + u * w * f.res
        pos[k * 3 + 1] = z
        pos[k * 3 + 2] = -(ymax - v * h * f.res)
      }
      uv[k * 2] = u
      uv[k * 2 + 1] = 1 - v
      k++
    }
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6)
  let n = 0
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c
      const b = a + 1
      const d = a + cols
      const e = d + 1
      idx[n++] = a; idx[n++] = d; idx[n++] = b
      idx[n++] = b; idx[n++] = d; idx[n++] = e
    }
  }
  const norm = new Float32Array(pos.length)
  gridNormals(pos, idx, norm)
  return { pos, uv, idx, norm, cols, rows }
}

/** Indexed vertex normals, the same accumulation THREE's `computeVertexNormals` does. */
export function gridNormals(pos: Float32Array, idx: Uint32Array, out: Float32Array): void {
  out.fill(0)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3
    const b = idx[t + 1] * 3
    const c = idx[t + 2] * 3
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2]
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2]
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz
  }
  for (let i = 0; i < out.length; i += 3) {
    const x = out[i], y = out[i + 1], z = out[i + 2]
    const len = Math.sqrt(x * x + y * y + z * z) || 1
    out[i] = x / len; out[i + 1] = y / len; out[i + 2] = z / len
  }
}
