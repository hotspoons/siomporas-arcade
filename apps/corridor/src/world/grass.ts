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
import { LAMPS, LAMP_PARS, retro } from '../visuals/retro'
import { SPLAT_MASK_PARS, splatMaskUniforms } from '../visuals/splatmask'
import type { SeasonLook } from '../visuals/season'
import { GRASS_LOOK, type GrassType } from './groundcover'
import { ACCUM_PARS, accumUniforms } from '../visuals/weather'
import * as T from '../tuning'
import { ROAD_CLIP_PARS, roadClipUniforms } from '../visuals/roadcover'
import { grassReliefLook, grassReliefTick } from '../visuals/grassrelief'

const SEGMENTS = 6
const TILE = 8
const BLADE_F = 8 // x y z | rand height width lean mown
const CARD_F = 6 // x y z | size rand mown
/** shared empty instance array: an off-road corridor tile and a bare one both want zero records */
const EMPTY_RECORDS = new Float32Array(0)

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
  // the strokes used to sit in the middle 28% of the card, so a clump was a thin wisp inside a
  // mostly empty quad and the verge read as dirt with a few tufts. Spread them across the card.
  for (let i = 0; i < 140; i++) {
    const x0 = S * (0.5 + (rnd() - 0.5) * 0.7)
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
  /** the fast-bias thin factor this tile was GENERATED at, so a slowed eye knows to regenerate it */
  thin: number
  /** uTime when the tile was generated: its blades and cards grow in from then (GRASS_GROW_S) */
  born: number
}

const GLSL_NOISE = /* glsl */ `
  float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
  }
`

/**
 * SUN-SHADOW RECEIVE, shared by the blade and card materials. Both light themselves in raw
 * ShaderMaterials, which sit outside three's light/shadow system, so `receiveShadow` does nothing;
 * each samples the sun's own depth texture by hand. Four-tap hardware PCF — the depth texture is a
 * sampler2DShadow with a compare function, so each texture() is itself a comparison. Outside the
 * sun's frustum, or before the map exists, everything is lit, as is everything once the sun is
 * below the horizon. Returns the RAW mask; the caller folds in the SHADOW knob. The `varying vec4
 * vSunShadow` is declared here; each vertex shader declares its own and writes it.
 */
const SUN_SHADOW_PARS = /* glsl */ `
  uniform sampler2DShadow uSunShadow;
  uniform vec2 uSunShadowSize;
  uniform float uSunShadowBias;
  uniform float uSunShadowRadius;
  uniform float uSunShadowIntensity;
  uniform float uSunShadowOn;
  varying vec4 vSunShadow;
  float sunShadowMask() {
    if (uSunShadowOn < 0.5) return 1.0;
    // THE SUN'S SHADOW IS THE SUN'S. Below civil twilight the sun light sits under the ground, so
    // its depth map is a view from beneath the world and rakes long phantom shadows across grass
    // that only the headlights are lighting — they read as "cast towards the headlights"
    // (Rich, 2026-06-22). Fade the sun's shadow out with the sun, on the scene's own twilight
    // curve: day is smoothstep(el, -6°, +4°), which is uSun.y across the same two elevations.
    // (uSun is declared by each fragment before this block.)
    float dayGate = smoothstep(-0.105, 0.070, uSun.y);
    if (dayGate <= 0.001) return 1.0;
    vec3 sc = vSunShadow.xyz / vSunShadow.w;
    if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
    sc.z += uSunShadowBias;
    vec2 texel = vec2(1.0) / uSunShadowSize;
    float r = uSunShadowRadius * texel.x;
    float s = 0.0;
    s += texture(uSunShadow, vec3(sc.xy + vec2(-r, -r), sc.z));
    s += texture(uSunShadow, vec3(sc.xy + vec2( r, -r), sc.z));
    s += texture(uSunShadow, vec3(sc.xy + vec2(-r,  r), sc.z));
    s += texture(uSunShadow, vec3(sc.xy + vec2( r,  r), sc.z));
    return mix(1.0, s * 0.25, dayGate);
  }
`

/**
 * GRASS CASTS ON ITSELF (fake) — shared by the blade and card materials. Real blade-on-blade
 * shadowing wants a real depth pass over tens of thousands of blades (GRASS_CAST_REAL does that for
 * the sun); this handles the rest — the headlamps, and the far cards — with no pass at all. Treat
 * the turf as a procedural canopy height field and march two samples along the ground TOWARD THE
 * BRIGHTEST LIGHT (the sun by day, the nearest headlamp by night); darken a fragment where the
 * canopy up-light stands above it. It reads as clumps rather than uniform darkening. `mown` damps
 * it: a mown blade has almost no canopy above it to shade it.
 */
