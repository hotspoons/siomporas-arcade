// A placed track: pieces on the grid, ports matched into a graph, and every
// reachable lane baked (in driving direction) into a PathTable. Also the
// spatial index the car uses to find surfaces while airborne or on grass.

import { smoothstep } from '@apex/engine/math/scalar'
import { Vec3 } from '@apex/engine/math/Vec3'
import { CELL, LEVEL_H, PATH_STEP, ROAD_HALF_WIDTH } from './Tuning'
import {
  makePathPoint,
  opposite,
  PIECE_BY_TYPE,
  rotateLocal,
  rotatePortCell,
  rotateSide,
  rotatedSize,
  sideOffset,
  type PieceDef,
  type Profile,
  type Side,
} from './pieces'
import { PathTable, makeLaneFrame } from './PathTable'
import { solidsOf, type Solid } from './decor'
import { drapes, flattenUnderPieces, sampleHeight } from './terrain'
import { linkPiece, type Link, type LinkRolls } from './links'

export interface PlacedPiece {
  type: string
  /** Anchor cell (min corner after rotation). */
  x: number
  z: number
  /** 0..3 quarter turns counter-clockwise. */
  rot: number
  /** Base elevation level. */
  level: number
}

export interface TrackData {
  name: string
  /** Grid size in cells (square). */
  size: number
  pieces: PlacedPiece[]
  /** Landscape heights at cell corners, (size+1)² metres row-major by z; absent = flat. See terrain.ts. */
  terrain?: number[]
  /** Spline roads between two open ports (see links.ts). */
  links?: Link[]
}

/** A world-space port: which grid edge, which level. */
interface WorldPort {
  key: string
  pieceIndex: number
  portIndex: number
  /** World cell the port sits in and the side it faces. */
  cx: number
  cz: number
  side: Side
  level: number
}

export interface Lane {
  id: number
  pieceIndex: number
  laneIndex: number
  reversed: boolean
  table: PathTable
  profile: Profile
  isStart: boolean
  /** Lanes reachable from the end of this one (0 = dead end, 2 = split). */
  next: Lane[]
  /** Lanes whose end feeds the start of this one (for reversing; 2 at a join). */
  prev: Lane[]
  /** Piece base height (metres) for pillar rendering. */
  baseY: number
  /** The end of this lane is a jump lip: `next` is where you should land, reached through the air, not along the path. */
  gap?: boolean
  /** Tube lanes: whether this end opens onto plain road (a mouth that ramps up from curb height) rather than more tube. */
  mouthIn?: boolean
  mouthOut?: boolean
}

export class Track {
  readonly data: TrackData
  readonly lanes: Lane[] = []
  readonly startLane: Lane | null
  readonly errors: string[] = []
  readonly warnings: string[] = []
  /** What the errors point at, for the editor to highlight. */
  readonly errorPieces = new Set<number>()
  readonly errorLinks = new Set<number>()
  readonly warnPieces = new Set<number>()
  /** Whether driving forward from the start returns to the start. */
  readonly closed: boolean
  /** Total length of the main loop (first branch at every split). */
  readonly loopLength: number
  /** Scenery pieces (no lanes) for the renderer, with what they block for the sim. */
  readonly decor: PlacedPiece[] = []
  readonly solids: Solid[] = []
  /** Landscape actually driven on: the data's heightmap with the ground under every road pinned to its base. */
  readonly heights: number[] | undefined
  private readonly waterCells = new Set<number>()
  private readonly cells = new Map<number, Lane[]>()
  private readonly rollFrameStore = makeLaneFrame()

