// Daylight that still shows a surface.
//
// A high sun on a horizontal road has almost the same N·L everywhere, so an albedo and a normal
// map that read clearly at sunset — or under the headlights, which strike the ground at a slant —
// wash out at noon. Two GPU-side remedies, neither of which walks the scene on the CPU:
//
//   relief   the mapped normal's lighting minus the flat polygon's, added back on. The standard
//            material already uses the mapped normal; this turns the difference up, which is the
//            part a high sun shrinks to nothing.
//   clearcoat  a view-dependent coat on the car, plus the environment map and a cube probe at the
//            car (carProbe.ts) so the paint mirrors the trees and bank around it, not only the sky.
//
// Shadows and the logarithmic depth buffer do not agree. The shadow map is an orthographic
// camera, whose clip-space w is 1, so the log-depth write stores the same depth for every
// fragment and the compare never fails. Casters use a depth material with that write removed,
// so the map stays linear and the receivers' shadow coordinates match it.
import * as THREE from 'three'
import * as T from '../tuning'
import { carProbeBlend, carProbeCube, carProbeGain, carProbeOn, carProbeOrigin, carProbeReach } from './carProbe'
import type { VehicleFinish } from '../game/vehicle/vehicles'

/** shared so a knob moves every material that compiled with it, without a rebuild */
export const reliefUniform = { value: 1.6 }
export const shineUniform = { value: 1 }
/** extra darkening of shadowed pixels, past the sun's own shadow, so ambient and the rake don't wash it out */
export const shadeUniform = { value: 1 }
const shiny: THREE.MeshStandardMaterial[] = []

const RELIEF = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
  {
    vec3 geoN = normalize(vNormal);
    vec3 mapN = normalize(normal);
    vec3 tilt = vec3(0.0);
    for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
      float geo = dot(geoN, directionalLights[i].direction);
      float det = dot(mapN, directionalLights[i].direction);
      tilt += directionalLights[i].color * (det - geo);
    }
    gl_FragColor.rgb += diffuseColor.rgb * tilt * uRelief;
  }
