// The road as a dynamic triangle list rebuilt every frame in screen space:
// grass, rumble strips, tarmac and lane markers per segment, far to near,
// coloured in alternating bands and blended toward the fog colour.

import { BufferGeometry, Color, DynamicDrawUsage, Float32BufferAttribute, Mesh, ShaderMaterial } from 'three'
import { DRAW_SEGMENTS } from '../sim/Tuning'

const QUADS_PER_SEGMENT = 12
const MAX_QUADS = (DRAW_SEGMENTS + 4) * QUADS_PER_SEGMENT

export class RoadMesh {
  readonly mesh: Mesh
  private readonly pos: Float32BufferAttribute
  private readonly col: Float32BufferAttribute
  private readonly geometry = new BufferGeometry()
  private quads = 0
  private readonly c = new Color()
  private readonly fog = new Color()

  constructor() {
    this.pos = new Float32BufferAttribute(new Float32Array(MAX_QUADS * 4 * 3), 3)
    this.col = new Float32BufferAttribute(new Float32Array(MAX_QUADS * 4 * 3), 3)
    this.pos.setUsage(DynamicDrawUsage)
    this.col.setUsage(DynamicDrawUsage)
    this.geometry.setAttribute('position', this.pos)
    this.geometry.setAttribute('color', this.col)
    const idx = new Uint32Array(MAX_QUADS * 6)
    for (let q = 0; q < MAX_QUADS; q++) {
      const v = q * 4
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6)
    }
    this.geometry.setIndex(new Float32BufferAttribute(idx as unknown as ArrayLike<number>, 1) as never)
    this.geometry.index!.array = idx as never
    this.mesh = new Mesh(
      this.geometry,
      new ShaderMaterial({
        vertexShader: /* glsl */ `varying vec3 vC; void main(){ vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `precision highp float; varying vec3 vC; void main(){ gl_FragColor = vec4(vC, 1.0); }`,
        vertexColors: true,
        depthTest: false,
        depthWrite: false,
      }),
    )
    this.mesh.frustumCulled = false
  }

  setFog(color: number): void {
    this.fog.set(color)
  }

  begin(): void {
    this.quads = 0
  }

  /** Trapezoid between two screen rows: (x1 ± w1) at y1 and (x2 ± w2) at y2. */
  quad(x1: number, y1: number, w1: number, x2: number, y2: number, w2: number, color: number, fogT: number): void {
    if (this.quads >= MAX_QUADS) return
    this.c.set(color).lerp(this.fog, fogT)
    const v = this.quads * 4
    this.pos.setXYZ(v, x1 - w1, y1, 0)
    this.pos.setXYZ(v + 1, x1 + w1, y1, 0)
    this.pos.setXYZ(v + 2, x2 + w2, y2, 0)
    this.pos.setXYZ(v + 3, x2 - w2, y2, 0)
    for (let k = 0; k < 4; k++) this.col.setXYZ(v + k, this.c.r, this.c.g, this.c.b)
    this.quads++
  }

  end(): void {
    this.geometry.setDrawRange(0, this.quads * 6)
    this.pos.needsUpdate = true
    this.col.needsUpdate = true
  }
}
