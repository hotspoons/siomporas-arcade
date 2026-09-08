// Landscape: a heightmap on the editor grid, one height per cell corner
// ((size+1)² values, metres, row-major by z). Absent means flat. Road pieces
// flatten the ground under their footprint to their base height, so a raised
// road sits on an embankment and the grass always meets the tarmac cleanly.

import { CELL } from './Tuning'
import { PIECE_BY_TYPE, applyMirror, makePathPoint, rotateLocal, rotatedSize } from './pieces'
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

/** Pieces whose geometry needs a flat pad (everything else drapes over the landscape). */
export const PAD_PIECES = new Set(['loop', 'corkscrew', 'tunnel', 'tunnel2', 'bank2', 'bank6'])

/** Whether a piece type follows the ground point by point (roads, ramps, humps, jumps…) rather than sitting on a pad. */
export function drapes(type: string): boolean {
  return !PAD_PIECES.has(type)
}

/** World-space centreline samples of a placed piece's lanes. */
function centreline(p: PlacedPiece): { x: number; y: number; z: number }[] {
  const def = PIECE_BY_TYPE[p.type]
  const out: { x: number; y: number; z: number }[] = []
  const pt = makePathPoint()
  const r = { x: 0, z: 0 }
  for (const lane of def.lanes)
    for (let i = 0; i <= 24; i++) {
      lane.path(i / 24, pt)
      applyMirror(def, p, pt)
      rotateLocal(def, p.rot, pt.x, pt.z, r)
      out.push({ x: p.x * CELL + r.x, y: pt.y, z: p.z * CELL + r.z })
    }
  return out
}

/**
 * Grade the landscape to the roads. Two passes:
 *
 * - Pad pieces (loops, tunnels, banks…) pin their footprint to the ground height at their centre,
 *   since their geometry is fixed and needs level ground.
 * - Draped pieces (roads, ramps, humps…) cut a corridor: every corner of their footprint takes the
 *   ground height of the nearest point on the piece's own centreline. Corners are 40 m apart, so the
 *   cell a road runs through becomes a shelf that follows the road's rise and fall instead of a
 *   hillside the tarmac has to slice through — which is what left terrain poking up through the road.
 *
 * Water keeps its own level, so a lake stays flat under a bridge.
 */
export function flattenUnderPieces(heights: number[], size: number, pieces: PlacedPiece[]): void {
  const original = heights.slice()
  const wet = new Set<number>()
  for (const p of pieces) {
    if (PIECE_BY_TYPE[p.type]?.decor !== 'water') continue
    const s = rotatedSize(PIECE_BY_TYPE[p.type], p.rot)
    for (let z = p.z; z <= p.z + s.h; z++) for (let x = p.x; x <= p.x + s.w; x++) wet.add(terrainIndex(size, x, z))
  }
  // Corridor under draped road: each corner follows the nearest point of the road through its cell.
  for (const p of pieces) {
    const def = PIECE_BY_TYPE[p.type]
    if (!def || def.decor || !drapes(p.type)) continue
    const line = centreline(p)
    if (!line.length) continue
    const s = rotatedSize(def, p.rot)
    for (let z = p.z; z <= p.z + s.h; z++)
      for (let x = p.x; x <= p.x + s.w; x++) {
        if (x < 0 || z < 0 || x > size || z > size) continue
        const i = terrainIndex(size, x, z)
        if (wet.has(i)) continue
        const wx = x * CELL
        const wz = z * CELL
        let best = line[0]
        let bestD = Infinity
        for (const q of line) {
          const d = (q.x - wx) ** 2 + (q.z - wz) ** 2
          if (d < bestD) {
            bestD = d
            best = q
          }
        }
        heights[i] = sampleHeight(original, size, best.x, best.z)
      }
  }
  const pinned = new Set<number>()
  for (const p of pieces) {
    const def = PIECE_BY_TYPE[p.type]
    if (!def || def.decor) continue
    const s = rotatedSize(def, p.rot)
    for (let z = p.z; z <= p.z + s.h; z++) for (let x = p.x; x <= p.x + s.w; x++) if (x >= 0 && z >= 0 && x <= size && z <= size) pinned.add(terrainIndex(size, x, z))
  }
  // Pads last: their level ground wins over any corridor that reaches the same corner.
  const pads: { p: PlacedPiece; y: number; s: { w: number; h: number } }[] = []
  for (const p of pieces) {
    const def = PIECE_BY_TYPE[p.type]
    if (!def || def.decor || drapes(p.type)) continue
    const s = rotatedSize(def, p.rot)
    pads.push({ p, s, y: sampleHeight(original, size, (p.x + s.w / 2) * CELL, (p.z + s.h / 2) * CELL) })
  }
  for (const { p, s, y } of pads)
    for (let z = p.z; z <= p.z + s.h; z++)
      for (let x = p.x; x <= p.x + s.w; x++) if (x >= 0 && z >= 0 && x <= size && z <= size) heights[terrainIndex(size, x, z)] = y
  // Feather: the corners a road did not claim relax toward their neighbours, so the graded shelf runs
  // out into the sculpted land as a slope instead of a step at the footprint edge.
  for (let pass = 0; pass < 2; pass++) {
    const before = heights.slice()
    for (let z = 0; z <= size; z++)
      for (let x = 0; x <= size; x++) {
        const i = terrainIndex(size, x, z)
        if (pinned.has(i) || wet.has(i)) continue
        let sum = 0
        let n = 0
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx
          const nz = z + dz
          if (nx < 0 || nz < 0 || nx > size || nz > size) continue
          sum += before[terrainIndex(size, nx, nz)]
          n++
        }
        if (n) heights[i] = before[i] * 0.45 + (sum / n) * 0.55
      }
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