#endif
`

const COAT = /* glsl */ `
{
  vec3 viewN = normalize(normal);
  vec3 viewV = normalize(vViewPosition);
  float ndv = clamp(dot(viewN, viewV), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 4.0);
  // the global CAR_SHINE dial times this car's own clearcoat, so a vehicle can be glossier or
  // flatter than the fleet without standing the fleet's dial down.
  float coat = uShine * uCoat;
  gl_FragColor.rgb += gl_FragColor.rgb * fres * coat * 0.55;
#if NUM_DIR_LIGHTS > 0
  vec3 halfV = normalize(viewV + directionalLights[0].direction);
  float spec = pow(clamp(dot(viewN, halfV), 0.0, 1.0), 64.0);
  gl_FragColor.rgb += directionalLights[0].color * spec * coat * 0.45;
#endif
}
`

function afterOpaque(shader: { fragmentShader: string; uniforms: Record<string, { value: unknown }> }, uniform: string, bag: { value: number }, body: string) {
  if (shader.fragmentShader.includes(`uniform float ${uniform}`)) return
  shader.uniforms[uniform] = bag
  // a material that already rewrote <common> (water) no longer has that include to hang the
  // uniform on, so it goes at the top instead
  shader.fragmentShader = shader.fragmentShader.includes('#include <common>')
    ? shader.fragmentShader.replace('#include <common>', `#include <common>\nuniform float ${uniform};`)
    : `uniform float ${uniform};\n${shader.fragmentShader}`
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${body}`)
}

/** Roads and water: turn the normal map's contribution back up. */
export function injectRelief(shader: { fragmentShader: string; uniforms: Record<string, { value: unknown }> }) {
  afterOpaque(shader, 'uRelief', reliefUniform, RELIEF)
}

/**
 * Wet-road streaks from the lamps that are actually on.
 *
 * The streak is vertical in the image: it starts at the lamp and runs straight down the screen
 * toward the camera, and only across the wet pavement that actually lies between the two.
 * It is not a ribbon laid along the road in world space, so turning the camera does not tilt it.
 * A lamp draws one only while its aim points at the camera. Headlights driving away, and tail
 * lights seen from the front, throw their light the other way and leave no streak.
 * Eight lamps, unrolled, so the road shader does not grow a dynamic light loop.
 * Dry pavement takes none of it (`uWetStreak` is the weather's wetness).
 */
const WET_N = 8
const wetAmount = { value: 0 }
const wetGain = { value: 1 }
const wetSpread = { value: 1 }
const wetCount = { value: 0 }
const wetSize = { value: new THREE.Vector2(1, 1) }
const wetViewProj = { value: new THREE.Matrix4() }
const wetLamp = Array.from({ length: WET_N }, () => new THREE.Vector4())
const wetAim = Array.from({ length: WET_N }, () => new THREE.Vector2())
const wetCol = Array.from({ length: WET_N }, () => new THREE.Vector3())

const WET_DECL = /* glsl */ `
uniform float uWetStreak;
uniform float uWetGain;
uniform float uWetSpread;
uniform float uWetCount;
uniform vec2 uWetSize;
uniform mat4 uWetViewProj;
uniform vec4 uWetLamp[8];
uniform vec2 uWetAim[8];
uniform vec3 uWetCol[8];
`
const WET_BODY = /* glsl */ `
{
  if (uWetStreak > 0.02 && uWetCount > 0.5) {
    vec3 wp = (inverse(viewMatrix) * vec4(-vViewPosition, 1.0)).xyz;
    vec3 nW = normalize(cross(dFdx(wp), dFdy(wp)));
    if (nW.y > 0.35) {
      float facing = clamp(dot(nW, normalize(cameraPosition - wp)), 0.0, 1.0);
      float graze = pow(1.0 - facing, 1.4);
      vec2 fragPx = gl_FragCoord.xy;
      vec3 acc = vec3(0.0);
      #define WET_LAMP(IDX) \
        if (uWetCount > float(IDX)) { \
          vec3 lamp = uWetLamp[IDX].xyz; \
          vec2 aim = uWetAim[IDX]; \
          float aimL = length(aim); \
          aim /= max(aimL, 1e-3); \
          vec2 toCam = cameraPosition.xz - lamp.xz; \
          float toCamL = length(toCam); \
          vec2 toCamN = toCam / max(toCamL, 1e-3); \
          float toward = dot(aim, toCamN); \
          if (toward > 0.2) { \
            vec4 clip = uWetViewProj * vec4(lamp, 1.0); \
            if (clip.w > 0.05) { \
              vec2 ndc = clip.xy / clip.w; \
              vec2 lampPx = (ndc * 0.5 + 0.5) * uWetSize; \
              vec2 toF = wp.xz - lamp.xz; \
              float side = dot(toF, toCam); \
              float toCamL2 = toCamL * toCamL; \
              float dx = fragPx.x - lampPx.x; \
              float dy = lampPx.y - fragPx.y; \
              float along = max(dy, 0.0); \
              float width = (uWetSize.y * 0.005 + along * 0.01) * uWetSpread; \
              float across = exp(-dx * dx / max(width * width, 0.25)); \
              float onSeg = step(-0.4, side) * step(side, toCamL2 + 0.4); \
              float span = smoothstep(-3.0, 10.0, dy) * (1.0 - smoothstep(toCamL2 * 0.82, toCamL2, side)); \
              float body = exp(-along / max(uWetSize.y, 1.0) * 1.4); \
              float aimed = smoothstep(0.2, 0.65, toward); \
              acc += uWetCol[IDX] * uWetLamp[IDX].w * across * onSeg * span * body * aimed; \
            } \
          } \
        }
      WET_LAMP(0)
      WET_LAMP(1)
      WET_LAMP(2)
      WET_LAMP(3)
      WET_LAMP(4)
      WET_LAMP(5)
      WET_LAMP(6)
      WET_LAMP(7)
      #undef WET_LAMP
      gl_FragColor.rgb += acc * uWetStreak * uWetGain * (0.15 + 0.85 * graze);
    }
  }
}
`

export interface WetMark { x: number; y: number; z: number; dx: number; dz: number; r: number; g: number; b: number; gain: number }

/** The lamps whose wet-road streaks are drawn this frame. Past eight, the farthest are dropped. */
export function setWetStreak(wet: number, marks: readonly WetMark[], camera: THREE.Camera, renderer: THREE.WebGLRenderer) {
  wetAmount.value = wet
  wetGain.value = T.WET_STREAK
  wetSpread.value = T.WET_SPREAD
  camera.updateMatrixWorld()
  wetViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  renderer.getDrawingBufferSize(wetSize.value)
  const n = Math.min(WET_N, marks.length)
  wetCount.value = n
  for (let i = 0; i < n; i++) {
    const m = marks[i]
    wetLamp[i].set(m.x, m.y, m.z, m.gain)
    wetAim[i].set(m.dx, m.dz)
    wetCol[i].set(m.r, m.g, m.b)
  }
}

export function injectWetStreak(shader: { fragmentShader: string; uniforms: Record<string, { value: unknown }> }) {
  if (shader.fragmentShader.includes('uniform float uWetStreak')) return
  shader.uniforms.uWetStreak = wetAmount
  shader.uniforms.uWetGain = wetGain
  shader.uniforms.uWetSpread = wetSpread
  shader.uniforms.uWetCount = wetCount
  shader.uniforms.uWetSize = wetSize
  shader.uniforms.uWetViewProj = wetViewProj
  shader.uniforms.uWetLamp = { value: wetLamp }
  shader.uniforms.uWetAim = { value: wetAim }
  shader.uniforms.uWetCol = { value: wetCol }
  shader.fragmentShader = shader.fragmentShader.includes('#include <common>')
    ? shader.fragmentShader.replace('#include <common>', `#include <common>\n${WET_DECL}`)
    : WET_DECL + shader.fragmentShader
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${WET_BODY}`)
}

const SHADE = /* glsl */ `
#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
  {
    DirectionalLightShadow shadeLight;
    float mask = 1.0;
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      shadeLight = directionalLightShadows[ i ];
      mask *= getShadow( directionalShadowMap[ i ], shadeLight.shadowMapSize, 1.0, shadeLight.shadowBias, shadeLight.shadowRadius, vDirectionalShadowCoord[ i ] );
    }
    #pragma unroll_loop_end
    // the sun's own shadow only removes the sun. Ambient and the rake stay, which is why a
    // tree was a wisp and the road showed nothing. A soft mask stays near 1, so crush it
    // before pulling the fill down — otherwise the slider's top end never reads.
    float crushed = pow(clamp(mask, 0.0, 1.0), 1.0 + uShade * 2.0);
    float floor = 1.0 / (1.0 + uShade * 3.0);
    gl_FragColor.rgb *= mix(floor, 1.0, crushed);
  }
