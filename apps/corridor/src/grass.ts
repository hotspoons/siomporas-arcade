// Grass and weeds on the verge: bezier blades near the eye, sprite clumps out to the horizon of
// the verge, both from a cache of world-aligned tiles that is filled a few tiles per frame.
//
// The blade technique is the one every good open three.js grass shares (CK42BB/procedural-grass-
// threejs MIT, Nitash-Biswas/grass-shader-glsl, the Codrops "fluffiest grass" write-up, and Ghost
// of Tsushima's GDC talk they all descend from), written here against our own data:
//
//   blade     a tapered strip swept along a QUADRATIC BEZIER from root to tip; the control point
//             carries a per-blade lean so blades arc rather than tilt; the tangent gives a normal
//   thicken   blades seen edge-on are widened in view space so a field never thins to nothing
//   wind      three layers: a slow global sway, gust fronts rolling through as scrolled value
//             noise over world position, and per-blade turbulence — all at the tip, fading to
//             zero at the root
//   shading   root-to-tip colour ramp, ambient occlusion at the root, half-Lambert sun, and a
//             back-light translucency term when the sun is behind the blade
//   sprites   beyond the blade rings a clump CARD — a cylindrical billboard with a baked tuft
//             texture, tinted by the same season colours — carries the ground cover out to
//             GRASS_SPRITE_RADIUS. Nobody needs swaying geometry a hundred feet away (Rich), and
//             one card per 1.2 m² is what lets the verge read as grass all the way out.
//   placement DATA-driven: open ground only (canopy model < 3 m), off the pavement, mown short
//             inside the mow line, taller with weeds beyond; positions hashed from a fixed
//             lattice so nothing jumps between re-seeds.
//
// WHY TILES (2026-09-21). The first version re-seeded the whole ring every 5 m of travel: at
// Rich's settings that was up to 400 000 blades regenerated — a ground lookup and five hashes
// each — and a 25 MB instance-matrix upload, in one frame, roughly every 0.75 s at road speed.
// That is the hiccup he felt. Now the world is cut into 8 m tiles; a tile is generated ONCE
// (full density, blades in random-rank order so any prefix is a uniform thinning), cached, and
// assembling the visible set is a typed-array copy of cached prefixes. Only tiles entering the
// ring cost anything, and no more than GRASS_TILES_PER_FRAME of them per frame.
import * as THREE from 'three'
import type { SeasonLook } from './season'
import * as T from './tuning'

const SEGMENTS = 6
const TILE = 8
const BLADE_F = 7 // x y z | rand height width lean
const CARD_F = 6 // x y z | size rand mown

