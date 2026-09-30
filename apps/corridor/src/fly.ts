// The fly camera: trailworks' orbit scheme, ported from ext/trailworks/viewer/src/render/OrbitKeyPan.tsx.
//
//   W/S, ↑/↓   move the orbit target (and camera) along the view heading; speed scales with the
//              camera's distance from the target, Shift sprints
//   A/D, ←/→   strafe
//   Q/E        rotate the VIEW about the camera (FPS-style yaw), not about the target
//   R/F        dolly in/out, exponential
//   T/G        raise/lower the camera about the target
//   mouse      left-drag orbits (OrbitControls), right-drag looks (yaw+pitch about the camera),
//              wheel dollies (OrbitControls, exponential)
//   the target's height eases toward the ground under it, so a flight over a ridge follows it
import * as THREE from 'three'
import * as T from './tuning'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const UP = new THREE.Vector3(0, 1, 0)

export class FlyControls {
  private keys = new Set<string>()
  private looking = false
  private lastX = 0
  private lastY = 0
  enabled = true
  /**
   * ON FOOT: the same keys and the same look, but the eye is pinned WALK_EYE above the ground
   * and moves at walking pace (Shift jogs); the dolly and lift keys do nothing. For the games
   * (walking up to a shop front), and for looking at a kerb the way a person does.
   */
  walk = false
  static WALK_EYE = 1.7
  private camera: THREE.PerspectiveCamera
  private orbit: OrbitControls
  private groundAt: (x: number, z: number) => number | null

  constructor(camera: THREE.PerspectiveCamera, orbit: OrbitControls, canvas: HTMLElement, groundAt: (x: number, z: number) => number | null) {
    this.camera = camera
    this.orbit = orbit
    this.groundAt = groundAt
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'SELECT' || (e.target as HTMLElement).tagName === 'INPUT') return
      this.keys.add(e.code)
    })
    addEventListener('keyup', (e) => this.keys.delete(e.code))
    addEventListener('blur', () => this.keys.clear())
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2 && this.enabled) {
        this.looking = true
        this.lastX = e.clientX
        this.lastY = e.clientY
        this.orbit.enabled = false
      }
    })
    addEventListener('pointerup', () => {
      if (this.looking) {
        this.looking = false
        this.orbit.enabled = this.enabled
      }
    })
    addEventListener('pointermove', (e) => {
      if (!this.looking) return
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY
      this.lastX = e.clientX
      this.lastY = e.clientY
      this.lookBy(-dx * 0.0035, -dy * 0.0035)
    })
    // right-drag look is the primary; OrbitControls keeps left = rotate about target, wheel = dolly
    orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null as unknown as THREE.MOUSE }
    orbit.zoomSpeed = 1.2
  }

  /** the pad's right stick: the same look as a right-drag, per frame */
  look(yaw: number, pitch: number): void {
    if (!this.enabled || (!yaw && !pitch)) return
    this.lookBy(yaw, pitch)
  }

  /** Rotate the view heading about the camera, FPS-style. */
  private lookBy(yaw: number, pitch: number) {
    const off = this.orbit.target.clone().sub(this.camera.position)
    off.applyAxisAngle(UP, yaw)
    const right = off.clone().cross(UP).normalize()
    const len = off.length()
    off.applyAxisAngle(right, pitch)
    // keep the target from flipping over the pole
    const el = Math.asin(THREE.MathUtils.clamp(off.y / len, -1, 1))
    if (el > 1.45 || el < -1.45) off.applyAxisAngle(right, -pitch)
    this.orbit.target.copy(this.camera.position).add(off)
  }

  /** put the eye on the ground where the camera is, keeping the look direction */
  setWalk(on: boolean) {
    this.walk = on
    if (!on) return
    const cam = this.camera, ctl = this.orbit
    const off = ctl.target.clone().sub(cam.position)
    const gy = this.groundAt(cam.position.x, cam.position.z)
    if (gy !== null) cam.position.y = gy + FlyControls.WALK_EYE
    // look level-ish from a standing height: keep the heading, flatten most of the pitch
    const len = Math.max(8, off.length())
    off.y = Math.max(-0.35, Math.min(0.2, off.y / len)) * len
    off.setLength(len)
    ctl.target.copy(cam.position).add(off)
  }

  update(dt: number) {
    if (!this.enabled) return
    const k = this.keys
    const d = Math.min(dt, 0.1)
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight')
    const fwd = Number(k.has('KeyW') || k.has('ArrowUp')) - Number(k.has('KeyS') || k.has('ArrowDown'))
    const strafe = Number(k.has('KeyD') || k.has('ArrowRight')) - Number(k.has('KeyA') || k.has('ArrowLeft'))
    const yaw = Number(k.has('KeyQ')) - Number(k.has('KeyE'))
    const cam = this.camera, ctl = this.orbit
    if (this.walk) {
      if (yaw) this.lookBy(yaw * (sprint ? 2.1 : 1.2) * d, 0)
      const off = ctl.target.clone().sub(cam.position)
      const heading = Math.atan2(off.x, off.z)
      const step = T.WALK_SPEED * (sprint ? T.WALK_SPRINT_X : 1) * d
      const mx = (Math.sin(heading) * fwd + Math.cos(heading) * strafe) * step
      const mz = (Math.cos(heading) * fwd - Math.sin(heading) * strafe) * step
      cam.position.x += mx
      cam.position.z += mz
      const gy = this.groundAt(cam.position.x, cam.position.z)
      if (gy !== null) {
        // ease onto steps and kerbs rather than snapping, but never sink below the eye height
        const want = gy + FlyControls.WALK_EYE
        cam.position.y += (want - cam.position.y) * (1 - Math.exp(-12 * d))
      }
      ctl.target.copy(cam.position).add(off)
      return
    }
    /*
     * R AND F RAISE AND LOWER. Rich, 2026-09-29: *"Can we make R and F keys raise and lower the
     * camera instead of zoom the camera in fly mode from the game"*. They were zoom, and zoom is
     * the mouse wheel's job anyway — while height is the thing you constantly want and could only
     * reach on T and G, which no other tool in this project uses for anything. The editor's flying
     * camera has been R/F for height since it was written, and two cameras in one product with the
     * same keys doing different things is worse than either choice.
     *
     * The old pair keeps zoom, so nothing that could be done can no longer be done.
     */
    const lift = Number(k.has('KeyR')) - Number(k.has('KeyF'))
    const zoom = Number(k.has('KeyG')) - Number(k.has('KeyT'))
    if (yaw) this.lookBy(yaw * T.FLY_LOOK * (sprint ? T.FLY_SPRINT_X : 1) * d, 0)
    if (zoom) {
      const f = Math.exp(zoom * T.FLY_ZOOM * (sprint ? T.FLY_SPRINT_X : 1) * d)
      cam.position.sub(ctl.target).multiplyScalar(f).add(ctl.target)
    }
    if (lift) {
      const dist = cam.position.distanceTo(ctl.target)
      cam.position.y += lift * Math.max(dist, T.FLY_LIFT_FLOOR_M) * T.FLY_LIFT * (sprint ? T.FLY_SPRINT_X : 1) * d
    }
    let nx = ctl.target.x, nz = ctl.target.z
    if (fwd || strafe) {
      const dist = cam.position.distanceTo(ctl.target)
      // THE FLOOR IS WHAT MAKES IT FEEL FAST. Speed scales with how far the camera is from its
      // target — right, because a view from 2 km wants to cross 2 km — but the floor means that
      // down at street level it still moves at FLY_SPEED_FLOOR_M × FLY_SPEED metres a second
      // whatever the zoom says. At the old fixed 40 m that was 32 m/s, or 72 mph, a foot off the
      // kerb (Rich, 2026-09-27: "right now it feels too fast"). Lower the floor to slow down
      // near the ground without making a high pass sluggish.
      const step = Math.max(dist, T.FLY_SPEED_FLOOR_M) * T.FLY_SPEED * (sprint ? T.FLY_SPRINT_X : 1) * d
      const heading = Math.atan2(cam.position.x - ctl.target.x, cam.position.z - ctl.target.z)
      nx += (-Math.sin(heading) * fwd + Math.cos(heading) * strafe) * step
      nz += (-Math.cos(heading) * fwd - Math.sin(heading) * strafe) * step
      cam.position.x += nx - ctl.target.x
      cam.position.z += nz - ctl.target.z
    }
    // the target rides the ground; the camera keeps its offset
    const gy = this.groundAt(nx, nz)
    if (gy !== null) {
      const ease = 1 - Math.exp(-2.5 * d)
      const ny = ctl.target.y + (gy - ctl.target.y) * ease
      cam.position.y += ny - ctl.target.y
      ctl.target.set(nx, ny, nz)
    } else ctl.target.set(nx, ctl.target.y, nz)
    // never below the ground under the camera
    const cy = this.groundAt(cam.position.x, cam.position.z)
    if (cy !== null && cam.position.y < cy + T.CAM_MIN_HEIGHT) cam.position.y = cy + T.CAM_MIN_HEIGHT
  }
}

