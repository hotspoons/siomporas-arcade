/**
 * WGS84 geodesy — the authoritative frame for everything that stands on the Earth.
 *
 * NO THREE, NO DOM, so a worker can import it without dragging in the renderer. Every function
 * here is float64 (plain JS numbers); float32 only ever appears at the end, in a vertex buffer,
 * and only for coordinates that have already been made RELATIVE to a nearby origin.
 *
 * ## Why this exists
 *
 * Corridor stored its world as UTM metres minus a per-site origin. That is a plane: it has no
 * curvature and it has projection scale error, so two things were true at once — a site could
 * never be stitched to its neighbour, and the far field was wrong. Measured against the ellipsoid,
 * the drop `d²/2R` a flat plane fails to represent is 0.08 m at 1 km, 5.67 m across
 * crofton-triangle's 8.5 km span, and 70.63 m at the 30 km horizon rim, which is why distant
 * terrain sits visibly too high.
 *
 * trailworks already solved the storage half of this: `viewer/src/render/geoMath.ts` is a WGS84
 * ellipsoid globe with a geographic quadtree. The constants and the ECEF transform here are the
 * same, deliberately, so the two can share a frame and eventually this module.
 *
 * ## Why NOT absolute ECEF, which is what trailworks renders in
 *
 * trailworks is a terrain viewer seen from altitude; corridor is a driving game with the camera
 * 1.5 m off the deck looking at 0.1 m lane markings. three.js vertex buffers are float32, and
 * float32 spacing at ECEF magnitude (6.4e6 m) is **0.256 m** — the road would visibly swim.
 * Measured, not estimated: see `test/wgs84.test.ts`.
 *
 * So the authoritative frame is geodetic, and the RENDER frame is a local ENU tangent frame at a
 * floating origin. Within ~30 km of that origin float32 gives millimetres. Curvature is not
 * approximated or added as a correction — it falls out of the geodetic → ECEF → ENU path, because
 * a point 8.5 km away genuinely is 5.67 m below the tangent plane.
 *
 * ## Axis conventions
 *
 *   ECEF   X through (0°E, 0°N), Y through (90°E, 0°N), Z through the north pole. Right-handed.
 *   ENU    east, north, up at the anchor. Right-handed.
 *   world  three.js: (x, y, z) = (east, up, -north).
 *
 * That last mapping is what corridor already used (`toWorld = (x, y, z) => (x, z, -y)`), so
 * nothing downstream changes its idea of which way is up. Only the derivation of the ENU metres
 * changes — from "UTM minus an origin" to a true tangent frame.
 */

/** equatorial radius, m (WGS84 defining constant) */
export const WGS84_A = 6378137.0
/** flattening (WGS84 defining constant) */
export const WGS84_F = 1 / 298.257223563
/** polar radius, m — derived, = 6356752.314245179; trailworks hardcodes 6356752.314245 */
export const WGS84_B = WGS84_A * (1 - WGS84_F)
/** first eccentricity squared */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F)
/** second eccentricity squared, for Bowring's latitude */
const EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B)

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

export type Vec3 = [number, number, number]

/** Geodetic position: degrees east, degrees north, metres above the ellipsoid. */
export interface Geodetic {
  lon: number
  lat: number
  h: number
}

/**
 * Geodetic → ECEF. Exact (closed form), float64.
 *
 * `out`/`o` let a caller fill a big Float64Array without allocating per point; the hot paths
 * (a tile's worth of terrain vertices) go through this hundreds of thousands of times.
 */
export function geodeticToEcef(lon: number, lat: number, h: number, out: number[] | Float64Array = [0, 0, 0], o = 0): typeof out {
  const la = lat * DEG
  const lo = lon * DEG
  const sl = Math.sin(la)
  const cl = Math.cos(la)
  // N: radius of curvature in the prime vertical
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl)
  out[o] = (N + h) * cl * Math.cos(lo)
  out[o + 1] = (N + h) * cl * Math.sin(lo)
  out[o + 2] = (N * (1 - WGS84_E2) + h) * sl
  return out
}