function bladeGeometry(): THREE.InstancedBufferGeometry {
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
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

function cardGeometry(): THREE.InstancedBufferGeometry {
  // a unit quad standing on its bottom edge: x ±0.5, y 0..1
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

/** A tuft of blades painted once to a canvas: R = shade (root dark → tip light), A = coverage. */
function clumpTexture(): THREE.Texture {
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = S
  cv.height = S
  const ctx = cv.getContext('2d')!
  ctx.clearRect(0, 0, S, S)
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  ctx.lineCap = 'round'
  for (let i = 0; i < 90; i++) {
    const x0 = S * (0.5 + (rnd() - 0.5) * 0.28)
    const lean = (rnd() - 0.5) * 1.6
    const h = S * (0.45 + rnd() * 0.5)
    const w = 1.5 + rnd() * 4
    const shade = 90 + rnd() * 110
    const grad = ctx.createLinearGradient(0, S, 0, S - h)
    grad.addColorStop(0, `rgba(${shade * 0.45 | 0},${shade * 0.45 | 0},${shade * 0.45 | 0},1)`)
    grad.addColorStop(1, `rgba(${shade | 0},${shade | 0},${shade | 0},1)`)
    ctx.strokeStyle = grad
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.moveTo(x0, S)
    ctx.quadraticCurveTo(x0 + lean * h * 0.25, S - h * 0.6, x0 + lean * h * 0.55, S - h)
    ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.NoColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  return tex
}

interface Tile {
  /** blades are only generated inside the blade radius — a card-only tile is ~50 records, a blade tile ~7000 */
  hasBlades: boolean
  blades: Float32Array // BLADE_F per blade, in random-rank order
  n: number
  cards: Float32Array // CARD_F per card, in random-rank order
  nc: number
  mown: boolean // most of the tile inside the mow line (drives card look)
}

const GLSL_NOISE = /* glsl */ `
  float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
  }
`

export class Grass {
  /** both tiers; scene adds this */
  mesh: THREE.Group
  private blades: THREE.Mesh
  private cards: THREE.Mesh
  private bladeGeo: THREE.InstancedBufferGeometry
  private cardGeo: THREE.InstancedBufferGeometry
  private aRoot: THREE.InstancedBufferAttribute
  private aBlade: THREE.InstancedBufferAttribute // (rand, height, width, lean)
  private aCard: THREE.InstancedBufferAttribute // (x, y, z, size)
  private aCard2: THREE.InstancedBufferAttribute // (rand, mown)
  private bladeMat: THREE.ShaderMaterial
  private cardMat: THREE.ShaderMaterial
  private capacity: number
  private cardCapacity: number
  private heightScale = 0.4
  private groundAt: (x: number, y: number) => number
  private canopyAt: (x: number, y: number) => number
  private roadDistance: (x: number, z: number) => number
  private pavedHalf: number
  private adjustAt: ((x: number, y: number) => [number, number]) | undefined
  private tiles = new Map<string, Tile>()
  private pending: { key: string; tx: number; tz: number; withBlades: boolean }[] = []
  private prevEye = new THREE.Vector3(NaN, NaN, NaN)
  private prevT = 0
  private motion = 1 // 1 still … 0 moving fast: scales the wind
  private lastTile = 'none'
  private lastHeading = Infinity
  private lastPitch = Infinity
  private dirty = true
  private frame = 0
  private eye = new THREE.Vector3()
  private fwd = new THREE.Vector3(1, 0, 0)
  private pitch = 0

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
    this.cardCapacity = Math.max(60_000, Math.round(capacity / 3))
    void radius // the live radius is the knob GRASS_RADIUS; the argument is kept for call-site compatibility
    this.heightScale = look.grass.height
    this.dryBase = look.grass.dry

    // --- blades -------------------------------------------------------------------------------
    this.bladeGeo = bladeGeometry()
    this.aRoot = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.aBlade = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.aRoot.setUsage(THREE.DynamicDrawUsage)
    this.aBlade.setUsage(THREE.DynamicDrawUsage)
    this.bladeGeo.setAttribute('aRoot', this.aRoot)
    this.bladeGeo.setAttribute('aBlade', this.aBlade)
    this.bladeGeo.instanceCount = 0
    this.bladeMat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
        uTime: { value: 0 },
        uWind: { value: 1 },
        uBase: { value: look.grass.base.clone() },
        uTip: { value: look.grass.tip.clone() },
        uDry: { value: look.grass.dry },
        uSun: { value: sun },
        uHue: { value: 0 },
        uSat: { value: 1 },
        uLight: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aRoot;
        attribute vec4 aBlade; // rand, height, width, lean
        uniform float uTime;
        uniform float uWind;
        varying float vT;
        varying float vRand;
        varying vec3 vNormal;
        varying vec3 vWorld;
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        ${GLSL_NOISE}
        void main() {
          float t = position.y;
          vT = t;
          vRand = aBlade.x;
          float h = aBlade.y;
          float width = aBlade.z;
          float lean = aBlade.w;
          vec3 root = aRoot;
          float yaw = aBlade.x * 6.2831853;
          vec3 face = vec3(cos(yaw), 0.0, sin(yaw));        // blade faces this way
          vec3 side = vec3(-face.z, 0.0, face.x);            // blade width runs this way

          // wind at the tip: sway + gust fronts + per-blade turbulence
          float sway = sin(uTime * 0.7 + root.x * 0.05 + root.z * 0.03) * 0.15;
          float gust = (vnoise(root.xz * 0.06 + vec2(uTime * 0.35, uTime * 0.12)) - 0.5) * 0.9;
          float turb = sin(uTime * 4.0 + aBlade.x * 60.0) * 0.06 * (0.5 + gust);
          vec3 windDir = normalize(vec3(0.8, 0.0, 0.5));
          vec3 windTip = windDir * (sway + gust + turb) * h * uWind;

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
        uniform float uHue;
        uniform float uSat;
        uniform float uLight;
        varying float vT;
        varying float vRand;
        varying vec3 vNormal;
        varying vec3 vWorld;
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
  // colour grading over the season palette: hue rotation about the grey axis (YIQ), saturation, lightness
  vec3 grade(vec3 c, float hueDeg, float sat, float light) {
    float a = radians(hueDeg);
    vec3 yiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c;
    float ca = cos(a), sa = sin(a);
    yiq.yz = vec2(yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca);
    c = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * yiq;
    c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, sat);
    return max(c * light, 0.0);
  }
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
          gl_FragColor = vec4(grade(lit, uHue, uSat, uLight), 1.0);
          #include <fog_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide,
      fog: !!fog,
    })
    this.blades = new THREE.Mesh(this.bladeGeo, this.bladeMat)
    this.blades.frustumCulled = false
    this.blades.name = 'grass-blades'

    // --- clump cards ---------------------------------------------------------------------------
    this.cardGeo = cardGeometry()
    this.aCard = new THREE.InstancedBufferAttribute(new Float32Array(this.cardCapacity * 4), 4)
    this.aCard2 = new THREE.InstancedBufferAttribute(new Float32Array(this.cardCapacity * 2), 2)
    this.aCard.setUsage(THREE.DynamicDrawUsage)
    this.aCard2.setUsage(THREE.DynamicDrawUsage)
    this.cardGeo.setAttribute('aCard', this.aCard)
    this.cardGeo.setAttribute('aCard2', this.aCard2)
    this.cardGeo.instanceCount = 0
    this.cardMat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
        uTime: { value: 0 },
        uWind: { value: 1 },
        uBase: { value: look.grass.base.clone() },
        uTip: { value: look.grass.tip.clone() },
        uDry: { value: look.grass.dry },
        uSun: { value: sun },
        uMap: { value: null as THREE.Texture | null },
        uFadeIn: { value: 30 },
        uFadeOut: { value: 300 },
        uWidth: { value: 1.2 },
        uLean: { value: 0.25 },
        uHue: { value: 0 },
        uSat: { value: 1 },
        uLight: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aCard;  // x y z size
        attribute vec2 aCard2; // rand mown
        uniform float uTime;
        uniform float uWind;
        uniform float uFadeIn;
        uniform float uFadeOut;
        uniform float uWidth;
        uniform float uLean;
        varying vec2 vUv;
        varying float vRand;
        varying float vMown;
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        ${GLSL_NOISE}
        void main() {
          vUv = uv;
          vRand = aCard2.x;
          vMown = aCard2.y;
          vec3 root = aCard.xyz;
          // cylindrical billboard: face the camera about Y
          vec3 toCam = cameraPosition - root;
          float d = length(toCam.xz);
          vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
          // cards grow in where the blades thin out and shrink away at the far rim — size, not
          // alpha, so there is no alpha-test pop
          float fade = smoothstep(uFadeIn - 8.0, uFadeIn, d) * (1.0 - smoothstep(uFadeOut * 0.8, uFadeOut, d));
          float size = aCard.w * fade;
          float gust = (vnoise(root.xz * 0.06 + vec2(uTime * 0.35, uTime * 0.12)) - 0.5) * 0.35 * uWind;
          // lean: the top of the card shears sideways by a per-card amount, so a field is not a row of fence posts
          float lean = (aCard2.x - 0.5) * 2.0 * uLean;
          vec3 world = root + right * (position.x * size * uWidth + lean * position.y * size) + vec3(0.0, position.y * size, 0.0)
                     + vec3(0.8, 0.0, 0.5) * gust * position.y * size;
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
        uniform sampler2D uMap;
        uniform float uHue;
        uniform float uSat;
        uniform float uLight;
        varying vec2 vUv;
        varying float vRand;
        varying float vMown;
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
  // colour grading over the season palette: hue rotation about the grey axis (YIQ), saturation, lightness
  vec3 grade(vec3 c, float hueDeg, float sat, float light) {
    float a = radians(hueDeg);
    vec3 yiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c;
    float ca = cos(a), sa = sin(a);
    yiq.yz = vec2(yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca);
    c = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * yiq;
    c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, sat);
    return max(c * light, 0.0);
  }
        void main() {
          #include <logdepthbuf_fragment>
          vec4 s = texture2D(uMap, vUv);
          if (s.a < 0.5) discard;
          vec3 c = mix(uBase, uTip, smoothstep(0.1, 1.0, vUv.y));
          c *= 0.8 + 0.4 * vRand;
          c = mix(c, c * vec3(1.15, 1.05, 0.65), uDry * (0.3 + 0.7 * vRand));
          // the baked shade carries root darkening and per-blade variation
          float shade = mix(0.55, 1.15, s.r);
          // a mown card is a low even turf; keep it a touch darker like the strip's mown texture
          c *= shade * mix(1.0, 0.85, vMown);
          gl_FragColor = vec4(grade(c, uHue, uSat, uLight), 1.0);
          #include <fog_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide,
      fog: !!fog,
    })
    this.cardMat.uniforms.uMap.value = clumpTexture()
    this.cards = new THREE.Mesh(this.cardGeo, this.cardMat)
    this.cards.frustumCulled = false
    this.cards.name = 'grass-cards'

    this.mesh = new THREE.Group()
    this.mesh.name = 'grass'
    this.mesh.add(this.blades, this.cards)
  }

  setLook(look: SeasonLook) {
    for (const m of [this.bladeMat, this.cardMat]) {
      ;(m.uniforms.uBase.value as THREE.Color).copy(look.grass.base)
      ;(m.uniforms.uTip.value as THREE.Color).copy(look.grass.tip)
      m.uniforms.uDry.value = look.grass.dry
    }
    this.dryBase = look.grass.dry
    this.heightScale = look.grass.height
    this.invalidate()
  }
  private dryBase = 0

  tick(t: number) {
    for (const m of [this.bladeMat, this.cardMat]) {
      m.uniforms.uTime.value = t
      // no sway from a moving car: the eye speed (measured in update) fades the wind out
      m.uniforms.uWind.value = T.GRASS_WIND * this.motion
      m.uniforms.uDry.value = Math.min(1, Math.max(0, this.dryBase + T.GRASS_DRY_ADD))
      m.uniforms.uHue.value = T.GRASS_HUE
      m.uniforms.uSat.value = T.GRASS_SAT
      m.uniforms.uLight.value = T.GRASS_LIGHT
    }
    this.cardMat.uniforms.uWidth.value = T.GRASS_SPRITE_WIDTH
    this.cardMat.uniforms.uLean.value = T.GRASS_SPRITE_LEAN
  }

  /** Drop the tile cache (a knob or the season changed); tiles regenerate over the next frames. */
  invalidate() {
    this.tiles.clear()
    this.pending = []
    this.lastTile = 'none'
    this.dirty = true
  }

  /** how many tiles are still waiting to be generated (probes read this) */
  get pendingTiles(): number {
    return this.pending.length
  }

  /**
   * Called every frame. Picks the tile set for this eye/heading, queues the tiles it has not seen
   * (nearest first), generates at most GRASS_TILES_PER_FRAME of them, and re-assembles the
   * instance buffers when the set or its contents changed.
   */
  update(eye: THREE.Vector3, fwd = new THREE.Vector3(1, 0, 0), pitch = 0) {
    this.frame++
    const now = performance.now()
    if (Number.isFinite(this.prevEye.x)) {
      const dt = Math.max(1e-3, (now - this.prevT) / 1000)
      const speed = eye.distanceTo(this.prevEye) / dt
      const still = T.GRASS_WIND_STILL_BELOW
      const target = still <= 0 ? 1 : 1 - Math.min(1, Math.max(0, (speed - still) / Math.max(0.1, still * 1.5)))
      this.motion += (target - this.motion) * Math.min(1, dt * 4)
    }
    this.prevEye.copy(eye)
    this.prevT = now
    this.eye.copy(eye)
    this.fwd.copy(fwd)
    this.pitch = pitch
    const heading = Math.atan2(fwd.x, fwd.z)
    const tileKey = `${Math.floor(eye.x / TILE)},${Math.floor(eye.z / TILE)}`
    const turned = Math.abs(heading - this.lastHeading) > 0.25 || Math.abs(pitch - this.lastPitch) > 0.2
    if (tileKey !== this.lastTile || turned) {
      this.lastTile = tileKey
      this.lastHeading = heading
      this.lastPitch = pitch
      this.dirty = true
      // the eye moved to a new tile (or teleported: fly → drive): re-plan from here, nearest first,
      // instead of finishing a queue that was planned for where we were
      this.queueMissing()
    } else if (this.dirty && this.pending.length === 0) this.queueMissing()
    // generate a few of the nearest missing tiles; a card-only tile is cheap, a blade tile is not
    let made = 0, budget = T.GRASS_TILES_PER_FRAME
    while (this.pending.length && budget > 0) {
      const p = this.pending.shift()!
      const have = this.tiles.get(p.key)
      if (!have || (p.withBlades && !have.hasBlades)) {
        this.tiles.set(p.key, this.generate(p.tx, p.tz, p.withBlades))
        made++
        budget -= p.withBlades ? 1 : 0.15
      }
    }
    if (made) this.dirty = true
    // assemble: every 4th frame while a burst is still filling, at once when it is complete
    if (this.dirty && (this.pending.length === 0 || this.frame % 4 === 0)) {
      this.assemble()
      this.dirty = this.pending.length > 0
    }
    if (this.tiles.size > 1600) this.evict()
  }

  // --- tiles --------------------------------------------------------------------------------------

  private visibleTiles(): { key: string; tx: number; tz: number; d: number }[] {
    const r = Math.max(T.GRASS_RADIUS, T.GRASS_SPRITE_RADIUS)
    const out: { key: string; tx: number; tz: number; d: number }[] = []
    const tx0 = Math.floor((this.eye.x - r) / TILE), tx1 = Math.floor((this.eye.x + r) / TILE)
    const tz0 = Math.floor((this.eye.z - r) / TILE), tz1 = Math.floor((this.eye.z + r) / TILE)
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let tz = tz0; tz <= tz1; tz++) {
        const cx = (tx + 0.5) * TILE, cz = (tz + 0.5) * TILE
        // the LOD footprint: stretched behind the view (tuning.ts), a circle when looking down
        const d = T.lodDistance(cx - this.eye.x, cz - this.eye.z, this.fwd.x, this.fwd.z, this.pitch)
        if (d > r + TILE) continue
        out.push({ key: `${tx},${tz}`, tx, tz, d })
      }
    }
    out.sort((a, b) => a.d - b.d)
    return out
  }

  private queueMissing() {
    const rBlade = T.GRASS_RADIUS + TILE * 0.71
    this.pending = []
    for (const t of this.visibleTiles()) {
      const withBlades = t.d <= rBlade
      const have = this.tiles.get(t.key)
      if (!have || (withBlades && !have.hasBlades)) this.pending.push({ ...t, withBlades })
    }
  }

  private evict() {
    const keep = new Set(this.visibleTiles().map((t) => t.key))
    for (const k of this.tiles.keys()) if (!keep.has(k)) this.tiles.delete(k)
  }

  /** One 8 m tile at full density. Deterministic in (tx, tz): the same tile always seeds alike. */
  private generate(tx: number, tz: number, withBlades: boolean): Tile {
    const cell = 1.0
    const perCellMax = Math.max(T.GRASS_MOWN_PER_M2, T.GRASS_ROUGH_PER_M2)
    const maxBlades = withBlades ? Math.ceil(TILE * TILE * perCellMax) + 64 : 0
    const blades = new Float32Array(maxBlades * BLADE_F)
    const rank = new Float32Array(maxBlades)
    const maxCards = Math.ceil(TILE * TILE * T.GRASS_SPRITE_PER_M2) + 16
    const cards = new Float32Array(maxCards * CARD_F)
    const crank = new Float32Array(maxCards)
    let n = 0, nc = 0, mownCells = 0, cells = 0
    const patchCells = Math.max(1, Math.round(T.GRASS_PATCH_SIZE))
    const x0 = tx * TILE, z0 = tz * TILE
    for (let cx = x0; cx < x0 + TILE; cx += cell) {
      for (let cz = z0; cz < z0 + TILE; cz += cell) {
        const wx = cx + 0.5 * cell, wz = cz + 0.5 * cell
        const roadD = this.roadDistance(wx, wz)
        if (roadD < this.pavedHalf + 0.3) continue // pavement
        if (roadD > this.pavedHalf + T.GRASS_MAX_FROM_ROAD) continue // spend the budget on the verge, where the eye is
        if (this.canopyAt(wx, -wz) > 3.0) continue // a real crown
        // slope rejection: a cut face or a steep embankment is rock and scrub, not turf
        const gy = this.groundAt(wx, -wz)
        const slope = Math.max(Math.abs(this.groundAt(wx + 1, -wz) - gy), Math.abs(this.groundAt(wx, -wz - 1) - gy))
        if (slope > T.GRASS_SLOPE_MAX) continue
        // bare patches: low-frequency hash noise thins the field where soil shows
        const patch = hash(Math.floor(cx / patchCells) * 971 + Math.floor(cz / patchCells) * 337)
        if (patch < T.GRASS_PATCHINESS) continue
        cells++
        const mown = roadD < this.pavedHalf + T.GRASS_MOW_LINE
        if (mown) mownCells++
        // the editor's local corrections: [height multiplier, density multiplier]
        const [ah, ad] = this.adjustAt ? this.adjustAt(wx, -wz) : [1, 1]
        const perCell = withBlades ? Math.round((mown ? T.GRASS_MOWN_PER_M2 : T.GRASS_ROUGH_PER_M2) * (0.7 + 0.6 * patch) * ad) : 0
        // one clump centre per cell; blades scatter around it
        const ccx = wx + (hash(cx * 7919 + cz * 104729) - 0.5) * cell
        const ccz = wz + (hash(cx * 15485863 + cz * 32452843) - 0.5) * cell
        for (let b = 0; b < perCell && n < maxBlades; b++) {
          const h1 = hash(cx * 31 + cz * 17 + b * 101), h2 = hash(cx * 13 + cz * 29 + b * 53)
          const x = ccx + (h1 - 0.5) * T.GRASS_SCATTER, z = ccz + (h2 - 0.5) * T.GRASS_SCATTER
          const y = this.groundAt(x, -z) - 0.02
          const rnd = hash(cx * 29 + cz * 31 + b * 3)
          const height = (mown ? T.GRASS_MOWN_HEIGHT : this.heightScale * T.GRASS_ROUGH_HEIGHT) * ah * T.GRASS_HEIGHT_SCALE * (0.6 + 0.8 * hash(cx * 3 + cz * 5 + b * 7))
          const width = (mown ? 0.035 : 0.05 + 0.03 * rnd) * T.GRASS_WIDTH_SCALE
          const lean = 0.15 + T.GRASS_LEAN * hash(cx * 11 + cz * 19 + b * 23)
          const o = n * BLADE_F
          blades[o] = x
          blades[o + 1] = y
          blades[o + 2] = z
          blades[o + 3] = rnd
          blades[o + 4] = height
          blades[o + 5] = width
          blades[o + 6] = lean
          rank[n] = hash(cx * 41 + cz * 43 + b * 47)
          n++
        }
        // clump cards: sparse, sized to the cover they stand in
        const cardsHere = T.GRASS_SPRITE_PER_M2 * (0.7 + 0.6 * patch) * ad
        const want = Math.floor(cardsHere) + (hash(cx * 61 + cz * 67) < cardsHere % 1 ? 1 : 0)
        for (let b = 0; b < want && nc < maxCards; b++) {
          const x = wx + (hash(cx * 71 + cz * 73 + b * 79) - 0.5) * cell, z = wz + (hash(cx * 83 + cz * 89 + b * 97) - 0.5) * cell
          const y = this.groundAt(x, -z) - 0.03
          const base = mown ? T.GRASS_MOWN_HEIGHT * 1.6 : this.heightScale * T.GRASS_ROUGH_HEIGHT * 0.8
          const size = base * ah * T.GRASS_HEIGHT_SCALE * T.GRASS_SPRITE_SCALE * (0.75 + 0.5 * hash(cx * 101 + cz * 103 + b * 107))
          const o = nc * CARD_F
          cards[o] = x
          cards[o + 1] = y
          cards[o + 2] = z
          cards[o + 3] = size
          cards[o + 4] = hash(cx * 109 + cz * 113 + b * 127)
          cards[o + 5] = mown ? 1 : 0
          crank[nc] = hash(cx * 131 + cz * 137 + b * 139)
          nc++
        }
      }
    }
    return { hasBlades: withBlades, blades: sortByRank(blades, rank, n, BLADE_F), n, cards: sortByRank(cards, crank, nc, CARD_F), nc, mown: mownCells * 2 > cells }
  }

  /** Copy the visible prefixes of the cached tiles into the instance buffers. */
  private assemble() {
    const rootArr = this.aRoot.array as Float32Array
    const bladeArr = this.aBlade.array as Float32Array
    const cardArr = this.aCard.array as Float32Array
    const card2Arr = this.aCard2.array as Float32Array
    let k = 0, kc = 0
    const rBlade = T.GRASS_RADIUS
    const rCard = T.GRASS_SPRITE_RADIUS
    const cardFrom = T.GRASS_LOD_MID - 8
    for (const t of this.visibleTiles()) {
      const tile = this.tiles.get(t.key)
      if (!tile) continue
      if (t.d <= rBlade + TILE * 0.71 && tile.n) {
        // density: LOD rings — full inside NEAR, MID_DENSITY to MID, FAR_DENSITY to the rim
        const falloff = t.d < T.GRASS_LOD_NEAR ? 1 : t.d < T.GRASS_LOD_MID ? T.GRASS_LOD_MID_DENSITY : T.GRASS_LOD_FAR_DENSITY
        const take = Math.min(tile.n, Math.round(tile.n * falloff), this.capacity - k)
        for (let i = 0; i < take; i++) {
          const o = i * BLADE_F
          rootArr[k * 3] = tile.blades[o]
          rootArr[k * 3 + 1] = tile.blades[o + 1]
          rootArr[k * 3 + 2] = tile.blades[o + 2]
          bladeArr[k * 4] = tile.blades[o + 3]
          bladeArr[k * 4 + 1] = tile.blades[o + 4]
          bladeArr[k * 4 + 2] = tile.blades[o + 5]
          bladeArr[k * 4 + 3] = tile.blades[o + 6]
          k++
        }
      }
      if (t.d >= cardFrom - TILE && t.d <= rCard + TILE * 0.71 && tile.nc) {
        // thin the cards toward the rim: full past the blades, GRASS_SPRITE_FAR_DENSITY at the far edge
        const u = Math.min(1, Math.max(0, (t.d - T.GRASS_LOD_MID) / Math.max(1, rCard - T.GRASS_LOD_MID)))
        const keep = 1 + (T.GRASS_SPRITE_FAR_DENSITY - 1) * u * u
        const take = Math.min(tile.nc, Math.round(tile.nc * keep), this.cardCapacity - kc)
        for (let i = 0; i < take; i++) {
          const o = i * CARD_F
          cardArr[kc * 4] = tile.cards[o]
          cardArr[kc * 4 + 1] = tile.cards[o + 1]
          cardArr[kc * 4 + 2] = tile.cards[o + 2]
          cardArr[kc * 4 + 3] = tile.cards[o + 3]
          card2Arr[kc * 2] = tile.cards[o + 4]
          card2Arr[kc * 2 + 1] = tile.cards[o + 5]
          kc++
        }
      }
    }
    this.bladeGeo.instanceCount = k
    this.aRoot.clearUpdateRanges()
    this.aRoot.addUpdateRange(0, k * 3)
    this.aRoot.needsUpdate = true
    this.aBlade.clearUpdateRanges()
    this.aBlade.addUpdateRange(0, k * 4)
    this.aBlade.needsUpdate = true
    this.cardGeo.instanceCount = kc
    this.aCard.clearUpdateRanges()
    this.aCard.addUpdateRange(0, kc * 4)
    this.aCard.needsUpdate = true
    this.aCard2.clearUpdateRanges()
    this.aCard2.addUpdateRange(0, kc * 2)
    this.aCard2.needsUpdate = true
    this.cardMat.uniforms.uFadeIn.value = T.GRASS_LOD_MID
    this.cardMat.uniforms.uFadeOut.value = T.GRASS_SPRITE_RADIUS
  }

  /** counts for probes and the HUD */
  get counts(): { blades: number; cards: number; tiles: number; pending: number; motion: number } {
    return { blades: this.bladeGeo.instanceCount, cards: this.cardGeo.instanceCount, tiles: this.tiles.size, pending: this.pending.length, motion: +this.motion.toFixed(2) }
  }
}

/** Reorder `n` records of `stride` floats by ascending rank, into a right-sized array. */
function sortByRank(data: Float32Array, rank: Float32Array, n: number, stride: number): Float32Array {
  const idx = new Uint32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  idx.sort((a, b) => rank[a] - rank[b])
  const out = new Float32Array(n * stride)
  for (let i = 0; i < n; i++) {
    const src = idx[i] * stride, dst = i * stride
    for (let j = 0; j < stride; j++) out[dst + j] = data[src + j]
  }
  return out
}

function hash(n: number): number {
  let x = (n | 0) ^ 0x5bd1e995
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d)
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39)
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296
}
