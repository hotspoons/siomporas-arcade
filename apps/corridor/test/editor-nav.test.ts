// The place editor's navigation maths (src/editor/view/navmath.ts): every promise trailworks'
// controls make, stated as a number. Each test also shows the promise CAN fail — the naive version
// of the same operation, run beside it, breaks it.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  clampAboveGround, glide, headingDegOf, marchRay, metresPerPixel, orbitAbout, panByPixels, panToKeep,
  pitchDegOf, pivotFrom, polarOf, rayPlane, setHeadingPitch, twoFingerFixedPoint, yawAboutEye, zoomAbout,
} from '../src/editor/view/navmath'

/** a camera at `eye` looking at `target` with the editor's continuous up, ready to project */
function cam(eye: THREE.Vector3, target: THREE.Vector3, aspect = 1.5): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(55, aspect, 0.1, 500_000)
  const d = eye.distanceTo(target)
  const h = Math.atan2(target.x - eye.x, -(target.z - eye.z))
  const p = Math.acos(Math.min(1, Math.max(-1, (eye.y - target.y) / d)))
  c.up.set(Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p))
  c.position.copy(eye)
  c.lookAt(target)
  c.updateMatrixWorld()
  c.updateProjectionMatrix()
  return c
}
const screen = (c: THREE.PerspectiveCamera, p: THREE.Vector3) => { const v = p.clone().project(c); return new THREE.Vector2(v.x, v.y) }
const rayAt = (c: THREE.PerspectiveCamera, ndc: THREE.Vector2) => { const r = new THREE.Raycaster(); r.setFromCamera(ndc, c); return r.ray }
const LIM = { min: 2, max: 150_000 }
const POLAR = { min: 0.05, max: (82 * Math.PI) / 180 }

describe('zoom about a point', () => {
  it('keeps the point under the cursor fixed on screen, tilted and off-centre', () => {
    const eye = new THREE.Vector3(120, 900, 1400)
    const target = new THREE.Vector3(0, 30, 0)
    const c0 = cam(eye, target)
    // the ground point under an off-centre pixel
    const pix = new THREE.Vector2(0.55, -0.4)
    const pivot = rayPlane(rayAt(c0, pix).origin, rayAt(c0, pix).direction, 30)!
    for (const logF of [-0.5, -0.2, 0.3, 1.1]) {
      const e = eye.clone(), t = target.clone()
      expect(zoomAbout(e, t, pivot, logF, LIM)).toBe(true)
      const after = screen(cam(e, t), pivot)
      expect(after.distanceTo(pix)).toBeLessThan(1e-4)
    }
  })

  it('a zoom toward the look-at point instead (OrbitControls) does move the cursor point — the test can fail', () => {
    const eye = new THREE.Vector3(120, 900, 1400)
    const target = new THREE.Vector3(0, 30, 0)
    const c0 = cam(eye, target)
    const pix = new THREE.Vector2(0.55, -0.4)
    const pivot = rayPlane(rayAt(c0, pix).origin, rayAt(c0, pix).direction, 30)!
    const e = eye.clone().sub(target).multiplyScalar(0.5).add(target) // dolly to the target
    expect(screen(cam(e, target), pivot).distanceTo(pix)).toBeGreaterThan(0.1)
  })

  it('refuses a step that would leave the distance limits, and moves nothing', () => {
    const eye = new THREE.Vector3(0, 3, 0.5)
    const target = new THREE.Vector3(0, 0, 0)
    const e = eye.clone(), t = target.clone()
    expect(zoomAbout(e, t, target, Math.log(0.3), LIM)).toBe(false)
    expect(e.equals(eye)).toBe(true)
    expect(zoomAbout(e, t, target, Math.log(1e6), LIM)).toBe(false)
  })
})

