// Chase camera. Its theta chases the craft's around the tube with lag — the
// wall you ride is always "down", and a hard roll swings the world before the
// view catches up. Adopts a fraction of the craft's bank, kicks FOV with speed,
// shakes on impacts. Airborne it trails the craft's velocity and eases its up
// vector toward world-up.

import { Object3D, PerspectiveCamera, Vector3 } from 'three'
import { angleDelta, clamp, expApproach } from '../sim/math/scalar'
import { Vec3 } from '../sim/math/Vec3'
import { SPEED_CRUISE, SPEED_MAX, VEHICLE_HOVER } from '../sim/Tuning'
import type { Track } from '../sim/track/Track'
import { makeFrame } from '../sim/track/TrackSpline'
import type { VehicleSnap } from '../sim/SimSnapshot'
import {
  CAM_BACK,
  CAM_BANK_FOLLOW,
  CAM_LOOK_AHEAD,
  CAM_SHAKE_AMPLITUDE,
  CAM_SHAKE_DECAY,
  CAM_THETA_LAG,
  CAM_UP,
  FOV_AT_MAX_SPEED,
  FOV_BASE,
  FOV_BOOST_KICK,
} from './RenderTuning'

export class CameraRig {
  readonly camera: PerspectiveCamera
  /** In XR the rig drives this parent; the runtime drives the camera inside it. */
  xrRig: Object3D | null = null
  /** XR only: 0 = up stays world-stable, 1 = up follows the tube like the 2D chase view. */
  xrRollBlend = 0
  /** Multiplier on FOV kick / shake (VISUAL_SPEED_GAIN, reduced motion). */
  effectGain = 1
  /** When false (XR), FOV is left to the runtime and roll is blended out. */
  controlsProjection = true
  rollBlend = 1
  shake = 0
  private camTheta = 0
  private fov = FOV_BASE
  private readonly frame = makeFrame()
  private readonly vA = new Vec3()
  private readonly vB = new Vec3()
  private readonly pos = new Vector3()
  private readonly look = new Vector3()
  private readonly up = new Vector3()
  private readonly smoothLook = new Vector3()
  private readonly smoothPos = new Vector3()
  private readonly worldUp = new Vector3(0, 1, 0)
  private initialised = false
  private time = 0

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(FOV_BASE, aspect, 0.3, 4000)
  }

  reset(theta: number): void {
    this.camTheta = theta
    this.initialised = false
    this.shake = 0
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount * this.effectGain)
  }

  update(v: VehicleSnap, track: Track, dt: number, boostGlow: number): void {
    this.time += dt
    const cam = this.camera
    const lag = 1 - Math.exp(-CAM_THETA_LAG * dt)
    this.camTheta += angleDelta(this.camTheta, v.theta) * lag

    if (v.airborne) {
      // Trail behind the flight path; ease up toward world up.
      this.pos.set(v.pos.x, v.pos.y, v.pos.z)
      this.pos.addScaledVector(toV3(v.forward, this.vA, tmpA), -CAM_BACK * 1.15)
      this.pos.addScaledVector(toV3(v.up, this.vA, tmpB), CAM_UP)
      this.look.set(v.pos.x, v.pos.y, v.pos.z).addScaledVector(tmpA, CAM_LOOK_AHEAD)
      this.up.copy(tmpB).lerp(this.worldUp, 0.5).normalize()
    } else {
      const f = track.frameAt(v.s - CAM_BACK, v.branch, this.frame)
      const c = Math.cos(this.camTheta)
      const sn = Math.sin(this.camTheta)
      this.vA.set(f.nor.x * c + f.bin.x * sn, f.nor.y * c + f.bin.y * sn, f.nor.z * c + f.bin.z * sn)
      // Keep the camera inside the tube regardless of radius.
      const lift = Math.min(CAM_UP + VEHICLE_HOVER, f.radius * 0.55)
      this.pos.set(f.pos.x + this.vA.x * (f.radius - lift), f.pos.y + this.vA.y * (f.radius - lift), f.pos.z + this.vA.z * (f.radius - lift))
      this.up.set(-this.vA.x, -this.vA.y, -this.vA.z)
      const fl = track.frameAt(v.s + CAM_LOOK_AHEAD, v.branch, this.frame)
      const c2 = Math.cos(v.theta)
      const sn2 = Math.sin(v.theta)
      this.vB.set(fl.nor.x * c2 + fl.bin.x * sn2, fl.nor.y * c2 + fl.bin.y * sn2, fl.nor.z * c2 + fl.bin.z * sn2)
      const lookLift = Math.min(VEHICLE_HOVER + 2.5, fl.radius * 0.4)
      this.look.set(fl.pos.x + this.vB.x * (fl.radius - lookLift), fl.pos.y + this.vB.y * (fl.radius - lookLift), fl.pos.z + this.vB.z * (fl.radius - lookLift))
    }

    if (!this.initialised) {
      this.smoothPos.copy(this.pos)
      this.smoothLook.copy(this.look)
      this.initialised = true
    }
    // Position follows exactly (theta lag already gives the swing); look point is softened.
    this.smoothPos.copy(this.pos)
    this.smoothLook.lerp(this.look, 1 - Math.exp(-14 * dt))

    // Shake: decaying pseudo-random jitter.
    if (this.shake > 0.001) {
      const a = this.shake * CAM_SHAKE_AMPLITUDE
      const t = this.time
      tmpA.set(Math.sin(t * 61.3) * a, Math.sin(t * 47.7 + 1.3) * a * 0.7, Math.sin(t * 53.1 + 2.1) * a * 0.4)
      this.smoothPos.add(tmpA)
      this.shake = expApproach(this.shake, 0, CAM_SHAKE_DECAY, dt)
    }

    tmpA.copy(this.smoothLook).sub(this.smoothPos).normalize()
    if (this.xrRig) {
      // Comfort: blend the up vector toward world-up (default fully world-stable).
      tmpB.copy(this.worldUp).projectOnPlane(tmpA).normalize()
      if (tmpB.lengthSq() < 1e-6) tmpB.copy(this.up)
      this.up.lerp(tmpB, 1 - this.xrRollBlend).normalize()
      const rig = this.xrRig
      rig.position.copy(this.smoothPos)
      rig.up.copy(this.up)
      rig.lookAt(this.smoothLook)
      return
    }
    cam.position.copy(this.smoothPos)
    // Bank follow: roll the up vector around the view direction.
    if (this.rollBlend > 0) {
      const roll = v.bank * CAM_BANK_FOLLOW * this.rollBlend
      if (Math.abs(roll) > 1e-4) this.up.applyAxisAngle(tmpA, roll)
    }
    cam.up.copy(this.up)
    cam.lookAt(this.smoothLook)

    if (this.controlsProjection) {
      const speedT = clamp((v.speed - SPEED_CRUISE) / (SPEED_MAX - SPEED_CRUISE), -0.5, 1.2)
      const target = FOV_BASE + (FOV_AT_MAX_SPEED - FOV_BASE) * speedT * this.effectGain + FOV_BOOST_KICK * boostGlow * this.effectGain
      this.fov = expApproach(this.fov, target, 6, dt)
      if (Math.abs(cam.fov - this.fov) > 0.01) {
        cam.fov = this.fov
        cam.updateProjectionMatrix()
      }
    }
  }
}

const tmpA = new Vector3()
const tmpB = new Vector3()

function toV3(v: Vec3, _scratch: Vec3, out: Vector3): Vector3 {
  return out.set(v.x, v.y, v.z)
}
