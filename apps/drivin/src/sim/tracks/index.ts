// Built-in tracks, laid out with the turtle so connectivity is by construction.

import { PIECE_BY_TYPE, opposite, rotatePortCell, rotateSide, sideOffset } from '../pieces'
import type { PlacedPiece, TrackData } from '../Track'
import { layFrom, layTrack, type Cursor } from './lay'

const S = (type: string) => ({ type })

/** Oval: straights and tight curves. The smoke-test track. */
export const OVAL: TrackData = layTrack('Oval', 12, 2, 2, [
  S('start'),
  S('straight'),
  S('straight'),
  S('curve'),
  S('curve'),
  S('straight'),
  S('straight'),
  S('straight'),
  S('curve'),
  S('curve'),
])

/** A rectangle of wide curves with a ramp up to an elevated back straight, a tunnel and a hump. */
export const HIGHLINE: TrackData = layTrack('Highline', 12, 3, 3, [
  S('start'),
  S('straight'),
  S('ramp'),
  S('straight'),
  S('straight'),
  S('curve2'),
  S('tunnel'),
  S('curve2'),
  S('straight'),
  S('hump'),
  S('straight'),
  S('straight'),
  S('curve2'),
  S('straight'),
  { type: 'ramp', enter: 1 },
  S('straight'),
  S('curve'),
])

/** Cursor just outside a placed piece's given port (for laying a branch). */
export function portExit(p: PlacedPiece, portIndex: number): Cursor {
  const def = PIECE_BY_TYPE[p.type]
  const port = def.ports[portIndex]
  const rc = rotatePortCell(def, p.rot, port.cx, port.cz)
  const side = rotateSide(port.side, p.rot)
  const o = sideOffset(side)
  return { cx: p.x + rc.cx + o.dx, cz: p.z + rc.cz + o.dz, side: opposite(side), level: p.level + port.dLevel }
}

/** Everything once: loop, jump, corkscrew, tunnel, banked sweeper, split/join with a humped alternate. */
export function stuntPark(): TrackData {
  const pieces: PlacedPiece[] = []
  layFrom({ cx: 9, cz: 2, side: 'W', level: 0 }, [
    S('start'),
    S('loop'),
    S('jump'),
    S('straight'),
    S('curve2'),
    S('tunnel'),
    S('bank2'),
    S('corkscrew'),
    { type: 'split', exit: 1 },
    S('straight'),
    S('straight'),
    { type: 'join', enter: 0 },
    S('curve2'),
    S('straight'),
    S('straight'),
    S('straight'),
    S('straight'),
    S('straight'),
    S('curve'),
    S('straight'),
    S('straight'),
    S('straight'),
    S('straight'),
    S('straight'),
    S('straight'),
    S('straight'),
  ], pieces)
  const split = pieces.find((p) => p.type === 'split')!
  layFrom(portExit(split, 2), [S('hump'), S('hump')], pieces)
  return { name: 'Stunt Park', size: 18, pieces }
}

export const STUNT_PARK: TrackData = stuntPark()

export const BUILTIN_TRACKS: TrackData[] = [OVAL, HIGHLINE, STUNT_PARK]
