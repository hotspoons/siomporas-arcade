// The editor camera's maths, with no DOM and no clock in it — so a test can state each promise.
//
// These are trailworks' navigation primitives (ext/trailworks/viewer/src/render: the flat
// engine's PivotOrbit/TouchExtras/OrbitKeyPan in Scene.tsx, and globe2/GlobeControls.tsx, which
// says of its own gesture maths that it was "ported verbatim from the flat engine's PivotOrbit")
// put back onto a flat frame. Trailworks' globe needs a quaternion frame because its up axis turns
// as you cross the planet; this editor's world is one ENU plane, up is +Y everywhere, and every
// gesture below is a RIGID transform of the eye and the look-at point about a fixed pivot. That is
// the property all of them are built on: a point on the same camera ray keeps its pixel under a
// homothety about it, and a rotation about an axis through it, done roll-free, keeps it pinned.
//
// The frame is three.js world: x east, y up, z SOUTH (site north = -z). Nothing here allocates
// per call except where it returns a new point.
import * as THREE from 'three'

export const UP = new THREE.Vector3(0, 1, 0)
const DEG = Math.PI / 180

/** clamp, the one everybody re-declares */
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export interface DistanceLimits {
  /** closest the eye may come to the look-at point, metres */
  min: number
  /** furthest, metres */
  max: number
}

// ---------------------------------------------------------------------------------------------
// ZOOM: a homothety about the pivot

/**
 * Scale the eye AND the look-at point about `pivot` by e^logF (logF < 0 closes in).
 *
 * Trailworks `zoomBy`: "scale eye AND target about the fixed pivot (a point on the same ray from a
 * perspective camera keeps its pixel → exact zoom-to-cursor lock)". The camera's orientation does
 * not change — that is why a pure zoom never rolls the view or walks the heading off north.
 *
 * Refused (returns false, nothing moved) when the result would leave the distance limits, which is
 * how trailworks stops the zoom glide dead at the floor and the ceiling.
 */
export function zoomAbout(eye: THREE.Vector3, target: THREE.Vector3, pivot: THREE.Vector3, logF: number, lim: DistanceLimits): boolean {
  const f = Math.exp(logF)
  const ex = pivot.x + (eye.x - pivot.x) * f, ey = pivot.y + (eye.y - pivot.y) * f, ez = pivot.z + (eye.z - pivot.z) * f
  const tx = pivot.x + (target.x - pivot.x) * f, ty = pivot.y + (target.y - pivot.y) * f, tz = pivot.z + (target.z - pivot.z) * f
  const d = Math.hypot(ex - tx, ey - ty, ez - tz)
  if (!(d > lim.min && d < lim.max)) return false
  eye.set(ex, ey, ez)
  target.set(tx, ty, tz)
  return true
}

// ---------------------------------------------------------------------------------------------
// ORBIT: a rigid rotation about the pivot

/** polar angle (radians from straight up) of the eye seen from the target */
export function polarOf(eye: THREE.Vector3, target: THREE.Vector3): number {
  const dx = eye.x - target.x, dy = eye.y - target.y, dz = eye.z - target.z
  const len = Math.hypot(dx, dy, dz)
  return len < 1e-9 ? 0 : Math.acos(clamp(dy / len, -1, 1))
}

/** Pitch in degrees off straight down: 0 is the north-up map view, 82 is trailworks' limit. */
export const pitchDegOf = (eye: THREE.Vector3, target: THREE.Vector3) => polarOf(eye, target) / DEG

/**
 * Compass heading the VIEW faces, degrees clockwise from site north (-z). `fallback` is returned
 * when looking straight down, where the eye-to-target offset has no horizontal part to read.
 */
export function headingDegOf(eye: THREE.Vector3, target: THREE.Vector3, fallback = 0): number {
  const fx = target.x - eye.x, fz = target.z - eye.z
  if (Math.hypot(fx, fz) < 1e-6 * Math.max(1, eye.distanceTo(target))) return fallback
  // north is -z, east is +x
  return Math.atan2(fx, -fz) / DEG
}

const _q = new THREE.Quaternion()
const _axis = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

export interface PolarLimits {
  /** radians from straight up; trailworks rejects below 0.05 (the "fishtail" overhead) */
  min: number
  /** radians; trailworks' 82° pitch ceiling */
  max: number
}