/**
 * Put the eye on the road: nearest point of the carriageway spline to where the camera is now, at
 * CAM_SIT_HEIGHT above the surface, looking along the road. The view from a driver's eye without
 * having to drive — which is the one that tells you whether the paint, the shoulder and the verge
 * are the right size.
 *
 * The camera's near plane is 0.5 m and the vertical fov 60 degrees, so the ground first enters the
 * frustum 0.5 / sin(30 deg) = 1.0 m ahead of the eye horizontally; at any eye height above 0.25 m
 * the road surface is drawn right up to the bottom of the frame and nothing is clipped. Both
 * CAM_MIN_HEIGHT (0.4) and CAM_SIT_HEIGHT are comfortably above that.
 */
export function sitOnRoad(
  camera: THREE.PerspectiveCamera,
  orbit: { target: THREE.Vector3; update: () => void },
  spineAt: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 },
  length: number,
): void {
  let best = Infinity, bs = 0
  for (let s = 0; s <= length; s += 2) {
    const p = spineAt(s)
    const d = (p.pos.x - camera.position.x) ** 2 + (p.pos.z - camera.position.z) ** 2
    if (d < best) { best = d; bs = s }
  }
  for (let s = Math.max(0, bs - 2); s <= Math.min(length, bs + 2); s += 0.25) {
    const p = spineAt(s)
    const d = (p.pos.x - camera.position.x) ** 2 + (p.pos.z - camera.position.z) ** 2
    if (d < best) { best = d; bs = s }
  }
  const p = spineAt(bs)
  const dir = p.dir.clone().setY(0).normalize()
  camera.up.set(0, 1, 0)
  camera.position.set(p.pos.x, p.pos.y + T.CAM_SIT_HEIGHT, p.pos.z)
  const ahead = spineAt(Math.min(length, bs + 40))
  orbit.target.set(ahead.pos.x, ahead.pos.y + T.CAM_SIT_HEIGHT * 0.6, ahead.pos.z)
  if (orbit.target.distanceTo(camera.position) < 1) orbit.target.copy(camera.position).addScaledVector(dir, 40)
  orbit.update()
}