describe('orbit about a point', () => {
  it('holds the pivot on its pixel through azimuth and elevation', () => {
    const eye = new THREE.Vector3(-300, 1200, 900)
    const target = new THREE.Vector3(50, 10, -40)
    const c0 = cam(eye, target)
    const pix = new THREE.Vector2(-0.35, 0.25)
    const r = rayAt(c0, pix)
    const pivot = rayPlane(r.origin, r.direction, 10)!
    const right = new THREE.Vector3().setFromMatrixColumn(c0.matrixWorld, 0)
    const e = eye.clone(), t = target.clone()
    expect(orbitAbout(e, t, pivot, 0.6, 0.2, right, POLAR)).toBe(true)
    expect(screen(cam(e, t), pivot).distanceTo(pix)).toBeLessThan(1e-4)
    // and the distance to the pivot is a rigid motion's
    expect(e.distanceTo(pivot)).toBeCloseTo(eye.distanceTo(pivot), 6)
  })

  it('rotating about the look-at point instead loses an off-centre pivot — the test can fail', () => {
    const eye = new THREE.Vector3(-300, 1200, 900)
    const target = new THREE.Vector3(50, 10, -40)
    const c0 = cam(eye, target)
    const pix = new THREE.Vector2(-0.35, 0.25)
    const r = rayAt(c0, pix)
    const pivot = rayPlane(r.origin, r.direction, 10)!
    const right = new THREE.Vector3().setFromMatrixColumn(c0.matrixWorld, 0)
    const e = eye.clone(), t = target.clone()
    orbitAbout(e, t, t.clone(), 0.6, 0.2, right, POLAR)
    expect(screen(cam(e, t), pivot).distanceTo(pix)).toBeGreaterThan(0.05)
  })

  it('rejects an elevation past the 82° ceiling and below the overhead floor, but lets the north-up view tilt out', () => {
    const target = new THREE.Vector3()
    const eye = new THREE.Vector3(0, 100, 0)
    setHeadingPitch(eye, target, 0, 80)
    const right = new THREE.Vector3(1, 0, 0)
    const e = eye.clone(), t = target.clone()
    expect(orbitAbout(e, t, target, 0, (5 * Math.PI) / 180, right, POLAR)).toBe(false) // to 85°: refused
    expect(e.equals(eye)).toBe(true)
    // straight down sits below the floor; a small tilt away from it is allowed, a further push into it is not
    const top = new THREE.Vector3(0, 100, 0)
    expect(pitchDegOf(top, target)).toBe(0)
    const e2 = top.clone()
    expect(orbitAbout(e2, target.clone(), target, 0, 0.01, right, POLAR)).toBe(true)
    expect(polarOf(e2, target)).toBeCloseTo(0.01, 6)
  })
})

describe('grab pan', () => {
  it('puts the grabbed ground point back under the cursor at any tilt', () => {
    const eye = new THREE.Vector3(200, 600, 800)
    const target = new THREE.Vector3(0, 0, 0)
    const c0 = cam(eye, target)
    const press = new THREE.Vector2(0.1, -0.2)
    const grab = rayPlane(rayAt(c0, press).origin, rayAt(c0, press).direction, 0)!
    const now = new THREE.Vector2(-0.45, 0.3) // the cursor moved
    const r = rayAt(c0, now)
    const mv = panToKeep(r.origin, r.direction, grab, 1e6)!
    const e = eye.clone().add(new THREE.Vector3(mv.dx, 0, mv.dz))
    const t = target.clone().add(new THREE.Vector3(mv.dx, 0, mv.dz))
    expect(screen(cam(e, t), grab).distanceTo(now)).toBeLessThan(1e-4)
  })

  it('a constant metres-per-pixel gain drifts off the grabbed point when tilted — the test can fail', () => {
    const eye = new THREE.Vector3(0, 300, 900)
    const target = new THREE.Vector3(0, 0, 0)
    const c0 = cam(eye, target, 1)
    const press = new THREE.Vector2(0, -0.6) // near the bottom: the ground is close there
    const grab = rayPlane(rayAt(c0, press).origin, rayAt(c0, press).direction, 0)!
    const now = new THREE.Vector2(0, 0.2)
    const H = 800
    const dyPx = -((now.y - press.y) / 2) * H
    const right = new THREE.Vector3().setFromMatrixColumn(c0.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(c0.matrixWorld, 1)
    const fwd = new THREE.Vector3().setFromMatrixColumn(c0.matrixWorld, 2).negate()
    const mv = panByPixels(0, dyPx, right, up, fwd, metresPerPixel(eye.distanceTo(target), 55, H))
    const e = eye.clone().add(new THREE.Vector3(mv.dx, 0, mv.dz))
    const t = target.clone().add(new THREE.Vector3(mv.dx, 0, mv.dz))
    expect(screen(cam(e, t, 1), grab).distanceTo(now)).toBeGreaterThan(0.05)
  })

  it('gives up when the cursor is above the horizon, so the caller falls back to the gain', () => {
    const eye = new THREE.Vector3(0, 50, 900)
    const target = new THREE.Vector3(0, 0, 0)
    const c0 = cam(eye, target)
    const grab = new THREE.Vector3(0, 0, 0)
    const sky = rayAt(c0, new THREE.Vector2(0, 0.95))
    expect(panToKeep(sky.origin, sky.direction, grab, 1e6)).toBeNull()
  })
})

describe('picking and clamps', () => {
  const hill = (x: number, z: number) => 20 + 15 * Math.sin(x / 90) * Math.cos(z / 70)
  it('marches a ray onto a height field and bisects to the surface', () => {
    const o = new THREE.Vector3(-800, 1500, 1200)
    const d = new THREE.Vector3(0.4, -0.75, -0.55).normalize()
    const p = marchRay(o, d, hill)!
    expect(p).not.toBeNull()
    expect(Math.abs(p.y - hill(p.x, p.z))).toBeLessThan(1e-6)
    // on the ray
    expect(p.clone().sub(o).normalize().distanceTo(d)).toBeLessThan(1e-4)
  })

  it('a ray pointing at the sky finds nothing', () => {
    expect(marchRay(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0.3, 0.2, 0).normalize(), hill)).toBeNull()
  })

  it('does not trust a hit far past the look-at point (the horizon), and takes the target plane instead', () => {
    const eye = new THREE.Vector3(0, 100, 0), target = new THREE.Vector3(0, 0, -300)
    const dir = new THREE.Vector3(0, -0.1, -1).normalize()
    const far = new THREE.Vector3(0, 0, -50_000)
    const p = pivotFrom(far, eye, dir, eye, target)!
    expect(p.distanceTo(far)).toBeGreaterThan(1000)
    expect(p.y).toBeCloseTo(0, 6)
  })

  it('keeps the eye above the ground without turning the view', () => {
    const target = new THREE.Vector3(0, 0, 0)
    const eye = new THREE.Vector3(0, 0.5, 4)
    const dir0 = target.clone().sub(eye).normalize()
    expect(clampAboveGround(eye, target, 0, 1.5, 150_000)).toBe(true)
    expect(eye.y).toBeGreaterThanOrEqual(1.5 - 1e-9)
    // the view direction is unchanged where the lever works
    const e2 = new THREE.Vector3(0, 40, 40)
    const d2 = target.clone().sub(e2).normalize()
    clampAboveGround(e2, target, 45, 1.5, 150_000)
    expect(e2.y).toBeGreaterThanOrEqual(46.5 - 1e-6)
    expect(target.clone().sub(e2).normalize().distanceTo(d2)).toBeLessThan(1e-9)
    void dir0
    // and leaves an eye already clear alone
    const e3 = new THREE.Vector3(0, 100, 10)
    expect(clampAboveGround(e3, target, 0, 1.5, 150_000)).toBe(false)
  })
})

