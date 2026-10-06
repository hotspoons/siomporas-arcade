/**
 * Grade separation: which carriageway does the ground follow where two cross, and the deck that
 * carries the one it does not.
 *
 * The physics ground is ONE height per column, so at a grade-separated crossing it can only be one
 * of the two carriageways. It follows the earth: a carriageway up in the air is a deck, not ground,
 * and is carried by a trimesh collider instead — the same trick a stunt loop uses to be a surface
 * that is above itself. `scene.ts` owns the splines and the station grid; this module owns only the
 * rule and the shape, kept pure so they can be wrong visibly and tested without a renderer.
 *
 * Paul, 2026-10-06: driving the ramp over the Beltway the car fell to the highway underneath
 * halfway across, and approaching an overpass on the Beltway it hit an invisible wall where the
 * ground had snapped up to the ramp. Both are the ground having no vertical awareness at all.
 */

/** one station of a carriageway's centreline, worst-case: x/z are WORLD, y is height above datum */
export interface DeckStation {
  x: number
  z: number
  /** paved half-width, and its lateral offset from the spline (a divided highway's own half) */
  half: number
  off: number
  /** along-track metres, so a gap in the list is not mistaken for a deck */
  s: number
  /** the carriageway's own height here — the spline IS the road surface */
  y: number
}

export interface DeckGeom {
  positions: Float32Array
  indices: Uint32Array
}

/**
 * Is a carriageway station a DECK — up in the air, so not ground to grade to?
 *
 * The physics ground is ONE height per column, so at a grade-separated crossing it can only be one
 * of the two carriageways, and the other must be a real surface or the car falls through it. The
 * ground follows the earth: a carriageway standing more than `clear` metres above the bare earth is
 * a bridge or overpass deck and is skipped by the grader, then carried by a trimesh collider (the
 * "invisible tunnel" under the structure). Everything nearer the earth than that is ground — a fill
 * embankment is IN the DEM, so it stays ground, while a genuine structure's DEM is the valley below.
 *
 * Paul, 2026-10-06: driving the ramp over the Beltway the car fell to the highway underneath
 * halfway across, and approaching an overpass on the Beltway it hit an invisible wall where the
 * ground had snapped up to the ramp. Both are the ground having no vertical awareness at all.
 */
export function isDeck(y: number, earthY: number, clear: number): boolean {
  return y - earthY > clear
}

/**
 * A drivable ribbon over the elevated runs of a carriageway's station list.
 *
 * Walks consecutive stations and emits a quad wherever the spline stands more than `clear` metres
 * above the bare earth — a carriageway on an embankment at +4 m qualifies, which is redundant with
 * the heightfield but harmless, and a genuine deck at +7 m is the whole point. Positions are the
 * SITE frame the caller works in: x east, y north (= -world z), z up (= world y); `addSurface`
 * converts to the physics frame once. Across the road the two edges sit at `off - half` and
 * `off + half` of the right-hand perpendicular, which is the pavement the road mesh draws.
 */
export function deckRibbon(
  list: DeckStation[],
  /** bare earth under a SITE point: x east, y north (-world z) — the DEM sampler */
  earthAt: (x: number, y: number) => number,
  clear: number,
): DeckGeom | null {
  if (!list || list.length < 2) return null
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i + 1 < list.length; i++) {
    const A = list[i]
    const B = list[i + 1]
    if (Math.abs(B.s - A.s) > 12) continue // a gap in the road, not a deck
    const dx = B.x - A.x
    const dz = B.z - A.z
    const seg = Math.hypot(dx, dz)
    if (seg < 0.5 || seg > 12) continue
    const midx = (A.x + B.x) / 2
    const midz = (A.z + B.z) / 2
    if ((A.y + B.y) / 2 - earthAt(midx, -midz) <= clear) continue
    const rx = -dz / seg
    const rz = dx / seg // right of travel: dir x UP = (-dz, 0, dx)
    const aL = A.off - A.half
    const aR = A.off + A.half
    const bL = B.off - B.half
    const bR = B.off + B.half
    const base = pos.length / 3
    pos.push(A.x + rx * aL, -(A.z + rz * aL), A.y)
    pos.push(A.x + rx * aR, -(A.z + rz * aR), A.y)
    pos.push(B.x + rx * bL, -(B.z + rz * bL), B.y)
    pos.push(B.x + rx * bR, -(B.z + rz * bR), B.y)
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
  }
  if (idx.length < 6) return null
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}
