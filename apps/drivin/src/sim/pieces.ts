// The track vocabulary: every piece type as data plus a local path generator.
// Local frame: the piece's footprint has its minimum corner at (0, 0), x runs
// east, z runs north, y is up. A piece has one or more LANES; each lane runs
// from one port to another and is described by a function of t ∈ [0, 1]
// returning position, an "up" hint (the surface normal before banking), and
// whether the surface exists there (gaps).

import { smoothstep } from '@apex/engine/math/scalar'
import { CELL, CORK_RADIUS, LEVEL_H, LOOP_RADIUS, LOOP_SHIFT, ROAD_HALF_WIDTH } from './Tuning'

export type Side = 'N' | 'E' | 'S' | 'W'

export interface Port {
  /** Footprint cell (local, before rotation). */
  cx: number
  cz: number
  side: Side
  /** Elevation change relative to the piece's base level. */
  dLevel: number
}

export interface PathPoint {
  x: number
  y: number
  z: number
  /** Up hint (unit not required). */
  ux: number
  uy: number
  uz: number
  /** Banking roll about the tangent, radians. Positive leans up toward the right, lowering the RIGHT edge (helps a right turn). */
  roll: number
  /** Surface present here. */
  surface: boolean
}

export type Profile = 'road' | 'tube'

export interface LaneDef {
  from: number
  to: number
  path: (t: number, out: PathPoint) => void
  /** Approximate length, for sampling density. */
  length: number
}

export interface PieceDef {
  type: string
  label: string
  /** Footprint in cells (before rotation). */
  w: number
  h: number
  ports: Port[]
  lanes: LaneDef[]
  profile: Profile
  /** Editor palette group. */
  group: 'basic' | 'curves' | 'stunts' | 'flow'
  /** Show a start/finish line. */
  isStart?: boolean
}

const UP = { ux: 0, uy: 1, uz: 0 }

function set(out: PathPoint, x: number, y: number, z: number, roll = 0, surface = true): void {
  out.x = x
  out.y = y
  out.z = z
  out.ux = UP.ux
  out.uy = UP.uy
  out.uz = UP.uz
  out.roll = roll
  out.surface = surface
}

const HALF = CELL / 2

// --- straights ------------------------------------------------------------------
const straight: LaneDef = { from: 0, to: 1, length: CELL, path: (t, o) => set(o, t * CELL, 0, HALF) }
const straight2: LaneDef = { from: 0, to: 1, length: 2 * CELL, path: (t, o) => set(o, t * 2 * CELL, 0, HALF) }

/** Quarter circle from the W port of cell (0,0) to the N port of the corner cell, radius r. */
function arc(r: number): LaneDef {
  return {
    from: 0,
    to: 1,
    length: (Math.PI / 2) * r,
    path: (t, o) => {
      // Entry (0, HALF) heading +x; centre at (0, HALF + r); exit at (r, HALF + r) heading +z.
      const a = (t * Math.PI) / 2
      set(o, r * Math.sin(a), 0, HALF + r - r * Math.cos(a))
    },
  }
}

function bankedArc(r: number, bank: number): LaneDef {
  const base = arc(r)
  return {
    ...base,
    path: (t, o) => {
      base.path(t, o)
      // Bank in over the first quarter, out over the last; the arc turns right (toward +z), so up leans right and the outer (left) edge rises.
      // The centreline lifts with the bank so the inner (right) edge stays at grass level: you can drive onto
      // the berm anywhere along it, and the outer edge becomes a wall the grass-side collision respects.
      const ramp = smoothstep(0, 0.25, t) * (1 - smoothstep(0.75, 1, t))
      o.roll = bank * ramp
      o.y += Math.sin(o.roll) * ROAD_HALF_WIDTH
    },
  }
}