  constructor(data: TrackData) {
    this.data = data
    if (data.terrain && data.terrain.length === (data.size + 1) * (data.size + 1)) {
      this.heights = data.terrain.slice()
      flattenUnderPieces(this.heights, data.size, data.pieces)
    }
    const ports: WorldPort[] = []
    const occupancy = new Map<number, number>()
    data.pieces.forEach((p, i) => {
      const def = PIECE_BY_TYPE[p.type]
      if (!def) {
        this.errors.push(`Unknown piece type "${p.type}" at (${p.x}, ${p.z})`)
        this.errorPieces.add(i)
        return
      }
      const size = rotatedSize(def, p.rot)
      for (let dx = 0; dx < size.w; dx++)
        for (let dz = 0; dz < size.h; dz++) {
          // Footprints may share a cell at different levels (a bridge over a road); the same level is a clash.
          const k = cellKey(p.x + dx, p.z + dz) * 8 + p.level
          if (occupancy.has(k)) {
            this.errors.push(`${def.label} at (${p.x}, ${p.z}) overlaps ${PIECE_BY_TYPE[data.pieces[occupancy.get(k)!].type]?.label ?? 'a piece'} at cell (${p.x + dx}, ${p.z + dz})`)
            this.errorPieces.add(i)
            this.errorPieces.add(occupancy.get(k)!)
          }
          occupancy.set(k, i)
        }
      if (def.decor) {
        this.decor.push(p)
        this.solids.push(...solidsOf(p))
        if (def.decor === 'water') for (let dx = 0; dx < size.w; dx++) for (let dz = 0; dz < size.h; dz++) this.waterCells.add(cellKey(p.x + dx, p.z + dz))
        return
      }
      def.ports.forEach((port, pi) => {
        const rc = rotatePortCell(def, p.rot, port.cx, port.cz)
        const side = rotateSide(port.side, p.rot)
        const cx = p.x + rc.cx
        const cz = p.z + rc.cz
        const level = p.level + port.dLevel
        ports.push({ key: edgeKey(cx, cz, side, level), pieceIndex: i, portIndex: pi, cx, cz, side, level })
      })
    })
    // Spline links become synthetic pieces after the real ones: two ports on the linked edges, one lane.
    const linkDefs: PieceDef[] = []
    const linkPlaced: PlacedPiece[] = []
    ;(data.links ?? []).forEach((link, li) => {
      const r = linkPiece(data.pieces, link, li)
      if ('error' in r) {
        this.errors.push(r.error)
        this.errorLinks.add(li)
        return
      }
      r.def.ports.forEach((port, pi) => {
        const key = edgeKey(port.cx, port.cz, port.side, port.dLevel)
        const at = ports.filter((w) => w.key === key)
        const ref = pi === 0 ? link.a : link.b
        const own = at.find((w) => w.pieceIndex === ref.piece)
        const where = own ? `connector at (${own.cx}, ${own.cz}) ${own.side}` : 'connector'
        const neighbour = at.find((w) => w.pieceIndex !== ref.piece && w.pieceIndex < data.pieces.length)
        const otherLink = at.find((w) => w.pieceIndex >= data.pieces.length)
        if (neighbour) {
          this.errors.push(`Link ${li + 1}: the ${where} already meets the piece beside it — unlink it`)
          this.errorLinks.add(li)
          this.errorPieces.add(ref.piece)
        } else if (otherLink) {
          this.errors.push(`Links ${otherLink.pieceIndex - data.pieces.length + 1} and ${li + 1} both use the ${where}`)
          this.errorLinks.add(li)
          this.errorLinks.add(otherLink.pieceIndex - data.pieces.length)
        }
      })
      const idx = data.pieces.length + linkDefs.length
      linkDefs.push(r.def)
      linkPlaced.push(r.placed)
      r.def.ports.forEach((port, pi) => ports.push({ key: edgeKey(port.cx, port.cz, port.side, port.dLevel), pieceIndex: idx, portIndex: pi, cx: port.cx, cz: port.cz, side: port.side, level: port.dLevel }))
    })
    const defAt = (i: number): PieceDef => (i < data.pieces.length ? PIECE_BY_TYPE[data.pieces[i].type] : linkDefs[i - data.pieces.length])
    const placedAt = (i: number): PlacedPiece => (i < data.pieces.length ? data.pieces[i] : linkPlaced[i - data.pieces.length])
    // Match ports pairwise by edge key.
    const byKey = new Map<string, WorldPort[]>()
    for (const wp of ports) {
      const list = byKey.get(wp.key) ?? []
      list.push(wp)
      byKey.set(wp.key, list)
    }
    // Connectors that meet edge to edge but at different levels look joined on the map and aren't: say so.
    for (const a of ports) {
      if (a.pieceIndex >= data.pieces.length) continue
      const o = sideOffset(a.side)
      const mate = ports.find((b) => b !== a && b.pieceIndex !== a.pieceIndex && b.pieceIndex < data.pieces.length && b.cx === a.cx + o.dx && b.cz === a.cz + o.dz && b.side === opposite(a.side) && b.level !== a.level)
      if (mate && a.pieceIndex < mate.pieceIndex) {
        this.errors.push(`Connectors meet at (${a.cx}, ${a.cz}) ${a.side} but at different levels (L${a.level} vs L${mate.level}) — use a ramp or match the levels`)
        this.errorPieces.add(a.pieceIndex)
        this.errorPieces.add(mate.pieceIndex)
      }
    }
    const partner = (wp: WorldPort): WorldPort | null => {
      const list = byKey.get(wp.key)
      if (!list) return null
      for (const o of list) if (o !== wp && o.pieceIndex !== wp.pieceIndex) return o
      return null
    }

    // Start piece.
    const startIndex = data.pieces.findIndex((p) => PIECE_BY_TYPE[p.type]?.isStart)
    if (startIndex < 0) this.errors.push('No start piece')

    // Directed walk from the start.
    const laneMemo = new Map<string, Lane>()
    const portsOf = (pieceIndex: number) => ports.filter((w) => w.pieceIndex === pieceIndex)
    const getLane = (pieceIndex: number, laneIndex: number, reversed: boolean): Lane => {
      const key = `${pieceIndex}:${laneIndex}:${reversed ? 'r' : 'f'}`
      let lane = laneMemo.get(key)
      if (lane) return lane
      const p = placedAt(pieceIndex)
      const def = defAt(pieceIndex)
      lane = {
        id: this.lanes.length,
        pieceIndex,
        laneIndex,
        reversed,
        table: bakeLane(def, p, laneIndex, reversed, this.heights ? (x, z) => sampleHeight(this.heights, data.size, x, z) : null),
        profile: def.profile,
        isStart: Boolean(def.isStart),
        next: [],
        prev: [],
        baseY: p.level * LEVEL_H,
      }
      this.lanes.push(lane)
      laneMemo.set(key, lane)
      return lane
    }
    /** Directed lanes of a piece that begin at the given port index. */
    const lanesFromPort = (pieceIndex: number, portIndex: number): Lane[] => {
      const def = defAt(pieceIndex)
      const out: Lane[] = []
      def.lanes.forEach((l, li) => {
        if (l.from === portIndex) out.push(getLane(pieceIndex, li, false))
        else if (l.to === portIndex) out.push(getLane(pieceIndex, li, true))
      })
      return out
    }

    let start: Lane | null = null
    if (startIndex >= 0) {
      start = getLane(startIndex, 0, false)
      const queue: Lane[] = [start]
      const seen = new Set<number>([start.id])
      while (queue.length) {
        const lane = queue.shift()!
        const def = defAt(lane.pieceIndex)
        const ldef = def.lanes[lane.laneIndex]
        const exitPortIndex = lane.reversed ? ldef.from : ldef.to
        const exitPort = portsOf(lane.pieceIndex).find((w) => w.portIndex === exitPortIndex)!
        let other = partner(exitPort)
        if (!other && def.ports[exitPortIndex].open) {
          // A jump lip: the far side is another open port facing back along this one's line.
          const o = sideOffset(exitPort.side)
          for (let d = 2; d <= 14 && !other; d++) {
            const cx = exitPort.cx + o.dx * d
            const cz = exitPort.cz + o.dz * d
            other = ports.find((w) => w.cx === cx && w.cz === cz && w.side === opposite(exitPort.side) && w.level === exitPort.level && w.pieceIndex !== lane.pieceIndex && defAt(w.pieceIndex).ports[w.portIndex].open) ?? null
          }
          if (other) lane.gap = true
          else {
            this.warnings.push(`Jump at cell (${exitPort.cx}, ${exitPort.cz}) has nothing to land on — face another drawbridge half at it`)
            this.warnPieces.add(lane.pieceIndex)
            continue
          }
        }
        if (!other) {
          this.errors.push(`Open end at cell (${exitPort.cx}, ${exitPort.cz}) ${exitPort.side}, level ${exitPort.level}`)
          if (lane.pieceIndex < data.pieces.length) this.errorPieces.add(lane.pieceIndex)
          else this.errorLinks.add(lane.pieceIndex - data.pieces.length)
          continue
        }
        lane.next = lanesFromPort(other.pieceIndex, other.portIndex)
        if (lane.next.length === 0) {
          this.errors.push(`Piece at (${placedAt(other.pieceIndex).x}, ${placedAt(other.pieceIndex).z}) cannot be entered from that side`)
          this.errorPieces.add(other.pieceIndex)
        }
        for (const n of lane.next) {
          if (!seen.has(n.id)) {
            seen.add(n.id)
            queue.push(n)
          }
        }
      }
      const reachedPieces = new Set(this.lanes.map((l) => l.pieceIndex))
      data.pieces.forEach((p, i) => {
        if (!reachedPieces.has(i) && !PIECE_BY_TYPE[p.type]?.decor) this.warnings.push(`Piece at (${p.x}, ${p.z}) is not connected to the start`)
      })
    }
    this.startLane = start
    for (const lane of this.lanes) for (const n of lane.next) if (!n.prev.includes(lane)) n.prev.push(lane)
    // Banks: a bank ramps down only against unbanked road; bank-to-bank joints stay fully banked, and a
    // spline link between two banks carries the roll across, blended end to end.
    const rollFrame = this.rollFrameStore
    const isBanked = (l: Lane | undefined): boolean => Boolean(l && defAt(l.pieceIndex).banked)
    const rollAt = (l: Lane, s: number): number => {
      // Recover the roll baked into the frame: how far up is tipped along the flat right.
      const f = l.table.frameAt(s, rollFrame)
      const rx = -f.tan.z
      const rz = f.tan.x // flat right = tan × (0,1,0)
      const len = Math.hypot(rx, rz) || 1
      return Math.asin(Math.max(-1, Math.min(1, (f.up.x * rx + f.up.z * rz) / len)))
    }
    // Which way a banked lane leans in its driving direction (+1 right edge low, -1 left edge low); links look
    // through to the bank beyond them.
    const leanOf = (l: Lane | undefined, through: 'prev' | 'next'): number => {
      if (!l) return 0
      if (l.pieceIndex >= data.pieces.length) return leanOf(l[through][0], through)
      if (!defAt(l.pieceIndex).banked) return 0
      return l.reversed ? -1 : 1
    }
    for (const lane of this.lanes) {
      if (lane.pieceIndex >= data.pieces.length) continue
      const def = defAt(lane.pieceIndex)
      if (!def.banked) continue
      // Run straight through a joint only into a bank leaning the same way; a left bank into a right
      // bank eases out to flat and back in, so the road never flips on its side at the seam.
      const lean = lane.reversed ? -1 : 1
      const rampIn = !lane.prev.some((p) => leanOf(p, 'prev') === lean)
      const rampOut = !lane.next.some((n) => leanOf(n, 'next') === lean)
      if (!rampIn || !rampOut) lane.table = bakeLane(def, placedAt(lane.pieceIndex), lane.laneIndex, lane.reversed, this.heights ? (x, z) => sampleHeight(this.heights, data.size, x, z) : null, rampIn, rampOut)
    }
    for (const lane of this.lanes) {
      if (lane.pieceIndex < data.pieces.length) continue
      const prev = lane.prev[0]
      const next = lane.next[0]
      if (!isBanked(prev) || !isBanked(next)) continue
      const li = lane.pieceIndex - data.pieces.length
      const rolls: LinkRolls = { a: rollAt(prev, prev.table.length), b: rollAt(next, 0) }
      const r = linkPiece(data.pieces, data.links![li], li, lane.reversed ? { a: -rolls.b, b: -rolls.a } : rolls)
      if ('error' in r) continue
      lane.table = bakeLane(r.def, r.placed, 0, lane.reversed, null, false, false)
    }
    // Tunnel mouths: only where a tube lane meets plain road (chained tube sections run seamlessly).
    for (const lane of this.lanes) {
      if (lane.profile !== 'tube') continue
      lane.mouthIn = lane.prev.length === 0 || lane.prev.some((p) => p.profile !== 'tube')
      lane.mouthOut = lane.next.length === 0 || lane.next.some((n) => n.profile !== 'tube')
    }
    // Closed if following first branches returns to the start lane.
    let closed = false
    let loopLength = 0
    if (start) {
      let lane: Lane | undefined = start
      const visited = new Set<number>()
      while (lane && !visited.has(lane.id)) {
        visited.add(lane.id)
        loopLength += lane.table.length
        lane = lane.next[0]
        if (lane === start) {
          closed = true
          break
        }
      }
    }
    this.closed = closed
    this.loopLength = loopLength
    if (start && !closed) this.warnings.push('Track does not return to the start line')

    // Spatial index: lanes by the world cells their samples fall in.
    for (const lane of this.lanes) {
      const t = lane.table
      const added = new Set<number>()
      for (let i = 0; i < t.n; i++) {
        const k = cellKey(Math.floor(t.pos[i * 3] / CELL), Math.floor(t.pos[i * 3 + 2] / CELL))
        if (added.has(k)) continue
        added.add(k)
        const list = this.cells.get(k) ?? []
        list.push(lane)
        this.cells.set(k, list)
      }
    }
  }