const GRASS_CAST_PARS = /* glsl */ `
  uniform float uCastStrength;
  uniform float uCastFreq;
  uniform float uCastReach;
  uniform float uCastHeight;
  float chash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float cnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(chash(i), chash(i + vec2(1, 0)), u.x), mix(chash(i + vec2(0, 1)), chash(i + vec2(1, 1)), u.x), u.y);
  }
  float grassCanopy(vec2 p) {
    // 0 in the gaps, 1 in the tall clumps (same clumpy character as the turf lattice)
    return smoothstep(0.45, 0.8, cnoise(p * uCastFreq));
  }
  vec2 brightLightXZ(vec3 w, float sunW) {
    vec2 best = uSun.xz;
    float bestW = sunW;
    // the lamp loop is only worth its ALU once the headlights are actually on
    if (uLampOn > 0.5) {
      for (int k = 0; k < ${LAMPS}; k++) {
        vec3 dir;
        float reach = lampReach(w, k, dir) * uLampOn;
        if (reach > bestW) { best = uLampPos[k].xz - w.xz; bestW = reach; }
      }
    }
    return best * inversesqrt(max(dot(best, best), 1e-6));
  }
  float grassSelfShadow(vec3 w, float above, float mown) {
    if (uCastStrength <= 0.001) return 1.0;
    // how tall this fragment stands against the canopy: a short blade is shadowed by far
    // more of the clumps up-light than a tip is
    float hFrac = clamp(above / max(uCastHeight, 0.05), 0.0, 1.0);
    vec2 d = brightLightXZ(w, uNightMul) * (uCastReach * 0.5);
    float lo = hFrac + 0.03, hi = hFrac + 0.45;
    float occ = smoothstep(lo, hi, grassCanopy(w.xz + d));
    occ = max(occ, smoothstep(lo, hi, grassCanopy(w.xz + d * 2.0)));
    return 1.0 - clamp(occ * uCastStrength * mix(1.0, 0.35, mown), 0.0, 1.0);
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
  private aExtra: THREE.InstancedBufferAttribute // (born, mown)
  private aBlade: THREE.InstancedBufferAttribute // (rand, height, width, lean)
  private aCard: THREE.InstancedBufferAttribute // (x, y, z, size)
  private aCard2: THREE.InstancedBufferAttribute // (rand, mown, born)
  private bladeMat: THREE.ShaderMaterial
  private cardMat: THREE.ShaderMaterial
  /** depth-only twin of the blade vertex transform, for the sun's shadow map (GRASS_CAST_REAL) */
  private bladeDepth: THREE.ShaderMaterial
  private capacity: number
  private cardCapacity: number
  private heightScale = 0.4
  private groundAt: (x: number, y: number) => number
  private canopyAt: (x: number, y: number) => number
  private roadDistance: (x: number, z: number) => number
  /** kept (mown lawn everywhere) or rural (a mown shoulder, then tall grass), world x,z — see zoning.ts */
  private zoneAt: ((x: number, z: number) => 'kept' | 'rural' | null) | undefined
  /** the direction in which the road distance grows (scene.ts edgeDistance): a blade's own distance
   * from the cell's, without a second grid walk per blade */
  private roadGrad: ((x: number, z: number) => [number, number]) | undefined
  /**
   * The masks, asked per blade rather than per cell.
   *
   * `roadDistance` folds two different things together: a smooth distance to the nearest
   * carriageway, and a set of hard-edged rasters — a parking bay, a walk, the vegetation mask,
   * the paving classifier — which it reports as the sentinel -1. The per-blade test below places
   * a blade's own distance by stepping along the GEOMETRY's gradient, which is legitimate (the
   * station field changes by about a third of a metre every half metre) but which steps straight
   * over a raster edge, because a raster has no gradient. So the geometry is extrapolated and the
   * masks are asked directly, at the blade's own feet. Rich, 2026-09-27: "found a couple more
   * spots where grass is growing through the road."
   */
  private blockedAt: ((x: number, z: number) => boolean) | undefined
  /** this site was baked as a world, so the ground decides where grass grows, not the road */
  world = false
  /** the last uTime pushed to the shaders; a tile born now grows in from here */
  private now = 0
  private pavedHalf: number
  private adjustAt: ((x: number, y: number) => [number, number]) | undefined
  /** the bare DEM, for the shelf test in generate(); undefined means the test is skipped */
  private demAt: ((x: number, y: number) => number) | undefined
  private tiles = new Map<string, Tile>()
  private pending: { key: string; tx: number; tz: number; withBlades: boolean }[] = []
  private prevEye = new THREE.Vector3(NaN, NaN, NaN)
  private prevT = 0
  private motion = 1 // 1 still … 0 moving fast: scales the wind
  /** 0 at rest … 1 at GRASS_CONE_SPEED: how tightly the footprint is focused ahead of the car */
  private speedFrac = 0
  /** 0 normal … 1 at GRASS_FAST_SPEED: how hard the thin/range fast bias is applied */
  private fastFrac = 0
  private lastSpeedFrac = -1
  private lastFastFrac = -1
  /** the live footprint shape, rebuilt from speed each update: half-angle and behind stretch */
  private coneDeg = 180
  private coneStretch = 0
  /** live fast-bias multipliers: blade/card density, and how far the far cards reach */
  private thinMul = 1
  private rangeMul = 1
  /** the far rim the generator can actually clear, as a fraction of GRASS_SPRITE_RADIUS (see GRASS_RIM_DRAIN) */
  private rimMul = 1
  /** cards at every range: GRASS_MODE 1, or the eye moving faster than GRASS_WIND_STILL_BELOW */
  private spritesOnly = T.grassMode() === 1
  private lastTile = 'none'
  private lastHeading = Infinity
  private lastPitch = Infinity
  private dirty = true
  private frame = 0
  private eye = new THREE.Vector3()
  private fwd = new THREE.Vector3(1, 0, 0)
  private pitch = 0
  /** the visible tile set for this eye/heading, nearest first; rebuilt only when the view moved */
  private vis: { key: string; tx: number; tz: number; d: number }[] = []
  private visStale = true
  /**
   * The settled layer's uniforms, shared by the blade and card materials so Precipitation.follow
   * drives both with one object. Snow has to lie on the grass as well as the ground: a white verge
   * with green grass standing out of it is worse than no snow at all.
   */
  readonly weatherUniforms = accumUniforms()
  /** what grows here: shape multipliers over the season palette and the knobs (groundcover.ts) */
  private type: GrassType = 'common'
  private look = GRASS_LOOK.common
  // per-frame cost of the last update(), milliseconds. This box has no GPU (swiftshader renders
  // ~1 frame per 10 s at Rich's density), so the only honest frame-time number we can take here
  // is the CPU half — tile generation and buffer assembly. probes/corridor-grasscpu.mjs reads it.
  private genMs = 0
  private asmMs = 0
  private madeThisFrame = 0

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
    demAt: ((x: number, y: number) => number) | undefined = undefined,
    zoneAt: ((x: number, z: number) => 'kept' | 'rural' | null) | undefined = undefined,
    roadGrad: ((x: number, z: number) => [number, number]) | undefined = undefined,
    /** where a MASK forbids grass — parking, a walk, bare ground, paved imagery. See below. */
    blockedAt: ((x: number, z: number) => boolean) | undefined = undefined,
  ) {
    this.demAt = demAt
    this.zoneAt = zoneAt
    this.roadGrad = roadGrad
    this.blockedAt = blockedAt
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
    this.aExtra = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    this.aRoot.setUsage(THREE.DynamicDrawUsage)
    this.aBlade.setUsage(THREE.DynamicDrawUsage)
    this.aExtra.setUsage(THREE.DynamicDrawUsage)
    this.bladeGeo.setAttribute('aRoot', this.aRoot)
    this.bladeGeo.setAttribute('aBlade', this.aBlade)
    this.bladeGeo.setAttribute('aExtra', this.aExtra)
    this.bladeGeo.instanceCount = 0
    this.bladeMat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
        ...roadClipUniforms,
        uTime: { value: 0 },
        uWind: { value: 1 },
        uGrow: { value: 0.8 },
        uRadius: { value: 40 },
        // tip taper 0..1 (0 = cut flat, 1 = needle point), blended by the blade's mown flag
        uTaperShort: { value: 0.25 },
        uTaperLong: { value: 0.95 },
        uBase: { value: look.grass.base.clone() },
        uTip: { value: look.grass.tip.clone() },
        uDry: { value: look.grass.dry },
        uSun: { value: sun },
        uHue: { value: 0 },
        uSat: { value: 1 },
        uLight: { value: 1 },
        // the car's lamps, shared BY REFERENCE with every other self-lighting shader (retro.ts)
        ...retro.uniforms,
        uLampGain: { value: 1 },
        // the seam: where a capture has taken over, the blades dissolve away (splatmask.ts)
        ...splatMaskUniforms(),
        uNightMul: { value: 1 },
        uLightTint: { value: new THREE.Color(1, 1, 1) },
        // SUN SHADOW. The blades light themselves (half-Lambert), so they sit outside three's light
        // system; `receiveShadow` does nothing for a raw ShaderMaterial. We sample the sun's own
        // shadow map by hand — the same depth texture the strip and the trees use — so a tree, a
        // building or the car drops a shadow across the blades. RECEIVE only: casting would mean a
        // second depth pass over ~90k blades for a self-shadow that reads as noise.
        uSunShadow: { value: null as THREE.Texture | null },
        uSunShadowMatrix: { value: new THREE.Matrix4() },
        uSunShadowSize: { value: new THREE.Vector2(1, 1) },
        uSunShadowBias: { value: 0 },
        uSunShadowRadius: { value: 1 },
        uSunShadowIntensity: { value: 1 },
        uSunShadowOn: { value: 0 },
        // the strip's extras for `SHADOW` past 1 (visuals/shading.ts SHADE): crush the soft shadow
        // mask and pull the whole fill down, so a shadowed blade matches the shadowed road
        uShade: { value: 1 },
        // FAKE grass-on-grass self-shadow (no depth pass): strength, canopy clump frequency, and
        // how far up-light the canopy march reaches
        uCastStrength: { value: 0.55 },
        uCastFreq: { value: 0.8 },
        uCastReach: { value: 1.8 },
        uCastHeight: { value: 0.6 },
        ...this.weatherUniforms,
      },
      vertexShader: /* glsl */ `
        attribute vec3 aRoot;
        attribute vec4 aBlade; // rand, height, width, lean
        attribute vec2 aExtra; // born (uTime of the tile), mown
        uniform float uTime;
        uniform float uWind;
        uniform float uGrow;
        uniform float uRadius;
        uniform float uTaperShort;
        uniform float uTaperLong;
        varying float vT;
        varying float vRand;
        varying float vMown;
        varying vec3 vNormal;
        varying vec3 vWorld;
        varying vec4 vSunShadow;
        varying float vAbove;
        uniform mat4 uSunShadowMatrix;
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        ${GLSL_NOISE}
        void main() {
          float t = position.y;
          vT = t;
          vRand = aBlade.x;
          vMown = aExtra.y;
          // NO POP AT THE RIM. Blade tiles are generated out to uRadius and used to appear there
          // at full height — "grass still pops in" (Rich, 2026-09-26). The height goes to zero
          // over the last 14 m before the radius, so a tile arriving at the rim arrives invisible
          // and grows as you approach; size, not alpha, so there is no alpha-test pop either.
          float dEye = length((cameraPosition - aRoot).xz);
          float rim = 1.0 - smoothstep(uRadius - 14.0, uRadius + 2.0, dEye);
          // NO POP ON A NEW TILE EITHER: a tile generated late (the eye outran the generator, a
          // hedgerow's worth of blades in one frame) grows from the ground over uGrow seconds
          float grow = smoothstep(aExtra.x, aExtra.x + uGrow, uTime);
          float h = aBlade.y * rim * grow;
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
          // trimmed lawn does not sway: a mown blade keeps a tenth of the wind
          vec3 windTip = windDir * (sway + gust + turb) * h * uWind * (1.0 - 0.9 * aExtra.y);

          // quadratic bezier from root through a leaned control point to a wind-blown tip
          vec3 P0 = root;
          vec3 P2 = root + vec3(0.0, h, 0.0) + face * (lean * h) + windTip;
          vec3 P1 = root + vec3(0.0, h * 0.62, 0.0) + face * (lean * h * 0.25);
          float it = 1.0 - t;
          vec3 pOnCurve = it * it * P0 + 2.0 * it * t * P1 + t * t * P2;
          vec3 tangent = normalize(2.0 * it * (P1 - P0) + 2.0 * t * (P2 - P1));
          vec3 n = normalize(cross(side, tangent));

          // taper, and a view-dependent thickening so edge-on blades keep a presence.
          // Short (mown) and long (rough) grass taper independently via GRASS_TAPER_SHORT/LONG.
          float tipTaper = mix(uTaperLong, uTaperShort, aExtra.y);
          float taper = 1.0 - t * t * tipTaper;
          vec3 toCam = normalize(cameraPosition - pOnCurve);
          float edgeOn = 1.0 - abs(dot(toCam, n));
          float w = width * taper * (1.0 + edgeOn * 0.7);
          vec3 world = pOnCurve + side * position.x * w * 0.5;

          // curved cross-section: bend the normal toward the blade's side for a rounded look
          vNormal = normalize(n + side * position.x * 0.35);
          vWorld = world;
          vAbove = world.y - root.y;
          vSunShadow = uSunShadowMatrix * vec4(world, 1.0);
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
        // the scene's day/night level: grass is drawn by its own shader and knows nothing about the
        // lights, so without this it glows in the dark (Rich, 2026-09-26)
        uniform float uNightMul;
        uniform vec3 uLightTint;
        uniform float uShade;
        varying float vT;
        varying float vRand;
        varying float vMown;
        varying vec3 vNormal;
        varying vec3 vWorld;
        varying float vAbove;
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        ${ACCUM_PARS}
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
        ${LAMP_PARS}
        ${SPLAT_MASK_PARS}
        ${ROAD_CLIP_PARS}
        ${SUN_SHADOW_PARS}
        ${GRASS_CAST_PARS}
        uniform float uLampGain;
        void main() {
          if (roadCovered(vWorld)) discard;
          splatDissolve(vWorld);
          #include <logdepthbuf_fragment>
          vec3 n = normalize(gl_FrontFacing ? vNormal : -vNormal);
          vec3 v = normalize(cameraPosition - vWorld);
          // colour: root to tip ramp, per-blade hue/brightness variation, dry-season straw
          vec3 c = mix(uBase, uTip, smoothstep(0.1, 1.0, vT));
          c *= 0.8 + 0.4 * vRand;
          c = mix(c, c * vec3(1.15, 1.05, 0.65), uDry * (0.3 + 0.7 * vRand));
          // ambient occlusion at the root, where blades shade each other
          float ao = mix(0.35, 1.0, smoothstep(0.0, 0.6, vT));
          // half-Lambert sun, sky ambient, and back-light translucency when the sun is behind.
          // Only the direct sun is shadowed; the 0.35 sky-ambient floor survives in shade, which
          // is what stops a shadowed blade going black.
          float selfSh = grassSelfShadow(vWorld, vAbove, vMown);
          float shR = sunShadowMask();
          float sh = mix(1.0, shR, uSunShadowIntensity) * selfSh;
          float ndl = dot(n, uSun) * 0.5 + 0.5;
          float back = pow(max(0.0, dot(v, -uSun)), 4.0) * 0.6 * vT;
          vec3 lit = c * (0.35 + 0.75 * ndl * sh) * ao + uTip * back * sh;
          // a little specular sheen along the blade
          vec3 hvec = normalize(uSun + v);
          lit += vec3(0.08) * pow(max(0.0, dot(n, hvec)), 24.0) * vT * sh;
          vec3 outCol = grade(lit, uHue, uSat, uLight) * uNightMul * uLightTint;
          // and the car's headlights, which a self-lighting shader would otherwise never see
          outCol += c * ao * lampDiffuse(vWorld, n, uLampGain) * selfSh;
          // a blade catches the settled layer at its TIP, not at its root, so the normal it is
          // weighed by is faked upright near the top — the real one points sideways all the way up
          outCol = applyWeather(outCol, vec3(0.0, mix(0.1, 1.0, vT), 0.0), vWorld);
          // the same extra darkening the strip gets (visuals/shading.ts SHADE): past SHADOW 1 the
          // sun's own shadow is not enough, so crush the soft mask and pull the fill down, or a
          // shadowed blade would sit brighter than the shadowed road beside it
          outCol *= mix(1.0 / (1.0 + uShade * 3.0), 1.0, pow(clamp(shR, 0.0, 1.0), 1.0 + uShade * 2.0));
          gl_FragColor = vec4(outCol, 1.0);
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
    // REAL SUN CAST. A raw ShaderMaterial needs its own depth material — three's default knows
    // nothing about aRoot/aBlade. This is the blade vertex transform with the wind, the rim fade
    // and the edge-on widening stripped out: it only has to put the blade in the light's clip
    // space. Casting is what lets the WORLD receive blade shadows; the color pass reads them back
    // through the same map (SUN_SHADOW_PARS) for blade-on-blade.
    this.bladeDepth = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uGrow: { value: 0.8 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aRoot;
        attribute vec4 aBlade; // rand, height, width, lean
        attribute vec2 aExtra; // born (uTime of the tile), mown
        uniform float uTime;
        uniform float uGrow;
        void main() {
          float t = position.y;
          float h = aBlade.y * smoothstep(aExtra.x, aExtra.x + uGrow, uTime);
          float lean = aBlade.w;
          vec3 root = aRoot;
          float yaw = aBlade.x * 6.2831853;
          vec3 face = vec3(cos(yaw), 0.0, sin(yaw));
          vec3 side = vec3(-face.z, 0.0, face.x);
          vec3 P0 = root;
          vec3 P2 = root + vec3(0.0, h, 0.0) + face * (lean * h);
          vec3 P1 = root + vec3(0.0, h * 0.62, 0.0) + face * (lean * h * 0.25);
          float it = 1.0 - t;
          vec3 pOnCurve = it * it * P0 + 2.0 * it * t * P1 + t * t * P2;
          vec3 world = pOnCurve + side * position.x * aBlade.z * 0.5;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `void main() { gl_FragColor = vec4(1.0); }`,
      side: THREE.DoubleSide,
    })
    this.blades.customDepthMaterial = this.bladeDepth

    // --- clump cards ---------------------------------------------------------------------------
    this.cardGeo = cardGeometry()
    this.aCard = new THREE.InstancedBufferAttribute(new Float32Array(this.cardCapacity * 4), 4)
    this.aCard2 = new THREE.InstancedBufferAttribute(new Float32Array(this.cardCapacity * 3), 3)
    this.aCard.setUsage(THREE.DynamicDrawUsage)
    this.aCard2.setUsage(THREE.DynamicDrawUsage)
    this.cardGeo.setAttribute('aCard', this.aCard)
    this.cardGeo.setAttribute('aCard2', this.aCard2)
    this.cardGeo.instanceCount = 0
    this.cardMat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
        ...roadClipUniforms,
        uTime: { value: 0 },
        uWind: { value: 1 },
        uGrow: { value: 0.8 },
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
        // the car's lamps, shared BY REFERENCE with every other self-lighting shader (retro.ts)
        ...retro.uniforms,
        uLampGain: { value: 1 },
        // the seam: where a capture has taken over, the blades dissolve away (splatmask.ts)
        ...splatMaskUniforms(),
        uNightMul: { value: 1 },
        uLightTint: { value: new THREE.Color(1, 1, 1) },
        // sun-shadow RECEIVE and fake self-shadow, same chunks the blades use (see SUN_SHADOW_PARS
        // / GRASS_CAST_PARS). Cards used to be outside the blade radius and skipped; now they fill
        // the far field in every mode, so a shadowed card must go dark with the ground beside it.
        uSunShadow: { value: null as THREE.Texture | null },
        uSunShadowMatrix: { value: new THREE.Matrix4() },
        uSunShadowSize: { value: new THREE.Vector2(1, 1) },
        uSunShadowBias: { value: 0 },
        uSunShadowRadius: { value: 1 },
        uSunShadowIntensity: { value: 1 },
        uSunShadowOn: { value: 0 },
        uShade: { value: 1 },
        uCastStrength: { value: 0.55 },
        uCastFreq: { value: 0.8 },
        uCastReach: { value: 1.8 },
        uCastHeight: { value: 0.6 },
        ...this.weatherUniforms,
      },
      vertexShader: /* glsl */ `
        attribute vec4 aCard;  // x y z size
        attribute vec3 aCard2; // rand mown born
        uniform float uTime;
        uniform float uWind;
        uniform float uGrow;
        uniform float uFadeIn;
        uniform float uFadeOut;
        uniform float uWidth;
        uniform float uLean;
        varying vec2 vUv;
        varying float vRand;
        varying float vMown;
        varying vec3 vCardWorld;
        varying vec4 vSunShadow;
        varying float vAbove;
        uniform mat4 uSunShadowMatrix;
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
          float size = aCard.w * fade * smoothstep(aCard2.z, aCard2.z + uGrow, uTime);
          float gust = (vnoise(root.xz * 0.06 + vec2(uTime * 0.35, uTime * 0.12)) - 0.5) * 0.35 * uWind * (1.0 - 0.9 * aCard2.y);
          // lean: the top of the card shears sideways by a per-card amount, so a field is not a row of fence posts
          float lean = (aCard2.x - 0.5) * 2.0 * uLean;
          vec3 world = root + right * (position.x * size * uWidth + lean * position.y * size) + vec3(0.0, position.y * size, 0.0)
                     + vec3(0.8, 0.0, 0.5) * gust * position.y * size;
          vCardWorld = world;
          // above the root, for the fake self-shadow; and this fragment in the sun's shadow clip
          vAbove = position.y * size;
          vSunShadow = uSunShadowMatrix * vec4(world, 1.0);
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
        uniform vec3 uSun;
        uniform float uHue;
        uniform float uSat;
        uniform float uLight;
        // the scene's day/night level: grass is drawn by its own shader and knows nothing about the
        // lights, so without this it glows in the dark (Rich, 2026-09-26)
        uniform float uNightMul;
        uniform vec3 uLightTint;
        uniform float uShade;
        varying vec2 vUv;
        varying float vRand;
        varying float vMown;
        varying vec3 vCardWorld;
        varying float vAbove;
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        ${ACCUM_PARS}
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
        ${LAMP_PARS}
        ${SPLAT_MASK_PARS}
        ${ROAD_CLIP_PARS}
        ${SUN_SHADOW_PARS}
        ${GRASS_CAST_PARS}
        uniform float uLampGain;
        void main() {
          if (roadCovered(vCardWorld)) discard;
          splatDissolve(vCardWorld);
          #include <logdepthbuf_fragment>
          vec3 c;
          float shade;
          {
            vec4 s = texture2D(uMap, vUv);
            if (s.a < 0.5) discard;
            c = mix(uBase, uTip, smoothstep(0.1, 1.0, vUv.y));
            shade = mix(0.55, 1.15, s.r);
          }
          c *= 0.8 + 0.4 * vRand;
          c = mix(c, c * vec3(1.15, 1.05, 0.65), uDry * (0.3 + 0.7 * vRand));
          // a mown card is a low even turf; keep it a touch darker like the strip's mown texture
          c *= shade * mix(1.0, 0.85, vMown);
          vec3 outCol = grade(c, uHue, uSat, uLight) * uNightMul * uLightTint;
          // a card is a billboard with no honest normal; light it as the turf it represents,
          // which is flat, so the beam rakes across it the way it rakes across the verge
          outCol += c * lampDiffuse(vCardWorld, vec3(0.0, 1.0, 0.0), uLampGain);
          // RECEIVE the sun's shadow (tree/building/car) and ADD the fake self-shadow, so a card
          // goes dark with the ground beside it and clumps cast on their neighbours
          float shR = sunShadowMask();
          float selfSh = grassSelfShadow(vCardWorld, vAbove, vMown);
          outCol *= mix(1.0, shR, uSunShadowIntensity) * selfSh;
          outCol = applyWeather(outCol, vec3(0.0, mix(0.1, 1.0, vUv.y), 0.0), vCardWorld);
          // the same extra crush the blades and the strip get past SHADOW 1
          outCol *= mix(1.0 / (1.0 + uShade * 3.0), 1.0, pow(clamp(shR, 0.0, 1.0), 1.0 + uShade * 2.0));
          gl_FragColor = vec4(outCol, 1.0);
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
    this.sig = this.signature() // so the FIRST knob change is judged against the built tiles, not ''
    this.lodSig = this.lodSignature()
  }

  /**
   * The site's ground cover: the blade style, and how much of it there is.
   *
   * `blades` is the second half of a ground-cover class (groundcover.ts `CoverLook`). Chaparral and
   * conifer duff are not swards — they are woody scrub and needle mat with a few stems in the gaps —
   * so the class that chooses the blade SHAPE also says how many blades belong there at all.
   * Regenerates only if something actually changed (see invalidate).
   */
  setType(t: GrassType, blades = 1) {
    if (t === this.type && blades === this.bladeScale) return
    this.type = t
    this.bladeScale = blades
    this.look = blades === 1 ? GRASS_LOOK[t] : { ...GRASS_LOOK[t], density: GRASS_LOOK[t].density * blades }
    this.invalidate()
  }
  private bladeScale = 1
  get grassType(): GrassType {
    return this.type
  }

  /**
   * What the blades are ACTUALLY drawing with, read back off the uniforms.
   *
   * probes/corridor-flora.mjs prints this per season. A screenshot cannot settle "is the hillside
   * browner in September than it used to be"; `#97a054 -> #cfbd8a` can.
   */
  get applied(): { type: GrassType; blades: number; dry: number; base: string; tip: string } {
    const u = this.bladeMat.uniforms
    return {
      type: this.type,
      blades: this.bladeScale,
      dry: u.uDry.value as number,
      base: '#' + (u.uBase.value as THREE.Color).getHexString(),
      tip: '#' + (u.uTip.value as THREE.Color).getHexString(),
    }
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
    this.bladeMat.uniforms.uRadius.value = T.GRASS_RADIUS
    this.bladeMat.uniforms.uTaperShort.value = T.GRASS_TAPER_SHORT
    this.bladeMat.uniforms.uTaperLong.value = T.GRASS_TAPER_LONG
    this.now = t
    for (const m of [this.bladeMat, this.cardMat]) {
      m.uniforms.uTime.value = t
      m.uniforms.uGrow.value = T.GRASS_GROW_S
      // no sway from a moving car: the eye speed (measured in update) fades the wind out
      m.uniforms.uWind.value = T.GRASS_WIND * this.motion
      m.uniforms.uDry.value = Math.min(1, Math.max(0, this.dryBase + T.GRASS_DRY_ADD + this.look.dry))
      m.uniforms.uHue.value = T.GRASS_HUE + this.look.hue
      m.uniforms.uSat.value = T.GRASS_SAT * this.look.sat
      m.uniforms.uLight.value = T.GRASS_LIGHT
      m.uniforms.uLampGain.value = T.HEADLIGHT_BOUNCE
    }
    // SUN SHADOW: read the sun's live shadow map. It only exists after the first shadow render,
    // and `castShadow` flips with the SHADOW knob, so this is a per-frame read rather than a
    // one-time bind. BOTH the blades and the cards receive it (and fake-self-shadow).
    {
      const light = this.sunLight
      const shadow = light && light.castShadow ? light.shadow : null
      const map = shadow && shadow.map ? (shadow.map.depthTexture ?? shadow.map.texture) : null
      const intensity = shadow ? ((shadow as THREE.LightShadow & { intensity?: number }).intensity ?? 1) : 1
      for (const mat of [this.bladeMat, this.cardMat]) {
        const u = mat.uniforms
        u.uSunShadowOn.value = map ? 1 : 0
        u.uSunShadow.value = map
        u.uShade.value = T.SHADOW
        u.uCastStrength.value = T.GRASS_CAST
        u.uCastFreq.value = 1 / Math.max(0.05, T.GRASS_CAST_SCALE)
        u.uCastReach.value = T.GRASS_CAST_REACH
        u.uCastHeight.value = Math.max(0.15, this.heightScale * T.GRASS_ROUGH_HEIGHT * this.look.height)
        if (map && shadow) {
          u.uSunShadowMatrix.value.copy(shadow.matrix)
          u.uSunShadowSize.value.set(shadow.mapSize.x, shadow.mapSize.y)
          u.uSunShadowBias.value = shadow.bias
          u.uSunShadowRadius.value = 1
          u.uSunShadowIntensity.value = intensity
        }
      }
    }
    // REAL CAST: spool the blades into the sun's shadow map so the world receives them. The depth
    // twin keeps its own clock; it is deliberately wind-free (imperceptible at shadow resolution).
    this.blades.castShadow = T.GRASS_CAST_REAL > 0.02
    this.bladeDepth.uniforms.uTime.value = t
    this.bladeDepth.uniforms.uGrow.value = T.GRASS_GROW_S
    // THICK is the same number on the blades and the cards; cards once ignored it, so the width
    // knob never filled the tufts.
    this.cardMat.uniforms.uWidth.value = T.GRASS_SPRITE_WIDTH * T.GRASS_THICK
    this.cardMat.uniforms.uLean.value = T.GRASS_SPRITE_LEAN
    // mode 1 is cards only (assemble draws no blades anyway); mode 0 keeps the real 3D blades, as
    // does the relief underlayment (GRASS_GROUND), which is a separate choice.
    this.blades.visible = T.grassMode() !== 1
    grassReliefLook(
      this.bladeMat.uniforms.uBase.value as THREE.Color,
      this.bladeMat.uniforms.uTip.value as THREE.Color,
      this.bladeMat.uniforms.uDry.value as number,
    )
    grassReliefTick(t, this.look)
  }

  /**
   * Everything about a tile's CONTENTS: change one of these and the cached tiles are wrong.
   * Deliberately not here: colour, wind, dryness, sprite width/lean (uniforms, free), and the LOD
   * densities and shape (they only choose how much of each cached tile to copy, in assemble).
   */
  private signature(): string {
    return [
      T.GRASS_MOWN_PER_M2, T.GRASS_ROUGH_PER_M2, T.GRASS_RADIUS, T.GRASS_SPRITE_RADIUS,
      T.GRASS_SPRITE_PER_M2, T.GRASS_MOW_LINE, T.GRASS_ROAD_CLEAR, T.GRASS_MAX_FROM_ROAD, T.GRASS_PATCHINESS,
      T.GRASS_PATCH_SIZE, T.GRASS_SCATTER, T.GRASS_SLOPE_MAX, T.GRASS_MOWN_HEIGHT,
      T.GRASS_ROUGH_HEIGHT, T.GRASS_LEAN, T.GRASS_HEIGHT, T.GRASS_THICK, T.GRASS_DENSITY,
      T.GRASS_SPRITE_SCALE, T.GRASS_MAX_SHELF, this.heightScale, this.type,
    ].join(',')
  }
  /** LOD knobs only change how much of a cached tile is copied. They must not rebuild the tiles. */
  private lodSignature(): string {
    return [T.GRASS_LOD_NEAR, T.GRASS_LOD_MID, T.GRASS_LOD_MID_DENSITY, T.GRASS_LOD_FAR_DENSITY, T.GRASS_SPRITE_FAR_DENSITY].join(',')
  }
  private sig = ''
  private lodSig = ''

  /**
   * A knob or the season changed. `retune()` cannot know WHICH knob, so it calls this for all of
   * them — and a full cache clear is ~3 s of grass visibly growing back in. That is what made
   * tuning miserable: dragging the hue slider threw away every tile, though hue is a uniform.
   * So compare the signature first and only pay when the tiles would actually come out different.
   * A lighting slider matches both signatures and does nothing here at all.
   */
  invalidate() {
    const sig = this.signature()
    const lod = this.lodSignature()
    if (sig === this.sig && lod === this.lodSig && this.sig !== '') return
    const contents = sig !== this.sig
    this.sig = sig
    this.lodSig = lod
    this.visStale = true
    this.dirty = true
    if (!contents) return
    this.tiles.clear()
    this.pending = []
    this.lastTile = 'none'
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
    let speed = 0
    if (Number.isFinite(this.prevEye.x)) {
      const dt = Math.max(1e-3, (now - this.prevT) / 1000)
      speed = eye.distanceTo(this.prevEye) / dt
      const still = T.GRASS_WIND_STILL_BELOW
      const target = still <= 0 ? 1 : 1 - Math.min(1, Math.max(0, (speed - still) / Math.max(0.1, still * 1.5)))
      this.motion += (target - this.motion) * Math.min(1, dt * 4)
    }
    this.prevEye.copy(eye)
    this.prevT = now
    this.eye.copy(eye)
    this.fwd.copy(fwd)
    this.pitch = pitch
    // THE FOOTPRINT SHAPE, rebuilt from the live speed every frame. `speedFrac` morphs the ring
    // from the all-round circle at rest to the forward cone at GRASS_CONE_SPEED; `fastFrac` ramps
    // the thin/range bias in as the car outruns the tile generator. See GRASS_CONE_* / GRASS_FAST_*.
    this.speedFrac = THREE.MathUtils.smoothstep(speed, T.GRASS_CONE_SPEED - Math.max(0.1, T.GRASS_CONE_FADE), Math.max(0.2, T.GRASS_CONE_SPEED))
    this.fastFrac = THREE.MathUtils.smoothstep(speed, Math.max(0.2, T.GRASS_FAST_SPEED - Math.max(0.1, T.GRASS_FAST_FADE)), Math.max(0.4, T.GRASS_FAST_SPEED))
    this.coneDeg = T.GRASS_CONE_STILL_DEG + (T.GRASS_CONE_DEG - T.GRASS_CONE_STILL_DEG) * this.speedFrac
    this.coneStretch = T.GRASS_CONE_STRETCH * this.speedFrac
    this.thinMul = 1 + (T.GRASS_FAST_THIN - 1) * this.fastFrac
    this.rangeMul = 1 + (T.GRASS_FAST_RANGE - 1) * this.fastFrac
    /*
     * THE RIM LEADS BY TIME, NOT DISTANCE.
     *
     * GRASS_FAST_RANGE is a fixed multiplier: it stops growing at the knee, so at 195 mph the far
     * cards still end GRASS_SPRITE_RADIUS × GRASS_FAST_RANGE metres ahead and the car drives at
     * bare ground. Above the knee, hold the rim GRASS_FAST_LEAD_S seconds of travel out instead.
     * Scaled by `fastFrac` so it ramps in with the rest of the bias and nothing below the knee
     * changes; capped so a teleport cannot ask for a ten-kilometre ring.
     */
    if (T.GRASS_FAST_LEAD_S > 0) {
      const leadMul = (speed * T.GRASS_FAST_LEAD_S) / Math.max(1, T.GRASS_SPRITE_RADIUS)
      this.rangeMul = Math.min(8, Math.max(this.rangeMul, 1 + (leadMul - 1) * this.fastFrac))
    }
    // GRASS_MODE 1 keeps the distance cards everywhere, including beside the camera. With the
    // blade mode on, a moving eye can still drop the blade mesh (GRASS_WIND_STILL_BELOW): generating
    // it is the hitch, and the cards cover the same ground. Slowing back down asks for the blades.
    const still = T.GRASS_WIND_STILL_BELOW
    // 0 means the blades stay, however fast the eye moves. A positive threshold is the old
    // swap: cards while moving, blades once you slow down.
    const bySpeed = still > 0 && Number.isFinite(this.prevEye.x) && (this.spritesOnly ? speed > still * 0.6 : speed > still)
    const wantSprites = T.grassMode() === 1 || bySpeed
    let modeChanged = false
    if (wantSprites !== this.spritesOnly) {
      this.spritesOnly = wantSprites
      modeChanged = true
      this.dirty = true
      this.visStale = true
    }
    const heading = Math.atan2(fwd.x, fwd.z)
    const tileKey = `${Math.floor(eye.x / TILE)},${Math.floor(eye.z / TILE)}`
    const turned = Math.abs(heading - this.lastHeading) > 0.25 || Math.abs(pitch - this.lastPitch) > 0.2
    const moved = tileKey !== this.lastTile || turned || modeChanged
    // the footprint changed SHAPE (speed) or REACH (fast bias): the visible set has to be rebuilt,
    // or the ring keeps the old circle after the car has driven away from a stop
    const reshaped = Math.abs(this.speedFrac - this.lastSpeedFrac) > 0.02 || Math.abs(this.fastFrac - this.lastFastFrac) > 0.02
    if (moved || this.visStale || reshaped) {
      this.lastTile = tileKey
      this.lastHeading = heading
      this.lastPitch = pitch
      this.lastSpeedFrac = this.speedFrac
      this.lastFastFrac = this.fastFrac
      this.revisit()
      this.dirty = true
      // the set of tiles that want blades changed with the footprint, so re-plan from here,
      // nearest first, instead of finishing a queue that was planned for the old shape
      this.queueMissing()
    } else if (this.dirty && this.pending.length === 0) this.queueMissing()
    // Generate the nearest missing tiles until this frame's MILLISECOND budget is spent. A fixed
    // tile count cannot work: a card-only tile is ~50 records and a blade tile ~7000, and the same
    // count is 0.3 ms of work in open country and 9 ms along a hedgerow. Spending time instead of
    // tiles means the queue drains as fast as the frame can afford and never faster.
    let made = 0, tiles = T.GRASS_TILES_PER_FRAME
    const t0 = performance.now()
    const deadline = t0 + T.GRASS_MS_PER_FRAME
    while (this.pending.length && tiles > 0) {
      const p = this.pending.shift()!
      const have = this.tiles.get(p.key)
      if (!have || (p.withBlades && !have.hasBlades)) {
        this.tiles.set(p.key, this.generate(p.tx, p.tz, p.withBlades))
        made++
        tiles -= p.withBlades ? 1 : 0.15
        if (performance.now() >= deadline) break
      }
    }
    const t1 = performance.now()
    if (made) this.dirty = true
    // assemble: every 4th frame while a burst is still filling, at once when it is complete
    if (this.dirty && (modeChanged || this.pending.length === 0 || this.frame % 4 === 0)) {
      this.assemble()
      this.dirty = this.pending.length > 0
    }
    this.genMs = t1 - t0
    this.asmMs = performance.now() - t1
    this.madeThisFrame = made
    /*
     * SIZE THE FAR RIM TO THE GENERATOR, NOT THE DRIVER.
     *
     * `rangeMul` is the ceiling the fast bias asks for (GRASS_FAST_RANGE / GRASS_FAST_LEAD_S), but
     * a wide-open cone at 160 mph needs far more front than the budget clears, so left at the
     * ceiling the eye sees a hard edge: cards to where generation stopped, then bare ground. Track
     * what the queue is actually draining instead. While the queue is deeper than GRASS_RIM_DRAIN
     * frames of work the rim contracts; while it is nearly empty the rim grows back toward the
     * ceiling. The fade (uFadeOut) rides this rim, so the cards fade out where they END rather than
     * at a distance nothing ever reached. At rest the queue empties and the rim returns to the
     * ceiling — the all-round circle, not a shrunken one.
     */
    const rimFloor = T.GRASS_RADIUS / T.GRASS_SPRITE_RADIUS
    if (speed < T.GRASS_CONE_SPEED) {
      this.rimMul += (this.rangeMul - this.rimMul) * 0.08
    } else {
      // hold the queue at GRASS_RIM_DRAIN frames of generation: deeper, pull the rim in; emptier,
      // let it out. A tiny proportional step, because the demand grows with the rim SQUARED — a
      // bigger gain rings between a drained queue and an impossible one.
      const target = Math.max(8, made * T.GRASS_RIM_DRAIN)
      const err = Math.max(-1, Math.min(1, (this.pending.length - target) / target))
      this.rimMul *= 1 - err * 0.012
    }
    this.rimMul = Math.min(this.rangeMul, Math.max(rimFloor, this.rimMul))
    // only worth walking the map when the cache holds appreciably more than the ring needs
    if (this.tiles.size > this.vis.length * T.GRASS_CACHE_SLACK + 64) this.evict()
  }

  // --- tiles --------------------------------------------------------------------------------------

  /**
   * The visible tile set, nearest first. At GRASS_SPRITE_RADIUS = 300 this walks a 76 × 76 box and
   * sorts ~4500 entries, so it is computed ONCE per update() into `vis` and shared by the queue,
   * the assembly and the eviction — they used to each rebuild it, three times a frame.
   */
  private revisit() {
    const r = Math.max(T.GRASS_RADIUS, T.GRASS_SPRITE_RADIUS * this.rimMul)
    const out = this.vis
    out.length = 0
    const tx0 = Math.floor((this.eye.x - r) / TILE), tx1 = Math.floor((this.eye.x + r) / TILE)
    const tz0 = Math.floor((this.eye.z - r) / TILE), tz1 = Math.floor((this.eye.z + r) / TILE)
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let tz = tz0; tz <= tz1; tz++) {
        const cx = (tx + 0.5) * TILE, cz = (tz + 0.5) * TILE
        const dx = cx - this.eye.x, dz = cz - this.eye.z
        const dist = Math.hypot(dx, dz)
        if (dist > r + TILE) continue
        // THE FOOTPRINT IS A CONE, NOT A RING. At rest it is the true CIRCLE the verge wants: the
        // ground is grass-textured in every direction, so a cone-shaped ring left the median and the
        // verge beside the car as flat photo turf (Rich: "what's up with all this not grass?"). Once
        // moving, the demand is a WEDGE facing the direction of travel — everything past the
        // GRASS_CONE_DEG half-angle (plus the 12° feather `coneDistance` already uses) is dropped
        // outright, not merely sorted last. The old soft version still queued and planted the whole
        // wake behind the car, which at speed is a large share of the ring and grass the driver can
        // never see; cutting it puts that budget in front, where the eye is. As the car slows,
        // `speedFrac` fades `coneDeg` back toward GRASS_CONE_STILL_DEG (180 = all round) and the
        // circle returns.
        if (this.coneDeg < 179.5 && dist > 1e-6) {
          const cos = (dx * this.fwd.x + dz * this.fwd.z) / dist
          const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
          if (angle >= this.coneDeg + 12) continue
        }
        const d = this.coneDistance(dx, dz)
        if (d > r + TILE) continue
        out.push({ key: `${tx},${tz}`, tx, tz, d })
      }
    }
    out.sort((a, b) => a.d - b.d)
    this.visStale = false
  }

  /**
   * How far a point counts for the grass budget: Euclidean at rest, stretched behind the view once
   * the car is moving. `coneDeg` is the half-angle that stays full resolution and `coneStretch` how
   * much further an outside point counts, both rebuilt from speed in `update`. A steep view is a
   * circle again, the same top-down escape `lodDistance` gives the trees.
   */
  private coneDistance(dx: number, dz: number): number {
    const d = Math.hypot(dx, dz)
    if (d < 1e-6 || this.coneStretch <= 1e-6) return d
    const cos = (dx * this.fwd.x + dz * this.fwd.z) / d
    let outside = 0
    if (this.coneDeg < 179.5) {
      const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
      outside = Math.min(1, Math.max(0, (angle - this.coneDeg) / 12))
    }
    const topdown = Math.min(1, Math.max(0, (this.pitch - T.LOD_TOPDOWN_PITCH * 0.7) / (T.LOD_TOPDOWN_PITCH * 0.3)))
    return d * (1 + this.coneStretch * outside * (1 - topdown))
  }

  /** the scene's day/night light level and its colour, for a shader that does its own lighting */
  setLight(level: number, tint: THREE.Color) {
    for (const m of [this.bladeMat, this.cardMat]) {
      m.uniforms.uNightMul.value = level
      ;(m.uniforms.uLightTint.value as THREE.Color).copy(tint)
    }
  }

  /** the real sun. The constructor default is a fixed corner of the sky and nothing else ever wrote it. */
  setSun(dir: THREE.Vector3) {
    const u = this.bladeMat.uniforms.uSun.value as THREE.Vector3
    u.copy(dir)
    if (u.lengthSq() > 1e-8) u.normalize()
    const card = this.cardMat.uniforms.uSun.value as THREE.Vector3
    if (card !== u) card.copy(u)
  }

  private sunLight: THREE.DirectionalLight | null = null
  /**
   * The sun light itself, so the blades can RECEIVE its shadow. They light themselves with
   * half-Lambert in a raw ShaderMaterial, which sits outside three's light/shadow system, so
   * `receiveShadow` on the mesh does nothing — tick() samples the light's depth texture by hand.
   */
  setSunShadow(light: THREE.DirectionalLight | null) {
    this.sunLight = light
  }

  /** forget the cached tiles inside a world box (x0, z0, x1, z1) so they regenerate: the vegetation mask for that ground just arrived */
  invalidateWithin(x0: number, z0: number, x1: number, z1: number) {
    let n = 0
    for (const k of [...this.tiles.keys()]) {
      const [tx, tz] = k.split(',').map(Number)
      const ax = tx * TILE, az = tz * TILE
      if (ax + TILE < x0 || ax > x1 || az + TILE < z0 || az > z1) continue
      this.tiles.delete(k)
      n++
    }
    if (n) { this.dirty = true; this.queueMissing() }
    return n
  }

  private queueMissing() {
    const rBlade = T.GRASS_RADIUS + TILE * 0.71
    // a tile planted while fast was planted THIN; once the car slows and the bias lifts, the tile
    // is under-dense and has to be asked for again. The margin stops a wobble around the threshold
    // from re-queueing the whole ring every frame.
    const wantThin = this.thinMul
    this.pending = []
    for (const t of this.vis) {
      const withBlades = !this.spritesOnly && t.d <= rBlade
      const have = this.tiles.get(t.key)
      const stale = !!have && wantThin > have.thin + 0.2
      if (!have || (withBlades && !have.hasBlades) || stale) this.pending.push({ ...t, withBlades })
    }
  }

  /**
   * Drop tiles the ring no longer covers. The threshold is a multiple of what the ring NEEDS, not
   * a constant: the old `> 1600` was below the ~2500 tiles GRASS_SPRITE_RADIUS = 300 m asks for,
   * so this ran every single frame, rebuilt the visible set, and deleted nothing.
   */
  private evict() {
    const keep = new Set<string>()
    for (const t of this.vis) keep.add(t.key)
    for (const k of this.tiles.keys()) if (!keep.has(k)) this.tiles.delete(k)
  }

  /** One 8 m tile at full density. Deterministic in (tx, tz): the same tile always seeds alike. */
  private generate(tx: number, tz: number, withBlades: boolean): Tile {
    /*
     * A CORRIDOR TILE AWAY FROM EVERY ROAD IS EMPTY, AND ONE QUERY SAYS SO.
     *
     * On a corridor bake grass only grows within GRASS_MAX_FROM_ROAD of the tarmac (the per-cell
     * test further down), so the 64-cell walk below rejects every cell and pays a road/ground/canopy
     * lookup to do it. A tile whose CENTRE is further than the band plus its own half-diagonal
     * cannot touch the band at any cell, so it is empty by construction. The ring at speed is
     * mostly off-road, and rejecting those tiles for the price of one query is what lets the
     * 4 ms/frame budget reach the verge tiles the driver is actually heading at.
     */
    if (!this.world) {
      const cx = tx * TILE + TILE * 0.5, cz = tz * TILE + TILE * 0.5
      if (this.roadDistance(cx, cz) > this.pavedHalf + T.GRASS_MAX_FROM_ROAD + TILE * 0.71) {
        return { hasBlades: withBlades, blades: EMPTY_RECORDS, n: 0, cards: EMPTY_RECORDS, nc: 0, mown: false, thin: this.thinMul, born: this.now }
      }
    }
    const cell = 1.0
    /*
     * THIN THE FIELD WHEN IT IS PLANTED, NOT ONLY WHEN IT IS DRAWN.
     *
     * GRASS_FAST_THIN used to be applied in `assemble`, so at speed the generator still built every
     * card and the renderer threw most of them away — the knob bought drawing, not the generation
     * headroom it was FOR. A card tile is ~5 ms (dominated by a fresh road and ground walk per
     * clump and per card; see the shared gradient and ground lattice below), the budget is
     * GRASS_MS_PER_FRAME, and at 150 mph the verge cannot be planted faster
     * than the car reaches it: the field only ever extends ~60 m ahead and the car outruns it
     * (Rich, 2026-10-05). Planting `thinMul` of the cards instead makes the knob pay where the cost
     * is, and it is visually the same — `assemble` keeps the same fraction, so the same density
     * lands on screen. `tile.thin` records what a tile was planted at; when the car slows and
     * `thinMul` rises, `queueMissing` asks for it again.
     */
    const thin = Math.max(0.05, this.thinMul)
    const perCellMax = Math.max(T.GRASS_MOWN_PER_M2, T.GRASS_ROUGH_PER_M2) * T.GRASS_DENSITY
    const maxBlades = withBlades ? Math.ceil(TILE * TILE * perCellMax) + 64 : 0
    const blades = new Float32Array(maxBlades * BLADE_F)
    const rank = new Float32Array(maxBlades)
    // cards scale with the blade density and with how little ground a short clump covers, so the
    // buffer has to fit the densest cell, not the bare sprite count
    const maxCards = Math.ceil(TILE * TILE * Math.min(18, T.GRASS_SPRITE_PER_M2 * (Math.max(T.GRASS_MOWN_PER_M2, T.GRASS_ROUGH_PER_M2) / 40) * 6 * 1.6 * T.GRASS_DENSITY)) + 16
    const cards = new Float32Array(maxCards * CARD_F)
    const crank = new Float32Array(maxCards)
    let n = 0, nc = 0, mownCells = 0, cells = 0
    const patchCells = Math.max(1, Math.round(T.GRASS_PATCH_SIZE))
    const x0 = tx * TILE, z0 = tz * TILE
    /*
     * ASK THE MASKS ONCE PER TILE, NOT ONCE PER BLADE.
     *
     * `blockedAt` (parking || sidewalk) used to be asked at every blade's own feet and at four
     * corners of every card — measured at ~1800 calls for a single verge tile, each re-walking the
     * same parking/walk bounds index. The per-call cost is small, but the count is not, so sample it
     * once onto a half-metre lattice over the tile plus the reach the records can stray (a blade's
     * scatter, a card's corners) and answer every later test from that. 0.5 m is the rounding error
     * at most, and both covers already pad wider than that (a walk by 0.35 m, a lot by 3 m), so the
     * lattice can never say "clear" over the surface of a walk it should keep grass off. Built
     * lazily: a tile whose cells are all pavement, canopy or otherwise rejected never asks.
     * (The bigger per-tile costs are the road and ground walks below — see the shared gradient and
     * the ground lattice.)
     */
    const maskB = this.blockedAt
    const maskStep = 0.5
    const maskReach = 0.5 * cell + (T.GRASS_SCATTER * this.look.scatter) * 0.5
    const maskMargin = Math.ceil(maskReach) + 0.5
    const maskN = Math.round((TILE + maskMargin * 2) / maskStep) + 1
    let mask: Uint8Array | null = null
    const maskBlocked = (x: number, z: number): boolean => {
      if (!maskB) return false
      if (!mask) {
        mask = new Uint8Array(maskN * maskN)
        const ox = x0 - maskMargin, oz = z0 - maskMargin
        for (let j = 0; j < maskN; j++) {
          const zz = oz + j * maskStep, row = j * maskN
          for (let i = 0; i < maskN; i++) if (maskB(ox + i * maskStep, zz)) mask[row + i] = 1
        }
      }
      let i = Math.round((x - (x0 - maskMargin)) / maskStep)
      let j = Math.round((z - (z0 - maskMargin)) / maskStep)
      if (i < 0) i = 0; else if (i >= maskN) i = maskN - 1
      if (j < 0) j = 0; else if (j >= maskN) j = maskN - 1
      return mask[j * maskN + i] === 1
    }
    /*
     * ONE GROUND HEIGHT PER CELL, NOT ONE PER BLADE.
     *
     * `groundAt` is `gradedHeight ?? heightAt` and `gradedHeight` walks the road station grid
     * itself, so a fresh call per card and per blade was the other half of the per-tile cost
     * (measured ~2.4 ms, alongside ~2.4 ms of road queries). The ground over a single 8 m tile is
     * smooth, so sample it on the cell lattice (+ one row and column, for the slope test) and read
     * the cell's value for everything that stands in that cell. Lazily, because a cell the canopy
     * or the road rejects never needs a height. Within GRASS_EXACT_M of pavement the lip and the
     * driveway aprons are NOT smooth, so blades and cards there still sample the ground exactly.
     */
    const GN = TILE + 1
    const gy = new Float32Array(GN * GN).fill(NaN)
    const gyAt = (i: number, j: number): number => {
      if (i < 0) i = 0; else if (i >= GN) i = GN - 1
      if (j < 0) j = 0; else if (j >= GN) j = GN - 1
      const k = i * GN + j
      let v = gy[k]
      if (Number.isNaN(v)) { v = this.groundAt(x0 + i + 0.5, -(z0 + j + 0.5)); gy[k] = v }
      return v
    }
    const cellGround = (x: number, z: number, exact: boolean): number =>
      exact ? this.groundAt(x, -z) : gyAt(Math.round(x - (x0 + 0.5)), Math.round(z - (z0 + 0.5)))
    for (let cx = x0; cx < x0 + TILE; cx += cell) {
      for (let cz = z0; cz < z0 + TILE; cz += cell) {
        const wx = cx + 0.5 * cell, wz = cz + 0.5 * cell
        const roadD = this.roadDistance(wx, wz)
        if (roadD < this.pavedHalf + T.GRASS_ROAD_CLEAR) continue // pavement
        /*
         * "Spend the budget on the verge, where the eye is" -- true of a CORRIDOR, false of a
         * WORLD.
         *
         * On a corridor bake there is no imagery and no vegetation mask past the road buffer, so
         * distance-from-a-road is a fair stand-in for "is there any data here" and this keeps the
         * blades where they can be judged. On a world bake the data covers everything, and the
         * same line means grass stops twenty-four metres from the tarmac and you walk out of it
         * into a bare field. Rich, 2026-09-27: "proximity to a road shouldn't really dictate tree
         * mappings and ground textures."
         *
         * The budget is not at risk either way: the ring radius and the LOD rings are already
         * eye-relative and the blade count is capped, so a bigger area is spread, not added.
         */
        if (!this.world && roadD > this.pavedHalf + T.GRASS_MAX_FROM_ROAD) continue
        if (this.canopyAt(wx, -wz) > 3.0) continue // a real crown
        // slope rejection: a cut face or a steep embankment is rock and scrub, not turf
        const ci = cx - x0, cj = cz - z0
        const gy0 = gyAt(ci, cj)
        const slope = Math.max(Math.abs(gyAt(ci + 1, cj) - gy0), Math.abs(gyAt(ci, cj + 1) - gy0))
        if (slope > T.GRASS_SLOPE_MAX) continue
        // NOTHING GROWS ON A SHELF. Past the strip's blend band the strip IS the DEM — both come
        // from the same raster — so any real gap there means this ground is not sitting on the
        // world: a bridge verge at deck height over a valley, a retaining wall, a deck that has
        // been widened. Grass standing on it is grass in the air. Inside the band the strip is
        // between road grade and the DEM by construction, and a fill embankment lives there
        // legitimately, so the test only applies once the blend has finished.
        if (this.demAt && T.GRASS_MAX_SHELF > 0 && roadD > this.pavedHalf + 8 && gy0 - this.demAt(wx, -wz) > T.GRASS_MAX_SHELF) continue
        // bare patches: low-frequency hash noise thins the field where soil shows
        const patch = hash(Math.floor(cx / patchCells) * 971 + Math.floor(cz / patchCells) * 337)
        if (patch < T.GRASS_PATCHINESS) continue
        cells++
        // the zone (zoning.ts): kept is mown everywhere; rural is a mown shoulder then tall rough
        // grass; no zone means the old mow line
        const zone = this.zoneAt ? this.zoneAt(wx, wz) : null
        const mown = zone === 'kept' ? true : roadD < this.pavedHalf + (zone === 'rural' ? T.GRASS_RURAL_MOW_LINE : T.GRASS_MOW_LINE)
        const tall = zone === 'rural' && !mown ? T.GRASS_RURAL_TALL : 1
        if (mown) mownCells++
        // the editor's local corrections: [height multiplier, density multiplier]
        const [ah, ad] = this.adjustAt ? this.adjustAt(wx, -wz) : [1, 1]
        const perCell = withBlades ? Math.round((mown ? T.GRASS_MOWN_PER_M2 : T.GRASS_ROUGH_PER_M2) * this.look.density * (0.7 + 0.6 * patch) * ad * T.GRASS_DENSITY * thin) : 0
        // one clump centre per cell; blades scatter around it
        const ccx = wx + (hash(cx * 7919 + cz * 104729) - 0.5) * cell
        const ccz = wz + (hash(cx * 15485863 + cz * 32452843) - 0.5) * cell
        // THE CLUMP IS WHERE THE BLADES STAND, NOT THE CELL CENTRE. The cell-centre test above
        // passes a cell 1.1 m from a walk's centreline, but its clump wanders up to 0.5 m and the
        // blades scatter 0.35 m beyond that, so blades landed 0.25 m from the centreline of a
        // 1.5 m walk — "grass growing over the sidewalk" (Rich, 2026-09-26), measured as 289
        // blades inside one walk with the cover answering "sidewalk" at every point of it. Asked
        // at the clump, a clump on pavement or a walk grows nothing.
        // ONE gradient walk per cell, shared by the clump and every card. The distance field near
        // the road is linear, so any point in the cell is the cell's distance plus its offset along
        // the gradient; a fresh roadDistance per clump and per card was ~half the per-tile cost.
        // Exact within GRASS_EXACT_M, where the field bends harder than a straight line follows.
        const grad = this.roadGrad ? this.roadGrad(wx, wz) : null
        const distAt = (x: number, z: number): number =>
          grad && roadD >= T.GRASS_EXACT_M ? roadD + (x - wx) * grad[0] + (z - wz) * grad[1] : this.roadDistance(x, z)
        const clumpClear = !maskBlocked(ccx, ccz) && distAt(ccx, ccz) >= this.pavedHalf + T.GRASS_ROAD_CLEAR
        for (let b = 0; b < (clumpClear ? perCell : 0) && n < maxBlades; b++) {
          const h1 = hash(cx * 31 + cz * 17 + b * 101), h2 = hash(cx * 13 + cz * 29 + b * 53)
          const scatter = T.GRASS_SCATTER * this.look.scatter
          const x = ccx + (h1 - 0.5) * scatter, z = ccz + (h2 - 0.5) * scatter
          const y = cellGround(x, z, roadD < T.GRASS_EXACT_M) - 0.02
          const rnd = hash(cx * 29 + cz * 31 + b * 3)
          const shape = mown ? this.look.mown : this.look.height
          const height = (mown ? T.GRASS_MOWN_HEIGHT : this.heightScale * T.GRASS_ROUGH_HEIGHT * tall) * shape * ah * 1.5 * T.GRASS_HEIGHT * (0.6 + 0.8 * hash(cx * 3 + cz * 5 + b * 7))
          const width = (mown ? 0.085 : 0.075 + 0.045 * rnd) * 0.55 * T.GRASS_THICK * this.look.width
          const lean = Math.max(0, 0.15 + this.look.lean + T.GRASS_LEAN * hash(cx * 11 + cz * 19 + b * 23))
          // A non-finite root (a groundAt miss just off the bake) makes a degenerate blade: the
          // vertex shader puts NaN in clip space and the rasteriser draws a giant black triangle.
          // Rich saw exactly that. Drop anything that is not a real, finite blade.
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
          if (!Number.isFinite(height) || !Number.isFinite(width) || height > 12) continue
          // THE ROOT REACHES THE KERB; THE TIP MAY LEAN OVER IT. The cell and the clump were
          // tested, but a blade scatters up to GRASS_SCATTER/2 beyond the clump, so its own root
          // needs the test. GRASS_ROAD_CLEAR is a ROOT clearance now, not the old TIP clearance:
          // the guard used to hold every blade far enough back that its lean and wind could not
          // cross the kerb, which left the verge 2–3 m short of the road (Rich, 2026-10-05). Verge
          // grass leans out over the tarmac; only the root has to stay off it.
          if (grad) {
            /*
             * CLOSE IN, ASK. FURTHER OUT, STEP.
             *
             * The gradient step is exact where the field is locally linear, and along a road it
             * is: measured at about a third of a metre of change per half metre. Beside a
             * DRIVEWAY it is not. A driveway is a handful of short, sharply curved stations, and
             * the field there bends faster than a straight line can follow — measured
             * 2026-09-27, the step said "clear of the road" at 24 of 15,678 blade positions that
             * were actually on asphalt, and all but two of them were on or beside a driveway.
             * A driveway apron is also exactly where a tuft of grass standing on pavement gets
             * noticed.
             *
             * So the blades that can be wrong pay for a real query and the rest do not. Only a
             * cell already within a few metres of pavement is near enough to matter.
             */
            const dRoot = roadD < T.GRASS_EXACT_M ? this.roadDistance(x, z) : roadD + (x - wx) * grad[0] + (z - wz) * grad[1]
            if (dRoot < this.pavedHalf + T.GRASS_ROAD_CLEAR) continue
          }
          // and the masks at the blade's OWN feet, which no gradient can predict — a raster has a
          // hard edge and no gradient at all. Inside GRASS_EXACT_M the query above already asked
          // them (roadDistance reports them as -1), so this is for the band beyond it. The answer
          // comes from the tile's mask lattice, not a fresh query per blade.
          if (roadD >= T.GRASS_EXACT_M && roadD < T.GRASS_MASK_CHECK_M && maskBlocked(x, z)) continue
          const o = n * BLADE_F
          blades[o] = x
          blades[o + 1] = y
          blades[o + 2] = z
          blades[o + 3] = rnd
          blades[o + 4] = height
          blades[o + 5] = width
          blades[o + 6] = lean
          blades[o + 7] = mown ? 1 : 0
          rank[n] = hash(cx * 41 + cz * 43 + b * 47)
          n++
        }
        // clump cards follow the same density as the blades. A short card covers less ground, so
        // the mown strip (and a low height scale) plants more of them; GRASS_SPRITE_PER_M2 is the
        // count at 40 blades/m² and a ~0.6 m clump, not a fixed number of tufts.
        const bladePer = (mown ? T.GRASS_MOWN_PER_M2 : T.GRASS_ROUGH_PER_M2) * this.look.density * (0.7 + 0.6 * patch) * Math.max(0, ad) * T.GRASS_DENSITY
        const baseH = mown ? T.GRASS_MOWN_HEIGHT * 1.6 * this.look.mown : this.heightScale * T.GRASS_ROUGH_HEIGHT * tall * 0.8 * this.look.height
        const sizeNom = Math.max(0.2, baseH * Math.max(0.15, ah) * 1.5 * T.GRASS_HEIGHT * T.GRASS_SPRITE_SCALE)
        const cover = Math.min(6, (0.85 / sizeNom) * (0.85 / sizeNom))
        const cardsHere = Math.min(18, T.GRASS_SPRITE_PER_M2 * (bladePer / 40) * cover) * thin
        const want = Math.floor(cardsHere) + (hash(cx * 61 + cz * 67) < cardsHere % 1 ? 1 : 0)
        for (let b = 0; b < want && nc < maxCards; b++) {
          const x = wx + (hash(cx * 71 + cz * 73 + b * 79) - 0.5) * cell, z = wz + (hash(cx * 83 + cz * 89 + b * 97) - 0.5) * cell
          // a card is a metre wide and stands where it is put: the same test, at its own foot
          // A CARD IS WIDE, and it is centred on its foot. Measured 2026-09-27: a foot 0.08 m
          // inside the asphalt drew a tuft about 0.6 m out over the road, which at fifty metres
          // in headlights is exactly "grass growing through the road". Its half-width has to
          // clear the kerb, not its centre.
          const cardHalf = 0.5 * sizeNom * T.GRASS_SPRITE_WIDTH * T.GRASS_THICK
          // its foot from the lattice first (a fresh roadDistance would only fold the same masks
          // in again), then from the field
          if (maskBlocked(x, z)) continue
          if (distAt(x, z) < this.pavedHalf + T.GRASS_ROAD_CLEAR + cardHalf) continue
          // a card is a metre across; its far edge must clear a mask too, not just its foot
          if (maskBlocked(x + 0.5, z) || maskBlocked(x - 0.5, z) || maskBlocked(x, z + 0.5) || maskBlocked(x, z - 0.5)) continue
          const y = cellGround(x, z, roadD < T.GRASS_EXACT_M) - 0.03
          const size = baseH * ah * 1.5 * T.GRASS_HEIGHT * T.GRASS_SPRITE_SCALE * (0.75 + 0.5 * hash(cx * 101 + cz * 103 + b * 107))
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(size) || size > 12) continue
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
    return { hasBlades: withBlades, blades: sortByRank(blades, rank, n, BLADE_F), n, cards: sortByRank(cards, crank, nc, CARD_F), nc, mown: mownCells * 2 > cells, thin, born: this.now }
  }

  /** Copy the visible prefixes of the cached tiles into the instance buffers. */
  private assemble() {
    const rootArr = this.aRoot.array as Float32Array
    const bladeArr = this.aBlade.array as Float32Array
    const extraArr = this.aExtra.array as Float32Array
    const cardArr = this.aCard.array as Float32Array
    const card2Arr = this.aCard2.array as Float32Array
    let k = 0, kc = 0
    const rBlade = T.GRASS_RADIUS
    // the tracked rim (GRASS_RIM_DRAIN) says how far the far cards reach; the fast bias still thins
    // both tiers when the car outruns the generator (GRASS_FAST_*); at rest rimMul = thinMul = 1
    const rCard = T.GRASS_SPRITE_RADIUS * this.rimMul
    // Cards used to start where the blades thin out. With the blades put away they have to
    // start at the eye, or the ground beside the car is bare until you slow down.
    const cardFrom = this.spritesOnly ? 0 : T.GRASS_LOD_MID - 8
    for (const t of this.vis) {
      const tile = this.tiles.get(t.key)
      if (!tile) continue
      // the tile was already planted `tile.thin` dense; keep `thinMul / tile.thin` of it so the bias
      // is applied exactly once (a tile planted before the car slowed is drawn at full until regenerated)
      const bias = Math.min(1, this.thinMul / Math.max(1e-3, tile.thin))
      if (!this.spritesOnly && t.d <= rBlade + TILE * 0.71 && tile.n) {
        // density: LOD rings — full inside NEAR, MID_DENSITY to MID, FAR_DENSITY to the rim
        const falloff = (t.d < T.GRASS_LOD_NEAR ? 1 : t.d < T.GRASS_LOD_MID ? T.GRASS_LOD_MID_DENSITY : T.GRASS_LOD_FAR_DENSITY) * bias
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
          extraArr[k * 2] = tile.born
          extraArr[k * 2 + 1] = tile.blades[o + 7]
          k++
        }
      }
      if (t.d >= cardFrom - TILE && t.d <= rCard + TILE * 0.71 && tile.nc) {
        // thin the cards toward the rim: full past the blades, GRASS_SPRITE_FAR_DENSITY at the far edge
        const u = Math.min(1, Math.max(0, (t.d - T.GRASS_LOD_MID) / Math.max(1, rCard - T.GRASS_LOD_MID)))
        const keep = (1 + (T.GRASS_SPRITE_FAR_DENSITY - 1) * u * u) * bias
        const take = Math.min(tile.nc, Math.round(tile.nc * keep), this.cardCapacity - kc)
        for (let i = 0; i < take; i++) {
          const o = i * CARD_F
          cardArr[kc * 4] = tile.cards[o]
          cardArr[kc * 4 + 1] = tile.cards[o + 1]
          cardArr[kc * 4 + 2] = tile.cards[o + 2]
          cardArr[kc * 4 + 3] = tile.cards[o + 3]
          card2Arr[kc * 3] = tile.cards[o + 4]
          card2Arr[kc * 3 + 1] = tile.cards[o + 5]
          card2Arr[kc * 3 + 2] = tile.born
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
    // The card shader shrinks a clump to nothing inside uFadeIn, so the blades can own the
    // foreground. With the blades put away that shrink is the pop: the ground beside the car
    // is empty until a clump crosses the ring. Cards that start at the eye have to be full size there.
    this.cardMat.uniforms.uFadeIn.value = this.spritesOnly ? 0 : T.GRASS_LOD_MID
    this.cardMat.uniforms.uFadeOut.value = T.GRASS_SPRITE_RADIUS * this.rimMul
  }

  /** counts for probes and the HUD */
  get counts(): { blades: number; cards: number; tiles: number; pending: number; motion: number; type: GrassType } {
    return { blades: this.bladeGeo.instanceCount, cards: this.cardGeo.instanceCount, tiles: this.tiles.size, pending: this.pending.length, motion: +this.motion.toFixed(2), type: this.type }
  }

  /**
   * What the last update() cost on the CPU, what it handed the GPU, and — the number that decides
   * whether the ring shows bare ground — how far away the NEAREST tile still waiting to be
   * generated is. The queue is nearest-first, so `nearestMissing` is the radius inside which the
   * world is complete. While it stays above GRASS_RADIUS nothing the eye can resolve is missing,
   * however deep the queue is: the tiles behind it are card-only tiles at the rim, where the size
   * fade has already taken the cards to nothing.
   */
  get perf(): { genMs: number; asmMs: number; made: number; triangles: number; nearestEmpty: number; nearestUpgrade: number; pendingEmpty: number } {
    // Two very different things sit in the queue and only one of them can show bare ground:
    //   EMPTY    no tile cached at all — nothing is drawn there
    //   UPGRADE  a card-only tile that has come inside the blade ring and wants blades too; the
    //            ground is already covered, it is about to get better
    // The ring crosses the blade radius continuously, so there is ALWAYS an upgrade pending at
    // about rBlade. Only `nearestEmpty` says whether the eye can see a hole.
    let empty = Infinity, upgrade = Infinity, nEmpty = 0
    for (const p of this.pending) {
      const d = this.coneDistance(p.tx * TILE + TILE / 2 - this.eye.x, p.tz * TILE + TILE / 2 - this.eye.z)
      if (this.tiles.has(p.key)) { if (d < upgrade) upgrade = d } else { nEmpty++; if (d < empty) empty = d }
    }
    return {
      nearestEmpty: +empty.toFixed(1),
      nearestUpgrade: +upgrade.toFixed(1),
      pendingEmpty: nEmpty,
      genMs: this.genMs,
      asmMs: this.asmMs,
      made: this.madeThisFrame,
      // a blade is (SEGMENTS - 1) quads plus a tip triangle; a card is a quad. Both are DoubleSide.
      triangles: this.bladeGeo.instanceCount * (SEGMENTS * 2 - 1) + this.cardGeo.instanceCount * 2,
    }
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
