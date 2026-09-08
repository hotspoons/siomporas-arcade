// The road as a dynamic triangle list rebuilt every frame in screen space:
// grass, rumble strips, tarmac and lane markers per segment, far to near,
// coloured in alternating bands and blended toward the fog colour.

import { BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Float32BufferAttribute, Mesh, ShaderMaterial } from 'three'
import { DRAW_SEGMENTS, ROAD_HALF_WIDTH } from '../sim/Tuning'

const QUADS_PER_SEGMENT = 18
const MAX_QUADS = (DRAW_SEGMENTS + 4) * QUADS_PER_SEGMENT

/** Height (metres) of a banked road's surface at lateral offset u (m, + right): 0 at the inner edge, |tilt| per metre outward, plateauing past the outer shoulder. */
export function bermLift(u: number, tilt: number, plateau: number): number {
  const d = Math.sign(tilt) * u + ROAD_HALF_WIDTH // distance from the inner edge toward the outside
  return Math.abs(tilt) * Math.max(0, Math.min(2 * ROAD_HALF_WIDTH + plateau, d))
}

export class RoadMesh {
  readonly mesh: Mesh
  private readonly pos: Float32BufferAttribute
  private readonly col: Float32BufferAttribute
  private readonly geometry = new BufferGeometry()
  private quads = 0
  private readonly c = new Color()
  private readonly fog = new Color()
  private dim = 1
  // Banked rows: the road plane tilts about its centreline; every quad vertex is lifted by its
  // lateral distance from the row centre × slope (clamped so the far grass doesn't fly away).
  private t1 = 0
  private t2 = 0
  private tx1 = 0
  private ts1 = 1
  private tx2 = 0
  private ts2 = 1
  /** Lateral metres over which the plane tilts; beyond it the ground plateaus at the edge height (a berm, not a cliff). */
  plateau = 13

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
        side: DoubleSide, // ceilings and walls wind the other way round
        depthTest: false,
        depthWrite: false,
      }),
    )
    this.mesh.frustumCulled = false
  }

  setFog(color: number): void {
    this.fog.set(color)
  }

  /** Brightness multiplier for subsequent quads (night headlights). */
  setDim(d: number): void {
    this.dim = d
  }

  begin(): void {
    this.quads = 0
    this.t1 = this.t2 = 0
  }

  /** Set the current row pair's tilt: centre x, scale and slope (screen-y per lateral metre) of the near and far rows. */
  setTilt(x1: number, s1: number, slope1: number, x2: number, s2: number, slope2: number): void {
    this.t1 = slope1
    this.t2 = slope2
    this.tx1 = x1
    this.ts1 = s1
    this.tx2 = x2
    this.ts2 = s2
  }

  /** Berm profile: level at the inner edge, rising toward the outer edge, flat again past the plateau. */
  private lift(x: number, xr: number, s: number, tilt: number): number {
    if (tilt === 0) return 0
    return bermLift((x - xr) / s, tilt, this.plateau) * s
  }

  /** Trapezoid between two screen rows: (x1 ± w1) at y1 and (x2 ± w2) at y2. */
  quad(x1: number, y1: number, w1: number, x2: number, y2: number, w2: number, color: number, fogT: number): void {
    if (this.quads >= MAX_QUADS) return
    this.c.set(color).lerp(this.fog, fogT)
    if (this.dim !== 1) this.c.multiplyScalar(this.dim)
    const v = this.quads * 4
    this.pos.setXYZ(v, x1 - w1, y1 + this.lift(x1 - w1, this.tx1, this.ts1, this.t1), 0)
    this.pos.setXYZ(v + 1, x1 + w1, y1 + this.lift(x1 + w1, this.tx1, this.ts1, this.t1), 0)
    this.pos.setXYZ(v + 2, x2 + w2, y2 + this.lift(x2 + w2, this.tx2, this.ts2, this.t2), 0)
    this.pos.setXYZ(v + 3, x2 - w2, y2 + this.lift(x2 - w2, this.tx2, this.ts2, this.t2), 0)
    for (let k = 0; k < 4; k++) this.col.setXYZ(v + k, this.c.r, this.c.g, this.c.b)
    this.quads++
  }

  /** Any four screen points, wound a→b→c→d (for walls and portal faces that aren't row trapezoids). */
  quad4(xa: number, ya: number, xb: number, yb: number, xc: number, yc: number, xd: number, yd: number, color: number, fogT: number): void {
    if (this.quads >= MAX_QUADS) return
    this.c.set(color).lerp(this.fog, fogT)
    if (this.dim !== 1) this.c.multiplyScalar(this.dim)
    const v = this.quads * 4
    this.pos.setXYZ(v, xa, ya, 0)
    this.pos.setXYZ(v + 1, xb, yb, 0)
    this.pos.setXYZ(v + 2, xc, yc, 0)
    this.pos.setXYZ(v + 3, xd, yd, 0)
    for (let k = 0; k < 4; k++) this.col.setXYZ(v + k, this.c.r, this.c.g, this.c.b)
    this.quads++
  }

  end(): void {
    this.geometry.setDrawRange(0, this.quads * 6)
    this.pos.needsUpdate = true
    this.col.needsUpdate = true
  }
}
