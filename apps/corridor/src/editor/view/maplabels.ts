// Road names on the map: which of the candidates get drawn this frame.
//
// PURE, so the rules are testable: give it every candidate already projected to the screen, get
// back the ones to draw. The painter (maproads.ts) owns the canvas and the projection.
//
// THE RULES, in the order a cartographer applies them:
//  - the more important road first (rank: motorway, trunk, primary … residential, service), then
//    the one nearer the middle of the screen, so what you are looking at is labelled first;
//  - no two labels overlap (their rotated boxes, padded, taken as screen-aligned boxes — a
//    conservative test that never lets two touch);
//  - the same name is not repeated within a few hundred pixels: a street labelled once per
//    screenful reads as a map, labelled at every anchor it reads as wallpaper;
//  - a hard cap on the count, which is what bounds the paint cost.

export interface LabelCand {
  /** screen position of the anchor, CSS pixels */
  sx: number
  sy: number
  /** text angle on screen, radians, already folded so the text reads left to right */
  ang: number
  /** text box, CSS pixels */
  w: number
  h: number
  /** name id: equal ids are the same name */
  name: number
  /** importance, 0 first */
  rank: number
  /** tie-break: distance from the screen centre, pixels */
  dist: number
}

export interface LayoutOpts {
  width: number
  height: number
  /** most labels to place */
  max: number
  /** minimum spacing between two labels of the same name, pixels, by rank */
  sameNamePx: (rank: number) => number
  /** clear space kept around every label, pixels */
  pad: number
}

const CELL = 64

/** Indices into `cands` of the labels to draw, highest priority first. */
export function layoutLabels(cands: LabelCand[], o: LayoutOpts): number[] {
  const order = cands.map((_, i) => i)
  order.sort((a, b) => cands[a].rank - cands[b].rank || cands[a].dist - cands[b].dist)
  const grid = new Map<number, number[]>() // cell → indices of placed boxes
  const boxes: [number, number, number, number][] = []
  const byName = new Map<number, [number, number][]>()
  const out: number[] = []
  for (const i of order) {
    if (out.length >= o.max) break
    const c = cands[i]
    const ca = Math.abs(Math.cos(c.ang)), sa = Math.abs(Math.sin(c.ang))
    const hw = (c.w * ca + c.h * sa) / 2 + o.pad
    const hh = (c.w * sa + c.h * ca) / 2 + o.pad
    const x0 = c.sx - hw, x1 = c.sx + hw, y0 = c.sy - hh, y1 = c.sy + hh
    // wholly on screen: a label cut by the edge is a label you cannot read
    if (x0 < 0 || y0 < 0 || x1 > o.width || y1 > o.height) continue
    const same = byName.get(c.name)
    if (same) {
      const r = o.sameNamePx(c.rank)
      if (same.some(([x, y]) => Math.hypot(x - c.sx, y - c.sy) < r)) continue
    }
    const gx0 = Math.floor(x0 / CELL), gx1 = Math.floor(x1 / CELL), gy0 = Math.floor(y0 / CELL), gy1 = Math.floor(y1 / CELL)
    let hit = false
    for (let gx = gx0; gx <= gx1 && !hit; gx++) {
      for (let gy = gy0; gy <= gy1 && !hit; gy++) {
        for (const k of grid.get(gx * 100_003 + gy) ?? []) {
          const b = boxes[k]
          if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) { hit = true; break }
        }
      }
    }
    if (hit) continue
    const k = boxes.push([x0, y0, x1, y1]) - 1
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const key = gx * 100_003 + gy
        const list = grid.get(key)
        if (list) list.push(k)
        else grid.set(key, [k])
      }
    }
    if (same) same.push([c.sx, c.sy])
    else byName.set(c.name, [[c.sx, c.sy]])
    out.push(i)
  }
  return out
}

/** Fold a screen angle so text never reads upside down: into (−π/2, π/2]. */
export function readableAngle(a: number): number {
  let v = a
  while (v > Math.PI / 2) v -= Math.PI
  while (v <= -Math.PI / 2) v += Math.PI
  return v
}