/**
 * ECEF → geodetic, by Bowring's method with one refinement.
 *
 * Bowring is closed-form and converges to well under a micrometre for anything within a few
 * thousand km of the surface, which is every case we have. The iterative alternative buys nothing
 * here and costs a loop. The poles are handled by falling back to the axis directly — `p` going to
 * zero is the only place the formula degenerates.
 */
export function ecefToGeodetic(x: number, y: number, z: number): Geodetic {
  const p = Math.hypot(x, y)
  const lon = Math.atan2(y, x) * RAD
  if (p < 1e-9) {
    // on the spin axis: latitude is ±90 and longitude is undefined (report 0)
    const sign = z >= 0 ? 1 : -1
    return { lon: 0, lat: sign * 90, h: Math.abs(z) - WGS84_B }
  }
  // Bowring's parametric latitude
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B)
  const st = Math.sin(theta)
  const ct = Math.cos(theta)
  const lat = Math.atan2(z + EP2 * WGS84_B * st * st * st, p - WGS84_E2 * WGS84_A * ct * ct * ct)
  const sl = Math.sin(lat)
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl)
  const h = p / Math.cos(lat) - N
  return { lon, lat: lat * RAD, h }
}

/**
 * The ENU basis at a geodetic point, as three ECEF unit vectors.
 *
 * These are the rows of the rotation that takes an ECEF delta into local east/north/up. They
 * depend only on lon/lat — height does not tilt the horizon.
 */
export function enuBasis(lon: number, lat: number): { east: Vec3; north: Vec3; up: Vec3 } {
  const la = lat * DEG
  const lo = lon * DEG
  const sla = Math.sin(la)
  const cla = Math.cos(la)
  const slo = Math.sin(lo)
  const clo = Math.cos(lo)
  return {
    east: [-slo, clo, 0],
    north: [-sla * clo, -sla * slo, cla],
    up: [cla * clo, cla * slo, sla],
  }
}

/**
 * A local tangent frame: an explicit geodetic anchor, and the exact transform to and from local
 * east/north/up metres about it.
 *
 * This is the thing a render origin IS. Rebasing means building a new Anchor and asking the old
 * one where it now sits (`Anchor.delta`) — the authoritative geodetic data never moves, only the
 * origin the float32 buffers are measured from.
 */
export class Anchor {
  readonly lon: number
  readonly lat: number
  readonly h: number
  /** the anchor's own ECEF position */
  readonly ecef: Vec3
  private readonly e: Vec3
  private readonly n: Vec3
  private readonly u: Vec3

  constructor(lon: number, lat: number, h = 0) {
    this.lon = lon
    this.lat = lat
    this.h = h
    this.ecef = geodeticToEcef(lon, lat, h) as Vec3
    const b = enuBasis(lon, lat)
    this.e = b.east
    this.n = b.north
    this.u = b.up
  }

  /** ECEF → local ENU metres about this anchor. */
  ecefToLocal(x: number, y: number, z: number, out: number[] | Float64Array | Float32Array = [0, 0, 0], o = 0): typeof out {
    const dx = x - this.ecef[0]
    const dy = y - this.ecef[1]
    const dz = z - this.ecef[2]
    out[o] = this.e[0] * dx + this.e[1] * dy + this.e[2] * dz
    out[o + 1] = this.n[0] * dx + this.n[1] * dy + this.n[2] * dz
    out[o + 2] = this.u[0] * dx + this.u[1] * dy + this.u[2] * dz
    return out
  }

