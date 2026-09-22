/**
 * Placing a raster on the ellipsoid, and finding your way back into it.
 *
 * A baked raster is a regular grid on whatever plane the pipeline projected it onto — UTM, today.
 * The viewer renders in a local ENU tangent frame, where that grid is rotated by the meridian
 * convergence (1.06 deg at Crofton, and a different amount at every site), scaled by the
 * projection's scale factor, and curved over the ellipsoid. So a raster cannot be placed from its
 * bounding box, and — the half that is easy to miss — it cannot be SAMPLED from one either.
 *
 * Both directions are needed:
 *
 *   forward   grid (col, row) -> ENU metres.   Builds the terrain mesh. Curvature falls out.
 *   inverse   ENU metres -> grid (col, row).   Every height and canopy lookup in the viewer;
 *                                              the road strip sits on the ground through it.
 *
 * The forward map is bilinear interpolation of the bake's geodetic control lattice followed by the
 * exact ellipsoid transform. The inverse starts from an affine fit of the lattice and refines with
 * Newton steps against the forward map, so it is exact to the forward map's own error rather than
 * to the affine's — the affine alone is metres out at site scale, which would have the road
 * sampling ground a couple of cells from where it stands.
 */
import { Anchor, type Geodetic } from './wgs84'

export interface LatticeSpec {
  /** lattice order: n*n samples, rows SOUTH->NORTH, columns WEST->EAST */
  n: number
  lon: number[]
  lat: number[]
}

/** The raster's own shape: `size` is [cols, rows], row 0 at the NORTH edge (image order). */
export interface RasterSpec {
  size: [number, number]
  geo: LatticeSpec
}

export class RasterFrame {
  readonly cols: number
  readonly rows: number
  private readonly n: number
  private readonly lon: number[]
  private readonly lat: number[]
  private readonly anchor: Anchor
  /**
   * The lattice points' own ENU positions, precomputed: [e0, n0, e1, n1, ...].
   *
   * `toGrid` runs in the hot path — every height and canopy lookup in the viewer, several times a
   * vertex while the road strips are built — and the first version iterated Newton against the
   * EXACT forward map, about nine geodetic transforms a call. It hung the build at "grading 1/427
   * streets". Over a raster the ENU surface is very nearly a bilinear patch on these points, so
   * the inverse iterates against THAT instead: four lerps and an analytic Jacobian, no
   * transcendentals at all, converging to the lattice's own accuracy.
   */
  private readonly enu: Float64Array
  /** affine ENU->grid seed for the inverse: [a, b, c, d, e, f] with u = a*x + b*y + c etc. */
  private readonly inv: number[]

  constructor(spec: RasterSpec, anchor: Anchor) {
    this.cols = spec.size[0]
    this.rows = spec.size[1]
    this.n = spec.geo.n
    this.lon = spec.geo.lon
    this.lat = spec.geo.lat
    this.anchor = anchor
    const n = this.n
    this.enu = new Float64Array(n * n * 2)
    const p: number[] = [0, 0, 0]
    for (let k = 0; k < n * n; k++) {
      anchor.toLocal(this.lon[k], this.lat[k], 0, p)
      this.enu[k * 2] = p[0]
      this.enu[k * 2 + 1] = p[1]
    }
    this.inv = this.fitInverse()
  }

