// The fly camera: trailworks' orbit scheme, ported from ext/trailworks/viewer/src/render/OrbitKeyPan.tsx.
//
//   W/S, ↑/↓   move the orbit target (and camera) along the view heading; speed scales with the
//              camera's distance from the target, Shift sprints
//   A/D, ←/→   strafe
//   Q/E        rotate the VIEW about the camera (FPS-style yaw), not about the target
//   R/F        raise/lower the camera (pure height: the target moves with it)
//   T/G        dolly in/out, exponential (zoom)
//   mouse      left-drag orbits (OrbitControls), right-drag looks (yaw+pitch about the camera),
//              wheel dollies (OrbitControls, exponential)
//   the target rides the CHANGE in the ground under it, so a flight over a ridge follows it without
//   the target's height -- which is the look direction -- being pulled down to the dirt
import * as THREE from 'three'
import * as T from '../../tuning'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const UP = new THREE.Vector3(0, 1, 0)

export class FlyControls {
  private keys = new Set<string>()
  private looking = false
  private lastX = 0
  private lastY = 0
  /** the ground under the target last frame, for following terrain WITHOUT touching the pitch */
  private lastGround = 0
  private groundSeen = false
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
    // Keep the target off the pole. `right` is horizontal and perpendicular to `off`, so rotating
    // about it moves `off` on a vertical great circle and the elevation changes by exactly the
    // rotation. Pre-clamp the ROTATION to the limit: if we applied the full pitch and then fixed
    // up the wrapped result, a hard hold on "look up" would sail past vertical and come back down
    // the far side. The old code undid the whole pitch instead, which stuck and jittered.
    const LIM = 1.45
    const e0 = Math.asin(THREE.MathUtils.clamp(off.y / len, -1, 1))
    off.applyAxisAngle(right, THREE.MathUtils.clamp(pitch, -LIM - e0, LIM - e0))
    this.orbit.target.copy(this.camera.position).add(off)
  }

  /** put the eye on the ground where the camera is, keeping the look direction */
  setWalk(on: boolean) {
    this.walk = on
    // the walk branch owns the ground; do not let a stale height follow us back into the air
    this.groundSeen = false
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
      // A PURE VERTICAL MOVE, not a dolly. Raising only the camera's Y leaves the target where it
      // is, so the distance to it changes and the view reads as a zoom -- which is exactly why R/F
      // and T/G felt like the same control. Move the target by the same amount so the view direction
      // is untouched and R/F is genuinely "up/down". (Rich, 2026-10-03)
      const dy = lift * Math.max(dist, T.FLY_LIFT_FLOOR_M) * T.FLY_LIFT * (sprint ? T.FLY_SPRINT_X : 1) * d
      cam.position.y += dy
      ctl.target.y += dy
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
    /*
     * THE CAMERA RIDES THE TERRAIN BY THE CHANGE IN THE GROUND UNDER IT.
     *
     * Rich, 2026-10-03: "you get stuck in the grass and can't see anything when you try to look
     * up." The old code eased target.y toward the ground under it every frame. But target.y IS the
     * look direction: pitch the view up and a few frames later the target had sunk to the dirt,
     * dragging the camera down onto the 0.4 m floor with it, so an upward look was impossible.
     *
     * Following the CAMERA'S OWN ground change keeps the promise the old code was reaching for --
     * fly forward over a ridge and the view rides up with it -- because the camera moves sideways
     * only when you translate (the `cam.position.x`/`.z` step above). Move the camera by the ground
     * delta and the target by the same delta and the pitch is untouched; a look swings the target
     * along its sphere but does not move the camera at all, so it sees a ground delta of zero and
     * changes nothing.
     */
    const gy = this.groundAt(cam.position.x, cam.position.z)
    if (gy !== null) {
      // a big jump in the ground under the camera is a teleport, not a flight: restart the track
      // rather than yanking the view by the difference
      const dy = this.groundSeen && Math.abs(gy - this.lastGround) < 100 ? gy - this.lastGround : 0
      this.lastGround = gy
      this.groundSeen = true
      cam.position.y += dy
      ctl.target.set(nx, ctl.target.y + dy, nz)
    } else {
      this.groundSeen = false
      ctl.target.set(nx, ctl.target.y, nz)
    }
    // NEVER BELOW THE GROUND UNDER THE CAMERA -- and when the floor catches it, lift the target
    // with the camera, so being kept out of the dirt does not pitch the view down instead.
    const cy = this.groundAt(cam.position.x, cam.position.z)
    if (cy !== null) {
      const floor = cy + T.CAM_MIN_HEIGHT
      if (cam.position.y < floor) {
        const lift = floor - cam.position.y
        cam.position.y = floor
        ctl.target.y += lift
      }
    }
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
 * CAM_MIN_HEIGHT (1.0) and CAM_SIT_HEIGHT are comfortably above that.
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