/**
 * Rotate the rig (eye and look-at point together) about `pivot`: azimuth `az` about the vertical
 * through the pivot, then elevation `elv` about the camera's RIGHT axis projected horizontal.
 *
 * Trailworks `orbitBy`: "camera-RIGHT axis through the pivot: the unique horizontal axis whose
 * rotation is roll-free, so controls.update()'s lookAt reproduces the orientation EXACTLY and the
 * pivot stays pinned to its pixel." An elevation step that would take the view overhead or below
 * the polar limit is REJECTED rather than clamped (trailworks zeroes the elevation glide there), so
 * the rig never fishtails about a numerically meaningless axis.
 *
 * `right` is the camera's screen-right in world space (matrix column 0). Returns false when the
 * elevation part was rejected.
 */
export function orbitAbout(eye: THREE.Vector3, target: THREE.Vector3, pivot: THREE.Vector3, az: number, elv: number, right: THREE.Vector3, lim: PolarLimits): boolean {
  if (az) {
    _q.setFromAxisAngle(UP, az)
    eye.sub(pivot).applyQuaternion(_q).add(pivot)
    target.sub(pivot).applyQuaternion(_q).add(pivot)
  }
  if (!elv) return true
  // the right axis turned with the azimuth step above
  _axis.copy(right)
  if (az) _axis.applyQuaternion(_q)
  _axis.y = 0
  if (_axis.lengthSq() < 1e-8) return false
  _axis.normalize()
  _q.setFromAxisAngle(_axis, elv)
  _a.copy(eye).sub(pivot).applyQuaternion(_q).add(pivot)
  _b.copy(target).sub(pivot).applyQuaternion(_q).add(pivot)
  const polar = polarOf(_a, _b)
  // Outside the limits is refused — EXCEPT a step that leaves the forbidden band. The north-up
  // view sits at polar 0, below the 0.05 floor, and a slow drag's steps of a few thousandths of a
  // radian would each be refused there for ever; a step that tilts away from overhead is allowed.
  const before = polarOf(eye, target)
  const inside = polar > lim.min && polar < lim.max
  const escaping = (before <= lim.min && polar > before && polar < lim.max) || (before >= lim.max && polar < before && polar > lim.min)
  if (!inside && !escaping) return false
  eye.copy(_a)
  target.copy(_b)
  return true
}

/**
 * Turn the view about the CAMERA (the look-at point swings round the eye): Rich's Q/E, and
 * trailworks OrbitKeyPan's flight-scheme "look: rotate the view heading about the CAMERA,
 * FPS-style". `yaw` radians, positive turns left (counter-clockwise seen from above).
 */
export function yawAboutEye(eye: THREE.Vector3, target: THREE.Vector3, yaw: number): void {
  _q.setFromAxisAngle(UP, yaw)
  target.sub(eye).applyQuaternion(_q).add(eye)
}

/** Rotate the look about the look-at point to a new heading/pitch, keeping the distance. */
export function setHeadingPitch(eye: THREE.Vector3, target: THREE.Vector3, headingDeg: number, pitchDeg: number): void {
  const d = eye.distanceTo(target)
  const h = headingDeg * DEG, p = pitchDeg * DEG
  // the view FACES `heading`, so the eye sits behind the target along the opposite direction
  const back = Math.sin(p) * d
  eye.set(target.x - Math.sin(h) * back, target.y + Math.cos(p) * d, target.z + Math.cos(h) * back)
}

// ---------------------------------------------------------------------------------------------
// PAN: the grabbed ground point stays under the cursor

/** Where a ray meets the horizontal plane y = `planeY`, or null when it never will. */
export function rayPlane(origin: THREE.Vector3, dir: THREE.Vector3, planeY: number, out = new THREE.Vector3()): THREE.Vector3 | null {
  if (Math.abs(dir.y) < 1e-9) return null
  const t = (planeY - origin.y) / dir.y
  if (!(t > 1e-6)) return null
  return out.copy(origin).addScaledVector(dir, t)
}

/**
 * The horizontal move of the whole rig that puts `grab` back under the cursor, given the cursor's
 * current ray. A pure translation does not change the ray's direction at that pixel, so after the
 * move the same ray meets the grab plane exactly at `grab`: the ground follows the hand 1:1, at
 * every altitude and every tilt, which is what trailworks' metres-per-pixel gain ("the grabbed
 * ground point tracks the cursor ~1:1 at every distance") approximates.
 *
 * Null when the ray no longer meets the grab plane in front of the camera (dragged above the
 * horizon) or meets it absurdly far away — the caller then falls back to that gain.
 */
export function panToKeep(rayOrigin: THREE.Vector3, rayDir: THREE.Vector3, grab: THREE.Vector3, maxRange: number): { dx: number; dz: number } | null {
  const hit = rayPlane(rayOrigin, rayDir, grab.y, _a)
  if (!hit || hit.distanceTo(rayOrigin) > maxRange) return null
  return { dx: grab.x - hit.x, dz: grab.z - hit.z }
}

