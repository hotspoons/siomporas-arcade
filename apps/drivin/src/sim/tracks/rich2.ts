// "Rich 2": a hand-built track from the editor — a tunnel and a lake crossing,
// a corkscrew through the woods, two speedbowl banks back to back, a jump, a
// loop, and spline links closing the run. The layout is exactly as authored;
// the landscape is sculpted here with the same brushes the editor uses, so it
// stays readable in source (and reproducible) rather than a wall of numbers.

import type { TrackData } from '../Track'
import type { Link } from '../links'
import { brushTerrain, flatTerrain } from '../terrain'

const P = (type: string, x: number, z: number, rot = 0, level = 0) => ({ type, x, z, rot, level })

const PIECES = [
  P('straight', 18, 33), P('straight', 24, 30, 1), P('tunnel', 24, 28, 1), P('tunnel', 24, 26, 1), P('tunnel', 24, 24, 1),
  P('corkscrew', 24, 17, 1), P('bank6', 24, 11, 3), P('bank6', 30, 11), P('jump', 35, 17, 1), P('water', 24, 22, 3),
  P('bank2', 32, 19, 1), P('bank2', 28, 22, 3), P('start', 17, 33), P('ramp', 28, 26, 1), P('rampDown', 28, 27, 1),
  P('straight', 28, 28, 1), P('straight', 28, 29, 1), P('straight', 28, 30, 1), P('straight', 28, 31, 1), P('straight', 23, 37, 2),
  P('lake', 20, 25), P('lake', 20, 22), P('lake', 17, 23), P('lake', 17, 26), P('lake', 17, 20),
  P('trees', 21, 18), P('trees', 22, 17), P('trees', 22, 16), P('trees', 22, 15), P('trees', 22, 14),
  P('trees', 22, 13), P('trees', 23, 12), P('trees', 27, 17), P('trees', 28, 17), P('trees', 29, 17),
  P('trees', 30, 17), P('trees', 26, 17), P('trees', 26, 18), P('trees', 28, 18), P('trees', 31, 18),
  P('trees', 31, 17), P('trees', 29, 18), P('trees', 27, 18), P('trees', 30, 18), P('trees', 25, 19),
  P('trees', 25, 20), P('trees', 25, 21), P('loop', 15, 32), P('bank6', 3, 38, 2), P('bank6', 3, 32, 3),
  P('hump', 11, 32), P('straight', 10, 32), P('straight', 9, 32), P('straight', 12, 32), P('straight', 14, 32),
  P('straight', 13, 32), P('forest', 41, 27), P('forest', 38, 26), P('forest', 34, 28), P('forest', 36, 29),
  P('forest', 36, 27), P('forest', 34, 25), P('forest', 36, 25), P('forest', 32, 31), P('forest', 32, 29),
  P('forest', 30, 29), P('forest', 31, 26), P('forest', 29, 27), P('forest', 30, 32), P('forest', 29, 34),
  P('forest', 26, 36), P('forest', 24, 39), P('forest', 22, 38), P('forest', 20, 40), P('gas', 8, 31),
  P('gas', 4, 31), P('gas', 11, 40, 1), P('gas', 16, 42, 1), P('gas', 25, 34, 1), P('gas', 25, 24, 2),
  P('gas', 24, 10), P('gas', 32, 10), P('gas', 28, 10), P('gas', 26, 10), P('building', 11, 29, 1),
  P('building', 18, 30, 1), P('building', 21, 28, 1), P('building', 26, 28, 1), P('building', 15, 36, 1), P('building', 10, 34, 1),
  P('building', 10, 37, 1), P('building', 14, 43, 1), P('building', 18, 40, 1), P('building', 37, 18, 1), P('building', 38, 14, 1),
  P('lake', 40, 11), P('lake', 39, 8), P('lake', 35, 6), P('lake', 32, 5), P('lake', 28, 4),
  P('lake', 25, 4), P('lake', 21, 5), P('lake', 18, 7), P('ramp', 24, 23, 3), P('ramp', 24, 21, 1),]

const LINKS: Link[] = [
  { a: { piece: 0, port: 1 }, b: { piece: 1, port: 1 }, tightness: 0.8 },
  { a: { piece: 19, port: 0 }, b: { piece: 18, port: 1 }, tightness: 0.8 },
  { a: { piece: 48, port: 0 }, b: { piece: 19, port: 1 }, tightness: 0.8 },
  { a: { piece: 103, port: 1 }, b: { piece: 104, port: 1 }, tightness: 0.8 },
]

const SIZE = 45

function terrain(): number[] {
  const t = flatTerrain(SIZE)
  // The ridge east of the corkscrew, rolling down toward the loop.
  brushTerrain(t, SIZE, 29, 32, 5, 15)
  brushTerrain(t, SIZE, 28, 35, 4, 12)
  brushTerrain(t, SIZE, 24, 35, 3.5, 9)
  brushTerrain(t, SIZE, 31, 34, 3, 8)
  brushTerrain(t, SIZE, 27, 29, 3, 5)
  // Hollows: the dip behind the jump and a low patch by the lakes.
  brushTerrain(t, SIZE, 35, 27, 4, -9)
  brushTerrain(t, SIZE, 22, 30, 3, -6)
  return t
}

/** The published copy of the editor track. */
export const RICH2: TrackData = { name: 'Rich 2', size: SIZE, pieces: PIECES, links: LINKS, terrain: terrain() }
