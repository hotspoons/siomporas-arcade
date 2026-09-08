// Scenery pieces: no lanes, just things on the ground. The sim needs their
// footprints (solid boxes to bump into, water to sink in); the renderer needs
// the same placements to draw them, so both come from here.

import { CELL } from './Tuning'
import { PIECE_BY_TYPE, rotatedSize } from './pieces'
import type { PlacedPiece } from './Track'

/** An axis-aligned solid on the ground, world metres (centre + half extents), plus its height for drawing. */
export interface Solid {
  x: number
  z: number
  hw: number
  hh: number
  height: number
  kind: 'trunk' | 'wall' | 'post' | 'pump'
}

/** Deterministic 0..1 from a cell and a salt. */
function hash(x: number, z: number, salt: number): number {
  let h = (x * 374761393 + z * 668265263 + salt * 2246822519) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Trees in a scenery cell: 5 trunks, deterministic per cell so the sim and the renderer agree. */
export function treesIn(cellX: number, cellZ: number): { x: number; z: number; r: number; h: number }[] {
  const out: { x: number; z: number; r: number; h: number }[] = []
  for (let i = 0; i < 5; i++) {
    const fx = 0.15 + 0.7 * hash(cellX, cellZ, i * 3 + 1)
    const fz = 0.15 + 0.7 * hash(cellX, cellZ, i * 3 + 2)
    const s = 0.7 + 0.6 * hash(cellX, cellZ, i * 3 + 3)
    out.push({ x: (cellX + fx) * CELL, z: (cellZ + fz) * CELL, r: 2.2 * s, h: 9 * s })
  }
  return out
}

/** Solids for one placed scenery piece (empty for water). */
export function solidsOf(p: PlacedPiece): Solid[] {
  const def = PIECE_BY_TYPE[p.type]
  if (!def?.decor) return []
  const size = rotatedSize(def, p.rot)
  const cx = (p.x + size.w / 2) * CELL
  const cz = (p.z + size.h / 2) * CELL
  switch (def.decor) {
    case 'trees': {
      const out: Solid[] = []
      for (let dx = 0; dx < size.w; dx++) for (let dz = 0; dz < size.h; dz++) for (const t of treesIn(p.x + dx, p.z + dz)) out.push({ x: t.x, z: t.z, hw: t.r * 0.35, hh: t.r * 0.35, height: t.h, kind: 'trunk' })
      return out
    }
    case 'building':
      // A block with a margin of pavement around it.
      return [{ x: cx, z: cz, hw: (size.w * CELL) / 2 - 6, hh: (size.h * CELL) / 2 - 6, height: 16, kind: 'wall' }]
    case 'gas': {
      // Canopy on four posts over two pump islands, a kiosk at the back.
      const along = size.w >= size.h ? 'x' : 'z'
      const L = Math.max(size.w, size.h) * CELL
      const D = Math.min(size.w, size.h) * CELL
      const out: Solid[] = []
      const put = (u: number, v: number, hw: number, hh: number, height: number, kind: Solid['kind']) => {
        // u along the long axis, v across.
        if (along === 'x') out.push({ x: cx + u, z: cz + v, hw, hh, height, kind })
        else out.push({ x: cx + v, z: cz + u, hw: hh, hh: hw, height, kind })
      }
      for (const u of [-L * 0.3, L * 0.3]) for (const v of [-D * 0.22, D * 0.22]) put(u, v, 0.4, 0.4, 6, 'post')
      for (const u of [-L * 0.14, L * 0.14]) put(u, 0, 0.8, 2.4, 1.6, 'pump')
      put(0, D * 0.36, L * 0.28, 3.2, 4, 'wall')
      return out
    }
    default:
      return []
  }
}