#endif
`

/** Receivers: darken the unshadowed fill so the shade reads on the road, not only on the sun term. */
export function injectShade(shader: { fragmentShader: string; uniforms: Record<string, { value: unknown }> }) {
  afterOpaque(shader, 'uShade', shadeUniform, SHADE)
}

/**
 * Paint and glass: a clearcoat fresnel and a tight sun highlight.
 *
 * `coat` is this car's own clearcoat multiplier, so two vehicles can wear different gloss while the
 * global CAR_SHINE stays the fleet's dial. It defaults to the shared uniform, which is a no-op times
 * one.
 */
export function injectCoat(shader: { fragmentShader: string; uniforms: Record<string, { value: unknown }> }, coat: { value: number } = shineUniform) {
  if (shader.fragmentShader.includes('uniform float uShine')) return
  shader.uniforms.uShine = shineUniform
  shader.uniforms.uCoat = coat
  const decl = 'uniform float uShine;\nuniform float uCoat;\n'
  shader.fragmentShader = shader.fragmentShader.includes('#include <common>')
    ? shader.fragmentShader.replace('#include <common>', `#include <common>\n${decl}`)
    : decl + shader.fragmentShader
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${COAT}`)
}

/**
 * Paint and glass: mirror the car's real surroundings (trees, bank), not just the sky dome.
 *
 * A cube probe rendered at the car (`carProbe.ts`) is sampled along the fragment's own reflected
 * ray and mixed over the standard material's sky reflection, so at `CAR_PROBE_BLEND 1` the paint
 * shows what is actually around it. It fades out with world distance from the capture point, which
 * is what lets the shared traffic materials hold one probe: a car across the road keeps the sky
 * instead of a wrong reflection. `vCarWorld` carries the fragment's world position for that fade.
 *
 * How much the cube shows is the paint's own reflectance: a dielectric (paint) reflects ~4% head-on
 * and everything at a grazing angle, a metal reflects at every angle. So a metal-finish car reads as
 * a real mirror square-on instead of only glinting at its edges, and the captured sun is a sharp
 * image rather than the standard material's roughness-blurred blob. `uCarProbeGain` folds in the
 * global REFLECT dial so that knob moves the probe as well as the sky map it replaces.
 */
const CAR_PROBE = /* glsl */ `
{
  if (uCarProbeOn > 0.5) {
    vec3 cpN = normalize(normal);
    vec3 cpV = normalize(vViewPosition);
    float cpNdv = clamp(dot(cpN, cpV), 0.0, 1.0);
    float cpBase = mix(0.04, 1.0, clamp(metalness, 0.0, 1.0));
    float cpFres = cpBase + (1.0 - cpBase) * pow(1.0 - cpNdv, 5.0);
    vec3 cpW = transformDirectionByInverseViewMatrix(reflect(-cpV, cpN), viewMatrix);
    vec3 cpCol = textureCube(uCarProbe, cpW).rgb;
    float cpFade = 1.0 - smoothstep(uCarProbeReach * 0.5, uCarProbeReach, distance(vCarWorld, uCarProbeOrigin));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, cpCol, clamp(uCarProbeBlend * cpFres * cpFade * uCarProbeGain, 0.0, 1.0));
  }
}
`

/** Paint and glass: sample the car's reflection probe along the reflected ray (carProbe.ts). */
export function injectCarProbe(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> }) {
  if (shader.fragmentShader.includes('uniform samplerCube uCarProbe')) return
  shader.uniforms.uCarProbe = carProbeCube
  shader.uniforms.uCarProbeOn = carProbeOn
  shader.uniforms.uCarProbeBlend = carProbeBlend
  shader.uniforms.uCarProbeGain = carProbeGain
  shader.uniforms.uCarProbeReach = carProbeReach
  shader.uniforms.uCarProbeOrigin = carProbeOrigin
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCarWorld;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
  const decl = 'uniform samplerCube uCarProbe;\nuniform float uCarProbeOn;\nuniform float uCarProbeBlend;\nuniform float uCarProbeGain;\nuniform float uCarProbeReach;\nuniform vec3 uCarProbeOrigin;\nvarying vec3 vCarWorld;\n'
  shader.fragmentShader = shader.fragmentShader.includes('#include <common>')
    ? shader.fragmentShader.replace('#include <common>', `#include <common>\n${decl}`)
    : decl + shader.fragmentShader
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${CAR_PROBE}`)
}

/**
 * The shadow pass inherits the renderer's logarithmic depth, which flattens an orthographic
 * shadow map to a single value. This material writes ordinary window depth instead.
 */
export const linearShadowDepth = new THREE.MeshDepthMaterial()
linearShadowDepth.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader.replace('#include <logdepthbuf_pars_vertex>', '').replace('#include <logdepthbuf_vertex>', '')
  shader.fragmentShader = shader.fragmentShader.replace('#include <logdepthbuf_pars_fragment>', '').replace('#include <logdepthbuf_fragment>', '')
}
linearShadowDepth.customProgramCacheKey = () => 'linear-shadow'

/** A leaf caster: the same linear depth, but compiled with the leaf's alpha map so the crown casts. */
export function leafShadowDepth(map: THREE.Texture | null, alphaTest: number): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ map, alphaTest })
  m.onBeforeCompile = linearShadowDepth.onBeforeCompile
  m.customProgramCacheKey = () => 'linear-shadow-leaf'
  return m
}

/** Paint, glass, water: REFLECT drives their environment-map strength each frame. */
export function noteShiny(m: THREE.MeshStandardMaterial) {
  if (!shiny.includes(m)) shiny.push(m)
}

/**
 * Chain a compile hook. Materials that already rewrite their shader (hex tiles, water, glass)
 * keep that rewrite; this only appends.
 */
export function chainCompile(mat: THREE.Material, inject: (shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> }) => void, key: string) {
  const prev = mat.onBeforeCompile
  const prevKey = mat.customProgramCacheKey?.bind(mat)
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer)
    inject(shader as unknown as { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> })
  }
  mat.customProgramCacheKey = () => `${prevKey?.() ?? ''}|${key}`
  mat.needsUpdate = true
}

/**
 * What a chrome finish is: mirror-smooth and fully metallic. The per-vehicle `finish.chrome` flag and
 * the live F6 `CAR_CHROME` dial both aim a car at these numbers, and the metalness-aware probe mix
 * (`CAR_PROBE`) turns that into a real reflection of the world rather than a soft highlight.
 */
export const CHROME_ROUGHNESS = 0.03
export const CHROME_METALNESS = 1

/**
 * The car should read as paint, including a TRELLIS mesh whose one material arrived at roughness 1.
 *
 * Tyres and the dash are left alone: near-black and already rough. Lamps are left alone because
 * they are emissive. Everything else gets a lower roughness, a bit of metal, a stronger environment
 * reflection, and the clearcoat hook.
 *
 * `finish` is the vehicle document's own say, when it has one. Roughness and metalness are absolute
 * — "this car's paint is a mirror" — and reflect/shine MULTIPLY the global F6 dials, so one car can
 * be glossier than the fleet without standing the fleet's dial down.
 */
export function applyCarShine(root: THREE.Object3D, finish?: VehicleFinish) {
  const rough = finish?.roughness
  const metal = finish?.metalness
  const reflect = Number.isFinite(finish?.reflect) ? Math.max(0, Math.min(8, finish!.reflect!)) : 1
  const coat = Number.isFinite(finish?.shine) ? Math.max(0, Math.min(8, finish!.shine!)) : 1
  const seen = new Set<THREE.Material>()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.customDepthMaterial = linearShadowDepth
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(m) || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue
      seen.add(m)
      const std = m as THREE.MeshStandardMaterial
      if (std.userData.coat) continue
      const emit = std.emissive
      if (emit && emit.r + emit.g + emit.b > 0.2) continue
      const c = std.color
      // tyres: near-black and already rough. Paint that arrived at roughness 1 is the case this is for.
      if (c && c.r < 0.09 && c.g < 0.09 && c.b < 0.09 && std.roughness > 0.7) continue
      std.userData.coat = 1
      std.userData.finishReflect = reflect
      // chrome wins over the two sliders: it is the mirror they can add up to, said in one word
      const chrome = finish?.chrome === true
      std.roughness = chrome ? CHROME_ROUGHNESS
        : rough != null && Number.isFinite(rough) ? Math.max(0, Math.min(1, rough)) : Math.min(std.roughness, 0.28)
      std.metalness = chrome ? CHROME_METALNESS
        : metal != null && Number.isFinite(metal) ? Math.max(0, Math.min(1, metal)) : Math.max(std.metalness, 0.5)
      // the base surface, before the global CAR_CHROME dial moves it each frame
      std.userData.finishRough = std.roughness
      std.userData.finishMetal = std.metalness
      std.envMapIntensity = T.REFLECT * reflect
      noteShiny(std)
      // one coat bag per material, so two vehicles can wear different gloss under one program
      const coatBag = { value: coat }
      chainCompile(std, (shader) => {
        // the probe goes on LAST: the cube is a mirror of the real surroundings, so it must replace
        // the coat's soft sun blob rather than sit under it, which is what makes a metal-finish car
        // read as an actual reflection instead of a matte highlight.
        injectCarProbe(shader)
        injectCoat(shader, coatBag)
      }, 'car-gloss')
    }
  })
}

/** The knobs, once a frame. The uniforms are the ones the compiled shaders already hold. */
export function tickShading() {
  reliefUniform.value = T.RELIEF
  shineUniform.value = T.CAR_SHINE
  shadeUniform.value = T.SHADOW
  // as the car's probe takes over its reflection, the sky map it replaces steps back with it
  const carBlend = carProbeOn.value > 0.5 ? Math.max(0, Math.min(1, carProbeBlend.value)) : 0
  carProbeGain.value = Math.max(0, Math.min(1, T.REFLECT))
  // the fleet-wide chrome dial: 0 leaves each car's own finish, 1 pushes every coat to a mirror
  const chrome = Math.max(0, Math.min(1, T.CAR_CHROME))
  for (const m of shiny) {
    const finish = typeof m.userData.finishReflect === 'number' ? m.userData.finishReflect : 1
    m.envMapIntensity = T.REFLECT * finish * (m.userData.coat ? 1 - 0.65 * carBlend : 1)
    if (m.userData.coat) {
      const baseR = typeof m.userData.finishRough === 'number' ? m.userData.finishRough : m.roughness
      const baseM = typeof m.userData.finishMetal === 'number' ? m.userData.finishMetal : m.metalness
      m.roughness = baseR + (CHROME_ROUGHNESS - baseR) * chrome
      m.metalness = baseM + (CHROME_METALNESS - baseM) * chrome
    }
  }
}