  /**
   * Fractional grid position -> geodetic, by bilinear interpolation of the lattice.
   *
   * `u` runs 0..1 west to east, `v` runs 0..1 NORTH to SOUTH — image order, matching `size` and
   * the pixel indices — while the lattice rows run south to north, hence the flip.
   */
  geodeticAt(u: number, v: number): Geodetic {
    const n = this.n
    const fu = Math.min(n - 1, Math.max(0, u * (n - 1)))
    const fv = Math.min(n - 1, Math.max(0, (1 - v) * (n - 1)))
    const j0 = Math.min(n - 2, Math.floor(fu))
    const i0 = Math.min(n - 2, Math.floor(fv))
    const tu = fu - j0
    const tv = fv - i0
    const a = i0 * n + j0
    const b = a + 1
    const c = a + n
    const d = c + 1
    const w0 = (1 - tv) * (1 - tu)
    const w1 = (1 - tv) * tu
    const w2 = tv * (1 - tu)
    const w3 = tv * tu
    return {
      lon: this.lon[a] * w0 + this.lon[b] * w1 + this.lon[c] * w2 + this.lon[d] * w3,
      lat: this.lat[a] * w0 + this.lat[b] * w1 + this.lat[c] * w2 + this.lat[d] * w3,
      h: 0,
    }
  }

  /** Fractional grid position + height above the ellipsoid -> ENU metres about the anchor. */
  toEnu(u: number, v: number, h: number, out: number[] | Float64Array | Float32Array = [0, 0, 0], o = 0): typeof out {
    const g = this.geodeticAt(u, v)
    return this.anchor.toLocal(g.lon, g.lat, h, out, o)
  }

