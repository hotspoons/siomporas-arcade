// Does the geometry hold up, including the cases that silence a game with no error anywhere?
//
// Spatial audio fails geometrically and quietly: a listener basis that is not orthonormal tilts
// the image as you look up, a NaN in an orientation silences everything, and a distance model
// that does not bottom out fades the car you are sitting in. None of those throw.
import { describe, expect, it } from 'vitest'
import { basis, inverseGain, spatialFor, unit, type Listener } from '../src/spatial'

const L = (forward: [number, number, number], up: [number, number, number] = [0, 0, 1], at: [number, number, number] = [0, 0, 0]): Listener => ({
  position: { x: at[0], y: at[1], z: at[2] },
  forward: { x: forward[0], y: forward[1], z: forward[2] },
  up: { x: up[0], y: up[1], z: up[2] },
})
const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol)

describe('the listener basis', () => {
  it('is orthonormal even when the camera hands over a world up', () => {
    // a camera looking north and slightly down, with up still world-up — the usual case
    const b = basis(L([0, 1, -0.4]))
    near(Math.hypot(b.forward.x, b.forward.y, b.forward.z), 1)
    near(Math.hypot(b.up.x, b.up.y, b.up.z), 1)
    near(b.forward.x * b.up.x + b.forward.y * b.up.y + b.forward.z * b.up.z, 0)
    expect(b.up.z).toBeGreaterThan(0) // still broadly upward, not flipped
  })

  it('survives looking straight up, which is where the maths degenerates', () => {
    // forward parallel to up: there is no way to say which way sideways is, and the naive answer
    // is a zero vector that becomes NaN in an orientation and silences everything
    const b = basis(L([0, 0, 1], [0, 0, 1]))
    for (const v of [b.forward, b.up]) for (const c of [v.x, v.y, v.z]) expect(Number.isFinite(c)).toBe(true)
    near(Math.hypot(b.up.x, b.up.y, b.up.z), 1)
    near(b.forward.x * b.up.x + b.forward.y * b.up.y + b.forward.z * b.up.z, 0)
  })

  it('survives a zero forward vector', () => {
    const b = basis(L([0, 0, 0]))
    for (const c of [b.forward.x, b.forward.y, b.forward.z]) expect(Number.isFinite(c)).toBe(true)
    near(Math.hypot(b.forward.x, b.forward.y, b.forward.z), 1)
  })

  it('leaves an already-orthonormal basis alone', () => {
    const b = basis(L([0, 1, 0], [0, 0, 1]))
    near(b.forward.y, 1)
    near(b.up.z, 1)
  })
})

describe('distance', () => {
  it('is full volume inside the reference distance, so the car you sit in does not fade', () => {
    expect(inverseGain(0, 2, 1, 200)).toBe(1)
    expect(inverseGain(1.9, 2, 1, 200)).toBe(1)
  })

  it('falls off and never reaches zero or negative', () => {
    const a = inverseGain(10, 2, 1, 200)
    const b = inverseGain(50, 2, 1, 200)
    expect(a).toBeLessThan(1)
    expect(b).toBeLessThan(a)
    expect(b).toBeGreaterThan(0)
  })

  it('clamps at maxDistance rather than continuing to fall', () => {
    expect(inverseGain(500, 2, 1, 200)).toBe(inverseGain(200, 2, 1, 200))
  })

  it('a bigger rolloff is quieter at the same distance', () => {
    expect(inverseGain(20, 2, 2, 200)).toBeLessThan(inverseGain(20, 2, 1, 200))
  })
})

describe('first person and third person', () => {
  const car = { x: 0, y: 0, z: 0 }

  it('the cockpit is interior and the chase camera is not', () => {
    // sitting in it: the driver's head is about a metre from the engine
    const inside = spatialFor(car, L([0, 1, 0], [0, 0, 1], [0, -1, 1]))
    expect(inside.interior).toBeGreaterThan(0.9)
    // chase camera, eight metres back and three up
    const outside = spatialFor(car, L([0, 1, 0], [0, 0, 1], [0, -8, 3]))
    expect(outside.interior).toBe(0)
    expect(outside.distance).toBeCloseTo(Math.hypot(8, 3), 5)
  })

  it('crossfades rather than snapping, so switching view is not a click', () => {
    const at = (d: number) => spatialFor(car, L([0, 1, 0], [0, 0, 1], [0, -d, 0])).interior
    const xs = [1, 1.5, 2, 2.5, 3, 3.5, 4, 5].map(at)
    // monotonically decreasing as you move away, and continuous
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThanOrEqual(xs[i - 1])
    for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i] - xs[i - 1])).toBeLessThan(0.55)
    expect(xs[0]).toBe(1)
    expect(xs[xs.length - 1]).toBe(0)
  })

  it('a sound to the left is to the left, whichever way the listener faces', () => {
    // the panner does the actual panning; what this checks is that the vectors we hand it put the
    // source on the correct side, which is the thing a wrong forward vector reverses
    const side = (fwd: [number, number, number], src: { x: number; y: number; z: number }) => {
      const b = basis(L(fwd, [0, 0, 1]))
      const right = { x: b.forward.y * b.up.z - b.forward.z * b.up.y, y: b.forward.z * b.up.x - b.forward.x * b.up.z, z: b.forward.x * b.up.y - b.forward.y * b.up.x }
      return Math.sign(src.x * right.x + src.y * right.y + src.z * right.z)
    }
    // facing north, a source to the east is on the right
    expect(side([0, 1, 0], { x: 10, y: 0, z: 0 })).toBe(1)
    // turn around and it is on the left
    expect(side([0, -1, 0], { x: 10, y: 0, z: 0 })).toBe(-1)
  })
})

describe('unit', () => {
  it('normalises and falls back rather than dividing by zero', () => {
    near(Math.hypot(unit({ x: 3, y: 4, z: 0 }).x, unit({ x: 3, y: 4, z: 0 }).y, 0), 1)
    expect(unit({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toEqual({ x: 1, y: 0, z: 0 })
  })
})
