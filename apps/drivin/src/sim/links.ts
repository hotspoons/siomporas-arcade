// Spline links: a smooth road auto-generated between two open ports. Drop
// anchor pieces where you want them, connect a connector to a connector, and
// a cubic Hermite curve fills the gap — tangents along each port's facing,
// scaled by a tightness factor (small = a tight, direct curve; large = a wide
// sweep). Height eases between the two port levels, and the road cambers
// into its own curvature a little so long sweepers feel banked.
//
// A link behaves as a synthetic piece with two ports that sit exactly on the
// linked ports' edges, so the track graph, the renderer and the car treat it
// like any other lane.

import { smoothstep } from '@apex/engine/math/scalar'
import { CELL, LEVEL_H } from './Tuning'
import { PIECE_BY_TYPE, opposite, rotatePortCell, rotateSide, sideOffset, type PieceDef, type Side } from './pieces'
import type { PlacedPiece } from './Track'

export interface PortRef {
  piece: number
  port: number
}

export interface Link {
  a: PortRef
  b: PortRef
  /** Tangent length as a fraction of the end-to-end distance (0.25 … 2). */
  tightness: number
  /** Camber into the curve, 0 = flat, 1 = full auto-bank. */
  bank?: number
}

export const LINK_TIGHTNESS_DEFAULT = 0.8

/** World position (metres) of a port's edge midpoint, its outward direction, level and edge cell. */
export interface PortWorld {
  x: number
  y: number
  z: number
  dx: number
  dz: number
  level: number
  cx: number
  cz: number
  side: Side
}

export function portWorld(pieces: PlacedPiece[], ref: PortRef): PortWorld | null {
  const p = pieces[ref.piece]
  const def = p ? PIECE_BY_TYPE[p.type] : undefined
  const port = def?.ports[ref.port]
  if (!p || !def || !port) return null
  const rc = rotatePortCell(def, p.rot, port.cx, port.cz)
  const side = rotateSide(port.side, p.rot)
  const o = sideOffset(side)
  const cx = p.x + rc.cx
  const cz = p.z + rc.cz
  const level = p.level + port.dLevel
  return { x: (cx + 0.5 + o.dx * 0.5) * CELL, y: level * LEVEL_H, z: (cz + 0.5 + o.dz * 0.5) * CELL, dx: o.dx, dz: o.dz, level, cx, cz, side }
}

/** Point on the link's Hermite curve at t ∈ [0,1], plus the horizontal tangent (unnormalised). */
export function linkPoint(a: PortWorld, b: PortWorld, tightness: number, t: number, out: { x: number; y: number; z: number; tx: number; tz: number }): void {
  const dist = Math.hypot(b.x - a.x, b.z - a.z)
  const L = Math.max(CELL * 0.5, dist * tightness)
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  // Leaving A along its facing; arriving at B against B's facing.
  const tax = a.dx * L
  const taz = a.dz * L
  const tbx = -b.dx * L
  const tbz = -b.dz * L
  out.x = h00 * a.x + h10 * tax + h01 * b.x + h11 * tbx
  out.z = h00 * a.z + h10 * taz + h01 * b.z + h11 * tbz
  // Derivatives.
  const d00 = 6 * t2 - 6 * t
  const d10 = 3 * t2 - 4 * t + 1
  const d01 = -6 * t2 + 6 * t
  const d11 = 3 * t2 - 2 * t
  out.tx = d00 * a.x + d10 * tax + d01 * b.x + d11 * tbx
  out.tz = d00 * a.z + d10 * taz + d01 * b.z + d11 * tbz
  out.y = a.y + (b.y - a.y) * smoothstep(0, 1, t)
}

/** Approximate arc length by sampling. */
export function linkLength(a: PortWorld, b: PortWorld, tightness: number): number {
  const s = { x: 0, y: 0, z: 0, tx: 0, tz: 0 }
  let len = 0
  let px = 0
  let pz = 0
  for (let i = 0; i <= 64; i++) {
    linkPoint(a, b, tightness, i / 64, s)
    if (i) len += Math.hypot(s.x - px, s.z - pz)
    px = s.x
    pz = s.z
  }
  return len
}

/**
 * The synthetic piece for a link: two ports coinciding with the linked edges (so they
 * match by edge key) and one lane along the curve, in world coordinates (the placed
 * piece sits at the origin with no rotation).
 */
export function linkPiece(pieces: PlacedPiece[], link: Link, index: number): { def: PieceDef; placed: PlacedPiece } | { error: string } {
  const a = portWorld(pieces, link.a)
  const b = portWorld(pieces, link.b)
  if (!a || !b) return { error: `Link ${index + 1} points at a missing port` }
  if (link.a.piece === link.b.piece && link.a.port === link.b.port) return { error: `Link ${index + 1} joins a port to itself` }
  const tight = link.tightness || LINK_TIGHTNESS_DEFAULT
  const length = linkLength(a, b, tight)
  const bank = link.bank ?? 0
  const s = { x: 0, y: 0, z: 0, tx: 0, tz: 0 }
  const def: PieceDef = {
    type: `link${index}`,
    label: 'Link',
    w: 1,
    h: 1,
    // The link's ports sit in the cell just outside each linked port, facing back at it: same edge key.
    ports: [
      { cx: a.cx + a.dx, cz: a.cz + a.dz, side: opposite(a.side), dLevel: a.level },
      { cx: b.cx + b.dx, cz: b.cz + b.dz, side: opposite(b.side), dLevel: b.level },
    ],
    lanes: [
      {
        from: 0,
        to: 1,
        length,
        path: (t, o) => {
          linkPoint(a, b, tight, t, s)
          o.x = s.x
          o.y = s.y
          o.z = s.z
          o.ux = 0
          o.uy = 1
          o.uz = 0
          o.surface = true
          // Camber: roll into the turn by curvature (sign of the cross of tangent and its change).
          if (bank > 0) {
            const eps = 0.002
            const s2 = { x: 0, y: 0, z: 0, tx: 0, tz: 0 }
            linkPoint(a, b, tight, Math.min(1, t + eps), s2)
            const cross = s.tx * s2.tz - s.tz * s2.tx
            const speed = Math.hypot(s.tx, s.tz) || 1
            const k = cross / (speed * speed * speed * eps) // curvature (1/m)
            o.roll = Math.max(-0.6, Math.min(0.6, k * 40)) * bank * smoothstep(0, 0.15, t) * (1 - smoothstep(0.85, 1, t))
          } else o.roll = 0
        },
      },
    ],
    // Tunnel to tunnel: the link is a tube too, so a bore can curve freely between two tunnel sections.
    profile: PIECE_BY_TYPE[pieces[link.a.piece].type].profile === 'tube' && PIECE_BY_TYPE[pieces[link.b.piece].type].profile === 'tube' ? 'tube' : 'road',
    group: 'flow',
  }
  return { def, placed: { type: def.type, x: 0, z: 0, rot: 0, level: 0 } }
}
