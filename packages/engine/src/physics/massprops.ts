// What a thing weighs, worked out from its own geometry.
//
// Rich, 2026-09-29: "street signs and stop signs should detach using real physics, try to use their
// geometry to approximate weight".
//
// THE ALTERNATIVE IS A TABLE OF GUESSES, and this codebase has a rule about that — four hand-typed
// width tables are why things kept ending up in the road. A sign's mass is not a matter of opinion:
// it is the volume of aluminium in the face plus the volume of steel in the post, and both of those
// are in the mesh already. So the only judgement left is WHAT IT IS MADE OF, which is one word per
// prop rather than a number per prop, and a word is much harder to get quietly wrong than a number.
//
// WHAT IT COMPUTES, and all of it in one pass over the triangles:
//
//   volume        the signed volume, by the divergence theorem.
//   centre of mass where it balances — which for a sign on a post is near the bottom, and is the
//                 difference between one that topples and one that helicopters.
//   inertia       the full tensor, so a detached sign tumbles like a flat plate rather than like a
//                 ball. Rapier wants principal moments and a frame; `principalInertia` does the
//                 eigendecomposition.
//
// THE METHOD is the tetrahedron decomposition (Blow & Binstock): every triangle forms a tet with the
// origin, each tet's contribution is exact, and the signed sum cancels whatever is outside the
// surface.
//
// FEED IT LOCAL COORDINATES, NOT WORLD ONES. Every tet is measured from the ORIGIN, so a shape a
// kilometre away accumulates terms of order distance² and then subtracts almost all of them again to
// get back to the centre of mass. Measured: the same 0.6 × 2.4 × 0.1 m box at the origin and at
// (900, 12, −400) agree on their inertia to about **two parts in ten thousand** — fine for a sign,
// and it degrades with distance. A corridor site is a kilometre across, so this is a real hazard;
// a prop's own geometry is already near its own origin, and keeping it that way avoids it entirely. It needs a CLOSED, consistently-wound mesh — an open shell gives a volume that depends on
// where the origin happens to be, which is why `massProperties` reports the volume it found and lets
// the caller decide whether to believe it. A negative volume means the winding is inside out, which
// is a fact worth knowing rather than an error worth hiding.

/** kg/m³. The materials the street is actually made of. */
export const DENSITY = {
  /** sign faces, light gantries */
  aluminium: 2700,
  /** posts, masts, guard rail */
  steel: 7850,
  /** power poles, fence rails */
  timber: 640,
  /** kerbs, bases, barriers */
  concrete: 2400,
  glass: 2500,
  plastic: 950,
  /** a building's massing is mostly air: floors, walls and a great deal of nothing */
  building: 350,
  /** a living trunk, green */
  wood: 900,
} as const

export type Material = keyof typeof DENSITY

export interface MassProperties {
  /** m³. Negative means the winding is inside out; near zero means the mesh is not closed */
  volume: number
  /** kg, at the density asked for */
  mass: number
  /** where it balances, in the geometry's own frame */
  com: { x: number; y: number; z: number }
  /**
   * The inertia tensor about the centre of mass, kg·m², row-major 3×3.
   *
   * Symmetric, so only six of the nine are independent — it is returned whole because that is what
   * the eigensolver wants and because reconstructing it from six numbers at three call sites is
   * three chances to transpose it.
   */
  inertia: number[]
  /** how many triangles went into it */
  triangles: number
}

/**
 * Mass properties of a triangle soup.
 *
 * `positions` is x,y,z per vertex; `index` is triples into it, or absent for an unindexed soup.
 * Everything is in the geometry's own units and frame — scale the result yourself if the mesh is
 * drawn scaled, because a mesh's world matrix is not something this function can see.
 */
