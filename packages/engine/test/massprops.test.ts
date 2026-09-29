// Mass from geometry: does it get the answers we already know?
//
// Every assertion here is against a shape whose mass properties are in a textbook, because that is
// the only way to know an integrator is right — a plausible number from a complicated mesh proves
// nothing at all. A unit box, a scaled box, an offset box and a sphere between them cover volume,
// centre of mass, the inertia tensor and the parallel-axis shift.

import { describe, expect, it } from 'vitest'
import { boundsOf, DENSITY, estimateMass, massProperties, principalInertia } from '../src/physics/massprops'

/** A closed, outward-wound box centred on `c` with half-extents `h`. */
function box(h = { x: 0.5, y: 0.5, z: 0.5 }, c = { x: 0, y: 0, z: 0 }) {
  const v = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ].map(([x, y, z]) => [c.x + x * h.x, c.y + y * h.y, c.z + z * h.z])
  const faces = [
    [0, 2, 1], [0, 3, 2], // -z
    [4, 5, 6], [4, 6, 7], // +z
    [0, 1, 5], [0, 5, 4], // -y
    [3, 7, 6], [3, 6, 2], // +y
    [0, 4, 7], [0, 7, 3], // -x
    [1, 2, 6], [1, 6, 5], // +x
  ]
  return { positions: v.flat(), index: faces.flat() }
}

/** A UV sphere, for a shape whose inertia is isotropic and known. */
function sphere(r = 1, seg = 48) {
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= seg; i++) {
    const phi = (i / seg) * Math.PI
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * Math.PI * 2
      pos.push(r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th))
    }
  }
  const row = seg + 1
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * row + j, b = a + row
      // wound outward. The first version had these reversed, which gave a NEGATIVE volume — and
      // the code was right to report it as negative rather than take the absolute value.
      idx.push(a, a + 1, b, a + 1, b + 1, b)
    }
  }
  return { positions: pos, index: idx }
}

describe('volume', () => {
  it('gets a unit box exactly right', () => {
    const { positions, index } = box()
    expect(massProperties(positions, index).volume).toBeCloseTo(1, 10)
  })

  it('scales with the box, in all three directions independently', () => {
    const { positions, index } = box({ x: 1, y: 0.25, z: 3 })
    // half-extents, so the box is 2 × 0.5 × 6
    expect(massProperties(positions, index).volume).toBeCloseTo(2 * 0.5 * 6, 10)
  })

  it('gets a sphere right to the accuracy of its own tessellation', () => {
    const { positions, index } = sphere(1.5, 64)
    const want = (4 / 3) * Math.PI * 1.5 ** 3
    expect(massProperties(positions, index).volume / want).toBeCloseTo(1, 2)
  })

  it('reports a NEGATIVE volume for an inside-out mesh rather than hiding it', () => {
    const { positions, index } = box()
    const flipped = []
    for (let i = 0; i < index.length; i += 3) flipped.push(index[i], index[i + 2], index[i + 1])
    expect(massProperties(positions, flipped).volume).toBeCloseTo(-1, 10)
  })
})

describe('centre of mass', () => {
  it('is the centre of a centred box, and moves with an offset one', () => {
    expect(massProperties(box().positions, box().index).com.x).toBeCloseTo(0, 10)
    const off = box({ x: 0.5, y: 0.5, z: 0.5 }, { x: 3, y: -2, z: 0.5 })
    const com = massProperties(off.positions, off.index).com
    expect(com.x).toBeCloseTo(3, 9)
    expect(com.y).toBeCloseTo(-2, 9)
    expect(com.z).toBeCloseTo(0.5, 9)
  })
})