  /**
   * A least-squares affine taking ENU (east, north) to fractional grid (u, v).
   *
   * Only the seed for `toGrid`. A rigid/affine fit cannot represent a conformal projection's
   * distortion — measured over a 50 km box the best rigid fit still leaves 2.42 m — so it is
   * refined, never trusted on its own.
   */
  private fitInverse(): number[] {
    const n = this.n
    // normal equations for [x, y, 1] -> u and -> v
    const A = new Float64Array(9)
    const bu = new Float64Array(3)
    const bv = new Float64Array(3)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const k = i * n + j
        const row = [this.enu[k * 2], this.enu[k * 2 + 1], 1]
        const u = j / (n - 1)
        const v = 1 - i / (n - 1) // lattice row i is south->north; v is north->south
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) A[r * 3 + c] += row[r] * row[c]
          bu[r] += row[r] * u
          bv[r] += row[r] * v
        }
      }
    }
    return [...solve3(A, bu), ...solve3(A, bv)]
  }

  /**
   * ENU metres -> fractional grid (u, v), clamped to the raster.
   *
   * Affine seed, then Newton steps on the forward map. Two iterations take it to the forward
   * map's own accuracy; the Jacobian is finite-differenced because the forward map is a bilinear
   * patch composed with the ellipsoid and writing its derivative by hand buys nothing.
   */
  /**
   * The ENU position of the lattice's bilinear patch at grid (u, v), plus its derivatives.
   *
   * This is the model `toGrid` inverts. It is not the exact forward map — that composes the
   * lattice with the ellipsoid — but over a raster the two differ by the lattice's own
   * interpolation error, and it costs four lerps rather than a geodetic transform.
   */
  private patch(u: number, v: number, out: number[]): void {
    const n = this.n
    const fu = u <= 0 ? 0 : u >= 1 ? n - 1 : u * (n - 1)
    const fv = v <= 0 ? n - 1 : v >= 1 ? 0 : (1 - v) * (n - 1)
    const j0 = Math.min(n - 2, Math.floor(fu))
    const i0 = Math.min(n - 2, Math.floor(fv))
    const tu = fu - j0
    const tv = fv - i0
    const a = (i0 * n + j0) * 2
    const b = a + 2
    const c = a + n * 2
    const d = c + 2
    const E = this.enu
    // value
    out[0] = (1 - tv) * ((1 - tu) * E[a] + tu * E[b]) + tv * ((1 - tu) * E[c] + tu * E[d])
    out[1] = (1 - tv) * ((1 - tu) * E[a + 1] + tu * E[b + 1]) + tv * ((1 - tu) * E[c + 1] + tu * E[d + 1])
    // d/du and d/dv, analytic — a bilinear patch has no need of a finite difference. The chain
    // rule brings in (n-1) for u and -(n-1) for v, because v runs north->south.
    const k = n - 1
    out[2] = ((1 - tv) * (E[b] - E[a]) + tv * (E[d] - E[c])) * k
    out[3] = ((1 - tv) * (E[b + 1] - E[a + 1]) + tv * (E[d + 1] - E[c + 1])) * k
    out[4] = ((1 - tu) * (E[c] - E[a]) + tu * (E[d] - E[b])) * -k
    out[5] = ((1 - tu) * (E[c + 1] - E[a + 1]) + tu * (E[d + 1] - E[b + 1])) * -k
  }

  /**
   * ENU metres -> NORMALISED grid position (u, v in 0..1), **clamped to the raster**.
   *
   * Two things about this signature have cost other lanes a round each, so they are stated plainly:
   *
   * - the result is NORMALISED, not cell units, despite the name. `indexAt` is what multiplies by
   *   `cols`/`rows`.
   * - it CLAMPS. A point outside the raster comes back pinned to the nearest edge, so this cannot
   *   be used to ask "is this point inside?" — every point looks inside. Use `contains`. On a
   *   tiled site the wrong answer is that every height comes from whichever tile the index
   *   happened to list first, and it looks entirely plausible.
   *
   * Affine seed, then Newton on the bilinear patch with its analytic Jacobian. No trigonometry, no
   * finite differences, and it converges in two passes because the patch is very nearly affine
   * within one lattice cell.
   */
  toGrid(x: number, z: number, out: [number, number] = [0, 0]): [number, number] {
    const [a, b, c, d, e, f] = this.inv
    const clamp = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t)
    let u = clamp(a * x + b * z + c)
    let v = clamp(d * x + e * z + f)
    const P = SCRATCH6
    for (let it = 0; it < 2; it++) {
      this.patch(u, v, P)
      const rx = P[0] - x
      const rz = P[1] - z
      const det = P[2] * P[5] - P[4] * P[3]
      if (!det) break
      u = clamp(u - (rx * P[5] - rz * P[4]) / det)
      v = clamp(v - (rz * P[2] - rx * P[3]) / det)
    }
    out[0] = u
    out[1] = v
    return out
  }

  /**
   * Is this ENU point actually inside the raster?
   *
   * `toGrid` clamps, so it cannot answer this — asking it is the trap. The honest test is whether
   * the clamped answer still maps BACK to where you asked: if the point was outside, the clamp
   * moved it, and the round trip lands somewhere else. `slackM` is how far outside still counts as
   * in, which matters on a tiled site where neighbouring tiles should overlap rather than leave a
   * seam of nothing.
   */
  contains(x: number, z: number, slackM = 0): boolean {
    const g = this.toGrid(x, z)
    const p = SCRATCH6
    this.patch(g[0], g[1], p)
    return Math.hypot(p[0] - x, p[1] - z) <= slackM + 1e-6
  }

  /** ENU metres -> nearest cell index into the raster's data array. */
  indexAt(x: number, z: number): number {
    const g = this.toGrid(x, z)
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(g[0] * this.cols)))
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(g[1] * this.rows)))
    return r * this.cols + c
  }
}

/** one shared scratch for `patch` — `toGrid` runs hundreds of thousands of times a load */
const SCRATCH6: number[] = [0, 0, 0, 0, 0, 0]

/** Solve a symmetric 3x3 by Gaussian elimination with partial pivoting. */
function solve3(A: Float64Array, b: Float64Array): number[] {
  const m = [
    [A[0], A[1], A[2], b[0]],
    [A[3], A[4], A[5], b[1]],
    [A[6], A[7], A[8], b[2]],
  ]
  for (let i = 0; i < 3; i++) {
    let piv = i
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[piv][i])) piv = r
    if (piv !== i) [m[i], m[piv]] = [m[piv], m[i]]
    if (!m[i][i]) return [0, 0, 0]
    for (let r = 0; r < 3; r++) {
      if (r === i) continue
      const k = m[r][i] / m[i][i]
      for (let c = i; c < 4; c++) m[r][c] -= k * m[i][c]
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]]
}