export const PIECES: PieceDef[] = [
  {
    type: 'start',
    label: 'Start / finish',
    w: 1,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 0, cz: 0, side: 'E', dLevel: 0 },
    ],
    lanes: [straight],
    profile: 'road',
    group: 'basic',
    isStart: true,
  },
  {
    type: 'straight',
    label: 'Straight',
    w: 1,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 0, cz: 0, side: 'E', dLevel: 0 },
    ],
    lanes: [straight],
    profile: 'road',
    group: 'basic',
  },
  {
    type: 'ramp',
    label: 'Ramp up',
    w: 1,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 0, cz: 0, side: 'E', dLevel: 1 },
    ],
    lanes: [{ from: 0, to: 1, length: CELL, path: (t, o) => set(o, t * CELL, LEVEL_H * smoothstep(0, 1, t), HALF) }],
    profile: 'road',
    group: 'basic',
  },
  {
    type: 'rampDown',
    label: 'Ramp down',
    w: 1,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 1 },
      { cx: 0, cz: 0, side: 'E', dLevel: 0 },
    ],
    lanes: [{ from: 0, to: 1, length: CELL, path: (t, o) => set(o, t * CELL, LEVEL_H * (1 - smoothstep(0, 1, t)), HALF) }],
    profile: 'road',
    group: 'basic',
  },
  {
    type: 'hump',
    label: 'Hump',
    w: 1,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 0, cz: 0, side: 'E', dLevel: 0 },
    ],
    lanes: [{ from: 0, to: 1, length: CELL, path: (t, o) => set(o, t * CELL, 3.5 * Math.sin(Math.PI * t) ** 2, HALF) }],
    profile: 'road',
    group: 'stunts',
  },
  {
    type: 'jump',
    label: 'Jump',
    w: 2,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 1, cz: 0, side: 'E', dLevel: 0 },
    ],
    lanes: [
      {
        from: 0,
        to: 1,
        length: 2 * CELL,
        path: (t, o) => {
          // Ramp that is still rising when it ends at 30 %, nothing until 70 %,
          // then a flat landing. The centreline through the gap is only a guide.
          const x = t * 2 * CELL
          const lip = smoothstep(0.05, 0.42, t) * 3.6
          const y = t < 0.3 ? lip : t < 0.7 ? 3.0 * (1 - smoothstep(0.3, 0.7, t)) : 0
          set(o, x, y, HALF, 0, t <= 0.3 || t >= 0.7)
        },
      },
    ],
    profile: 'road',
    group: 'stunts',
  },
  {
    type: 'curve',
    label: 'Tight curve',
    w: 1,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 0, cz: 0, side: 'N', dLevel: 0 },
    ],
    lanes: [arc(HALF)],
    profile: 'road',
    group: 'curves',
  },
  {
    type: 'curve2',
    label: 'Wide curve',
    w: 2,
    h: 2,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 1, cz: 1, side: 'N', dLevel: 0 },
    ],
    lanes: [arc(CELL + HALF)],
    profile: 'road',
    group: 'curves',
  },
  {
    type: 'bank2',
    label: 'Banked sweeper',
    w: 4,
    h: 4,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 3, cz: 3, side: 'N', dLevel: 0 },
    ],
    lanes: [bankedArc(3 * CELL + HALF, 0.55)],
    profile: 'road',
    group: 'curves',
  },
  {
    type: 'bank6',
    label: 'Speedbowl bank',
    w: 6,
    h: 6,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 5, cz: 5, side: 'N', dLevel: 0 },
    ],
    // The vmax test-track turn: huge radius, steep wall. Hit it flat out and the banking holds you.
    lanes: [bankedArc(5 * CELL + HALF, 0.95)],
    profile: 'road',
    group: 'curves',
  },
  {
    type: 'cross',
    label: 'Crossroads',
    w: 1,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 0, cz: 0, side: 'E', dLevel: 0 },
      { cx: 0, cz: 0, side: 'S', dLevel: 0 },
      { cx: 0, cz: 0, side: 'N', dLevel: 0 },
    ],
    // Two straights through each other: the track can cross its own path.
    lanes: [straight, { from: 2, to: 3, length: CELL, path: (t, o) => set(o, HALF, 0, t * CELL) }],
    profile: 'road',
    group: 'flow',
  },
  {
    type: 'loop',
    label: 'Loop',
    w: 2,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 1, cz: 0, side: 'E', dLevel: 0 },
    ],
    lanes: [
      {
        from: 0,
        to: 1,
        length: 2 * CELL + 2 * Math.PI * LOOP_RADIUS,
        path: (t, o) => {
          // Distance-parameterised over two cells: ease out to the entry lane over
          // the first cell, a full vertical circle that drifts sideways by a whole
          // road width so the exit clears the entry, then ease back over the last.
          const loopLen = 2 * Math.PI * LOOP_RADIUS
          const L = 2 * CELL + loopLen
          const d = t * L
          const lead = CELL
          const shift = LOOP_SHIFT
          if (d < lead) {
            set(o, d, 0, HALF - (shift / 2) * smoothstep(0.15, 0.85, d / lead))
            return
          }
          if (d < lead + loopLen) {
            const a = ((d - lead) / loopLen) * Math.PI * 2
            const cx = lead
            const cy = LOOP_RADIUS
            set(o, cx + LOOP_RADIUS * Math.sin(a), cy - LOOP_RADIUS * Math.cos(a), HALF - shift / 2 + (shift * (d - lead)) / loopLen)
            // Up points at the loop centre.
            o.ux = -Math.sin(a)
            o.uy = Math.cos(a)
            o.uz = 0
            return
          }
          const rest = d - lead - loopLen
          const tail = CELL
          set(o, lead + rest, 0, HALF + (shift / 2) * (1 - smoothstep(0.15, 0.85, rest / tail)))
        },
      },
    ],
    profile: 'road',
    group: 'stunts',
  },
  {
    type: 'corkscrew',
    label: 'Corkscrew',
    w: 4,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 3, cz: 0, side: 'E', dLevel: 0 },
    ],
    lanes: [
      {
        from: 0,
        to: 1,
        length: Math.hypot(4 * CELL, 2 * Math.PI * CORK_RADIUS),
        path: (t, o) => {
          // A helix about the axis (x, R, HALF): one full turn over four cells,
          // eased so the ends are tangent to the straights on either side.
          const a = Math.PI * 2 * smoothstep(0, 1, t)
          set(o, t * 4 * CELL, CORK_RADIUS - CORK_RADIUS * Math.cos(a), HALF + CORK_RADIUS * Math.sin(a))
          o.ux = 0
          o.uy = Math.cos(a)
          o.uz = -Math.sin(a)
        },
      },
    ],
    profile: 'road',
    group: 'stunts',
  },
  {
    type: 'split',
    label: 'Split',
    w: 2,
    h: 2,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 1, cz: 0, side: 'E', dLevel: 0 },
      { cx: 1, cz: 1, side: 'E', dLevel: 0 },
    ],
    lanes: [
      { from: 0, to: 1, length: 2 * CELL, path: (t, o) => set(o, t * 2 * CELL, 0, HALF) },
      { from: 0, to: 2, length: 2 * CELL + 10, path: (t, o) => set(o, t * 2 * CELL, 0, HALF + CELL * smoothstep(0.1, 0.9, t)) },
    ],
    profile: 'road',
    group: 'flow',
  },
  {
    type: 'join',
    label: 'Join',
    w: 2,
    h: 2,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 0, cz: 1, side: 'W', dLevel: 0 },
      { cx: 1, cz: 0, side: 'E', dLevel: 0 },
    ],
    lanes: [
      { from: 0, to: 2, length: 2 * CELL, path: (t, o) => set(o, t * 2 * CELL, 0, HALF) },
      { from: 1, to: 2, length: 2 * CELL + 10, path: (t, o) => set(o, t * 2 * CELL, 0, HALF + CELL * (1 - smoothstep(0.1, 0.9, t))) },
    ],
    profile: 'road',
    group: 'flow',
  },
  {
    type: 'tunnel',
    label: 'Tunnel',
    w: 2,
    h: 1,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 1, cz: 0, side: 'E', dLevel: 0 },
    ],
    lanes: [straight2],
    profile: 'tube',
    group: 'basic',
  },
  {
    type: 'tunnel2',
    label: 'Tunnel curve',
    w: 2,
    h: 2,
    ports: [
      { cx: 0, cz: 0, side: 'W', dLevel: 0 },
      { cx: 1, cz: 1, side: 'N', dLevel: 0 },
    ],
    lanes: [arc(CELL + HALF)],
    profile: 'tube',
    group: 'curves',
  },
]

