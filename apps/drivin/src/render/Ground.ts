// The flat world: a huge plane with a cell grid that fades with distance and
// a soft horizon. Retro mode gets drivins and no gradient.

import { BufferAttribute, BufferGeometry, Color, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'
import { CELL } from '../sim/Tuning'
import type { Track } from '../sim/Track'
import { GROUND_SIZE } from './RenderTuning'

export class Ground {
  readonly mesh: Mesh
  readonly material: ShaderMaterial
  /** The sculpted landscape over the grid (only when the track has terrain). */
  hills: Mesh | null = null

  constructor() {
    this.material = new ShaderMaterial({
      uniforms: {
        uCameraPos: { value: new Vector3() },
        uFogColor: { value: new Color(0xbcd8f2) },
        uFogDensity: { value: 0.0011 },
        uGrass: { value: new Color(0x4a9a3e) },
        uGrid: { value: new Color(0x3b7a30) },
        uFlat: { value: 0 },
        uCell: { value: CELL },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld; varying vec3 vNormal;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; vNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vWorld; varying vec3 vNormal;
        uniform vec3 uCameraPos; uniform vec3 uFogColor; uniform float uFogDensity;
        uniform vec3 uGrass; uniform vec3 uGrid; uniform float uFlat; uniform float uCell;
        float lineAt(float x, float w) { float f = abs(fract(x) - 0.5); float aa = max(fwidth(x), 1e-5); return smoothstep(0.5 - w - aa, 0.5 - w + aa, f) * clamp(2.0 * w / aa, 0.0, 1.0); }
        void main() {
          float dist = length(uCameraPos - vWorld);
          float g = max(lineAt(vWorld.x / uCell, 0.012), lineAt(vWorld.z / uCell, 0.012));
          float fine = max(lineAt(vWorld.x / (uCell * 0.25), 0.02), lineAt(vWorld.z / (uCell * 0.25), 0.02)) * 0.35;
          if (uFlat > 0.5) { g = step(0.5, g); fine = 0.0; }
          // Slopes shade: a hillside catches light from the up-sun side and darkens on the other.
          float shade = 0.72 + 0.28 * clamp(dot(normalize(vNormal), normalize(vec3(0.35, 1.0, 0.25))), 0.0, 1.0);
          if (uFlat > 0.5) shade = floor(shade * 4.0) / 4.0;
          vec3 col = mix(uGrass, uGrid, clamp(g + fine, 0.0, 1.0) * 0.8) * shade;
          float fog = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
          gl_FragColor = vec4(mix(col, uFogColor, clamp(fog, 0.0, 1.0)), 1.0);
        }`,
    })
    // Pushed back in depth so a level-0 road never fights it, whatever the camera distance.
    this.material.polygonOffset = true
    this.material.polygonOffsetFactor = 2
    this.material.polygonOffsetUnits = 4
    this.mesh = new Mesh(new PlaneGeometry(GROUND_SIZE, GROUND_SIZE), this.material)
    this.mesh.rotation.x = -Math.PI / 2
    this.mesh.position.y = -0.05
    this.mesh.renderOrder = -5
    this.mesh.frustumCulled = false
  }

  /** Rebuild the landscape mesh for a track (removed again when the track is flat). */
  setTrack(track: Track): void {
    if (this.hills) {
      this.hills.parent?.remove(this.hills)
      this.hills.geometry.dispose()
      this.hills = null
    }
    const h = track.heights
    if (!h) return
    const N = track.data.size
    const sub = 6 // quads per cell (~6.7 m): fine enough that the facets stay under the road slab
    const n = N * sub + 1
    const pos = new Float32Array(n * n * 3)
    const idx: number[] = []
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = (i / sub) * CELL
        const z = (j / sub) * CELL
        const k = (j * n + i) * 3
        pos[k] = x
        pos[k + 1] = track.groundHeight(x, z) - 0.06
        pos[k + 2] = z
        if (i < n - 1 && j < n - 1) {
          const a = j * n + i
          const b = a + 1
          const c = a + n
          const d = c + 1
          idx.push(a, c, b, b, c, d)
        }
      }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setIndex(idx)
    g.computeVertexNormals()
    const m = new Mesh(g, this.material)
    m.renderOrder = -4
    m.frustumCulled = false
    this.hills = m
    this.mesh.parent?.add(m)
  }
}
