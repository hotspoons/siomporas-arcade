// Landscape: a heightmap on the editor grid, one height per cell corner
// ((size+1)² values, metres, row-major by z). Absent means flat. Road pieces
// flatten the ground under their footprint to their base height, so a raised
// road sits on an embankment and the grass always meets the tarmac cleanly.

import { CELL, LEVEL_H, TUBE_RADIUS } from './Tuning'
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

/** One-dimensional Catmull-Rom through four samples. */
function spline(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (p2 - p0) + 0.5 * t * t * (2 * p0 - 5 * p1 + 4 * p2 - p3) + 0.5 * t * t * t * (-p0 + 3 * p1 - 3 * p2 + p3)
}

/**
 * Ground height at a world point (metres), interpolated as a Catmull-Rom surface through the corner
 * grid. Corners are 40 m apart, so bilinear interpolation made every cell a flat plane: a hill's crest
 * became a corner between two cells, the road over it had no curvature at all, and the car stayed glued
 * to the tarmac where it should have taken off. A smooth surface gives crests a real radius — and the
 * spline passes exactly through the corners, so the roads draped on it and the mesh drawn from it agree.
 */
export function sampleHeight(heights: number[] | undefined, size: number, x: number, z: number): number {
  if (!heights) return 0
  const fx = Math.max(0, Math.min(size - 1e-6, x / CELL))
  const fz = Math.max(0, Math.min(size - 1e-6, z / CELL))
  const cx = Math.floor(fx)
  const cz = Math.floor(fz)
  const tx = fx - cx
  const tz = fz - cz
  const at = (ix: number, iz: number) => heights[terrainIndex(size, Math.max(0, Math.min(size, ix)), Math.max(0, Math.min(size, iz)))] ?? 0
  const row = (dz: number) => spline(at(cx - 1, cz + dz), at(cx, cz + dz), at(cx + 1, cz + dz), at(cx + 2, cz + dz), tx)
  return spline(row(-1), row(0), row(1), row(2), tz)
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

/** How far a cutting reaches past the road, in cells. */
const CUT_REACH = 1.6
/** Cells of level apron around a tunnel, so the ground inside the bore is flat and stays under the floor. */
const TUBE_FLAT = 1.5
/** How fast a cutting's banks may climb away from the road, metres per cell. */
const CUT_RISE = 12
/** Ground this far above a road clears the tube around it, so a hill may carry on over a tunnel. */
const TUNNEL_OVERBURDEN = TUBE_RADIUS * 2 + 6

/**
 * Cut the land down to the roads that dip below it.
 *
 * Grading pins the ground under a piece's footprint, which is enough while the road runs along the
 * surface. It is not enough where the road drops — into a dip, down to a tunnel mouth, or under a
 * hillside — because the land beside it keeps its own height and simply grows over the tarmac. So
 * every corner near a road is pushed down to just under the driving surface, with a bank that climbs
 * away at CUT_RISE per cell so the cutting has sides instead of walls.
 *
 * A tunnel is the exception worth making: ground already high enough to clear the tube is left alone,
 * so a hill still passes over the bore rather than being sliced into a trench.
 *
 * Returns the corners it pinned, which the clamp then treats as fixed.
 */
function cutForRoads(heights: number[], size: number, roads: { x: number; z: number; y: number; tube: boolean }[]): Set<number> {
  const limit = new Map<number, { max: number; over: number }>()
  for (const s of roads) {
    const cx = s.x / CELL
    const cz = s.z / CELL
    // A tunnel needs a flat apron, not a bank: the ground is interpolated through the corners a cell
    // either side, so a step that close bulges the surface up inside the bore.
    const reach = s.tube ? TUBE_FLAT + 1 : CUT_REACH
    const x0 = Math.max(0, Math.floor(cx - reach))
    const x1 = Math.min(size, Math.ceil(cx + reach))
    const z0 = Math.max(0, Math.floor(cz - reach))
    const z1 = Math.min(size, Math.ceil(cz + reach))
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        // Half a cell of slack: the corners of the cell the road runs through are cut to the road itself.
        const d = Math.max(0, Math.hypot(x - cx, z - cz) - 0.7)
        if (d > reach) continue
        const flat = s.tube && d <= TUBE_FLAT
        // Down to the driving surface and no further: the tarmac and the tube floor are both built
        // to stand clear of the ground, so cutting to the lane height leaves them proud of the grass
        // without a step at the shoulder. Around a tunnel the apron stays level, then banks away.
        const max = s.y + (flat ? 0 : Math.max(0, d - (s.tube ? TUBE_FLAT : 0)) * CUT_RISE)
        const i = terrainIndex(size, x, z)
        const had = limit.get(i)
        // Only land well clear of a tunnel's apron may stand: that is the hill the bore runs into.
        if (!had || max < had.max) limit.set(i, { max, over: s.tube && !flat ? s.y + TUNNEL_OVERBURDEN : Infinity })
      }
  }
  const pinned = new Set<number>()
  for (const [i, l] of limit) {
    pinned.add(i)
    if (heights[i] > l.over) continue // high enough to pass over the tube: leave the hill alone
    if (heights[i] > l.max) heights[i] = l.max
  }
  return pinned
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
export function flattenUnderPieces(heights: number[], size: number, pieces: PlacedPiece[]): Map<number, number> {
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
  const padY = new Map<number, number>()
  const pads: { p: PlacedPiece; y: number; s: { w: number; h: number } }[] = []
  pieces.forEach((p, i) => {
    const def = PIECE_BY_TYPE[p.type]
    if (!def || def.decor || drapes(p.type)) return
    const s = rotatedSize(def, p.rot)
    const y = sampleHeight(original, size, (p.x + s.w / 2) * CELL, (p.z + s.h / 2) * CELL)
    padY.set(i, y)
    pads.push({ p, s, y })
  })
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
  // Where the tarmac actually is, so the cutting knows what to dig down to.
  const roads: { x: number; z: number; y: number; tube: boolean }[] = []
  pieces.forEach((p, i) => {
    const def = PIECE_BY_TYPE[p.type]
    if (!def || def.decor) return
    const tube = def.profile === 'tube'
    const draped = drapes(p.type)
    for (const q of centreline(p)) {
      const base = draped ? sampleHeight(heights, size, q.x, q.z) : (padY.get(i) ?? 0)
      roads.push({ x: q.x, z: q.z, y: p.level * LEVEL_H + q.y + base, tube })
    }
  })
  clampTerrain(heights, size, TERRAIN_MAX_STEP, cutForRoads(heights, size, roads))
  // The pad heights the grading settled on. The ground under a tunnel is cut below its floor, so a
  // piece that reads its height back off the graded ground would sink with it, every build.
  return padY
}

/** How far two neighbouring corners may differ, in metres. Corners are CELL apart, so this is the steepest cliff the land can hold. */
export const TERRAIN_MAX_STEP = 30
/** Absolute limits, a little wider than the sculpting brush's own range so grading has room to work. */
export const TERRAIN_MIN = -60
export const TERRAIN_MAX = 160

/**
 * Keep a heightmap sane: finite, within range, and with no cliff between neighbouring corners taller
 * than `maxStep`. Excess is split between the two corners, so the pair keeps its average and the whole
 * surface settles like a sandpile instead of being flattened.
 *
 * This is a backstop, not a sculpting tool. Grading the land under the roads used to be written back
 * over the sculpted heightmap, so every brush sample re-graded its own output; the corridor resamples
 * the surface with a spline, that spline can overshoot by a quarter, and a few hundred strokes of
 * compounding overshoot turned a hillside into six-figure spikes. The feedback is gone, and this makes
 * sure nothing like it can put an Escher landscape on the grid again.
 *
 * Returns true when it had to change something.
 */
export function clampTerrain(heights: number[], size: number, maxStep = TERRAIN_MAX_STEP, pinned?: Set<number>): boolean {
  let touched = false
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i]
    const c = Number.isFinite(v) ? Math.max(TERRAIN_MIN, Math.min(TERRAIN_MAX, v)) : 0
    if (c !== v) {
      heights[i] = c
      touched = true
    }
  }
  for (let pass = 0; pass < 24; pass++) {
    let changed = false
    for (let z = 0; z <= size; z++)
      for (let x = 0; x <= size; x++) {
        const i = terrainIndex(size, x, z)
        for (const [dx, dz] of [
          [1, 0],
          [0, 1],
        ]) {
          const nx = x + dx
          const nz = z + dz
          if (nx > size || nz > size) continue
          const j = terrainIndex(size, nx, nz)
          const d = heights[j] - heights[i]
          if (Math.abs(d) <= maxStep) continue
          const excess = (Math.abs(d) - maxStep) * Math.sign(d)
          // A pinned corner is ground a road stands on: the other side gives way instead, otherwise
          // the hill beside a cutting would drag the cutting back up over the tarmac.
          const iFixed = pinned?.has(i) ?? false
          const jFixed = pinned?.has(j) ?? false
          if (iFixed && jFixed) continue
          if (iFixed) heights[j] -= excess
          else if (jFixed) heights[i] += excess
          else {
            heights[i] += excess / 2
            heights[j] -= excess / 2
          }
          changed = true
        }
      }
    if (!changed) break
    touched = true
  }
  return touched
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
