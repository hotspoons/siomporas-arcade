// The roof laser's beam: a stretched additive quad pair from the mount to the
// target, plus a flare at the hit point. Hitscan, so the beam is drawn
// instantly and fades over a few frames when fire stops.

import { AdditiveBlending, CylinderGeometry, Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three'
import type { SimSnapshot } from '../../sim/SimSnapshot'

export class LaserBeam {
  readonly root = new Group()
  private readonly beam: Mesh
  private readonly core: Mesh
  private readonly flare: Mesh
  private readonly beamMat: MeshBasicMaterial
  private readonly coreMat: MeshBasicMaterial
  private readonly flareMat: MeshBasicMaterial
  private readonly a = new Vector3()
  private readonly b = new Vector3()
  private readonly mid = new Vector3()
  private readonly up = new Vector3(0, 1, 0)
  private fade = 0

  constructor() {
    this.beamMat = new MeshBasicMaterial({ color: 0x3cf5ff, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false })
    this.coreMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false })
    this.flareMat = new MeshBasicMaterial({ color: 0xbfffff, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false })
    const geo = new CylinderGeometry(1, 1, 1, 6, 1, true).rotateX(Math.PI / 2)
    this.beam = new Mesh(geo, this.beamMat)
    this.core = new Mesh(geo, this.coreMat)
    this.flare = new Mesh(new SphereGeometry(1, 8, 6), this.flareMat)
    this.root.add(this.beam, this.core, this.flare)
    this.root.visible = false
  }

  update(snap: SimSnapshot, dt: number, time: number): void {
    if (snap.laserFiring) this.fade = 1
    else this.fade = Math.max(0, this.fade - dt * 12)
    this.root.visible = this.fade > 0.02
    if (!this.root.visible) return
    this.a.set(snap.laserFrom.x, snap.laserFrom.y, snap.laserFrom.z)
    this.b.set(snap.laserTo.x, snap.laserTo.y, snap.laserTo.z)
    const len = this.a.distanceTo(this.b)
    this.mid.copy(this.a).lerp(this.b, 0.5)
    const flicker = 0.85 + 0.15 * Math.sin(time * 90)
    for (const [mesh, radius] of [
      [this.beam, 0.45],
      [this.core, 0.12],
    ] as const) {
      mesh.position.copy(this.mid)
      mesh.up.copy(this.up)
      mesh.lookAt(this.b)
      mesh.scale.set(radius * flicker, radius * flicker, len)
    }
    this.beamMat.opacity = 0.35 * this.fade
    this.coreMat.opacity = 0.9 * this.fade
    this.flare.visible = snap.laserHit && snap.laserFiring
    if (this.flare.visible) {
      this.flare.position.copy(this.b)
      const s = 1.6 + Math.random() * 0.8
      this.flare.scale.set(s, s, s)
    }
  }
}