export function massProperties(positions: ArrayLike<number>, index: ArrayLike<number> | null | undefined, density: number = DENSITY.steel): MassProperties {
  // The canonical covariance of the unit tetrahedron (0, e1, e2, e3), from Blow & Binstock. Every
  // tet's contribution is `det(A) · A · C · Aᵀ`, which is why this constant is the whole method.
  const C = [2, 1, 1, 1, 2, 1, 1, 1, 2]
  let volume = 0
  let cx = 0, cy = 0, cz = 0
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  const n = index ? index.length : positions.length / 3
  let triangles = 0

  for (let t = 0; t + 2 < n; t += 3) {
    const i0 = (index ? index[t] : t) * 3
    const i1 = (index ? index[t + 1] : t + 1) * 3
    const i2 = (index ? index[t + 2] : t + 2) * 3
    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2]
    const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2]
    const gx = positions[i2], gy = positions[i2 + 1], gz = positions[i2 + 2]

    // det of the matrix whose columns are the three vertices: six times the tet's signed volume
    const det = ax * (by * gz - bz * gy) - ay * (bx * gz - bz * gx) + az * (bx * gy - by * gx)
    const v = det / 6
    volume += v
    // the tet's own centroid is a quarter of the way along each vertex from the origin
    cx += v * (ax + bx + gx) / 4
    cy += v * (ay + by + gy) / 4
    cz += v * (az + bz + gz) / 4

    // A · C · Aᵀ · det, accumulated. A's columns are the three vertices.
    const A = [ax, bx, gx, ay, by, gy, az, bz, gz]
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let k = 0; k < 3; k++) {
          for (let l = 0; l < 3; l++) sum += A[r * 3 + k] * C[k * 3 + l] * A[c * 3 + l]
        }
        cov[r * 3 + c] += (det / 120) * sum
      }
    }
    triangles++
  }

  const com = volume !== 0
    ? { x: cx / volume, y: cy / volume, z: cz / volume }
    : { x: 0, y: 0, z: 0 }

  // Shift the covariance to the centre of mass (parallel axis, on the covariance rather than on the
  // inertia — doing it the other way round is where the sign errors live).
  const m = Math.abs(volume) * density
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      cov[r * 3 + c] -= volume * [com.x, com.y, com.z][r] * [com.x, com.y, com.z][c]
    }
  }
  // I = trace(C)·Id − C, scaled by density. The covariance is in volume units; density makes it mass.
  const trace = cov[0] + cov[4] + cov[8]
  const inertia = new Array(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      inertia[r * 3 + c] = density * ((r === c ? trace : 0) - cov[r * 3 + c])
    }
  }

  return { volume, mass: m, com, inertia, triangles }
}

/**
 * The principal moments and the frame they are in, for Rapier's `setMassProperties`.
 *
 * Jacobi rotation on a symmetric 3×3 — small, exact enough in a handful of sweeps, and the only
 * honest way to hand Rapier an inertia for a shape that is not aligned with its own axes. A sign
 * plate on a post is nearly aligned and would survive taking the diagonal; an excavator arm is not.
 *
 * Returns the moments and the rotation as a quaternion, which is the form Rapier asks for.
 */
export function principalInertia(inertia: number[]): { moments: { x: number; y: number; z: number }; frame: { x: number; y: number; z: number; w: number } } {
  const a = inertia.slice()
  // the accumulated rotation, as a matrix; turned into a quaternion at the end
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = a[1] * a[1] + a[2] * a[2] * 1 + a[5] * a[5]
    if (off < 1e-18) break
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q]
      if (Math.abs(apq) < 1e-20) continue
      const app = a[p * 3 + p]
      const aqq = a[q * 3 + q]
      const theta = (aqq - app) / (2 * apq)
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p]
        const akq = a[k * 3 + q]
        a[k * 3 + p] = c * akp - s * akq
        a[k * 3 + q] = s * akp + c * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k]
        const aqk = a[q * 3 + k]
        a[p * 3 + k] = c * apk - s * aqk
        a[q * 3 + k] = s * apk + c * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p]
        const vkq = v[k * 3 + q]
        v[k * 3 + p] = c * vkp - s * vkq
        v[k * 3 + q] = s * vkp + c * vkq
      }
    }
  }
  return { moments: { x: a[0], y: a[4], z: a[8] }, frame: quatFromMatrix(v) }
}

