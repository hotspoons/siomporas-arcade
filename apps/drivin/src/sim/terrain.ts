// Landscape: a heightmap on the editor grid, one height per cell corner
// ((size+1)² values, metres, row-major by z). Absent means flat. Road pieces
// flatten the ground under their footprint to their base height, so a raised
// road sits on an embankment and the grass always meets the tarmac cleanly.

import { CELL, LEVEL_H } from './Tuning'
import { PIECE_BY_TYPE, rotatedSize } from './pieces'
import type { PlacedPiece } from './Track'

export function terrainIndex(size: number, cx: number, cz: number): number {
  return cz * (size + 1) + cx
}

/** A flat heightmap for a grid. */
export function flatTerrain(size: number): number[] {
  return new Array((size + 1) * (size + 1)).fill(0)
}

/** Resize a heightmap to a new grid size (shifting content by `shift` cells when the world grows toward negative). */
export function resizeTerrain(old: number[] | undefined, oldSize: number, size: number, shift = 0): number[] {
  const out = flatTerrain(size)
  if (!old) return out
  for (let z = 0; z <= oldSize; z++)
    for (let x = 0; x <= oldSize; x++) {
      const nx = x + shift
      const nz = z + shift
      if (nx <= size && nz <= size) out[terrainIndex(size, nx, nz)] = old[terrainIndex(oldSize, x, z)] ?? 0
    }
  return out
}

/** Bilinear ground height at a world point (metres); the grid's edge value beyond it. */
export function sampleHeight(heights: number[] | undefined, size: number, x: number, z: number): number {
  if (!heights) return 0
  const fx = Math.max(0, Math.min(size - 1e-6, x / CELL))
  const fz = Math.max(0, Math.min(size - 1e-6, z / CELL))
  const cx = Math.floor(fx)
  const cz = Math.floor(fz)
  const tx = fx - cx
  const tz = fz - cz
  const h00 = heights[terrainIndex(size, cx, cz)] ?? 0
  const h10 = heights[terrainIndex(size, cx + 1, cz)] ?? 0
  const h01 = heights[terrainIndex(size, cx, cz + 1)] ?? 0
  const h11 = heights[terrainIndex(size, cx + 1, cz + 1)] ?? 0
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
}

/** Pin every corner under a road piece's footprint to the piece's base height. */
export function flattenUnderPieces(heights: number[], size: number, pieces: PlacedPiece[]): void {
  for (const p of pieces) {
    const def = PIECE_BY_TYPE[p.type]
    if (!def || def.decor) continue
    const s = rotatedSize(def, p.rot)
    const y = p.level * LEVEL_H
    for (let z = p.z; z <= p.z + s.h; z++)
      for (let x = p.x; x <= p.x + s.w; x++) if (x >= 0 && z >= 0 && x <= size && z <= size) heights[terrainIndex(size, x, z)] = y
  }
}

/**
 * Sculpt: add `delta` metres at the brush centre (cell coordinates, fractional),
 * falling off smoothly to zero at `radius` cells. `flatten` pulls toward `target` instead.
 */
export function brushTerrain(heights: number[], size: number, cx: number, cz: number, radius: number, delta: number, flatten?: number): void {
  const x0 = Math.max(0, Math.floor(cx - radius))
  const x1 = Math.min(size, Math.ceil(cx + radius))
  const z0 = Math.max(0, Math.floor(cz - radius))
  const z1 = Math.min(size, Math.ceil(cz + radius))
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, z - cz) / radius
      if (d >= 1) continue
      const w = (1 - d * d) ** 2
      const i = terrainIndex(size, x, z)
      if (flatten !== undefined) heights[i] += (flatten - heights[i]) * Math.min(1, w * 0.5)
      else heights[i] = Math.max(-30, Math.min(120, heights[i] + delta * w))
    }
}
