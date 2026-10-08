// The fly-mode beacon has to be SEEN: in frame, the arrow over the car stands a fixed height on
// screen however far away the car is; out of frame, the rim tick takes over.
//
// Rich, 2026-10-08: from the wide fly view "I don't see a marker with a pin when the vehicle is in
// the frame". The arrow scaled with distance and stopped at ×6 (25 m), a few pixels from kilometres
// away. These hold the screen size.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'

const W = 1600
const H = 900
const g = globalThis as Record<string, unknown>
const saved = { document: g.document, window: g.window }

beforeAll(() => {
  // the four DOM calls the beacon makes, and nothing else
  const el = () => ({ style: {} as Record<string, string>, className: '', hidden: false, width: 0, height: 0, textContent: '', append() {}, getContext: () => null })
  g.document = { createElement: el, body: { append() {} } }
  g.window = { innerWidth: W, innerHeight: H }
})
afterAll(() => {
  g.document = saved.document
  g.window = saved.window
})

/** the arrow's height on screen, px, for a camera `dist` metres from a car it is looking at */
async function arrowPx(dist: number) {
  const { AvatarBeacon } = await import('../src/game/world/beacon')
  const b = new AvatarBeacon()
  const cam = new THREE.PerspectiveCamera(60, W / H, 0.5, 100000)
  const car = new THREE.Vector3(1000, 30, -2000)
  cam.position.copy(car).add(new THREE.Vector3(0, dist * 0.5, dist * 0.866))
  cam.lookAt(car)
  cam.updateMatrixWorld()
  b.update(cam, car, 1 / 60)
  const arrow = b.object.children[0]
  const perPx = (2 * cam.position.distanceTo(car) * Math.tan((cam.fov * Math.PI) / 360)) / H
  return { visible: b.object.visible, scale: arrow.scale.x, px: (4.3 * arrow.scale.x) / perPx }
}

describe('the fly-mode beacon', () => {
  it('stands ~72 px tall over a car kilometres away in frame — it used to be a speck', async () => {
    const far = await arrowPx(3000)
    expect(far.visible).toBe(true)
    expect(far.px).toBeGreaterThan(65)
    expect(far.px).toBeLessThan(80)
  })

  it('keeps its own size up close rather than shrinking below it', async () => {
    const near = await arrowPx(15)
    expect(near.visible).toBe(true)
    expect(near.scale).toBe(1)
  })
})