/** A rotation matrix (row-major 3×3) as a quaternion. */
function quatFromMatrix(m: number[]): { x: number; y: number; z: number; w: number } {
  const tr = m[0] + m[4] + m[8]
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    return { w: s / 4, x: (m[7] - m[5]) / s, y: (m[2] - m[6]) / s, z: (m[3] - m[1]) / s }
  }
  if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2
    return { w: (m[7] - m[5]) / s, x: s / 4, y: (m[1] + m[3]) / s, z: (m[2] + m[6]) / s }
  }
  if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2
    return { w: (m[2] - m[6]) / s, x: (m[1] + m[3]) / s, y: s / 4, z: (m[5] + m[7]) / s }
  }
  const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2
  return { w: (m[3] - m[1]) / s, x: (m[2] + m[6]) / s, y: (m[5] + m[7]) / s, z: s / 4 }
}

/**
 * Mass from geometry, with the checks that stop a wrong answer being used.
 *
 * A mesh that is not closed — a sign FACE is often a single quad, which encloses no volume at all —
 * gives a volume near zero and therefore a mass near zero, and a 0.0 kg stop sign is a stop sign
 * that is fired into orbit by a bicycle. So an open or inside-out mesh falls back to the bounding
 * box times a fill fraction, and SAYS which it did, so a caller can put it on screen rather than
 * discover it in play.
 *
 * `solidity` IS THE ONE JUDGEMENT GEOMETRY CANNOT MAKE, and it applies on both paths.
 *
 * A drawn sign post is a solid box; a real one is a square tube with a two-millimetre wall, or a
 * U-channel. The mesh gives the ENVELOPE, and the envelope of 60 mm steel over 2.4 m is 68 kg of
 * solid bar — about five times what the post on the corner actually weighs. So the caller says how
 * much of the envelope is metal: 1 for a wall or a kerb, ~0.2 for a tube post, ~0.1 for a lattice
 * mast, ~0.05 for a building's massing.
 *
 * That is still one number per KIND of prop rather than per prop, which is the whole point — a word
 * and a fraction are far harder to get quietly wrong than a mass, and they do not have to be
 * re-derived every time somebody changes a model.
 */
export function estimateMass(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null | undefined,
  material: Material,
  opts: { solidity?: number; minKg?: number } = {},
): { kg: number; from: 'volume' | 'bounds'; volume: number; com: { x: number; y: number; z: number } } {
  const density = DENSITY[material]
  const p = massProperties(positions, index, density)
  const bounds = boundsOf(positions)
  const boxVolume = bounds.size.x * bounds.size.y * bounds.size.z
  // Believe the mesh volume only when it is positive AND a believable share of the box it sits in.
  // A closed shape cannot enclose more than its own bounding box, and a shell whose winding is
  // inconsistent produces small positive volumes that look plausible and are not.
  const believable = p.volume > 0 && boxVolume > 0 && p.volume <= boxVolume * 1.01 && p.volume >= boxVolume * 0.001
  const solidity = opts.solidity ?? 1
  /*
   * ONE factor, not two. The fallback used to halve the bounding box AND then apply `solidity`,
   * which meant a caller who calibrated `solidity` against a measured envelope got half the mass it
   * had worked out — and the only way to find that is to notice the answer is exactly 2× wrong.
   * `solidity` is THE fraction of the envelope that is material; nothing else scales it.
   */
  const kg = (believable ? p.volume : boxVolume) * solidity * density
  return {
    kg: Math.max(opts.minKg ?? 0.5, kg),
    from: believable ? 'volume' : 'bounds',
    volume: p.volume,
    com: believable ? p.com : bounds.centre,
  }
}

/** Axis-aligned bounds of a vertex array, and its centre. */
export function boundsOf(positions: ArrayLike<number>): { min: { x: number; y: number; z: number }; size: { x: number; y: number; z: number }; centre: { x: number; y: number; z: number } } {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minX)) return { min: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 }, centre: { x: 0, y: 0, z: 0 } }
  return {
    min: { x: minX, y: minY, z: minZ },
    size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
  }
}
