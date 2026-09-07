// One InstancedMesh per traffic kind, filled from the snapshot each frame.
// Instances interpolate between prev and curr when the slot holds the same
// agent id. Hit flash and health tint go through instanceColor.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  Material,
  Matrix4,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  SphereGeometry,
  Vector3,
} from 'three'
import { SimSnapshot, TRAFFIC_KIND_CODES } from '../sim/SimSnapshot'
import { MAX_TRAFFIC } from '../sim/Tuning'

interface KindLook {
  geometry: BufferGeometry
  color: number
  emissive: number
  metal: number
}

const LOOKS: Record<string, KindLook> = {
  DRONE: { geometry: new OctahedronGeometry(2.3, 0), color: 0x4de1ff, emissive: 0x0d5a7a, metal: 0.6 },
  BLOCKER: { geometry: new BoxGeometry(8.4, 2.4, 3.2), color: 0xffb020, emissive: 0x6a3d00, metal: 0.5 },
  MINE: { geometry: new IcosahedronGeometry(2.0, 0), color: 0xff3b5c, emissive: 0x7a0a1e, metal: 0.3 },
  INTERCEPTOR: { geometry: new ConeGeometry(2.2, 5.2, 5).rotateX(Math.PI / 2), color: 0xc46bff, emissive: 0x4a1a7a, metal: 0.7 },
  ARMORED: { geometry: new BoxGeometry(5.4, 3.2, 7.4), color: 0x8a9bb0, emissive: 0x1a2a3a, metal: 0.9 },
  GATE_BOSS: { geometry: new DodecahedronGeometry(6.4, 0), color: 0xff6a3c, emissive: 0x7a1e00, metal: 0.6 },
  POD_SHOCK: { geometry: new SphereGeometry(2.2, 10, 8), color: 0xff5fd2, emissive: 0xaa2090, metal: 0.1 },
  POD_SHIELD: { geometry: new SphereGeometry(2.2, 10, 8), color: 0x5cff8a, emissive: 0x20aa50, metal: 0.1 },
}

const KINDS = Object.keys(LOOKS)

export class TrafficRenderer {
  readonly root = new Object3D()
  private readonly meshes = new Map<number, InstancedMesh>()
  private readonly modern = new Map<number, Material>()
  private readonly retro = new Map<number, Material>()
  private readonly m = new Matrix4()
  private readonly p = new Vector3()
  private readonly up = new Vector3()
  private readonly fwd = new Vector3()
  private readonly right = new Vector3()
  private readonly scale = new Vector3()
  private readonly color = new Color()
  private readonly white = new Color(1, 1, 1)
  private readonly base = new Map<number, Color>()

  constructor() {
    for (const kind of KINDS) {
      const code = TRAFFIC_KIND_CODES.indexOf(kind as (typeof TRAFFIC_KIND_CODES)[number])
      const look = LOOKS[kind]
      const modern = new MeshStandardMaterial({ color: 0xffffff, emissive: look.emissive, emissiveIntensity: 1.2, metalness: look.metal, roughness: 0.4, flatShading: true })
      const retro = new MeshLambertMaterial({ color: 0xffffff, emissive: look.emissive, emissiveIntensity: 0.8, flatShading: true })
      const mesh = new InstancedMesh(look.geometry, modern, MAX_TRAFFIC)
      mesh.count = 0
      mesh.frustumCulled = false
      this.meshes.set(code, mesh)
      this.modern.set(code, modern)
      this.retro.set(code, retro)
      this.base.set(code, new Color(look.color))
      this.root.add(mesh)
    }
  }

  setRetro(retro: boolean): void {
    for (const [code, mesh] of this.meshes) mesh.material = (retro ? this.retro : this.modern).get(code)!
  }

  update(prev: SimSnapshot, curr: SimSnapshot, alpha: number): void {
    for (const mesh of this.meshes.values()) mesh.count = 0
    for (let i = 0; i < MAX_TRAFFIC; i++) {
      if (!curr.trafficActive[i]) continue
      const kind = curr.trafficKind[i]
      const mesh = this.meshes.get(kind)
      if (!mesh) continue
      const same = prev.trafficActive[i] && prev.trafficId[i] === curr.trafficId[i]
      const k = i * 3
      if (same) {
        this.p.set(
          prev.trafficPos[k] + (curr.trafficPos[k] - prev.trafficPos[k]) * alpha,
          prev.trafficPos[k + 1] + (curr.trafficPos[k + 1] - prev.trafficPos[k + 1]) * alpha,
          prev.trafficPos[k + 2] + (curr.trafficPos[k + 2] - prev.trafficPos[k + 2]) * alpha,
        )
      } else {
        this.p.set(curr.trafficPos[k], curr.trafficPos[k + 1], curr.trafficPos[k + 2])
      }
      this.up.set(curr.trafficUp[k], curr.trafficUp[k + 1], curr.trafficUp[k + 2])
      this.fwd.set(curr.trafficFwd[k], curr.trafficFwd[k + 1], curr.trafficFwd[k + 2])
      this.right.crossVectors(this.fwd, this.up).normalize()
      this.up.crossVectors(this.right, this.fwd).normalize()
      const anim = curr.trafficAnim[i]
      const kindName = TRAFFIC_KIND_CODES[kind]
      let s = 1
      if (kindName === 'DRONE' || kindName === 'MINE') {
        // Spin slowly so silhouettes read at range.
        this.right.applyAxisAngle(this.up, anim * 1.3)
        this.fwd.crossVectors(this.up, this.right).normalize()
      } else if (kindName === 'POD_SHOCK' || kindName === 'POD_SHIELD') {
        s = 1 + 0.15 * Math.sin(anim * 5)
      } else if (kindName === 'GATE_BOSS') {
        this.right.applyAxisAngle(this.up, anim * 0.7)
        this.fwd.crossVectors(this.up, this.right).normalize()
        s = 1 + 0.05 * Math.sin(anim * 3)
      }
      this.scale.set(s, s, s)
      this.m.makeBasis(this.right, this.up, this.fwd)
      this.m.scale(this.scale)
      this.m.setPosition(this.p)
      const idx = mesh.count++
      mesh.setMatrixAt(idx, this.m)
      // Colour: base tint darkened by lost health, white flash on hit.
      const flash = curr.trafficFlash[i]
      this.color.copy(this.base.get(kind)!)
      const hp = curr.trafficHp[i]
      this.color.lerp(this.white, flash < 0.09 ? 0.9 : 0)
      this.color.multiplyScalar(0.55 + 0.45 * hp)
      mesh.setColorAt(idx, this.color)
    }
    for (const mesh of this.meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }
}
