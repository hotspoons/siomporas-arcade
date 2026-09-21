// Grass and weeds on the verge: dense instanced blades in a ring around the eye, on open ground.
//
// The technique is the one every good open three.js grass shares (CK42BB/procedural-grass-threejs
// MIT, Nitash-Biswas/grass-shader-glsl, the Codrops "fluffiest grass" write-up, and Ghost of
// Tsushima's GDC talk they all descend from), written here against our own data:
//
//   blade     a tapered strip swept along a QUADRATIC BEZIER from root to tip; the control point
//             carries a per-blade lean so blades arc rather than tilt; the tangent gives a normal
//   thicken   blades seen edge-on are widened in view space so a field never thins to nothing
//   wind      three layers: a slow global sway, gust fronts rolling through as scrolled value
//             noise over world position, and per-blade turbulence — all at the tip, fading to
//             zero at the root
//   shading   root-to-tip colour ramp, ambient occlusion at the root, half-Lambert sun, and a
//             back-light translucency term when the sun is behind the blade
//   placement DATA-driven: open ground only (canopy model < 3 m), off the pavement, mown short
//             inside the mow line 8 m from the shoulder, taller with weeds beyond; density falls
//             with distance; positions hashed from a fixed lattice so nothing jumps on re-seed
import * as THREE from 'three'
import type { SeasonLook } from './season'

const SEGMENTS = 6

function bladeGeometry(): THREE.BufferGeometry {
  // strip: pairs of vertices up the blade, then the tip; x is ±1 (scaled by width in the shader), y = t
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i < SEGMENTS; i++) {
    const t = i / SEGMENTS
    pos.push(-1, t, 0, 1, t, 0)
    uv.push(0, t, 1, t)
  }
  pos.push(0, 1, 0)
  uv.push(0.5, 1)
  for (let i = 0; i < SEGMENTS - 1; i++) {
    const k = i * 2
    idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
  }
  const k = (SEGMENTS - 1) * 2
  idx.push(k, k + 1, SEGMENTS * 2)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

export class Grass {
  mesh: THREE.InstancedMesh
  private aBlade: THREE.InstancedBufferAttribute // (rand, height, width, lean)
  private material: THREE.ShaderMaterial
  private last = new THREE.Vector3(Infinity, 0, Infinity)
  private capacity: number
  private radius: number
  private heightScale = 0.4
  private groundAt: (x: number, y: number) => number
  private canopyAt: (x: number, y: number) => number
  private roadDistance: (x: number, z: number) => number
  private pavedHalf: number
  private adjustAt: ((x: number, y: number) => [number, number]) | undefined

  constructor(
    groundAt: (x: number, y: number) => number,
    canopyAt: (x: number, y: number) => number,
    roadDistance: (x: number, z: number) => number,
    pavedHalf: number,
    look: SeasonLook,
    capacity = 400_000,
    radius = 40,
    fog: THREE.FogExp2 | null = null,
    adjustAt: ((x: number, y: number) => [number, number]) | undefined = undefined,
    sun = new THREE.Vector3(-3000, 4000, 2500).normalize(),
  ) {
    this.adjustAt = adjustAt
    this.groundAt = groundAt
    this.canopyAt = canopyAt
    this.roadDistance = roadDistance
    this.pavedHalf = pavedHalf
    this.capacity = capacity
    this.radius = radius
    this.heightScale = look.grass.height
    const geo = bladeGeometry()
    this.aBlade = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    geo.setAttribute('aBlade', this.aBlade)
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
        uTime: { value: 0 },
        uBase: { value: look.grass.base.clone() },
        uTip: { value: look.grass.tip.clone() },
        uDry: { value: look.grass.dry },
        uSun: { value: sun },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aBlade; // rand, height, width, lean
        uniform float uTime;
        varying float vT;
        varying float vRand;
        varying vec3 vNormal;
        varying vec3 vWorld;
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>

        float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        // value noise: the gust fronts
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
        }

