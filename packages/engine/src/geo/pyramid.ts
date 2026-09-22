/**
 * LOD selection over the geographic quadtree — which tiles a camera actually wants.
 *
 * The viewer loads EVERY tile of a site before it draws a frame. That is deferred loading, not
 * streaming, and it scales with the world instead of the view: 33.8 MB of packs at boot for
 * crofton-crownsville's 125 tiles, and 8.7 GB for a Maryland-sized world.
 *
 * A pyramid bounds the resident set by the VIEW. `wanted()` walks down from the root and keeps a
 * tile only when its screen-space error is too large to accept — so a driving camera holds about
 * 69 tiles whatever the world's size, fewer than one site costs today.
 *
 * ## Strict child-replaces-parent, and the rule that makes it safe
 *
 * A tile is drawn only if it is a leaf of the wanted set. A parent subdivides only when ALL FOUR
 * children are available; otherwise it draws itself. That avoids the hole a partial quad would
 * leave — and it is why the bake emits a quad-closed set, including empty siblings. trailworks
 * learned this the other way round: `pipeline/bake/pyramid.py` documents whole regions frozen at a
 * coarse level because one child of a quad was never written.
 *
 * ## Heights never wait
 *
 * The flat loader existed because "heights cannot stream" — the strip, trees, grass and car all
 * ask on the first frame and a missing height is a hole, not a coarser LOD. With a pyramid the
 * ROOT is small, always resident, and always answers. Finer tiles refine that answer as they
 * arrive. Nothing ever has to wait for one.
 */

export interface TileId {
  z: number
  x: number
  y: number
}

export const tileKey = (t: TileId): string => `${t.z}/${t.x}/${t.y}`

/** (w, s, e, n) in degrees — implicit in the id, which is the point of quadtree addressing. */
export function tileBoundsOf(z: number, x: number, y: number): { w: number; s: number; e: number; n: number } {
  const cols = 2 ** (z + 1)
  const rows = 2 ** z
  return {
    w: -180 + (x * 360) / cols,
    e: -180 + ((x + 1) * 360) / cols,
    n: 90 - (y * 180) / rows,
    s: 90 - ((y + 1) * 180) / rows,
  }
}

export const childrenOf = (t: TileId): TileId[] => [
  { z: t.z + 1, x: t.x * 2, y: t.y * 2 },
  { z: t.z + 1, x: t.x * 2 + 1, y: t.y * 2 },
  { z: t.z + 1, x: t.x * 2, y: t.y * 2 + 1 },
  { z: t.z + 1, x: t.x * 2 + 1, y: t.y * 2 + 1 },
]

export const parentOf = (t: TileId): TileId | null =>
  t.z === 0 ? null : { z: t.z - 1, x: t.x >> 1, y: t.y >> 1 }

/** Metres per tile edge at a latitude — east-west shrinks with cos(lat), north-south does not. */
export function tileMetres(z: number, lat: number): { ew: number; ns: number } {
  return {
    ew: (360 / 2 ** (z + 1)) * 111_320 * Math.cos((lat * Math.PI) / 180),
    ns: (180 / 2 ** z) * 111_320,
  }
}

export interface WantOpts {
  /** the camera, in the same ENU metres the tiles are placed in */
  eye: { x: number; z: number }
  /** how many metres of tile may map to one screen pixel before it must subdivide */
  metresPerPixel: (distance: number) => number
  /** hard ceiling on the wanted set, so a pathological view cannot ask for the world */
  maxTiles?: number
  /** does this tile exist in the bake? a quad is only split when all four are present */
  has: (t: TileId) => boolean
  /** ENU position of a tile's centre and its half-diagonal, for the distance term */
  place: (t: TileId) => { x: number; z: number; radius: number }
}

/**
 * The tiles to draw: the leaves of a strict child-replaces-parent walk from `roots`.
 *
 * Screen-space error, not raw distance. A tile is acceptable when its own ground sample distance
 * is finer than what a pixel covers at that range — so the same code gives more detail to a
 * long-lens view and less to a wide one, and the ring falls out rather than being tuned.
 */
export function wanted(roots: TileId[], opts: WantOpts, zmax: number): TileId[] {
  const { eye, metresPerPixel, has, place } = opts
  const cap = opts.maxTiles ?? 512
  const out: TileId[] = []
  const stack = [...roots]
  while (stack.length) {
    const t = stack.pop()!
    if (out.length >= cap) break
    if (t.z >= zmax) {
      out.push(t)
      continue
    }
    const p = place(t)
    const d = Math.max(1, Math.hypot(p.x - eye.x, p.z - eye.z) - p.radius)
    // this tile's own ground sample distance: its edge divided by the raster it carries
    const gsd = (p.radius * 2) / Math.SQRT2 / 512
    if (gsd <= metresPerPixel(d)) {
      out.push(t)
      continue
    }
    const kids = childrenOf(t)
    // STRICT: all four, or none. A partial quad would leave a hole where the missing child is,
    // and the parent can no longer cover it once a sibling has replaced part of its area.
    if (kids.every(has)) stack.push(...kids)
    else out.push(t)
  }
  return out
}

/**
 * What to load and what to drop, given what is wanted and what is held.
 *
 * Eviction is farthest-first and bounded by BYTES rather than tile count, because a tile's cost
 * depends on what it carries — a compressed texture is eight times cheaper than a decoded one, so
 * a count is a proxy that silently means different things.
 */
export function diff(
  want: TileId[],
  held: Map<string, { bytes: number; dist: number }>,
  budgetBytes: number,
): { load: TileId[]; drop: string[] } {
  const wantKeys = new Set(want.map(tileKey))
  const load = want.filter((t) => !held.has(tileKey(t)))
  const drop: string[] = []
  let total = 0
  for (const [, v] of held) total += v.bytes
  // anything no longer wanted goes first, then the farthest, until the budget is met
  const spare = [...held.entries()].filter(([k]) => !wantKeys.has(k)).sort((a, b) => b[1].dist - a[1].dist)
  for (const [k, v] of spare) {
    drop.push(k)
    total -= v.bytes
  }
  if (total > budgetBytes) {
    const rest = [...held.entries()]
      .filter(([k]) => wantKeys.has(k))
      .sort((a, b) => b[1].dist - a[1].dist)
    for (const [k, v] of rest) {
      if (total <= budgetBytes) break
      drop.push(k)
      total -= v.bytes
    }
  }
  return { load, drop }
}

/**
 * The 2x2 geodetic control lattice for a quadtree tile.
 *
 * The UTM tiles need a 9x9 lattice because a UTM square is a curved quadrilateral in lon/lat and
 * 2x2 leaves 1179 mm of bilinear error. A quadtree tile IS a lon/lat rectangle, so interpolating
 * lon linearly in u and lat linearly in v is not an approximation of the right answer — it is the
 * right answer, to float64. Four corners, no lattice in the manifest, nothing to keep in step.
 *
 * Rows run south to north and columns west to east, matching `Frame.control_lattice`.
 */
export function latticeFor(z: number, x: number, y: number): { n: number; lon: number[]; lat: number[] } {
  const b = tileBoundsOf(z, x, y)
  return { n: 2, lon: [b.w, b.e, b.w, b.e], lat: [b.s, b.s, b.n, b.n] }
}
