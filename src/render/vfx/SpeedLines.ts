// Streaks living in a shell around the camera in track space, stretched along
// the tangent by speed. They recycle themselves as they fall behind. Intensity
// (VISUAL_SPEED_GAIN) scales opacity and length, never gameplay.

import { AdditiveBlending, InstancedMesh, Matrix4, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three'
import { angleDelta } from '../../sim/math/scalar'
import { Vec3 } from '../../sim/math/Vec3'
import { Track } from '../../sim/track/Track'
import { makeFrame } from '../../sim/track/TrackSpline'
import { SPEED_MAX } from '../../sim/Tuning'
import { SPEED_LINE_COUNT, SPEED_LINE_MIN_SPEED } from '../RenderTuning'

export class SpeedLines {
  readonly mesh: InstancedMesh
  readonly material: MeshBasicMaterial
  gain = 1
  private readonly s = new Float32Array(SPEED_LINE_COUNT)
  private readonly theta = new Float32Array(SPEED_LINE_COUNT)
  private readonly lift = new Float32Array(SPEED_LINE_COUNT)
  private readonly frame = makeFrame()
  private readonly vA = new Vec3()
  private readonly p = new Vector3()
  private readonly x = new Vector3()
  private readonly m = new Matrix4()
  private readonly scale = new Vector3()
  private readonly z = new Vector3()
  private readonly tan = new Vector3()
  private seeded = false

  constructor() {
    this.material = new MeshBasicMaterial({ color: 0x9be8ff, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false })
    this.mesh = new InstancedMesh(new PlaneGeometry(0.08, 1), this.material, SPEED_LINE_COUNT)
    this.mesh.frustumCulled = false
  }

  private seed(track: Track, s0: number): void {
    for (let i = 0; i < SPEED_LINE_COUNT; i++) this.respawn(track, i, s0 + Math.random() * 160)
    this.seeded = true
  }

  private respawn(track: Track, i: number, s: number): void {
    this.s[i] = s
    this.theta[i] = Math.random() * Math.PI * 2
    const r = track.frameAt(s, 0, this.frame).radius
    this.lift[i] = r * (0.06 + Math.random() * 0.3)
  }

  update(track: Track, camS: number, branch: number, speed: number, airborne: boolean, camTheta: number): void {
    if (!this.seeded) this.seed(track, camS)
    const t = Math.max(0, (speed - SPEED_LINE_MIN_SPEED) / (SPEED_MAX - SPEED_LINE_MIN_SPEED))
    const intensity = Math.min(1.3, t) * this.gain
    this.material.opacity = airborne ? 0.12 * intensity : 0.55 * intensity
    this.mesh.visible = intensity > 0.02
    if (!this.mesh.visible) return
    const len = 6 + 34 * intensity
    for (let i = 0; i < SPEED_LINE_COUNT; i++) {
      if (this.s[i] < camS - 4 || this.s[i] > camS + 220) this.respawn(track, i, camS + 30 + Math.random() * 170)
      // Never let a streak pass through the camera itself.
      if (Math.abs(angleDelta(this.theta[i], camTheta)) < 0.55) this.theta[i] = camTheta + Math.PI + (Math.random() - 0.5) * 4
      const f = track.frameAt(this.s[i], branch, this.frame)
      Track.radial(f, this.theta[i], this.vA)
      this.p.set(f.pos.x + this.vA.x * (f.radius - this.lift[i]), f.pos.y + this.vA.y * (f.radius - this.lift[i]), f.pos.z + this.vA.z * (f.radius - this.lift[i]))
      // Plane's long axis (Y) along the tangent, normal facing the tube centre.
      this.tan.set(f.tan.x, f.tan.y, f.tan.z)
      this.z.set(-this.vA.x, -this.vA.y, -this.vA.z)
      this.x.crossVectors(this.tan, this.z).normalize()
      this.m.makeBasis(this.x, this.tan, this.z)
      this.scale.set(1, len, 1)
      this.m.scale(this.scale)
      this.m.setPosition(this.p)
      this.mesh.setMatrixAt(i, this.m)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }
}