        void main() {
          float t = position.y;
          vT = t;
          vRand = aBlade.x;
          float h = aBlade.y;
          float width = aBlade.z;
          float lean = aBlade.w;
          vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float yaw = aBlade.x * 6.2831853;
          vec3 face = vec3(cos(yaw), 0.0, sin(yaw));        // blade faces this way
          vec3 side = vec3(-face.z, 0.0, face.x);            // blade width runs this way

          // wind at the tip: sway + gust fronts + per-blade turbulence
          float sway = sin(uTime * 0.7 + root.x * 0.05 + root.z * 0.03) * 0.15;
          float gust = (vnoise(root.xz * 0.06 + vec2(uTime * 0.35, uTime * 0.12)) - 0.5) * 0.9;
          float turb = sin(uTime * 4.0 + aBlade.x * 60.0) * 0.06 * (0.5 + gust);
          vec3 windDir = normalize(vec3(0.8, 0.0, 0.5));
          vec3 windTip = windDir * (sway + gust + turb) * h;

          // quadratic bezier from root through a leaned control point to a wind-blown tip
          vec3 P0 = root;
          vec3 P2 = root + vec3(0.0, h, 0.0) + face * (lean * h) + windTip;
          vec3 P1 = root + vec3(0.0, h * 0.62, 0.0) + face * (lean * h * 0.25);
          float it = 1.0 - t;
          vec3 pOnCurve = it * it * P0 + 2.0 * it * t * P1 + t * t * P2;
          vec3 tangent = normalize(2.0 * it * (P1 - P0) + 2.0 * t * (P2 - P1));
          vec3 n = normalize(cross(side, tangent));

          // taper, and a view-dependent thickening so edge-on blades keep a presence
          float taper = 1.0 - t * t * 0.85;
          vec3 toCam = normalize(cameraPosition - pOnCurve);
          float edgeOn = 1.0 - abs(dot(toCam, n));
          float w = width * taper * (1.0 + edgeOn * 0.7);
          vec3 world = pOnCurve + side * position.x * w * 0.5;

          // curved cross-section: bend the normal toward the blade's side for a rounded look
          vNormal = normalize(n + side * position.x * 0.35);
          vWorld = world;
          vec4 mvPosition = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uBase;
        uniform vec3 uTip;
        uniform float uDry;
        uniform vec3 uSun;
        varying float vT;
        varying float vRand;
        varying vec3 vNormal;
        varying vec3 vWorld;
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec3 n = normalize(gl_FrontFacing ? vNormal : -vNormal);
          vec3 v = normalize(cameraPosition - vWorld);
          // colour: root to tip ramp, per-blade hue/brightness variation, dry-season straw
          vec3 c = mix(uBase, uTip, smoothstep(0.1, 1.0, vT));
          c *= 0.8 + 0.4 * vRand;
          c = mix(c, c * vec3(1.15, 1.05, 0.65), uDry * (0.3 + 0.7 * vRand));
          // ambient occlusion at the root, where blades shade each other
          float ao = mix(0.35, 1.0, smoothstep(0.0, 0.6, vT));
          // half-Lambert sun, sky ambient, and back-light translucency when the sun is behind
          float ndl = dot(n, uSun) * 0.5 + 0.5;
          float back = pow(max(0.0, dot(v, -uSun)), 4.0) * 0.6 * vT;
          vec3 lit = c * (0.35 + 0.75 * ndl) * ao + uTip * back;
          // a little specular sheen along the blade
          vec3 hvec = normalize(uSun + v);
          lit += vec3(0.08) * pow(max(0.0, dot(n, hvec)), 24.0) * vT;
          gl_FragColor = vec4(lit, 1.0);
          #include <fog_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide,
      fog: !!fog,
    })
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.name = 'grass'
  }

  setLook(look: SeasonLook) {
    ;(this.material.uniforms.uBase.value as THREE.Color).copy(look.grass.base)
    ;(this.material.uniforms.uTip.value as THREE.Color).copy(look.grass.tip)
    this.material.uniforms.uDry.value = look.grass.dry
    this.heightScale = look.grass.height
    this.last.set(Infinity, 0, Infinity)
  }

  tick(t: number) {
    this.material.uniforms.uTime.value = t
  }

  /** Re-seed the ring around `eye` (world X/Z) once it has moved 5 m. */
  update(eye: THREE.Vector3) {
    if (eye.distanceTo(this.last) < 5) return
    this.last.copy(eye)
    const cell = 1.0
    const r = this.radius
    const m = new THREE.Matrix4()
    let k = 0
    const x0 = Math.floor((eye.x - r) / cell), x1 = Math.ceil((eye.x + r) / cell)
    const z0 = Math.floor((eye.z - r) / cell), z1 = Math.ceil((eye.z + r) / cell)
    outer: for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const wx = cx * cell, wz = cz * cell
        const d = Math.hypot(wx - eye.x, wz - eye.z)
        if (d > r) continue
        const roadD = this.roadDistance(wx, wz)
        if (roadD < this.pavedHalf + 0.3) continue // pavement
        if (this.canopyAt(wx, -wz) > 3.0) continue // a real crown
        // slope rejection: a cut face or a steep embankment is rock and scrub, not turf
        const gy = this.groundAt(wx, -wz)
        const slope = Math.max(Math.abs(this.groundAt(wx + 1, -wz) - gy), Math.abs(this.groundAt(wx, -wz - 1) - gy))
        if (slope > 0.7) continue
        // bare patches: low-frequency hash noise thins the field where soil shows
        const patch = hash(Math.floor(cx / 6) * 971 + Math.floor(cz / 6) * 337)
        if (patch < 0.12) continue
        // density: LOD rings — full inside 15 m, 40% to 30 m, 15% at the rim; mown verge denser
        // the skill's numbers: lawn 80/m², meadow 35/m² near, thinning in rings
        const falloff = d < 14 ? 1 : d < 26 ? 0.45 : 0.18
        const mown = roadD < this.pavedHalf + 8
        if (roadD > this.pavedHalf + 60) continue // spend the budget on the verge, where the eye is
        // the editor's local corrections: [height multiplier, density multiplier]
        const [ah, ad] = this.adjustAt ? this.adjustAt(wx, -wz) : [1, 1]
        const perCell = Math.round((mown ? 40 : 22) * falloff * (0.7 + 0.6 * patch) * ad)
        // one clump centre per cell; blades scatter around it
        const ccx = wx + (hash(cx * 7919 + cz * 104729) - 0.5) * cell
        const ccz = wz + (hash(cx * 15485863 + cz * 32452843) - 0.5) * cell
        for (let b = 0; b < perCell; b++) {
          if (k >= this.capacity) break outer
          const h1 = hash(cx * 31 + cz * 17 + b * 101), h2 = hash(cx * 13 + cz * 29 + b * 53)
          const x = ccx + (h1 - 0.5) * 0.7, z = ccz + (h2 - 0.5) * 0.7
          const y = this.groundAt(x, -z) - 0.02
          m.makeTranslation(x, y, z)
          this.mesh.setMatrixAt(k, m)
          const rnd = hash(cx * 29 + cz * 31 + b * 3)
          const height = (mown ? 0.22 : this.heightScale * 1.8) * ah * (0.6 + 0.8 * hash(cx * 3 + cz * 5 + b * 7))
          const width = mown ? 0.035 : 0.05 + 0.03 * rnd
          const lean = 0.15 + 0.45 * hash(cx * 11 + cz * 19 + b * 23)
          this.aBlade.setXYZW(k, rnd, height, width, lean)
          k++
        }
      }
    }
    this.mesh.count = k
    this.mesh.instanceMatrix.needsUpdate = true
    this.aBlade.needsUpdate = true
  }
}

function hash(n: number): number {
  let x = (n | 0) ^ 0x5bd1e995
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d)
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39)
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296
}
