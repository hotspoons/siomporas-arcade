// One InstancedMesh per traffic kind, filled from the snapshot each frame.
// Instances interpolate between prev and curr when the slot holds the same
// agent id. Hit flash and health tint go through instanceColor. Trains draw
// one instance per car along the track; light-cycles trail a light ribbon.

import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DoubleSide,
  IcosahedronGeometry,
  InstancedMesh,
  Material,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  SphereGeometry,
  TetrahedronGeometry,
  Vector3,
} from 'three'
import { SimSnapshot, TRAFFIC_KIND_CODES } from '../sim/SimSnapshot'
import { MAX_TRAFFIC, SPINNER_HALF_ARC, TRAIN_CARS, TRAIN_CAR_LENGTH } from '../sim/Tuning'
import { Track } from '../sim/track/Track'
import { Vec3 } from '@apex/engine/math/Vec3'
import { makeFrame } from '../sim/track/TrackSpline'

interface KindLook {
  geometry: BufferGeometry
  color: number
  emissive: number
  metal: number
  /** Instances per agent (trains). */
  per?: number
}

/** Light-cycle ribbon length behind the bike, metres. */
const TRAIL_LENGTH = 48
const TRAIL_HEIGHT = 2.2

const LOOKS: Record<string, KindLook> = {
  DRONE: { geometry: new OctahedronGeometry(2.3, 0), color: 0x4de1ff, emissive: 0x0d5a7a, metal: 0.6 },
  BLOCKER: { geometry: new BoxGeometry(8.4, 2.4, 3.2), color: 0xffb020, emissive: 0x6a3d00, metal: 0.5 },
  MINE: { geometry: new IcosahedronGeometry(2.0, 0), color: 0xff3b5c, emissive: 0x7a0a1e, metal: 0.3 },
  INTERCEPTOR: { geometry: new ConeGeometry(2.2, 5.2, 5).rotateX(Math.PI / 2), color: 0xc46bff, emissive: 0x4a1a7a, metal: 0.7 },
  ARMORED: { geometry: new BoxGeometry(5.4, 3.2, 7.4), color: 0x8a9bb0, emissive: 0x1a2a3a, metal: 0.9 },
  GATE_BOSS: { geometry: new DodecahedronGeometry(6.4, 0), color: 0xff6a3c, emissive: 0x7a1e00, metal: 0.6 },
  POD_SHOCK: { geometry: new SphereGeometry(2.2, 10, 8), color: 0xff5fd2, emissive: 0xaa2090, metal: 0.1 },
  POD_SHIELD: { geometry: new SphereGeometry(2.2, 10, 8), color: 0x5cff8a, emissive: 0x20aa50, metal: 0.1 },
  TRAIN: { geometry: trainCar(), color: 0xc9d3e6, emissive: 0x1e5a8a, metal: 0.8, per: TRAIN_CARS },
  LIGHTBIKE: { geometry: lightbike(), color: 0xeaf6ff, emissive: 0x3aa8ff, metal: 0.9 },
  HAULER: { geometry: new BoxGeometry(5.6, 4.2, 9.6), color: 0xb0743a, emissive: 0x4a2a10, metal: 0.4 },
  SWARM: { geometry: new TetrahedronGeometry(1.7, 0), color: 0x7dff5c, emissive: 0x1f7a2a, metal: 0.3 },
  TURRET: { geometry: turret(), color: 0x9aa7b8, emissive: 0x7a2020, metal: 0.7 },
  SPINNER: { geometry: new BoxGeometry(SPINNER_HALF_ARC * 2 * 14, 1.4, 2.2), color: 0xffd45f, emissive: 0x7a5a00, metal: 0.6 },
}

const KINDS = Object.keys(LOOKS)

