// GPU-integrated particle pool: each slot stores start, velocity, birth, life,
// colour and size; the vertex shader computes position from uTime, so the CPU
// only touches the buffer when something spawns. Used for explosions, impacts,
// sparks, landing dust and pickup bursts.

import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Vector3 } from 'three'
import type { Vec3 } from '../math/Vec3'

const VERT = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aVel;
attribute vec2 aTime; // birth, life
attribute vec3 aColor;
attribute float aSize;
uniform float uTime;
uniform vec3 uGravity;
uniform float uPixelRatio;
uniform float uPoint;
varying vec3 vColor;
varying float vFade;
void main() {
  float age = uTime - aTime.x;
  float t = clamp(age / max(aTime.y, 0.001), 0.0, 1.0);
  vFade = (age < 0.0 || t >= 1.0) ? 0.0 : (1.0 - t) * (1.0 - t);
  vec3 p = aStart + aVel * age + 0.5 * uGravity * age * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = aSize * (1.0 + t * 1.5) * uPixelRatio * uPoint;
  gl_PointSize = clamp(size * 300.0 / max(-mv.z, 1.0), 1.0, 96.0) * step(0.001, vFade);
  vColor = aColor;
}
`
const FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vFade;
uniform float uFlat;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float a = uFlat > 0.5 ? step(r, 0.8) : smoothstep(1.0, 0.2, r);
  a *= vFade;
  if (a <= 0.01) discard;
  gl_FragColor = vec4(vColor * (1.0 + (1.0 - r) * 0.6), a);
}
`

export class Particles {
  readonly points: Points
  readonly material: ShaderMaterial
  private readonly start: BufferAttribute
  private readonly vel: BufferAttribute
  private readonly time: BufferAttribute
  private readonly color: BufferAttribute
  private readonly size: BufferAttribute
  private head = 0
  private dirty = false
  private now = 0
  private readonly v = new Vector3()

  private readonly capacity: number

  constructor(capacity = 1024) {
    this.capacity = capacity
    const MAX_PARTICLES = capacity
    const g = new BufferGeometry()
    this.start = new BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3)
    this.vel = new BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3)
    this.time = new BufferAttribute(new Float32Array(MAX_PARTICLES * 2).fill(-1000), 2)
    this.color = new BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3)
    this.size = new BufferAttribute(new Float32Array(MAX_PARTICLES), 1)
    g.setAttribute('position', this.start) // needed by three for bounds; we alias start
    g.setAttribute('aStart', this.start)
    g.setAttribute('aVel', this.vel)
    g.setAttribute('aTime', this.time)
    g.setAttribute('aColor', this.color)
    g.setAttribute('aSize', this.size)
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uGravity: { value: new Vector3(0, -6, 0) },
        uPixelRatio: { value: 1 },
        uPoint: { value: 1 },
        uFlat: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    this.points = new Points(g, this.material)
    this.points.frustumCulled = false
  }

  setPixelRatio(pr: number): void {
    this.material.uniforms.uPixelRatio.value = pr
  }

  setFlat(flat: boolean): void {
    this.material.uniforms.uFlat.value = flat ? 1 : 0
    this.material.uniforms.uPoint.value = flat ? 1.6 : 1
  }

  update(dt: number): void {
    this.now += dt
    this.material.uniforms.uTime.value = this.now
    if (this.dirty) {
      this.start.needsUpdate = true
      this.vel.needsUpdate = true
      this.time.needsUpdate = true
      this.color.needsUpdate = true
      this.size.needsUpdate = true
      this.dirty = false
    }
  }

  /** Emit `count` particles at `pos`; velocities random in a cone/sphere. */
  burst(pos: Vec3 | Vector3, count: number, speed: number, life: number, r: number, g: number, b: number, size: number, dir?: Vector3, spread = 1): void {
    const st = this.start.array as Float32Array
    const vl = this.vel.array as Float32Array
    const tm = this.time.array as Float32Array
    const cl = this.color.array as Float32Array
    const sz = this.size.array as Float32Array
    for (let i = 0; i < count; i++) {
      const k = this.head
      this.head = (this.head + 1) % this.capacity
      st[k * 3] = pos.x
      st[k * 3 + 1] = pos.y
      st[k * 3 + 2] = pos.z
      // Random direction on a sphere, optionally biased along dir.
      const u = Math.random() * 2 - 1
      const ph = Math.random() * Math.PI * 2
      const rr = Math.sqrt(1 - u * u)
      this.v.set(rr * Math.cos(ph), rr * Math.sin(ph), u).multiplyScalar(spread)
      if (dir) this.v.add(dir)
      this.v.normalize().multiplyScalar(speed * (0.35 + Math.random() * 0.65))
      vl[k * 3] = this.v.x
      vl[k * 3 + 1] = this.v.y
      vl[k * 3 + 2] = this.v.z
      tm[k * 2] = this.now
      tm[k * 2 + 1] = life * (0.6 + Math.random() * 0.6)
      const tint = 0.75 + Math.random() * 0.5
      cl[k * 3] = r * tint
      cl[k * 3 + 1] = g * tint
      cl[k * 3 + 2] = b * tint
      sz[k] = size * (0.6 + Math.random() * 0.8)
    }
    this.dirty = true
  }
}
