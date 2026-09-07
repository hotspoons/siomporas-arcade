// The flat world: a huge plane with a cell grid that fades with distance and
// a soft horizon. Retro mode gets hard lines and no gradient.

import { Color, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'
import { CELL } from '../sim/Tuning'
import { GROUND_SIZE } from './RenderTuning'

export class Ground {
  readonly mesh: Mesh
  readonly material: ShaderMaterial

  constructor() {
    this.material = new ShaderMaterial({
      uniforms: {
        uCameraPos: { value: new Vector3() },
        uFogColor: { value: new Color(0x0b1020) },
        uFogDensity: { value: 0.0011 },
        uGrass: { value: new Color(0x1d3a2a) },
        uGrid: { value: new Color(0x2f6b4a) },
        uFlat: { value: 0 },
        uCell: { value: CELL },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vWorld;
        uniform vec3 uCameraPos; uniform vec3 uFogColor; uniform float uFogDensity;
        uniform vec3 uGrass; uniform vec3 uGrid; uniform float uFlat; uniform float uCell;
        float lineAt(float x, float w) { float f = abs(fract(x) - 0.5); float aa = max(fwidth(x), 1e-5); return smoothstep(0.5 - w - aa, 0.5 - w + aa, f) * clamp(2.0 * w / aa, 0.0, 1.0); }
        void main() {
          float dist = length(uCameraPos - vWorld);
          float g = max(lineAt(vWorld.x / uCell, 0.012), lineAt(vWorld.z / uCell, 0.012));
          float fine = max(lineAt(vWorld.x / (uCell * 0.25), 0.02), lineAt(vWorld.z / (uCell * 0.25), 0.02)) * 0.35;
          if (uFlat > 0.5) { g = step(0.5, g); fine = 0.0; }
          vec3 col = uGrass + uGrid * (g + fine) * 0.9;
          float fog = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
          gl_FragColor = vec4(mix(col, uFogColor, clamp(fog, 0.0, 1.0)), 1.0);
        }`,
    })
    this.mesh = new Mesh(new PlaneGeometry(GROUND_SIZE, GROUND_SIZE), this.material)
    this.mesh.rotation.x = -Math.PI / 2
    this.mesh.position.y = -0.02
    this.mesh.frustumCulled = false
  }
}
