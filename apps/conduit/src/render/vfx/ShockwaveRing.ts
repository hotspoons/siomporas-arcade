// The shockwave: a bright ring that races down the tunnel from the craft,
// scaled to the local tube radius, fading as it goes.

import { AdditiveBlending, DoubleSide, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three'
import type { SimSnapshot } from '../../sim/SimSnapshot'
import type { Track } from '../../sim/track/Track'
import { makeFrame } from '../../sim/track/TrackSpline'
import { SHOCKWAVE_RADIUS } from '../../sim/Tuning'

/** How long the wave takes to sweep SHOCKWAVE_RADIUS metres. */
const SWEEP_TIME = 0.55

export class ShockwaveRing {
  readonly mesh: Mesh
  private readonly mat: MeshBasicMaterial
  private readonly frame = makeFrame()
  private readonly p = new Vector3()
  private readonly look = new Vector3()
  private readonly up = new Vector3()

  constructor() {
    this.mat = new MeshBasicMaterial({ color: 0xff7ae0, transparent: true, opacity: 0.8, side: DoubleSide, blending: AdditiveBlending, depthWrite: false })
    this.mesh = new Mesh(new RingGeometry(0.82, 1, 48), this.mat)
    this.mesh.visible = false
    this.mesh.frustumCulled = false
  }

  update(snap: SimSnapshot, track: Track): void {
    const age = snap.shockAge
    if (age < 0 || age > SWEEP_TIME) {
      this.mesh.visible = false
      return
    }
    this.mesh.visible = true
    const t = age / SWEEP_TIME
    const s = snap.vehicle.s + t * SHOCKWAVE_RADIUS
    const f = track.frameAt(s, snap.vehicle.branch, this.frame)
    this.p.set(f.pos.x, f.pos.y, f.pos.z)
    this.look.set(f.pos.x + f.tan.x, f.pos.y + f.tan.y, f.pos.z + f.tan.z)
    this.up.set(-f.nor.x, -f.nor.y, -f.nor.z)
    this.mesh.position.copy(this.p)
    this.mesh.up.copy(this.up)
    this.mesh.lookAt(this.look)
    const r = f.radius * (1.05 + t * 0.15)
    this.mesh.scale.set(r, r, 1)
    this.mat.opacity = 0.9 * (1 - t) * (1 - t)
  }
}
