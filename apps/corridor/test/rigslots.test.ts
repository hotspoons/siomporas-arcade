// The whole value of this module is that a wrong answer is invisible downstream, so the tests are
// about the ways it could be wrong QUIETLY: an axis convention it was not written for, names that
// disagree with the geometry, a rig that is not four wheels at all.
import { describe, expect, it } from 'vitest'
import { guessWheelSlots, swapEnds, swapSides } from '../src/game/vehicle/rigslots'

/** four wheels of a 2.6 m wheelbase, 1.5 m track car, laid out on whichever axes you name */
function car(opts: { lon: 'x' | 'y' | 'z', lat: 'x' | 'y' | 'z', up: 'x' | 'y' | 'z', names: string[], flip?: boolean }) {
  const { lon, lat, up, names } = opts
  const f = opts.flip ? -1 : 1
  const at = (l: number, t: number) => {
    const p = { x: 0, y: 0, z: 0 }
    p[lon] = l * f
    p[lat] = t
    p[up] = 0.32
    return p
  }
  // FL, FR, RL, RR in the layout's own terms
  const pts = [at(1.3, -0.75), at(1.3, 0.75), at(-1.3, -0.75), at(-1.3, 0.75)]
  return Object.fromEntries(names.map((n, i) => [n, pts[i]]))
}

const FLFRRLRR = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']

describe('it finds the four corners whatever the file calls its axes', () => {
  it('Y-up, forward along X', () => {
    const places = car({ lon: 'x', lat: 'z', up: 'y', names: FLFRRLRR })
    expect(guessWheelSlots(FLFRRLRR, places)?.order).toEqual(FLFRRLRR)
  })

  it('Z-up out of Blender, forward along Y', () => {
    const places = car({ lon: 'y', lat: 'x', up: 'z', names: FLFRRLRR })
    expect(guessWheelSlots(FLFRRLRR, places)?.order).toEqual(FLFRRLRR)
  })

  it('Y-up, forward along -Z, which is the glTF camera convention and the one a hard-coded +X gets wrong', () => {
    const places = car({ lon: 'z', lat: 'x', up: 'y', names: FLFRRLRR, flip: true })
    expect(guessWheelSlots(FLFRRLRR, places)?.order).toEqual(FLFRRLRR)
  })

  it('the bones can arrive in any order — the answer is the same', () => {
    const places = car({ lon: 'x', lat: 'z', up: 'y', names: FLFRRLRR })
    const shuffled = ['wheel_rr', 'wheel_fl', 'wheel_rl', 'wheel_fr']
    expect(guessWheelSlots(shuffled, places)?.order).toEqual(FLFRRLRR)
  })
})

describe('names decide which end is the front, because geometry cannot', () => {
  it('reads front/rear off the names when they disagree with the +longitudinal assumption', () => {
    // laid out so the REAR wheels are at +x; only the names can tell you
    const names = ['w_front_left', 'w_front_right', 'w_rear_left', 'w_rear_right']
    const places = car({ lon: 'x', lat: 'z', up: 'y', names, flip: true })
    const g = guessWheelSlots(names, places)
    expect(g?.order).toEqual(names)
    expect(g?.oriented).toBe(true)
  })

  it('says so when nothing named an end, so the editor can offer the swap instead of pretending', () => {
    const names = ['Bone_001', 'Bone_002', 'Bone_003', 'Bone_004']
    const places = car({ lon: 'x', lat: 'z', up: 'y', names })
    const g = guessWheelSlots(names, places)
    expect(g).not.toBeNull()
    expect(g?.oriented).toBe(false)
  })

  it('a swap is its own inverse and never loses a bone', () => {
    const o = FLFRRLRR as [string, string, string, string]
    expect(swapEnds(swapEnds(o))).toEqual(o)
    expect(swapSides(swapSides(o))).toEqual(o)
    expect([...swapEnds(o)].sort()).toEqual([...o].sort())
  })

  it('swapping ends really does move the driven axle, not just the labels', () => {
    expect(swapEnds(FLFRRLRR)[0]).toBe('wheel_rl')
    expect(swapSides(FLFRRLRR)[0]).toBe('wheel_fr')
  })
})

describe('it refuses rather than half-answering', () => {
  it('three wheel bones is a question for a person', () => {
    const places = car({ lon: 'x', lat: 'z', up: 'y', names: FLFRRLRR })
    expect(guessWheelSlots(FLFRRLRR.slice(0, 3), places)).toBeNull()
  })

  it('a bone with no known position does not silently drop out of the count', () => {
    const places = car({ lon: 'x', lat: 'z', up: 'y', names: FLFRRLRR })
    delete (places as Record<string, unknown>).wheel_rr
    expect(guessWheelSlots(FLFRRLRR, places)).toBeNull()
  })

  it('four bones that are not a rectangle — two in one corner — is refused, not rounded off', () => {
    const places = {
      a: { x: 1.3, y: 0.3, z: -0.75 },
      b: { x: 1.3, y: 0.3, z: -0.74 },
      c: { x: -1.3, y: 0.3, z: -0.75 },
      d: { x: -1.3, y: 0.3, z: -0.74 },
    }
    expect(guessWheelSlots(['a', 'b', 'c', 'd'], places)).toBeNull()
  })
})