export class TrafficRenderer {
  readonly root = new Object3D()
  private readonly meshes = new Map<number, InstancedMesh>()
  private readonly modern = new Map<number, Material>()
  private readonly retro = new Map<number, Material>()
  private readonly trails: InstancedMesh
  private readonly m = new Matrix4()
  private readonly p = new Vector3()
  private readonly up = new Vector3()
  private readonly fwd = new Vector3()
  private readonly right = new Vector3()
  private readonly scale = new Vector3()
  private readonly color = new Color()
  private readonly white = new Color(1, 1, 1)
  private readonly base = new Map<number, Color>()
  private readonly frame = makeFrame()
  private readonly vA = new Vec3()
  private readonly vB = new Vec3()
  private readonly lightbikeCode = TRAFFIC_KIND_CODES.indexOf('LIGHTBIKE')
  private readonly trainCode = TRAFFIC_KIND_CODES.indexOf('TRAIN')

  constructor() {
    for (const kind of KINDS) {
      const code = TRAFFIC_KIND_CODES.indexOf(kind as (typeof TRAFFIC_KIND_CODES)[number])
      const look = LOOKS[kind]
      const modern = new MeshStandardMaterial({ color: 0xffffff, emissive: look.emissive, emissiveIntensity: 1.2, metalness: look.metal, roughness: 0.4, flatShading: true })
      const retro = new MeshLambertMaterial({ color: 0xffffff, emissive: look.emissive, emissiveIntensity: 0.8, flatShading: true })
      const mesh = new InstancedMesh(look.geometry, modern, MAX_TRAFFIC * (look.per ?? 1))
      mesh.count = 0
      mesh.frustumCulled = false
      this.meshes.set(code, mesh)
      this.modern.set(code, modern)
      this.retro.set(code, retro)
      this.base.set(code, new Color(look.color))
      this.root.add(mesh)
    }
    this.trails = new InstancedMesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ color: 0x6ad0ff, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
      MAX_TRAFFIC,
    )
    this.trails.count = 0
    this.trails.frustumCulled = false
    this.root.add(this.trails)
  }

  setRetro(retro: boolean): void {
    for (const [code, mesh] of this.meshes) mesh.material = (retro ? this.retro : this.modern).get(code)!
  }

  update(prev: SimSnapshot, curr: SimSnapshot, alpha: number, track: Track): void {
    for (const mesh of this.meshes.values()) mesh.count = 0
    this.trails.count = 0
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
      } else if (kindName === 'SWARM') {
        this.right.applyAxisAngle(this.fwd, anim * 5)
        this.up.crossVectors(this.right, this.fwd).normalize()
      } else if (kindName === 'POD_SHOCK' || kindName === 'POD_SHIELD') {
        s = 1 + 0.15 * Math.sin(anim * 5)
      } else if (kindName === 'GATE_BOSS') {
        this.right.applyAxisAngle(this.up, anim * 0.7)
        this.fwd.crossVectors(this.up, this.right).normalize()
        s = 1 + 0.05 * Math.sin(anim * 3)
      } else if (kindName === 'TURRET') {
        this.right.applyAxisAngle(this.up, Math.sin(anim * 1.5) * 0.4)
        this.fwd.crossVectors(this.up, this.right).normalize()
      }
      // Colour: base tint darkened by lost health, white flash on hit.
      const flash = curr.trafficFlash[i]
      this.color.copy(this.base.get(kind)!)
      const hp = curr.trafficHp[i]
      this.color.lerp(this.white, flash < 0.09 ? 0.9 : 0)
      this.color.multiplyScalar(0.55 + 0.45 * hp)

      if (kind === this.trainCode) {
        this.placeTrain(mesh, curr, i, track)
        continue
      }
      this.scale.set(s, s, s)
      this.m.makeBasis(this.right, this.up, this.fwd)
      this.m.scale(this.scale)
      this.m.setPosition(this.p)
      const idx = mesh.count++
      mesh.setMatrixAt(idx, this.m)
      mesh.setColorAt(idx, this.color)
      if (kind === this.lightbikeCode) this.placeTrail(curr, i, track)
    }
    for (const mesh of this.meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    this.trails.instanceMatrix.needsUpdate = true
  }

  /** Cars spaced along the track behind the head, each following the curve. */
  private placeTrain(mesh: InstancedMesh, snap: SimSnapshot, i: number, track: Track): void {
    const s0 = snap.trafficS[i]
    const theta = snap.trafficTheta[i]
    const branch = snap.trafficBranch[i]
    for (let c = 0; c < TRAIN_CARS; c++) {
      const s = s0 - c * TRAIN_CAR_LENGTH
      const f = track.frameAt(s, branch, this.frame)
      Track.surfaceFromFrame(f, theta, 3.0, this.vA, this.vB)
      Track.radial(f, theta, this.vB)
      this.p.set(this.vA.x, this.vA.y, this.vA.z)
      this.up.set(-this.vB.x, -this.vB.y, -this.vB.z)
      this.fwd.set(f.tan.x, f.tan.y, f.tan.z)
      this.right.crossVectors(this.fwd, this.up).normalize()
      this.m.makeBasis(this.right, this.up, this.fwd)
      this.m.setPosition(this.p)
      const idx = mesh.count++
      mesh.setMatrixAt(idx, this.m)
      mesh.setColorAt(idx, c === 0 ? this.color : this.color.clone().multiplyScalar(0.85))
    }
  }

  /** A vertical light ribbon from the bike back along the track. */
  private placeTrail(snap: SimSnapshot, i: number, track: Track): void {
    const s = snap.trafficS[i]
    const theta = snap.trafficTheta[i]
    const branch = snap.trafficBranch[i]
    const f = track.frameAt(s - TRAIL_LENGTH / 2, branch, this.frame)
    Track.surfaceFromFrame(f, theta, 1.4 + TRAIL_HEIGHT / 2, this.vA, this.vB)
    Track.radial(f, theta, this.vB)
    this.p.set(this.vA.x, this.vA.y, this.vA.z)
    this.up.set(-this.vB.x, -this.vB.y, -this.vB.z)
    this.fwd.set(f.tan.x, f.tan.y, f.tan.z)
    this.right.crossVectors(this.fwd, this.up).normalize()
    // Plane X along the track (length), Y up (height), normal sideways.
    this.scale.set(TRAIL_LENGTH, TRAIL_HEIGHT, 1)
    this.m.makeBasis(this.fwd, this.up, this.right)
    this.m.scale(this.scale)
    this.m.setPosition(this.p)
    const idx = this.trails.count++
    this.trails.setMatrixAt(idx, this.m)
  }
}