describe('heading, pitch, keys, glide, touch', () => {
  it('reads heading as the direction the view faces, and sets it back exactly', () => {
    const t = new THREE.Vector3(10, 5, -20)
    const e = new THREE.Vector3()
    for (const [h, p] of [[0, 30], [90, 45], [-135, 70], [179, 10]]) {
      e.set(0, 0, 0)
      e.copy(t).add(new THREE.Vector3(0, 100, 0))
      setHeadingPitch(e, t, h, p)
      expect(headingDegOf(e, t)).toBeCloseTo(h, 6)
      expect(pitchDegOf(e, t)).toBeCloseTo(p, 6)
    }
    // north is -z: a view facing north has its target north of the eye
    setHeadingPitch(e, t, 0, 45)
    expect(t.z).toBeLessThan(e.z)
  })

  it('turns about the eye: the eye stays, the target swings, Q (positive) turns left', () => {
    const e = new THREE.Vector3(0, 50, 0), t = new THREE.Vector3(0, 0, -100)
    yawAboutEye(e, t, Math.PI / 2)
    expect(e.toArray()).toEqual([0, 50, 0])
    expect(headingDegOf(e, t)).toBeCloseTo(-90, 6) // facing north, a left turn faces west
  })

  it('glides decay, and stop dead with the knob at zero', () => {
    expect(glide(1, 0.5, 0.1)).toBeLessThan(1)
    expect(glide(1, 0.5, 0.1)).toBeGreaterThan(0.8)
    expect(glide(1, 0, 0.1)).toBe(0)
  })

  it('finds the fixed point of a two-finger twist: one finger still, the other circling it', () => {
    const g0 = { ax: 400, ay: 300, bx: 600, by: 300 }
    const a = Math.PI / 8
    const g1 = { ax: 400, ay: 300, bx: 400 + 200 * Math.cos(a), by: 300 + 200 * Math.sin(a) }
    const fp = twoFingerFixedPoint(g0, g1, 1400, 900)
    expect(fp.x).toBeCloseTo(400, 3)
    expect(fp.y).toBeCloseTo(300, 3)
    expect(fp.dAng).toBeCloseTo(a, 6)
    // a pure slide has no fixed point on screen: the centroid stands in
    const slide = twoFingerFixedPoint(g0, { ax: 450, ay: 320, bx: 650, by: 320 }, 1400, 900)
    expect(slide.x).toBeCloseTo(550, 6)
    expect(slide.y).toBeCloseTo(320, 6)
  })
})
