// Turtle layout: place pieces one after another so each piece's entry port
// lands on the previous exit. Used for the built-in tracks and as a test of
// the same port geometry the editor relies on.

import { PIECE_BY_TYPE, opposite, rotatePortCell, rotateSide, sideOffset, type Side } from '../pieces'
import type { PlacedPiece, TrackData } from '../Track'

export interface Cursor {
  /** Cell the next piece's entry port must occupy. */
  cx: number
  cz: number
  /** Side of that cell the entry port faces (toward the previous piece). */
  side: Side
  level: number
}

export interface LayStep {
  type: string
  /** For pieces whose entry is ambiguous (join): which port index to enter by. */
  enter?: number
  /** Which port to leave by (split: 1 = straight, 2 = diverging). */
  exit?: number
}

/**
 * Lay `steps` starting from `start`. Returns the placed pieces and the exit
 * cursor. Throws if a piece cannot be rotated to fit.
 */
export function layFrom(start: Cursor, steps: LayStep[], out: PlacedPiece[]): Cursor {
  let cur = { ...start }
  for (const step of steps) {
    const def = PIECE_BY_TYPE[step.type]
    if (!def) throw new Error(`unknown piece ${step.type}`)
    const entryIndex = step.enter ?? def.lanes[0].from
    const entry = def.ports[entryIndex]
    let placed: PlacedPiece | null = null
    for (let rot = 0; rot < 4 && !placed; rot++) {
      if (rotateSide(entry.side, rot) !== cur.side) continue
      const rc = rotatePortCell(def, rot, entry.cx, entry.cz)
      placed = { type: step.type, x: cur.cx - rc.cx, z: cur.cz - rc.cz, rot, level: cur.level - entry.dLevel }
    }
    if (!placed) throw new Error(`cannot orient ${step.type} to enter from ${cur.side}`)
    out.push(placed)
    // Exit: the lane leaving this entry, or — entering a lane backwards (a ramp
    // driven downhill) — the far end of the lane that ends here.
    const forwardLane = def.lanes.find((l) => l.from === entryIndex)
    const backwardLane = def.lanes.find((l) => l.to === entryIndex)
    const exitIndex = step.exit ?? forwardLane?.to ?? backwardLane?.from ?? def.lanes[0].to
    const exit = def.ports[exitIndex]
    const erc = rotatePortCell(def, placed.rot, exit.cx, exit.cz)
    const eside = rotateSide(exit.side, placed.rot)
    const o = sideOffset(eside)
    cur = { cx: placed.x + erc.cx + o.dx, cz: placed.z + erc.cz + o.dz, side: opposite(eside), level: placed.level + exit.dLevel }
  }
  return cur
}

/** Convenience: a closed course starting with a start piece heading east from (x, z). */
export function layTrack(name: string, size: number, x: number, z: number, steps: LayStep[]): TrackData {
  const pieces: PlacedPiece[] = []
  layFrom({ cx: x, cz: z, side: 'W', level: 0 }, steps, pieces)
  return { name, size, pieces }
}