describe('inertia', () => {
  it('matches the textbook box, about its own centre of mass', () => {
    // I = m/12 · (h² + d²) and so on round the axes
    const hx = 1, hy = 0.25, hz = 2 // half-extents → 2 × 0.5 × 4
    const { positions, index } = box({ x: hx, y: hy, z: hz })
    const density = DENSITY.steel
    const p = massProperties(positions, index, density)
    const w = 2 * hx, h = 2 * hy, d = 2 * hz
    const m = w * h * d * density
    expect(p.mass).toBeCloseTo(m, 6)
    expect(p.inertia[0]).toBeCloseTo((m / 12) * (h * h + d * d), 4)
    expect(p.inertia[4]).toBeCloseTo((m / 12) * (w * w + d * d), 4)
    expect(p.inertia[8]).toBeCloseTo((m / 12) * (w * w + h * h), 4)
    // and the off-diagonal terms of an axis-aligned box are zero
    for (const i of [1, 2, 3, 5, 6, 7]) expect(Math.abs(p.inertia[i])).toBeLessThan(1e-6)
  })

  it('is unchanged by moving the shape — the parallel-axis shift is applied', () => {
    // The inertia is about the CENTRE OF MASS, so an identical box somewhere else has an identical
    // tensor. Forgetting the shift makes a sign at the far end of a site enormously hard to turn.
    const a = box({ x: 0.3, y: 1.2, z: 0.05 })
    const b = box({ x: 0.3, y: 1.2, z: 0.05 }, { x: 900, y: 12, z: -400 })
    const ia = massProperties(a.positions, a.index).inertia
    const ib = massProperties(b.positions, b.index).inertia
    /*
     * RELATIVELY, not absolutely — and the gap is the method's own precision limit rather than a
     * bug. Every tet is measured from the ORIGIN, so a box 900 m out accumulates terms of order
     * distance² and subtracts almost all of them again. Measured: the two agree to about **two
     * parts in ten thousand** at that distance. That is why `massProperties` is documented as
     * wanting LOCAL coordinates — a corridor site is a kilometre across, and handing it world-space
     * geometry makes this worse without anything saying so.
     */
    // Normalised against the TENSOR's magnitude, not each term's. An off-diagonal term of an
    // axis-aligned box is zero, so dividing by it asks a rounding error to be relatively small
    // against zero — an off-diagonal residue of 0.0015 beside diagonals of 543 is zero to five
    // digits, and per-term normalisation calls it a 100% error.
    const scale = Math.max(Math.abs(ia[0]), Math.abs(ia[4]), Math.abs(ia[8]))
    for (let i = 0; i < 9; i++) expect(Math.abs(ib[i] - ia[i]) / scale, `term ${i}`).toBeLessThan(1e-3)
  })

  it('gets the isotropic sphere, where all three moments are equal', () => {
    const { positions, index } = sphere(1, 64)
    const p = massProperties(positions, index, 1000)
    const want = 0.4 * p.mass * 1 * 1 // 2/5 m r²
    for (const i of [0, 4, 8]) expect(p.inertia[i] / want).toBeCloseTo(1, 1)
  })

  it('finds principal moments that agree with the diagonal when the shape is already aligned', () => {
    const { positions, index } = box({ x: 1, y: 0.25, z: 2 })
    const p = massProperties(positions, index, DENSITY.aluminium)
    const { moments } = principalInertia(p.inertia)
    const got = [moments.x, moments.y, moments.z].sort((m, n) => m - n)
    const want = [p.inertia[0], p.inertia[4], p.inertia[8]].sort((m, n) => m - n)
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 4)
  })
})

describe('estimateMass — the one the game actually calls', () => {
  it('weighs a steel post from its volume', () => {
    // a 0.06 m square post, 3 m tall: 0.0108 m³ of steel, about 85 kg
    const { positions, index } = box({ x: 0.03, y: 1.5, z: 0.03 })
    const r = estimateMass(positions, index, 'steel')
    expect(r.from).toBe('volume')
    expect(r.kg).toBeCloseTo(0.06 * 3 * 0.06 * DENSITY.steel, 3)
    expect(r.kg).toBeGreaterThan(80)
    expect(r.kg).toBeLessThan(90)
  })

  it('falls back to the bounds for an OPEN shell, and says so', () => {
    /*
     * A sign FACE is often a single quad, which encloses no volume at all. Believing that gives a
     * 0 kg stop sign, and a 0 kg stop sign is fired into orbit by a bicycle. This is the check that
     * the fallback exists and is reported rather than silently taken.
     */
    const quad = { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], index: [0, 1, 2, 0, 2, 3] }
    const r = estimateMass(quad.positions, quad.index, 'aluminium', { solidity: 1 })
    expect(r.from).toBe('bounds')
    expect(r.kg).toBeGreaterThan(0)
    // a flat quad has zero thickness, so the box is zero too — the floor is what saves it
    expect(r.kg).toBeGreaterThanOrEqual(0.5)
  })

  it('falls back when the winding is inside out rather than reporting a negative mass', () => {
    const { positions, index } = box()
    const flipped = []
    for (let i = 0; i < index.length; i += 3) flipped.push(index[i], index[i + 2], index[i + 1])
    const r = estimateMass(positions, flipped, 'steel')
    expect(r.from).toBe('bounds')
    expect(r.kg).toBeGreaterThan(0)
  })

  it('puts a stop sign somewhere a person would recognise', () => {
    // 0.75 m across, 2 mm of aluminium, on a 2.4 m × 60 mm steel post
    const face = box({ x: 0.375, y: 0.375, z: 0.001 }, { x: 0, y: 2.2, z: 0 })
    const post = box({ x: 0.03, y: 1.2, z: 0.03 }, { x: 0, y: 1.2, z: 0 })
    // A real post is a TUBE, not a bar: the mesh's envelope of 60 mm steel over 2.4 m is 68 kg of
    // solid steel, about five times the thing on the corner. `solidity` is the one judgement the
    // geometry cannot make.
    const plate = estimateMass(face.positions, face.index, 'aluminium')
    const pole = estimateMass(post.positions, post.index, 'steel', { solidity: 0.2 })
    const total = plate.kg + pole.kg
    // a real US stop sign assembly is somewhere around 15–30 kg
    expect(total).toBeGreaterThan(12)
    expect(total).toBeLessThan(40)
    // and the plate is the light half — which is why the thing topples rather than helicopters
    expect(plate.kg).toBeLessThan(pole.kg)
  })

  it('never returns a zero or negative mass, whatever it is handed', () => {
    for (const junk of [[], [0, 0, 0], [1, 1, 1, 1, 1, 1, 1, 1, 1]]) {
      const r = estimateMass(junk, null, 'steel')
      expect(r.kg).toBeGreaterThan(0)
      expect(Number.isFinite(r.kg)).toBe(true)
    }
  })
})

describe('bounds', () => {
  it('handles an empty array without returning infinities', () => {
    const b = boundsOf([])
    expect(b.size).toEqual({ x: 0, y: 0, z: 0 })
  })
})