  /** Lanes with samples in the 3×3 cells around a world point. */
  lanesNear(p: Vec3, out: Lane[]): Lane[] {
    out.length = 0
    const cx = Math.floor(p.x / CELL)
    const cz = Math.floor(p.z / CELL)
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.cells.get(cellKey(cx + dx, cz + dz))
        if (!list) continue
        for (const l of list) if (!out.includes(l)) out.push(l)
      }
    return out
  }

  get valid(): boolean {
    return this.errors.length === 0 && this.startLane !== null
  }

  /** Ground (grass) height under a world point. */
  groundHeight(x: number, z: number): number {
    return this.heights ? sampleHeight(this.heights, this.data.size, x, z) : 0
  }

  /** Whether a world point is over a water cell. */
  isWater(x: number, z: number): boolean {
    return this.waterCells.size > 0 && this.waterCells.has(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)))
  }
}

function cellKey(x: number, z: number): number {
  return (x + 512) * 4096 + (z + 512)
}

/** Identify a grid edge from either side: the two cells it separates, plus level. */
function edgeKey(cx: number, cz: number, side: Side, level: number): string {
  const o = sideOffset(side)
  const nx = cx + o.dx
  const nz = cz + o.dz
  const a = `${cx},${cz}`
  const b = `${nx},${nz}`
  return (a < b ? `${a}|${b}` : `${b}|${a}`) + `@${level}`
}

