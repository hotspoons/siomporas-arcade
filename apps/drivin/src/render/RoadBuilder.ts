import { buildStartGantry } from './StartGantry'
import { PIECE_BY_TYPE } from '../sim/pieces'
// Turns baked lanes into meshes: a ribbon with raised curbs for roads, a ring
// tube around the road for tunnels, and pillars under anything elevated.
// Built once per track; nothing here runs per frame.

import { BoxGeometry, BufferAttribute, BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, ShaderMaterial, Vector3 } from 'three'
import { Vec3 } from '@apex/engine/math/Vec3'
import { makeLaneFrame } from '../sim/PathTable'
import type { Lane, Track } from '../sim/Track'
import { CURB_WIDTH, ROAD_HALF_WIDTH, TUBE_RADIUS } from '../sim/Tuning'
import { PILLAR_SPACING } from './RenderTuning'

const STEP = 2

export class RoadBuilder {
  readonly root = new Group()
  private extras: Group[] = []
  private readonly frame = makeLaneFrame()
  private readonly v = new Vec3()
  private meshes: Mesh[] = []
  private pillars: InstancedMesh | null = null
  triangles = 0

  private readonly material: ShaderMaterial
  private readonly pillarMaterial: MeshStandardMaterial

  constructor(material: ShaderMaterial, pillarMaterial: MeshStandardMaterial) {
    this.material = material
    this.pillarMaterial = pillarMaterial
  }

  build(track: Track, tubeSegments: number): void {
    this.clear()
    const pillarMatrices: Matrix4[] = []
    let gantryDone = false
    for (const lane of track.lanes) {
      // Start / finish gantry over the middle of the start piece (one per track).
      if (!gantryDone && PIECE_BY_TYPE[track.data.pieces[lane.pieceIndex]?.type]?.isStart) {
        gantryDone = true
        const gantry = buildStartGantry(lane.table.frameAt(lane.table.length / 2, this.frame))
        this.root.add(gantry)
        this.extras.push(gantry)
      }
      const mesh = new Mesh(lane.profile === 'tube' ? this.tube(lane, tubeSegments) : this.ribbon(lane), this.material)
      mesh.frustumCulled = true
      mesh.geometry.computeBoundingSphere()
      this.root.add(mesh)
      this.meshes.push(mesh)
      this.pillarsFor(lane, pillarMatrices)
      if (lane.profile === 'tube') {
        // Tubes still get their road surface.
        const road = new Mesh(this.ribbon(lane), this.material)
        road.geometry.computeBoundingSphere()
        this.root.add(road)
        this.meshes.push(road)
      }
    }
    if (pillarMatrices.length) {
      const inst = new InstancedMesh(new BoxGeometry(0.8, 1, 0.8), this.pillarMaterial, pillarMatrices.length)
      pillarMatrices.forEach((m, i) => inst.setMatrixAt(i, m))
      inst.instanceMatrix.needsUpdate = true
      this.root.add(inst)
      this.pillars = inst
    }
  }

  clear(): void {
    for (const m of this.meshes) {
      this.root.remove(m)
      m.geometry.dispose()
    }
    this.meshes = []
    for (const e of this.extras) this.root.remove(e)
    this.extras = []
    if (this.pillars) {
      this.root.remove(this.pillars)
      this.pillars.geometry.dispose()
      this.pillars = null
    }
    this.triangles = 0
  }

