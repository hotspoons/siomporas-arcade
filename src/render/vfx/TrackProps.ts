// Pooled meshes for authored track features: checkpoint gate arches and
// flight rings. Both are placed from Track data inside the visible window.

import { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, TorusGeometry, Vector3 } from 'three'
import type { Track } from '../../sim/track/Track'
import { makeFrame } from '../../sim/track/TrackSpline'
import { GATE_POOL, RING_POOL } from '../RenderTuning'

export class TrackProps {
  readonly root = new Group()
  private readonly gates: Mesh[] = []
  private readonly rings: Mesh[] = []
  private readonly gateMat: MeshStandardMaterial
  private readonly gatePassedMat: MeshStandardMaterial
  private readonly ringMat: MeshBasicMaterial
  private readonly frame = makeFrame()
  private readonly p = new Vector3()
  private readonly look = new Vector3()
  private readonly up = new Vector3()

  constructor() {
    this.gateMat = new MeshStandardMaterial({ color: 0x4df5ff, emissive: 0x25c8ff, emissiveIntensity: 1.8, metalness: 0.4, roughness: 0.4, flatShading: true })
    this.gatePassedMat = new MeshStandardMaterial({ color: 0x224455, emissive: 0x112233, emissiveIntensity: 0.6, flatShading: true })
    this.ringMat = new MeshBasicMaterial({ color: 0xffd45f })
    for (let i = 0; i < GATE_POOL; i++) {
      const m = new Mesh(new TorusGeometry(1, 0.06, 6, 24), this.gateMat)
      m.visible = false
      this.gates.push(m)
      this.root.add(m)
    }
    for (let i = 0; i < RING_POOL; i++) {
      const m = new Mesh(new TorusGeometry(7, 0.35, 6, 20), this.ringMat)
      m.visible = false
      this.rings.push(m)
      this.root.add(m)
    }
  }

  update(track: Track, s: number, gatesPassed: number, ringTaken: (i: number) => boolean, time: number): void {
    // Gates within the window.
    let gi = 0
    for (let i = 0; i < track.gates.length && gi < GATE_POOL; i++) {
      const gs = track.gates[i]
      if (gs < s - 150 || gs > s + 2000) continue
      const m = this.gates[gi++]
      const f = track.frameAt(gs, 0, this.frame)
      this.p.set(f.pos.x, f.pos.y, f.pos.z)
      this.look.set(f.pos.x + f.tan.x, f.pos.y + f.tan.y, f.pos.z + f.tan.z)
      this.up.set(-f.nor.x, -f.nor.y, -f.nor.z)
      m.position.copy(this.p)
      m.up.copy(this.up)
      m.lookAt(this.look)
      const r = f.radius * 0.94
      m.scale.set(r, r, 1 + 0.3 * Math.sin(time * 4))
      m.material = i < gatesPassed ? this.gatePassedMat : this.gateMat
      m.visible = true
    }
    for (; gi < GATE_POOL; gi++) this.gates[gi].visible = false
    // Flight rings.
    let ri = 0
    for (let i = 0; i < track.rings.length && ri < RING_POOL; i++) {
      const r = track.rings[i]
      if (r.s < s - 100 || r.s > s + 1500 || ringTaken(i)) continue
      const m = this.rings[ri++]
      const f = track.frameAt(r.s, 0, this.frame)
      m.position.set(r.pos.x, r.pos.y, r.pos.z)
      this.look.set(r.pos.x + f.tan.x, r.pos.y + f.tan.y, r.pos.z + f.tan.z)
      this.up.set(-f.nor.x, -f.nor.y, -f.nor.z)
      m.up.copy(this.up)
      m.lookAt(this.look)
      m.rotateZ(time * 1.5)
      m.visible = true
    }
    for (; ri < RING_POOL; ri++) this.rings[ri].visible = false
  }
}