/** Sample a lane in world space, in driving direction, with frames. */
function bakeLane(def: PieceDef, p: PlacedPiece, laneIndex: number, reversed: boolean, ground: ((x: number, z: number) => number) | null, rampIn = true, rampOut = true): PathTable {
  const ldef = def.lanes[laneIndex]
  // Roads drape over the landscape point by point; pad pieces sit on the level ground pinned under them.
  const size = rotatedSize(def, p.rot)
  const padY = ground ? ground((p.x + size.w / 2) * CELL, (p.z + size.h / 2) * CELL) : 0
  const drape = ground !== null && drapes(def.type)
  const n = Math.max(2, Math.round(ldef.length / PATH_STEP) + 1)
  // Oversample the path to get arc-length-uniform output.
  const fine = n * 6
  const pt = makePathPoint()
  const rot = { x: 0, z: 0 }
  const pts: number[] = []
  const ups: number[] = []
  const rolls: number[] = []
  const surf: number[] = []
  for (let i = 0; i <= fine; i++) {
    let t = i / fine
    const tl = t // along the lane in driving direction
    if (reversed) t = 1 - t
    ldef.path(t, pt)
    // Banked road: ramp the roll in/out only at ends that meet unbanked road, and lift the centreline
    // so the inner (lower) edge stays at grade — full banking runs straight across bank-to-bank joints.
    let roll = pt.roll
    let lift = 0
    if (def.banked) {
      roll *= (rampIn ? smoothstep(0, 0.25, tl) : 1) * (rampOut ? 1 - smoothstep(0.75, 1, tl) : 1)
      lift = Math.sin(Math.abs(roll)) * ROAD_HALF_WIDTH
    }
    rotateLocal(def, p.rot, pt.x, pt.z, rot)
    const wx = p.x * CELL + rot.x
    const wz = p.z * CELL + rot.z
    pts.push(wx, p.level * LEVEL_H + pt.y + lift + (drape ? ground!(wx, wz) : padY), wz)
    const u = { x: 0, z: 0 }
    rotateLocal(def, p.rot, pt.ux, pt.uz, u)
    // rotateLocal translates; undo by rotating the origin too.
    const o = { x: 0, z: 0 }
    rotateLocal(def, p.rot, 0, 0, o)
    if (drape && ground && pt.uy > 0.99 && Math.abs(pt.ux) < 1e-6 && Math.abs(pt.uz) < 1e-6) {
      // A flat road on the landscape takes the ground's normal, so it cambers with the hillside instead of
      // cutting a level shelf into it.
      const d = 2
      const gx = (ground(wx + d, wz) - ground(wx - d, wz)) / (2 * d)
      const gz = (ground(wx, wz + d) - ground(wx, wz - d)) / (2 * d)
      const len = Math.hypot(gx, 1, gz)
      ups.push(-gx / len, 1 / len, -gz / len)
    } else ups.push(u.x - o.x, pt.uy, u.z - o.z)
    rolls.push(reversed ? -roll : roll)
    surf.push(pt.surface ? 1 : 0)
  }
  // Cumulative length along the fine polyline.
  const cum = new Float64Array(fine + 1)
  for (let i = 1; i <= fine; i++) {
    const dx = pts[i * 3] - pts[(i - 1) * 3]
    const dy = pts[i * 3 + 1] - pts[(i - 1) * 3 + 1]
    const dz = pts[i * 3 + 2] - pts[(i - 1) * 3 + 2]
    cum[i] = cum[i - 1] + Math.hypot(dx, dy, dz)
  }
  const total = cum[fine]
  const count = Math.max(2, Math.round(total / PATH_STEP) + 1)
  const table = new PathTable(count)
  const step = total / (count - 1)
  let j = 0
  const a = new Vec3()
  const b = new Vec3()
  const tan = new Vec3()
  const up = new Vec3()
  const right = new Vec3()
  const axis = new Vec3()
  for (let i = 0; i < count; i++) {
    const s = i * step
    while (j < fine - 1 && cum[j + 1] < s) j++
    const seg = cum[j + 1] - cum[j] || 1
    const t = Math.min(1, Math.max(0, (s - cum[j]) / seg))
    a.set(pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2])
    b.set(pts[(j + 1) * 3], pts[(j + 1) * 3 + 1], pts[(j + 1) * 3 + 2])
    table.pos[i * 3] = a.x + (b.x - a.x) * t
    table.pos[i * 3 + 1] = a.y + (b.y - a.y) * t
    table.pos[i * 3 + 2] = a.z + (b.z - a.z) * t
    up.set(ups[j * 3] + (ups[(j + 1) * 3] - ups[j * 3]) * t, ups[j * 3 + 1] + (ups[(j + 1) * 3 + 1] - ups[j * 3 + 1]) * t, ups[j * 3 + 2] + (ups[(j + 1) * 3 + 2] - ups[j * 3 + 2]) * t)
    table.up[i * 3] = up.x
    table.up[i * 3 + 1] = up.y
    table.up[i * 3 + 2] = up.z
    table.kUp[i] = rolls[j] + (rolls[j + 1] - rolls[j]) * t // temporarily stash roll here
    table.surface[i] = surf[j] === 1 && surf[j + 1] === 1 ? 1 : 0
    table.minX = Math.min(table.minX, table.pos[i * 3])
    table.minY = Math.min(table.minY, table.pos[i * 3 + 1])
    table.minZ = Math.min(table.minZ, table.pos[i * 3 + 2])
    table.maxX = Math.max(table.maxX, table.pos[i * 3])
    table.maxY = Math.max(table.maxY, table.pos[i * 3 + 1])
    table.maxZ = Math.max(table.maxZ, table.pos[i * 3 + 2])
  }
  // Tangents (central differences), orthonormal up with banking roll, right, curvatures.
  const prevTan = new Vec3()
  for (let i = 0; i < count; i++) {
    const i0 = Math.max(0, i - 1)
    const i1 = Math.min(count - 1, i + 1)
    tan.set(table.pos[i1 * 3] - table.pos[i0 * 3], table.pos[i1 * 3 + 1] - table.pos[i0 * 3 + 1], table.pos[i1 * 3 + 2] - table.pos[i0 * 3 + 2]).normalize()
    up.set(table.up[i * 3], table.up[i * 3 + 1], table.up[i * 3 + 2]).projectOntoPlane(tan)
    if (up.lengthSq() < 1e-6) up.set(0, 1, 0).projectOntoPlane(tan)
    up.normalize()
    const roll = table.kUp[i]
    if (roll !== 0) up.rotateAxis(tan, roll)
    right.cross(tan, up).normalize()
    table.tan[i * 3] = tan.x
    table.tan[i * 3 + 1] = tan.y
    table.tan[i * 3 + 2] = tan.z
    table.up[i * 3] = up.x
    table.up[i * 3 + 1] = up.y
    table.up[i * 3 + 2] = up.z
    table.right[i * 3] = right.x
    table.right[i * 3 + 1] = right.y
    table.right[i * 3 + 2] = right.z
    if (i > 0) {
      // Curvature ≈ change of tangent per metre, decomposed along up / right.
      axis.copy(tan).sub(prevTan).scale(1 / step)
      table.kUp[i] = axis.dot(up)
      table.kRight[i] = axis.dot(right)
    }
    prevTan.copy(tan)
  }
  table.kUp[0] = table.kUp[1] ?? 0
  table.kRight[0] = table.kRight[1] ?? 0
  return table
}