export const PIECE_BY_TYPE: Record<string, PieceDef> = Object.fromEntries(PIECES.map((p) => [p.type, p]))

export function makePathPoint(): PathPoint {
  return { x: 0, y: 0, z: 0, ux: 0, uy: 1, uz: 0, roll: 0, surface: true }
}

/** Rotate a local point about the footprint centre by rot × 90° (counter-clockwise seen from above). */
export function rotateLocal(def: PieceDef, rot: number, x: number, z: number, out: { x: number; z: number }): void {
  const w = def.w * CELL
  const h = def.h * CELL
  const r = ((rot % 4) + 4) % 4
  // Rotate about the origin then re-anchor so the rotated footprint's min corner is (0,0).
  switch (r) {
    case 0:
      out.x = x
      out.z = z
      break
    case 1: // 90° CCW (from above, +x → +z): (x, z) → (-z, x), shift by h
      out.x = h - z
      out.z = x
      break
    case 2:
      out.x = w - x
      out.z = h - z
      break
    default: // 270°
      out.x = z
      out.z = w - x
  }
}

/** Footprint size after rotation. */
export function rotatedSize(def: PieceDef, rot: number): { w: number; h: number } {
  return rot % 2 === 0 ? { w: def.w, h: def.h } : { w: def.h, h: def.w }
}

const SIDES: Side[] = ['N', 'E', 'S', 'W']

export function rotateSide(side: Side, rot: number): Side {
  // CCW from above: N → W → S → E → N   (x→+z means east turns north)
  const order: Side[] = ['E', 'N', 'W', 'S']
  const i = order.indexOf(side)
  return order[(i + ((rot % 4) + 4) % 4) % 4]
}

export function rotatePortCell(def: PieceDef, rot: number, cx: number, cz: number): { cx: number; cz: number } {
  const r = ((rot % 4) + 4) % 4
  switch (r) {
    case 0:
      return { cx, cz }
    case 1:
      return { cx: def.h - 1 - cz, cz: cx }
    case 2:
      return { cx: def.w - 1 - cx, cz: def.h - 1 - cz }
    default:
      return { cx: cz, cz: def.w - 1 - cx }
  }
}

export function opposite(side: Side): Side {
  return SIDES[(SIDES.indexOf(side) + 2) % 4]
}

export function sideOffset(side: Side): { dx: number; dz: number } {
  switch (side) {
    case 'N':
      return { dx: 0, dz: 1 }
    case 'S':
      return { dx: 0, dz: -1 }
    case 'E':
      return { dx: 1, dz: 0 }
    case 'W':
      return { dx: -1, dz: 0 }
  }
}
