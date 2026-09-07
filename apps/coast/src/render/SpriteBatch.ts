// Instanced screen-space sprites from the atlas. Instances are written far →
// near every frame; a per-instance clip line hides anything below a hill crest.

import { BufferGeometry, Color, Float32BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, type Texture } from 'three'
import type { SpriteFrame } from './SpriteAtlas'

const VERT = /* glsl */ `
attribute vec4 aRect;   // x, y (bottom-centre, screen), w, h
attribute vec4 aUv;     // u0 v0 u1 v1
attribute vec4 aTint;   // fogT, brightness, unused, clipY
varying vec2 vUv;
varying vec4 vTint;
varying float vScreenY;
void main() {
  vec2 p = vec2(aRect.x + (position.x - 0.5) * aRect.z, aRect.y + position.y * aRect.w);
  vUv = vec2(mix(aUv.x, aUv.z, position.x), mix(aUv.y, aUv.w, position.y));
  vTint = aTint;
  vScreenY = p.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}
`
const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tAtlas;
uniform vec3 uFog;
varying vec2 vUv;
varying vec4 vTint;
varying float vScreenY;
void main() {
  if (vScreenY < vTint.w) discard;
  vec4 c = texture2D(tAtlas, vUv);
  if (c.a < 0.35) discard;
  gl_FragColor = vec4(mix(c.rgb * vTint.y, uFog, vTint.x), 1.0);
}
`

export class SpriteBatch {
  readonly mesh: Mesh
  readonly material: ShaderMaterial
  private readonly rect: InstancedBufferAttribute
  private readonly uv: InstancedBufferAttribute
  private readonly tint: InstancedBufferAttribute
  private readonly geometry: InstancedBufferGeometry
  count = 0
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    const base = new BufferGeometry()
    base.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3))
    base.setIndex([0, 1, 2, 0, 2, 3])
    this.geometry = new InstancedBufferGeometry()
    this.geometry.index = base.index
    this.geometry.setAttribute('position', base.getAttribute('position'))
    this.rect = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.uv = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.tint = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.rect.setUsage(35048)
    this.uv.setUsage(35048)
    this.tint.setUsage(35048)
    this.geometry.setAttribute('aRect', this.rect)
    this.geometry.setAttribute('aUv', this.uv)
    this.geometry.setAttribute('aTint', this.tint)
    this.material = new ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { tAtlas: { value: null }, uFog: { value: new Color(1, 1, 1) } }, transparent: false, depthTest: false, depthWrite: false })
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
  }

  setAtlas(t: Texture): void {
    this.material.uniforms.tAtlas.value = t
  }

  setFog(color: number): void {
    ;(this.material.uniforms.uFog.value as Color).set(color)
  }

  begin(): void {
    this.count = 0
  }

  /** Add a sprite by bottom-centre screen position, height in screen px, frame, fog weight, brightness and clip. */
  add(x: number, y: number, h: number, f: SpriteFrame, fogT: number, bright: number, clipY: number): void {
    if (this.count >= this.capacity) return
    const i = this.count++
    const w = h * (f.widthM / f.heightM)
    // The frame's baseline (ground contact) sits above the cell bottom; shift so it lands on y.
    const ry = y - f.baseline * h
    this.rect.setXYZW(i, x, ry, w, h)
    this.uv.setXYZW(i, f.u0, f.v0, f.u1, f.v1)
    this.tint.setXYZW(i, fogT, bright, 0, clipY)
  }

  end(): void {
    this.geometry.instanceCount = this.count
    this.rect.needsUpdate = true
    this.uv.needsUpdate = true
    this.tint.needsUpdate = true
    this.mesh.visible = this.count > 0
  }
}