/** Every port of every piece with its world edge key and whether it has a partner — a neighbouring piece or a spline link (editor overlay). */
export function portStatus(pieces: PlacedPiece[], links: Link[] = []): { pieceIndex: number; portIndex: number; cx: number; cz: number; side: Side; level: number; key: string; matched: boolean; linked: boolean }[] {
  const out: { pieceIndex: number; portIndex: number; cx: number; cz: number; side: Side; level: number; key: string; matched: boolean; linked: boolean }[] = []
  pieces.forEach((p, i) => {
    const def = PIECE_BY_TYPE[p.type]
    if (!def) return
    def.ports.forEach((port, pi) => {
      const rc = rotatePortCell(def, p.rot, port.cx, port.cz)
      const side = rotateSide(port.side, p.rot)
      const cx = p.x + rc.cx
      const cz = p.z + rc.cz
      const level = p.level + port.dLevel
      out.push({ pieceIndex: i, portIndex: pi, cx, cz, side, level, key: edgeKey(cx, cz, side, level), matched: false, linked: false })
    })
  })
  const count = new Map<string, number>()
  for (const o of out) count.set(o.key, (count.get(o.key) ?? 0) + 1)
  for (const o of out) o.matched = (count.get(o.key) ?? 0) >= 2
  for (const l of links) for (const ref of [l.a, l.b]) {
    const o = out.find((x) => x.pieceIndex === ref.piece && x.portIndex === ref.port)
    if (o) {
      o.matched = true
      o.linked = true
    }
  }
  return out
}

/** World position of a piece's footprint centre (editor/minimap helper). */
export function pieceCentre(p: PlacedPiece): { x: number; z: number } {
  const def = PIECE_BY_TYPE[p.type]
  const size = rotatedSize(def, p.rot)
  return { x: (p.x + size.w / 2) * CELL, z: (p.z + size.h / 2) * CELL }
}

export { opposite }