/**
 * Ground metres per screen pixel at `distance` from a camera with vertical fov `fovDeg` drawn
 * `viewportH` pixels tall — trailworks' `mPerPx = 2·d·tan(fov/2)/vh`, the gain its pan, its ring
 * and its tile choice all read.
 */
export const metresPerPixel = (distance: number, fovDeg: number, viewportH: number) =>
  (2 * distance * Math.tan((fovDeg * DEG) / 2)) / Math.max(1, viewportH)

/**
 * The gain pan: screen pixels → a horizontal move of the rig, along the camera's screen axes
 * projected onto the ground (trailworks `panByRot`: "the two rotation axes are the camera's
 * SCREEN directions … PROJECTED INTO THE TANGENT PLANE", so a drag slides the ground instead of
 * spinning it when tilted). Dragging right moves the world right, i.e. the rig left.
 */
export function panByPixels(dxPx: number, dyPx: number, right: THREE.Vector3, screenUp: THREE.Vector3, viewForward: THREE.Vector3, mPerPx: number): { dx: number; dz: number } {
  _a.set(right.x, 0, right.z)
  _b.set(screenUp.x, 0, screenUp.z)
  if (_b.lengthSq() < 1e-9) _b.set(viewForward.x, 0, viewForward.z) // horizon-level view
  if (_a.lengthSq() < 1e-9) _a.crossVectors(_b, UP)
  if (_a.lengthSq() < 1e-9 || _b.lengthSq() < 1e-9) return { dx: 0, dz: 0 }
  _a.normalize()
  _b.normalize()
  return {
    dx: (-dxPx * _a.x + dyPx * _b.x) * mPerPx,
    dz: (-dxPx * _a.z + dyPx * _b.z) * mPerPx,
  }
}

// ---------------------------------------------------------------------------------------------
// PICKING: the cursor ray against the height field

/**
 * March a ray against a height field and bisect the crossing — trailworks `marchRay`, the "ONE
 * shared primitive behind pin drops, pin drag, pivot orbit, and zoom-to-cursor". Steps shrink as
 * the ray nears the ground (0.4 of the gap) and grow with range, so a 40 km overview pick and a
 * pick from three metres above the road cost about the same handful of samples.
 *
 * `heightAt(x, z)` takes the WORLD x and z and returns the ground height, or null where there is
 * no ground (off the site); a null stretch is crossed in long steps, as trailworks does.
 */
export function marchRay(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  heightAt: (x: number, z: number) => number | null,
  maxDist = 400_000,
  minStep = 0.25,
): THREE.Vector3 | null {
  const p = new THREE.Vector3()
  let t = 0
  let prevT = 0
  for (let i = 0; i < 6000 && t < maxDist; i++) {
    p.copy(origin).addScaledVector(dir, t)
    const h = heightAt(p.x, p.z)
    if (h !== null && Number.isFinite(h) && p.y <= h) {
      let lo = prevT
      let hi = t
      for (let k = 0; k < 28; k++) {
        const mid = (lo + hi) / 2
        p.copy(origin).addScaledVector(dir, mid)
        const hm = heightAt(p.x, p.z)
        if (hm !== null && Number.isFinite(hm) && p.y <= hm) hi = mid
        else lo = mid
      }
      p.copy(origin).addScaledVector(dir, hi)
      const hh = heightAt(p.x, p.z)
      if (hh !== null && Number.isFinite(hh)) p.y = hh
      return p
    }
    prevT = t
    // the ray climbing away from the ground can never come back down to it
    if (h !== null && Number.isFinite(h) && dir.y >= 0 && p.y > h + 1e4) return null
    t += h === null || !Number.isFinite(h) ? Math.max(50, t * 0.01) : Math.max(minStep, (p.y - h) * 0.4, t * 0.0015)
  }
  return null
}

/**
 * A gesture's pivot: the ground under the cursor when the hit is SANE, else where the ray meets
 * the plane through the look-at point. Trailworks `pivotAt`: "over unloaded tiles or sky a grazing
 * raycast lands on HORIZON terrain and the zoom re-anchors miles away mid-gesture" — so a hit
 * farther from the look-at point than `3·distance + 500` m is not trusted.
 */