function trainCar(): BufferGeometry {
  // A boxy car with a chamfered roof, read as a windowed transit pod.
  const g = new BoxGeometry(3.4, 3.0, TRAIN_CAR_LENGTH * 0.92, 1, 1, 1)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    if (y > 0) pos.setX(i, pos.getX(i) * 0.7)
  }
  g.computeVertexNormals()
  return g
}

function lightbike(): BufferGeometry {
  // Long thin wedge, taller than wide: the classic light-cycle silhouette.
  const g = new BoxGeometry(1.0, 1.5, 5.8, 1, 1, 2)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i)
    if (z > 2) {
      pos.setX(i, pos.getX(i) * 0.25)
      pos.setY(i, pos.getY(i) * 0.5 - 0.3)
    }
  }
  g.computeVertexNormals()
  return g
}

function turret(): BufferGeometry {
  const g = new CylinderGeometry(1.4, 2.4, 1.8, 8)
  const barrel = new BoxGeometry(0.5, 0.5, 3.6).translate(0, 0.8, 1.6)
  const merged = new BufferGeometry()
  const a = g.toNonIndexed()
  const b = barrel.toNonIndexed()
  const pa = a.attributes.position.array as Float32Array
  const pb = b.attributes.position.array as Float32Array
  const pos = new Float32Array(pa.length + pb.length)
  pos.set(pa)
  pos.set(pb, pa.length)
  merged.setAttribute('position', new (a.attributes.position.constructor as typeof import('three').BufferAttribute)(pos, 3))
  merged.computeVertexNormals()
  return merged
}
