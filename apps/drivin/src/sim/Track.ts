// A placed track: pieces on the grid, ports matched into a graph, and every
// reachable lane baked (in driving direction) into a PathTable. Also the
// spatial index the car uses to find surfaces while airborne or on grass.

import { Vec3 } from '@apex/engine/math/Vec3'
import { CELL, LEVEL_H, PATH_STEP } from './Tuning'
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
import { PathTable } from './PathTable'

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
  /** Piece base height (metres) for pillar rendering. */
  baseY: number
}

export class Track {
  readonly data: TrackData
  readonly lanes: Lane[] = []
  readonly startLane: Lane | null
  readonly errors: string[] = []
  readonly warnings: string[] = []
  /** Whether driving forward from the start returns to the start. */
  readonly closed: boolean
  /** Total length of the main loop (first branch at every split). */
  readonly loopLength: number
  private readonly cells = new Map<number, Lane[]>()

  constructor(data: TrackData) {
    this.data = data
    const ports: WorldPort[] = []
    const occupancy = new Map<number, number>()
    data.pieces.forEach((p, i) => {
      const def = PIECE_BY_TYPE[p.type]
      if (!def) {
        this.errors.push(`Unknown piece type "${p.type}"`)
        return
      }
      const size = rotatedSize(def, p.rot)
      for (let dx = 0; dx < size.w; dx++)
        for (let dz = 0; dz < size.h; dz++) {
          const k = cellKey(p.x + dx, p.z + dz)
          if (occupancy.has(k)) this.errors.push(`Pieces overlap at (${p.x + dx}, ${p.z + dz})`)
          occupancy.set(k, i)
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
    // Match ports pairwise by edge key.
    const byKey = new Map<string, WorldPort[]>()
    for (const wp of ports) {
      const list = byKey.get(wp.key) ?? []
      list.push(wp)
      byKey.set(wp.key, list)
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
      const p = data.pieces[pieceIndex]
      const def = PIECE_BY_TYPE[p.type]
      lane = {
        id: this.lanes.length,
        pieceIndex,
        laneIndex,
        reversed,
        table: bakeLane(def, p, laneIndex, reversed),
        profile: def.profile,
        isStart: Boolean(def.isStart),
        next: [],
        baseY: p.level * LEVEL_H,
      }
      this.lanes.push(lane)
      laneMemo.set(key, lane)
      return lane
    }
    /** Directed lanes of a piece that begin at the given port index. */
    const lanesFromPort = (pieceIndex: number, portIndex: number): Lane[] => {
      const def = PIECE_BY_TYPE[data.pieces[pieceIndex].type]
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
        const def = PIECE_BY_TYPE[data.pieces[lane.pieceIndex].type]
        const ldef = def.lanes[lane.laneIndex]
        const exitPortIndex = lane.reversed ? ldef.from : ldef.to
        const exitPort = portsOf(lane.pieceIndex).find((w) => w.portIndex === exitPortIndex)!
        const other = partner(exitPort)
        if (!other) {
          this.errors.push(`Open end at cell (${exitPort.cx}, ${exitPort.cz}) ${exitPort.side}, level ${exitPort.level}`)
          continue
        }
        lane.next = lanesFromPort(other.pieceIndex, other.portIndex)
        if (lane.next.length === 0) this.errors.push(`Piece at (${data.pieces[other.pieceIndex].x}, ${data.pieces[other.pieceIndex].z}) cannot be entered from that side`)
        for (const n of lane.next) {
          if (!seen.has(n.id)) {
            seen.add(n.id)
            queue.push(n)
          }
        }
      }
      const reachedPieces = new Set(this.lanes.map((l) => l.pieceIndex))
      data.pieces.forEach((p, i) => {
        if (!reachedPieces.has(i)) this.warnings.push(`Piece at (${p.x}, ${p.z}) is not connected to the start`)
      })
    }
    this.startLane = start
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
function bakeLane(def: PieceDef, p: PlacedPiece, laneIndex: number, reversed: boolean): PathTable {
  const ldef = def.lanes[laneIndex]
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
    if (reversed) t = 1 - t
    ldef.path(t, pt)
    rotateLocal(def, p.rot, pt.x, pt.z, rot)
    pts.push(p.x * CELL + rot.x, p.level * LEVEL_H + pt.y, p.z * CELL + rot.z)
    const u = { x: 0, z: 0 }
    rotateLocal(def, p.rot, pt.ux, pt.uz, u)
    // rotateLocal translates; undo by rotating the origin too.
    const o = { x: 0, z: 0 }
    rotateLocal(def, p.rot, 0, 0, o)
    ups.push(u.x - o.x, pt.uy, u.z - o.z)
    rolls.push(reversed ? -pt.roll : pt.roll)
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

/** Every port of every piece with its world edge key and whether it has a partner (editor overlay). */
export function portStatus(pieces: PlacedPiece[]): { pieceIndex: number; cx: number; cz: number; side: Side; level: number; matched: boolean }[] {
  const out: { pieceIndex: number; cx: number; cz: number; side: Side; level: number; key: string; matched: boolean }[] = []
  pieces.forEach((p, i) => {
    const def = PIECE_BY_TYPE[p.type]
    if (!def) return
    for (const port of def.ports) {
      const rc = rotatePortCell(def, p.rot, port.cx, port.cz)
      const side = rotateSide(port.side, p.rot)
      const cx = p.x + rc.cx
      const cz = p.z + rc.cz
      const level = p.level + port.dLevel
      out.push({ pieceIndex: i, cx, cz, side, level, key: edgeKey(cx, cz, side, level), matched: false })
    }
  })
  const count = new Map<string, number>()
  for (const o of out) count.set(o.key, (count.get(o.key) ?? 0) + 1)
  for (const o of out) o.matched = (count.get(o.key) ?? 0) >= 2
  return out
}

/** World position of a piece's footprint centre (editor/minimap helper). */
export function pieceCentre(p: PlacedPiece): { x: number; z: number } {
  const def = PIECE_BY_TYPE[p.type]
  const size = rotatedSize(def, p.rot)
  return { x: (p.x + size.w / 2) * CELL, z: (p.z + size.h / 2) * CELL }
}

export { opposite }
