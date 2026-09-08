import { buildStartGantry } from './StartGantry'
import { PIECE_BY_TYPE } from '../sim/pieces'
// Turns baked lanes into meshes: a ribbon with raised curbs for roads, a ring
// tube around the road for tunnels, pillars under anything elevated, and a
// bridge span (parapets, deck edge, piers into the water) wherever a road
// crosses water — no authoring needed, it follows from the water pieces.
// Built once per track; nothing here runs per frame.

import { BoxGeometry, BufferAttribute, BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, ShaderMaterial, Vector3 } from 'three'
import { Vec3 } from '@apex/engine/math/Vec3'
import { makeLaneFrame } from '../sim/PathTable'
import type { Lane, Track } from '../sim/Track'
import { CURB_WIDTH, ROAD_HALF_WIDTH, TUBE_RADIUS, TUBE_RAMP } from '../sim/Tuning'
import { smoothstep } from '@apex/engine/math/scalar'
import { PILLAR_SIDE, PILLAR_SPACING } from '../sim/Tuning'

const STEP = 2
/** Bridge spans: sampling step along the lane, parapet height and how far the deck skirt hangs below the tarmac. */
const BRIDGE_STEP = 4
const PARAPET_HEIGHT = 0.95
const DECK_THICKNESS = 0.7

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
  private readonly parapetMaterial = new MeshStandardMaterial({ color: 0xd8dce4, roughness: 0.75, flatShading: true })
  private readonly deckMaterial = new MeshStandardMaterial({ color: 0x8a8f9a, roughness: 0.85, flatShading: true, side: 2 })

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
      this.pillarsFor(lane, pillarMatrices, track)
      this.bridgesFor(lane, track)
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
      // A full ring inside; at each mouth it pinches down over TUBE_RAMP metres to a lip at road level,
      // so the tube's threshold flows out of the tarmac instead of standing as a wall.
      const wall = (lane.mouthIn === false ? 1 : smoothstep(0, TUBE_RAMP, s)) * (lane.mouthOut === false ? 1 : smoothstep(0, TUBE_RAMP, t.length - s))
      const maxA = 0.03 + (Math.PI - 0.03) * Math.pow(wall, 0.7)
      for (let k = 0; k < across; k++) {
        const i = r * across + k
        // Angle from the floor (0) around the tube, folded onto the wall's current top so the mouth flares open.
        let a = -Math.PI + (k / segments) * Math.PI * 2
        a = Math.max(-maxA, Math.min(maxA, a))
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

  /**
   * Bridges: any run of a lane whose road surface is over water becomes a span — a parapet along each
   * edge and a deck skirt under the tarmac, with the run extended a little onto dry land so the ends
   * sit on the bank. Supports come from the usual elevated-road pillars, so a road at water level
   * reads as a causeway and one up on a level gets piers standing in the water.
   */
  private bridgesFor(lane: Lane, track: Track): void {
    const t = lane.table
    const f = this.frame
    // Where is the deck over water? Sample the centreline and both edges.
    const over: boolean[] = []
    const rings = Math.max(2, Math.ceil(t.length / BRIDGE_STEP) + 1)
    for (let r = 0; r < rings; r++) {
      t.frameAt(Math.min(t.length, r * BRIDGE_STEP), f)
      let wet = track.isWater(f.pos.x, f.pos.z)
      for (const side of [-1, 1]) {
        this.v.copy(f.pos).addScaled(f.right, side * ROAD_HALF_WIDTH)
        wet = wet || track.isWater(this.v.x, this.v.z)
      }
      over.push(wet)
    }
    if (!over.some(Boolean)) return
    // Contiguous runs, each grown by one sample so the ends land on the bank.
    const spans: [number, number][] = []
    for (let r = 0; r < rings; r++) {
      if (!over[r]) continue
      const start = r
      while (r + 1 < rings && over[r + 1]) r++
      spans.push([Math.max(0, start - 1), Math.min(rings - 1, r + 1)])
    }
    const g = new Group()
    for (const [r0, r1] of spans) {
      const s0 = r0 * BRIDGE_STEP
      const s1 = Math.min(t.length, r1 * BRIDGE_STEP)
      if (s1 - s0 < BRIDGE_STEP) continue
      g.add(new Mesh(this.parapetRibbon(t, s0, s1, ROAD_HALF_WIDTH + CURB_WIDTH * 0.5, PARAPET_HEIGHT), this.parapetMaterial))
      g.add(new Mesh(this.parapetRibbon(t, s0, s1, -(ROAD_HALF_WIDTH + CURB_WIDTH * 0.5), PARAPET_HEIGHT), this.parapetMaterial))
      // Deck skirt: the same ribbon hung below the tarmac, so the span reads as a slab from the side.
      g.add(new Mesh(this.parapetRibbon(t, s0, s1, ROAD_HALF_WIDTH + CURB_WIDTH, -DECK_THICKNESS), this.deckMaterial))
      g.add(new Mesh(this.parapetRibbon(t, s0, s1, -(ROAD_HALF_WIDTH + CURB_WIDTH), -DECK_THICKNESS), this.deckMaterial))
    }
    if (!g.children.length) return
    this.root.add(g)
    this.extras.push(g)
  }

  /** A vertical strip along the lane at a lateral offset: up `height` from the road (or down, when negative). */
  private parapetRibbon(t: Lane['table'], s0: number, s1: number, lateral: number, height: number): BufferGeometry {
    const f = this.frame
    const rings = Math.max(2, Math.ceil((s1 - s0) / BRIDGE_STEP) + 1)
    const pos = new Float32Array(rings * 2 * 3)
    const nor = new Float32Array(rings * 2 * 3)
    const idx: number[] = []
    for (let r = 0; r < rings; r++) {
      const s = Math.min(s1, s0 + (r * (s1 - s0)) / (rings - 1))
      t.frameAt(s, f)
      for (let k = 0; k < 2; k++) {
        const i = r * 2 + k
        this.v.copy(f.pos).addScaled(f.right, lateral).addScaled(f.up, k === 0 ? 0.06 : height)
        pos[i * 3] = this.v.x
        pos[i * 3 + 1] = this.v.y
        pos[i * 3 + 2] = this.v.z
        nor[i * 3] = f.right.x * Math.sign(lateral)
        nor[i * 3 + 1] = f.right.y * Math.sign(lateral)
        nor[i * 3 + 2] = f.right.z * Math.sign(lateral)
      }
      if (r > 0) {
        const a = (r - 1) * 2
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
        this.triangles += 2
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('normal', new BufferAttribute(nor, 3))
    g.setIndex(idx)
    return g
  }

  private pillarsFor(lane: Lane, out: Matrix4[], track: Track): void {
    const t = lane.table
    const f = this.frame
    const m = new Matrix4()
    const p = new Vector3()
    const sc = new Vector3()
    for (let s = PILLAR_SPACING / 2; s < t.length; s += PILLAR_SPACING) {
      t.frameAt(s, f)
      const h = f.pos.y - track.groundHeight(f.pos.x, f.pos.z) - 0.4
      // Only under upright, elevated road.
      if (h < 1.5 || f.up.y < 0.7 || !f.surface) continue
      for (const side of [-PILLAR_SIDE, PILLAR_SIDE]) {
        this.v.copy(f.pos).addScaled(f.right, side)
        p.set(this.v.x, this.v.y - h / 2 - 0.2, this.v.z)
        sc.set(1, h, 1)
        m.identity().setPosition(p).scale(sc)
        out.push(m.clone())
      }
    }
  }
}
