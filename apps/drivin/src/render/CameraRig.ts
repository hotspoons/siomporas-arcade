// Cameras: chase (follows the car's up, so loops turn the world over), hood,
// trackside replay, and an orbiting overview for the editor's test view.

import { PerspectiveCamera, Vector3 } from 'three'
import { expApproach } from '@apex/engine/math/scalar'
import type { Snapshot } from '../sim/Snapshot'
import { CAM_BACK, CAM_LOOK_AHEAD, CAM_POS_RATE, CAM_UP, CAM_UP_RATE, FOV_AT_TOP_SPEED, FOV_BASE } from './RenderTuning'

export type CameraMode = 'chase' | 'hood' | 'orbit'

export class CameraRig {
  readonly camera: PerspectiveCamera
  mode: CameraMode = 'chase'
  /** Multiplier on FOV kick / shake. */
  effectGain = 1
  shake = 0
  orbitAngle = 0
  private readonly pos = new Vector3()
  private readonly look = new Vector3()
  private readonly up = new Vector3(0, 1, 0)
  private readonly smoothPos = new Vector3()
  private readonly smoothLook = new Vector3()
  private readonly carPos = new Vector3()
  private readonly carFwd = new Vector3()
  private readonly carUp = new Vector3()
  private readonly tmp = new Vector3()
  private fov = FOV_BASE
  private initialised = false
  private time = 0

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(FOV_BASE, aspect, 0.2, 6000)
  }

  reset(): void {
    this.initialised = false
    this.shake = 0
  }

  addShake(a: number): void {
    this.shake = Math.min(1.5, this.shake + a * this.effectGain)
  }

  update(snap: Snapshot, dt: number, topSpeed: number): void {
    this.time += dt
    const c = snap.car
    this.carPos.set(c.pos.x, c.pos.y, c.pos.z)
    this.carFwd.set(c.forward.x, c.forward.y, c.forward.z)
    this.carUp.set(c.up.x, c.up.y, c.up.z)
    const cam = this.camera

    if (snap.phase === 'replay') {
      cam.position.set(snap.replayCam.x, snap.replayCam.y, snap.replayCam.z)
      cam.up.set(0, 1, 0)
      cam.lookAt(this.carPos)
      cam.fov = 40
      cam.updateProjectionMatrix()
      this.initialised = false
      return
    }

    if (this.mode === 'orbit') {
      this.orbitAngle += dt * 0.25
      this.pos.set(this.carPos.x + Math.cos(this.orbitAngle) * 60, this.carPos.y + 35, this.carPos.z + Math.sin(this.orbitAngle) * 60)
      this.look.copy(this.carPos)
      this.up.set(0, 1, 0)
    } else if (this.mode === 'hood') {
      this.pos.copy(this.carPos).addScaledVector(this.carFwd, 1.2).addScaledVector(this.carUp, 0.9)
      this.look.copy(this.carPos).addScaledVector(this.carFwd, 30).addScaledVector(this.carUp, 0.6)
      this.up.copy(this.carUp)
    } else {
      // Chase: behind and above in the car's own frame; up follows the car's up with lag.
      // Inside loops and corkscrews the car's up leaves vertical: pull the camera in
      // so it stays inside the curve instead of staring at the road's underside.
      const tight = 1 - Math.max(0, Math.min(1, (0.85 - this.carUp.y) / 0.6))
      const back = CAM_BACK * (0.5 + 0.5 * tight)
      const upOff = CAM_UP * (0.55 + 0.45 * tight)
      this.pos.copy(this.carPos).addScaledVector(this.carFwd, -back).addScaledVector(this.carUp, upOff)
      this.look.copy(this.carPos).addScaledVector(this.carFwd, CAM_LOOK_AHEAD).addScaledVector(this.carUp, 0.8)
      const k = 1 - Math.exp(-CAM_UP_RATE * dt)
      this.up.lerp(this.carUp, this.initialised ? k : 1).normalize()
    }
    if (!this.initialised) {
      this.smoothPos.copy(this.pos)
      this.smoothLook.copy(this.look)
      this.initialised = true
    }
    const kp = 1 - Math.exp(-CAM_POS_RATE * dt)
    this.smoothPos.lerp(this.pos, this.mode === 'hood' ? 1 : kp)
    this.smoothLook.lerp(this.look, this.mode === 'hood' ? 1 : 1 - Math.exp(-18 * dt))
    if (this.shake > 0.001) {
      const a = this.shake * 0.25
      this.tmp.set(Math.sin(this.time * 61.3) * a, Math.sin(this.time * 47.7 + 1.3) * a * 0.6, Math.sin(this.time * 53.1 + 2.1) * a * 0.4)
      this.smoothPos.add(this.tmp)
      this.shake = expApproach(this.shake, 0, 5, dt)
    }
    cam.position.copy(this.smoothPos)
    cam.up.copy(this.up)
    cam.lookAt(this.smoothLook)
    const t = Math.min(1.2, Math.abs(c.speed) / topSpeed)
    const target = this.mode === 'orbit' ? 55 : FOV_BASE + (FOV_AT_TOP_SPEED - FOV_BASE) * t * this.effectGain
    this.fov = expApproach(this.fov, target, 5, dt)
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov
      cam.updateProjectionMatrix()
    }
  }
}
