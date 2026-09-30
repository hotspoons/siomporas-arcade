// Point-in-polygon and polygon area, on their own.
//
// They lived in `adjust.ts`, which is right until something that is not an adjustment needs them —
// and `zones.ts` does. Importing them from there drags `DATA_BASE` in with them, and `site.ts`
// reads `location.search` at module scope, so a Node test that merely wants to know whether a point
// is inside a ring dies on `location is not defined`.
//
// The same lesson as `classes.ts`, which was extracted from the UI for exactly this reason:
// GEOMETRY IS DATA. It should not require a browser to use, and it certainly should not require one
// to test.

/**
 * Even-odd point in polygon, in any frame, with the ring closed implicitly.
 *
 * Even-odd rather than winding because nothing guarantees the authored rings have a consistent
 * direction — the editor draws them however the mouse went.
 */
export function inside(poly: [number, number][], x: number, y: number): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** The shoelace area, always positive — the direction the ring was drawn in is not information. */
export function areaOf(poly: [number, number][]): number {
  let s = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
  return Math.abs(s) / 2
}