export function pivotFrom(hit: THREE.Vector3 | null, rayOrigin: THREE.Vector3, rayDir: THREE.Vector3, eye: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 | null {
  const sane = eye.distanceTo(target) * 3 + 500
  if (hit && hit.distanceTo(target) < sane) return hit
  return rayPlane(rayOrigin, rayDir, target.y)
}

// ---------------------------------------------------------------------------------------------
// CLAMPS

/**
 * Keep the eye at least `clearance` above the ground (trailworks' "ground-collision clamp"):
 * the eye recedes from the look-at point along its own line by the shortfall over cos(pitch), so
 * the view direction is unchanged; at a grazing pitch, where that lever is useless, it is lifted
 * straight up. Returns true when it moved the eye.
 */
export function clampAboveGround(eye: THREE.Vector3, target: THREE.Vector3, groundY: number | null, clearance: number, maxDistance: number): boolean {
  if (groundY === null || !Number.isFinite(groundY)) return false
  const floor = groundY + clearance
  if (eye.y >= floor) return false
  _a.copy(eye).sub(target)
  const d = _a.length()
  if (d > 1e-6) {
    _a.divideScalar(d)
    if (_a.y > 0.08) {
      const bump = (floor - eye.y) / _a.y
      const nd = Math.min(maxDistance, d + bump)
      eye.copy(target).addScaledVector(_a, nd)
    }
  }
  if (eye.y < floor) eye.y = floor
  return true
}

/**
 * Trailworks' tilt ENVELOPE: full tilt up close, levelling off toward planetary range ("so a
 * tilted close-up levels out as you zoom to planet scale"). Its 200 km → 10 Mm blend never bites
 * on a 60 km site; it is kept so the editor's ceiling is the same number trailworks uses.
 */
export function maxPitchFor(distance: number): number {
  const blend = clamp(Math.log(distance / 200_000) / Math.log(10_000_000 / 200_000), 0, 1)
  return 82 * (1 - blend)
}

// ---------------------------------------------------------------------------------------------
// GLIDE

/** One frame of an exponential glide with time constant `tau` — and 0 when the glide knob is off. */
export const glide = (v: number, glideKnob: number, dt: number) =>
  glideKnob <= 0.01 ? 0 : v * Math.exp(-dt / (0.15 + glideKnob * 1.1))

/**
 * A velocity sample folded into the running estimate — trailworks' `0.7·v + 0.3·(step/dt)`, with
 * dt floored at 8 ms: "browsers coalesce moves during a hitch and then deliver a large jump 1-2ms
 * after the previous event — dividing that jump by a microscopic dt manufactured enormous glide
 * velocities (the 'camera flung across the map' reports)".
 */
export const fold = (v: number, step: number, dtSec: number, cap: number) =>
  clamp(0.7 * v + 0.3 * (step / Math.max(0.008, dtSec)), -cap, cap)

/** frame-rate independent ease toward a goal: the share of the gap to close this frame */
export const easeK = (rate: number, dt: number) => 1 - Math.exp(-rate * dt)

// ---------------------------------------------------------------------------------------------
// TOUCH

export interface TwoFinger { ax: number; ay: number; bx: number; by: number }

/**
 * The fixed point of a two-finger gesture, solved as a 2D similarity transform — trailworks
 * TouchExtras: "its FIXED POINT is where the map should stay put — a stationary finger with a
 * rotating friend pivots on the finger; a counter-spin pivots between them. Solve (I - sR) p =
 * c1 - sR c0 for p." Falls back to the current centroid for a near-pure translation (the fixed
 * point is then wildly off screen) or when the solve is singular.
 */
export function twoFingerFixedPoint(g0: TwoFinger, g1: TwoFinger, w: number, h: number): { x: number; y: number; s: number; dAng: number } {
  const c0x = (g0.ax + g0.bx) / 2, c0y = (g0.ay + g0.by) / 2
  const c1x = (g1.ax + g1.bx) / 2, c1y = (g1.ay + g1.by) / 2
  const d0 = Math.hypot(g0.bx - g0.ax, g0.by - g0.ay)
  const d1 = Math.hypot(g1.bx - g1.ax, g1.by - g1.ay)
  let dAng = Math.atan2(g1.by - g1.ay, g1.bx - g1.ax) - Math.atan2(g0.by - g0.ay, g0.bx - g0.ax)
  if (dAng > Math.PI) dAng -= Math.PI * 2
  if (dAng < -Math.PI) dAng += Math.PI * 2
  const s = d1 / Math.max(d0, 1)
  const cos = s * Math.cos(dAng)
  const sin = s * Math.sin(dAng)
  const a11 = 1 - cos, a12 = sin, a21 = -sin, a22 = 1 - cos
  const det = a11 * a22 - a12 * a21
  let x = c1x, y = c1y
  if (Math.abs(det) > 1e-7) {
    const bx = c1x - (cos * c0x - sin * c0y)
    const by = c1y - (sin * c0x + cos * c0y)
    const fx = (a22 * bx - a12 * by) / det
    const fy = (-a21 * bx + a11 * by) / det
    if (fx > -400 && fx < w + 400 && fy > -400 && fy < h + 400) { x = fx; y = fy }
  }
  return { x, y, s, dAng }
}