  /** local ENU metres → ECEF. */
  localToEcef(e: number, n: number, u: number, out: number[] | Float64Array = [0, 0, 0], o = 0): typeof out {
    out[o] = this.ecef[0] + this.e[0] * e + this.n[0] * n + this.u[0] * u
    out[o + 1] = this.ecef[1] + this.e[1] * e + this.n[1] * n + this.u[1] * u
    out[o + 2] = this.ecef[2] + this.e[2] * e + this.n[2] * n + this.u[2] * u
    return out
  }

  /** geodetic → local ENU metres. The whole point: this is where curvature enters. */
  toLocal(lon: number, lat: number, h = 0, out: number[] | Float64Array | Float32Array = [0, 0, 0], o = 0): typeof out {
    const p = geodeticToEcef(lon, lat, h, SCRATCH)
    return this.ecefToLocal(p[0], p[1], p[2], out, o)
  }

  /** local ENU metres → geodetic. */
  toGeodetic(e: number, n: number, u: number): Geodetic {
    const p = this.localToEcef(e, n, u, SCRATCH)
    return ecefToGeodetic(p[0], p[1], p[2])
  }

  /**
   * Where `other`'s origin sits in THIS anchor's local metres.
   *
   * Rebasing the render origin is: `const shift = oldAnchor.delta(newAnchor)`, then every retained
   * object moves by `-shift` and the new anchor becomes the origin. Note this is a translation
   * only — the two frames are also ROTATED relative to each other by the angle subtended at the
   * centre of the Earth (about 0.009° per km), so a rebase over any real distance must rotate too.
   * `deltaRotation` gives that part.
   */
  delta(other: Anchor): Vec3 {
    return this.ecefToLocal(other.ecef[0], other.ecef[1], other.ecef[2]) as Vec3
  }

  /**
   * The 3×3 rotation (row-major, ENU-of-this → ENU-of-other) between two anchors' tangent frames.
   *
   * Over a kilometre this is a 0.009° tilt. It is negligible for a single site and is exactly what
   * makes a continuous world curve, so it is not optional once the origin moves.
   */
  deltaRotation(other: Anchor): number[] {
    const A = [this.e, this.n, this.u]
    const B = [other.e, other.n, other.u]
    const m: number[] = []
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m.push(B[r][0] * A[c][0] + B[r][1] * A[c][1] + B[r][2] * A[c][2])
    return m
  }
}

/** shared scratch so the composed transforms do not allocate per point */
const SCRATCH: Float64Array = new Float64Array(3)

/**
 * Geographic quadtree tile bounds — the same scheme as trailworks `globe_tiles.tile_bounds` and
 * `geoMath.tileBoundsRaw`, so the two projects address the world with the same ids.
 *
 * Level z has 2^(z+1) columns of longitude and 2^z rows of latitude, i.e. z=0 is two square-ish
 * hemispherical tiles rather than one 2:1 tile.
 */
export function tileBounds(z: number, x: number, y: number): { w: number; s: number; e: number; n: number } {
  const cols = 2 ** (z + 1)
  const rows = 2 ** z
  return {
    w: -180 + (x * 360) / cols,
    e: -180 + ((x + 1) * 360) / cols,
    n: 90 - (y * 180) / rows,
    s: 90 - ((y + 1) * 180) / rows,
  }
}

/** Which tile a geodetic point falls in at level `z`. */
export function tileOf(z: number, lon: number, lat: number): { z: number; x: number; y: number } {
  const cols = 2 ** (z + 1)
  const rows = 2 ** z
  const x = Math.min(cols - 1, Math.max(0, Math.floor(((lon + 180) / 360) * cols)))
  const y = Math.min(rows - 1, Math.max(0, Math.floor(((90 - lat) / 180) * rows)))
  return { z, x, y }
}

/**
 * The drop of the ellipsoid below the tangent plane at horizontal distance `d`.
 *
 * Not used by the transforms — they are exact — but it is the number to quote when someone asks
 * what a flat world was getting wrong, and the tests check the exact path against it.
 */
export function curvatureDrop(d: number, R = 6371008.8): number {
  return (d * d) / (2 * R)
}