  /** Flat ribbon: curb | road | curb, curbs raised 0.15 m. */
  private ribbon(lane: Lane): BufferGeometry {
    const t = lane.table
    const rings = Math.max(2, Math.ceil(t.length / STEP) + 1)
    // Cross-section lateral offsets and heights: outer curb edge, curb top, road edge, centre, road edge, curb top, outer curb edge.
    const W = ROAD_HALF_WIDTH
    const C = CURB_WIDTH
    // Tarmac sits a few centimetres proud of the ground plane; curbs a little more.
    const xs = [-W - C, -W, -W, 0, W, W, W + C]
    const ys = [0.2, 0.2, 0.06, 0.06, 0.06, 0.2, 0.2]
    const kinds = [1, 1, 0, 0, 0, 1, 1]
    const across = xs.length
    const pos = new Float32Array(rings * across * 3)
    const nor = new Float32Array(rings * across * 3)
    const road = new Float32Array(rings * across * 4)
    const idx: number[] = []
    const f = this.frame
    let n = 0
    for (let r = 0; r < rings; r++) {
      const s = Math.min(t.length, r * STEP)
      t.frameAt(s, f)
      // Gaps: collapse the ring so no surface is drawn.
      const present = f.surface
      for (let k = 0; k < across; k++) {
        const i = r * across + k
        const x = present ? xs[k] : 0
        const y = present ? ys[k] : -0.5
        this.v.copy(f.pos).addScaled(f.right, x).addScaled(f.up, y)
        pos[i * 3] = this.v.x
        pos[i * 3 + 1] = this.v.y
        pos[i * 3 + 2] = this.v.z
        nor[i * 3] = f.up.x
        nor[i * 3 + 1] = f.up.y
        nor[i * 3 + 2] = f.up.z
        road[i * 4] = s
        road[i * 4 + 1] = xs[k]
        road[i * 4 + 2] = kinds[k]
        road[i * 4 + 3] = f.kRight
      }
      if (r > 0) {
        for (let k = 0; k < across - 1; k++) {
          const a = (r - 1) * across + k
          const b = a + 1
          const c = r * across + k
          const d = c + 1
          idx.push(a, c, b, b, c, d)
          n += 2
        }
      }
    }
    this.triangles += n
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('normal', new BufferAttribute(nor, 3))
    g.setAttribute('aRoad', new BufferAttribute(road, 4))
    g.setIndex(idx)
    return g
  }

  /** Ring tube around the road; the tube's floor is the road, so the centre is up by R. */
  private tube(lane: Lane, segments: number): BufferGeometry {
    const t = lane.table
    const rings = Math.max(2, Math.ceil(t.length / STEP) + 1)
    const across = segments + 1
    const pos = new Float32Array(rings * across * 3)
    const nor = new Float32Array(rings * across * 3)
    const road = new Float32Array(rings * across * 4)
    const idx: number[] = []
    const f = this.frame
    const R = TUBE_RADIUS
    let n = 0
    for (let r = 0; r < rings; r++) {
      const s = Math.min(t.length, r * STEP)
      t.frameAt(s, f)
      for (let k = 0; k < across; k++) {
        const i = r * across + k
        // Angle from the floor (0) around the tube; skip the very bottom so the road shows.
        const a = -Math.PI + (k / segments) * Math.PI * 2
        const ox = Math.sin(a) * R
        const oy = R - Math.cos(a) * R
        this.v.copy(f.pos).addScaled(f.right, ox).addScaled(f.up, oy)
        pos[i * 3] = this.v.x
        pos[i * 3 + 1] = this.v.y
        pos[i * 3 + 2] = this.v.z
        // Inward normal.
        this.v.copy(f.right).scale(-Math.sin(a)).addScaled(f.up, Math.cos(a))
        nor[i * 3] = this.v.x
        nor[i * 3 + 1] = this.v.y
        nor[i * 3 + 2] = this.v.z
        road[i * 4] = s
        road[i * 4 + 1] = a * R
        road[i * 4 + 2] = 2
        road[i * 4 + 3] = 0
      }
      if (r > 0) {
        for (let k = 0; k < segments; k++) {
          const a = (r - 1) * across + k
          const b = a + 1
          const c = r * across + k
          const d = c + 1
          idx.push(a, b, c, b, d, c)
          n += 2
        }
      }
    }
    this.triangles += n
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('normal', new BufferAttribute(nor, 3))
    g.setAttribute('aRoad', new BufferAttribute(road, 4))
    g.setIndex(idx)
    return g
  }

  private pillarsFor(lane: Lane, out: Matrix4[]): void {
    const t = lane.table
    const f = this.frame
    const m = new Matrix4()
    const p = new Vector3()
    const sc = new Vector3()
    for (let s = PILLAR_SPACING / 2; s < t.length; s += PILLAR_SPACING) {
      t.frameAt(s, f)
      const h = f.pos.y - 0.4
      // Only under upright, elevated road.
      if (h < 1.5 || f.up.y < 0.7 || !f.surface) continue
      for (const side of [-3.2, 3.2]) {
        this.v.copy(f.pos).addScaled(f.right, side)
        p.set(this.v.x, this.v.y - h / 2 - 0.2, this.v.z)
        sc.set(1, h, 1)
        m.identity().setPosition(p).scale(sc)
        out.push(m.clone())
      }
    }
  }
}
