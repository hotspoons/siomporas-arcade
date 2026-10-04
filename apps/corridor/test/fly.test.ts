// THE FREE CAMERA'S LOOK, which is the one thing about it a probe cannot see.
//
// Rich, 2026-10-03: "fly mode had no ability to look up reasonably, you get stuck in the grass
// and can't see anything when you try to look up." The bug was that the orbit target IS the look
// direction, and the old terrain-follow eased the target's height onto the ground every frame, so
// a pitch up was undone within a few frames and the camera was dragged down onto the floor.
//
// These checks are about the INVARIANTS that make a look a look, and hold whatever the terrain
// does: a pitch persists when nothing else moves, a hard hold clamps at the pole instead of
// flipping over it, the floor lifts the camera and the target together, and flying forward rides
// the ground while leaving the pitch alone.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { FlyControls } from '../src/game/move/fly'

beforeAll(() => {
  // the controls wire themselves to key/pointer events on the window and the canvas; node has
  // neither, and the handlers are irrelevant to the arithmetic under test
  vi.stubGlobal('addEventListener', () => {})
})

const elevation = (target: THREE.Vector3, cam: THREE.PerspectiveCamera) => {
  const off = target.clone().sub(cam.position)
  return Math.asin(off.y / off.length())
}

/** A bare-bones stand-in for the OrbitControls: only `.target`, `.enabled` and two setup fields. */
function makeSetup(ground: (x: number, z: number) => number | null, camY = 10, targetX = 40) {
  const cam = new THREE.PerspectiveCamera()
  cam.position.set(0, camY, 0)
  const orbit = { target: new THREE.Vector3(targetX, camY, 0), enabled: true }
  const canvas = { addEventListener() {} } as unknown as HTMLElement
  const fly = new FlyControls(cam, orbit as never, canvas, ground)
  return { cam, orbit, fly }
}

/** `keys` is private because the DOM writes it; the test is allowed to press a key. */
const press = (fly: FlyControls, code: string) => {
  ;(fly as unknown as { keys: Set<string> }).keys.add(code)
}

describe('the free camera look', () => {
  it('keeps a pitch when nothing else moves (the reported bug)', () => {
    const { cam, orbit, fly } = makeSetup(() => 0)
    fly.look(0, 0.8)
    for (let i = 0; i < 180; i++) fly.update(1 / 60)
    // three seconds of sim with no input: the look is still up, and the camera still where it was
    expect(elevation(orbit.target, cam)).toBeCloseTo(0.8, 2)
    expect(cam.position.y).toBeCloseTo(10, 5)
  })

  it('clamps a hard hold at the pole instead of sailing over it', () => {
    const { cam, orbit, fly } = makeSetup(() => 0)
    fly.look(0, 5)
    const el = elevation(orbit.target, cam)
    expect(el).toBeLessThanOrEqual(1.45 + 1e-6)
    expect(el).toBeGreaterThan(1.4)
    // and it got there without wrapping to the other side
    expect(cam.position.y).toBeCloseTo(10, 5)
  })

  it('lifts camera and target together off the floor, so the pitch survives rescue', () => {
    const { cam, orbit, fly } = makeSetup(() => 0, 0.2)
    const before = elevation(orbit.target, cam)
    fly.update(1 / 60)
    expect(cam.position.y).toBeCloseTo(1.0, 5) // CAM_MIN_HEIGHT above the ground
    expect(elevation(orbit.target, cam)).toBeCloseTo(before, 5)
  })

  it('follows rising ground while flying forward without changing the pitch', () => {
    // ground climbs 10 cm per metre east; the camera flies east toward its target
    const ground = (x: number) => x * 0.1
    const { cam, orbit, fly } = makeSetup(ground, 5)
    const before = elevation(orbit.target, cam)
    press(fly, 'KeyW')
    for (let i = 0; i < 120; i++) fly.update(1 / 60)
    expect(cam.position.x).toBeGreaterThan(10) // it actually went somewhere
    expect(elevation(orbit.target, cam)).toBeCloseTo(before, 1)
    // the camera rides the hill: its height above the ground under it is unchanged (within the
    // one-frame ground sample the track starts from)
    const under = ground(cam.position.x) as number
    expect(cam.position.y - under).toBeCloseTo(5, 0)
  })

  it('R/F raises camera and target together: height, not zoom', () => {
    // Rich, 2026-10-03: "one for zoom, and one for camera height ... they both seem to do zoom."
    // Raising only the camera's Y changes the distance to the target -- that reads as a dolly. A
    // real height move takes the target with it, so the distance and the pitch are untouched.
    const { cam, orbit, fly } = makeSetup(() => -1000, 10, 40)
    const dist = cam.position.distanceTo(orbit.target)
    const before = elevation(orbit.target, cam)
    press(fly, 'KeyR')
    for (let i = 0; i < 60; i++) fly.update(1 / 60)
    expect(cam.position.y).toBeGreaterThan(10)
    expect(orbit.target.y).toBeGreaterThan(10)
    expect(cam.position.distanceTo(orbit.target)).toBeCloseTo(dist, 4)
    expect(elevation(orbit.target, cam)).toBeCloseTo(before, 4)
  })

  it('T/G dollies in without moving the target: zoom', () => {
    const { cam, orbit, fly } = makeSetup(() => -1000, 10, 40)
    const dist = cam.position.distanceTo(orbit.target)
    press(fly, 'KeyT')
    for (let i = 0; i < 60; i++) fly.update(1 / 60)
    expect(cam.position.distanceTo(orbit.target)).toBeLessThan(dist)
    expect(orbit.target.y).toBeCloseTo(10, 5) // a dolly moves the eye, not the target
  })
})
