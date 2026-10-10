/**
 * THE GROUND UNDER A BUILDING, for anything that must not grow there.
 *
 * The canopy model is a height above the ground, and over a city it reads some roofs as crowns:
 * on dc-metro-take-2 along Belcrest Road the planter grew trees through the floors of high-rises
 * (Rich, 2026-10-10). The bake's CHM is one fix; this is the one that holds for every bake already
 * published. The OSM footprints are the authority on where a building stands, so the planter asks
 * them as well as the canopy.
 *
 * Footprints arrive a vector tile at a time, after the trees near them may already be planted, so
 * `add` returns the box it covered: the caller culls the standing trees in it.
 *
 * SITE FRAME, x east, y north — the same as a footprint ring and as the tree planter.
 */

type Ring = [number, number][]
interface Entry {
  ring: Ring
  x0: number
  y0: number
  x1: number
  y1: number
}

export class FootprintMask {
  private readonly cell: number
  private readonly grid = new Map<string, Entry[]>()
  private readonly seen = new WeakSet<object>()
  /** footprints indexed — a probe compares it with the buildings loaded */
  count = 0

  constructor(cell = 32) {
    this.cell = cell
  }

  /** index these footprints; returns the box they cover, or null when none were new */
  add(list: readonly { ring?: Ring | null }[]): [number, number, number, number] | null {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
    for (const b of list) {
      const ring = b.ring
      if (!ring || ring.length < 3 || this.seen.has(b)) continue
      this.seen.add(b)
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const [x, y] of ring) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      if (!Number.isFinite(x0)) continue
      const e: Entry = { ring, x0, y0, x1, y1 }
      // padded by a cell so a query with clearance finds the footprint from the next cell over
      for (let cy = Math.floor(y0 / this.cell) - 1; cy <= Math.floor(y1 / this.cell) + 1; cy++) {
        for (let cx = Math.floor(x0 / this.cell) - 1; cx <= Math.floor(x1 / this.cell) + 1; cx++) {
          const k = `${cx},${cy}`
          const arr = this.grid.get(k)
          if (arr) arr.push(e)
          else this.grid.set(k, [e])
        }
      }
      this.count++
      if (x0 < bx0) bx0 = x0
      if (y0 < by0) by0 = y0
      if (x1 > bx1) bx1 = x1
      if (y1 > by1) by1 = y1
    }
    return Number.isFinite(bx0) ? [bx0, by0, bx1, by1] : null
  }

  /**
   * Is (x, y) inside a footprint, or within `pad` metres of one? `pad` is capped at the index cell,
   * which is as far as the padded index reaches.
   */
  inside(x: number, y: number, pad = 0): boolean {
    const arr = this.grid.get(`${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`)
    if (!arr) return false
    const p = Math.min(Math.max(0, pad), this.cell)
    for (const e of arr) {
      if (x < e.x0 - p || x > e.x1 + p || y < e.y0 - p || y > e.y1 + p) continue
      if (inRing(e.ring, x, y)) return true
      if (p > 0 && nearRing(e.ring, x, y, p)) return true
    }
    return false
  }
}

/** even-odd point in polygon; the ring may or may not repeat its first vertex */
export function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** is any edge of the ring within `d` metres of (x, y)? */
function nearRing(ring: Ring, x: number, y: number, d: number): boolean {
  const d2 = d * d
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]
    const [bx, by] = ring[i]
    const ex = bx - ax, ey = by - ay
    const L = ex * ex + ey * ey
    const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L)) : 0
    const dx = ax + ex * t - x, dy = ay + ey * t - y
    if (dx * dx + dy * dy <= d2) return true
  }
  return false
}
