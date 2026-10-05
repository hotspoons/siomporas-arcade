// Water reflection: one extra scene render from the camera mirrored across the water plane.
//
// The screen-space pass in shading.ts fakes a reflection by sampling the previous frame along a
// linearly shifted screen row — it is tuned for a car bonnet, and on a body the size of the sea the
// shift runs off the texture along a straight line and paints a flat plate over half the ocean.
// This is the honest version: render the scene once more from the mirror camera into a texture and
// read it back with the projected screen coordinate of each water fragment. The water plane is flat,
// so this is exact, needs no depth buffer, and reflects the coast, the trees and a boat — the
// geometry the sky environment map can never supply.
//
// ONE PLANE, AIMED. The mirror is exact only across the plane it is rendered from, so originally it
// served only the sea. But the eye is at one body at a time, and a pond is flat too: each frame the
// plane is aimed at the nearest inland body within `WATER_REFLECT_REACH` (else the sea), so the lake
// under your nose mirrors its own bank and trees with the same render the coast uses. The sea keeps
// its level when no body is near; on an inland site the pass stands down as before.
//
// The mirror camera, the oblique clipping plane that keeps the seabed out of the sky, and the
// projected sample are adapted from three.js `examples/jsm/objects/Reflector.js` (MIT).
import * as THREE from 'three'
import * as T from '../tuning'
import { waterProbeAtlas, waterProbeCount, waterProbeWeight } from './waterProbes'

/** the colour of the reflected scene, this frame; bound into the water material */
export const waterReflectMap = { value: null as THREE.Texture | null }
/** clip → [0,1]² projection of a world point through the mirror camera */
export const waterReflectMatrix = { value: new THREE.Matrix4() }
/** reflection share, 0..1; the live knob, read every frame from `WATER_REFLECT` */
export const waterReflectStrength = { value: 0 }
/** how far the wave normal smears the reflected image, in screen fractions */
export const waterReflectRipple = { value: 0.1 }
/**
 * env-map roughness of the sky/horizon reflection. Low is a crisp sky, high a soft sheen. The
 * reflection SHARE is per body (`WaterWaveUniforms.uSkyReflect`, bound in water.ts); this is only
 * the blur, shared by every water material.
 */
const waterSkyRough = { value: 0.03 }

let planeY = 0
/** the sea plane's Y, or null when the site has no visible sea (inland, or the flood is under the hill) */
let seaLevel: number | null = null
let hide: THREE.Object3D | null = null
let target: THREE.WebGLRenderTarget | null = null
/**
 * Inland bodies the mirror may follow: one flat polygon each, at its own waterline. `x`/`z` is the
 * body centre and `radius` its rough half-width, so "near" means near the shore. The plane itself is
 * exact for any viewpoint, so these exist only to decide WHICH body the single mirror plane belongs
 * to this frame. Filled by water.ts via registerWaterReflectBodies.
 */
export interface WaterReflectBody { x: number; y: number; z: number; radius: number }
let localBodies: WaterReflectBody[] = []

const virtualCamera = new THREE.PerspectiveCamera()
const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
const reflectorPlane = new THREE.Plane()
const normal = new THREE.Vector3()
const planePoint = new THREE.Vector3()
const cameraWorld = new THREE.Vector3()
const rotation = new THREE.Matrix4()
const lookAt = new THREE.Vector3()
const view = new THREE.Vector3()
const targetPoint = new THREE.Vector3()
const clipPlane = new THREE.Vector4()
const q = new THREE.Vector4()
const size = new THREE.Vector2()

/**
 * Point the reflection at the sea plane. `level` is the world Y of the sea, or `null` when the site
 * has no water for the sea mirror to show — then the pass may still run for an inland body (see
 * registerWaterReflectBodies), but with no inland body near it is skipped entirely rather than
 * rendering the whole scene twice for a plane hidden under terrain. `group` is the water itself,
 * hidden while the mirror is drawn so the sea does not reflect the sea.
 */
export function configureWaterReflection(level: number | null, group: THREE.Object3D | null) {
  seaLevel = level
  if (level !== null) planeY = level
  hide = group
}

/**
 * Give the mirror the inland bodies it may follow. The one plane cannot serve the sea and every pond
 * at once, but it is exact for whichever flat body it is aimed at, and the eye is at one body at a
 * time: each frame `renderWaterReflection` aims it at the nearest body within `WATER_REFLECT_REACH`,
 * falling back to the sea. `radius` is the body's rough half-width so proximity means the shore, not
 * the centroid. Called by water.ts once the manifest is known.
 */
export function registerWaterReflectBodies(bodies: WaterReflectBody[]) {
  localBodies = bodies
}

/** The water plane the mirror should use this frame: nearest inland body in reach, else the sea. */
function pickPlane(camera: THREE.Camera): number | null {
  const reach = T.WATER_REFLECT_REACH
  if (reach > 0 && localBodies.length) {
    let best = reach
    let bestY: number | null = null
    for (const b of localBodies) {
      const d = Math.hypot(b.x - camera.position.x, b.z - camera.position.z) - b.radius
      if (d < best) {
        best = d
        bestY = b.y
      }
    }
    if (bestY !== null) return bestY
  }
  return seaLevel
}

/**
 * Draw the reflected scene. Call once a frame, before the main render, with the same camera the
 * frame will be drawn from.
 */
export function renderWaterReflection(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  waterReflectRipple.value = T.WATER_REFLECT_RIPPLE
  // aim the one mirror at the water the eye is at: the nearest inland body within reach, else the
  // sea. null means nothing to mirror (no visible sea, no pond near), so the pass is skipped.
  const level = pickPlane(camera)
  const on = T.WATER_REFLECT > 0.001 && level !== null
  // zero it when off, or a disabled plane keeps sampling its last texture
  waterReflectStrength.value = on ? T.WATER_REFLECT : 0
  if (!on) return
  planeY = level

  const full = renderer.getDrawingBufferSize(size)
  const w = Math.max(2, Math.round(full.x * T.WATER_REFLECT_SCALE))
  const h = Math.max(2, Math.round(full.y * T.WATER_REFLECT_SCALE))
  if (!target || target.width !== w || target.height !== h) {
    target?.dispose()
    // linear (the composer works in linear half-float and OutputPass does sRGB), so the water can
    // mix the reflection straight in before it is tone- and colour-mapped like everything else
    target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    })
    target.texture.colorSpace = THREE.NoColorSpace
    waterReflectMap.value = target.texture
  }

  // the camera mirrored across y = planeY
  normal.set(0, 1, 0)
  planePoint.set(0, planeY, 0)
  cameraWorld.setFromMatrixPosition(camera.matrixWorld)
  view.subVectors(planePoint, cameraWorld).reflect(normal).negate().add(planePoint)

  rotation.extractRotation(camera.matrixWorld)
  lookAt.set(0, 0, -1).applyMatrix4(rotation).add(cameraWorld)
  targetPoint.subVectors(planePoint, lookAt).reflect(normal).negate().add(planePoint)

  virtualCamera.position.copy(view)
  virtualCamera.up.set(0, 1, 0).applyMatrix4(rotation).reflect(normal)
  virtualCamera.lookAt(targetPoint)
  virtualCamera.near = camera.near
  virtualCamera.far = camera.far
  virtualCamera.updateMatrixWorld()
  virtualCamera.projectionMatrix.copy(camera.projectionMatrix)

  // oblique near plane: clip everything below the water line, or the seabed reflects into the sky
  reflectorPlane.setFromNormalAndCoplanarPoint(normal, planePoint)
  reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse)
  clipPlane.set(reflectorPlane.normal.x, reflectorPlane.normal.y, reflectorPlane.normal.z, reflectorPlane.constant)
  const P = virtualCamera.projectionMatrix
  q.x = (Math.sign(clipPlane.x) + P.elements[8]) / P.elements[0]
  q.y = (Math.sign(clipPlane.y) + P.elements[9]) / P.elements[5]
  q.z = -1
  q.w = (1 + P.elements[10]) / P.elements[14]
  clipPlane.multiplyScalar(2 / clipPlane.dot(q))
  P.elements[2] = clipPlane.x
  P.elements[6] = clipPlane.y
  P.elements[10] = clipPlane.z + 1
  P.elements[14] = clipPlane.w

  waterReflectMatrix.value.copy(bias).multiply(P).multiply(virtualCamera.matrixWorldInverse)

  const wasVisible = hide?.visible ?? false
  if (hide) hide.visible = false
  const prevTarget = renderer.getRenderTarget()
  const prevXR = renderer.xr.enabled
  const prevShadow = renderer.shadowMap.autoUpdate
  renderer.xr.enabled = false
  renderer.shadowMap.autoUpdate = false
  renderer.setRenderTarget(target)
  renderer.state.buffers.depth.setMask(true)
  if (renderer.autoClear === false) renderer.clear()
  renderer.render(scene, virtualCamera)
  renderer.setRenderTarget(prevTarget)
  renderer.xr.enabled = prevXR
  renderer.shadowMap.autoUpdate = prevShadow
  if (hide) hide.visible = wasVisible
}

/**
 * The sky/horizon reflection, for the bodies the single sea-level plane cannot serve.
 *
 * The planar sample above needs a plane, and there is only one: at sea level. A pond or a stream at
 * any other height projects through it onto the reflection of some other place, and inland — where
 * the sea is not visible — the mirror is off entirely. The environment map (`scene.environment`, the
 * prefiltered sky dome) knows no plane, so this samples it along the fragment's own reflected ray,
 * which is sky, haze and cloud at any height. It is drawn BEFORE the planar mix, so wherever the
 * mirror reaches the mirror still owns the pixel and the trees still show, while a pond keeps the
 * sky. Fresnel and the depth fade keep the wet bank from turning into a mirror.
 */
const SKY_BODY = /* glsl */ `
#ifdef USE_ENVMAP
{
  vec3 skyV = normalize(vViewPosition);
  vec3 skyN = normalize(normal);
  // Schlick, softened. Real water only mirrors near grazing, but a pond read from a car is a
  // narrow band at a moderate slant, and a strict fifth-power Fresnel left the sky all but
  // invisible there. A small base sheen plus a third-power falloff reads as a mirror across the
  // whole body while still going clear when you look straight down at it.
  float skyNdv = clamp(dot(skyN, skyV), 0.0, 1.0);
  float skyFres = 0.08 + 0.92 * pow(1.0 - skyNdv, 3.0);
  // fade in past the waterline so the shingle and the foam edge stay dry
  float skyWet = smoothstep(0.0, 0.8, max(vWater.x, 0.0));
  float skyShare = skyFres * skyWet;
  if (uSkyReflect > 0.001) {
    // the environment's own radiance along the reflected ray: sky and horizon, no second render
    vec3 sky = getIBLRadiance(skyV, skyN, uSkyRough);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, sky, clamp(uSkyReflect * skyShare, 0.0, 1.0));
  }
  // A captured per-body probe (waterProbes.ts) layers over the sky: the trees and bank the sky dome
  // cannot hold. The strip is transparent until captured — that is the "no probe" flag — so an
  // uncaptured body keeps the sky with no branch on the CPU side. It has its own share, so it shows
  // even on a look that has the sky reflection dialed out.
  if (uProbeCount > 0.5) {
    float pi = floor(vProbe + 0.5);
    if (pi >= 0.0 && pi < uProbeCount) {
      vec3 wr = transformDirectionByInverseViewMatrix(reflect(-skyV, skyN), viewMatrix);
      vec2 euv = equirectUv(wr);
      vec4 probe = texture2D(uProbeAtlas, vec2((pi + euv.x) / uProbeCount, euv.y));
      if (probe.a > 0.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, probe.rgb, clamp(uProbeWeight * skyShare, 0.0, 1.0));
    }
  }
}
#endif
`

const REFLECT_BODY = /* glsl */ `
{
  if (uReflect > 0.001) {
    vec2 ruv = vReflectUv.xy / max(vReflectUv.w, 1e-4);
    // smear the mirror with the wave normal: the deviation from the FLAT-water normal, not the
    // normal itself. At a grazing angle the flat normal already points across the screen, so
    // offsetting by it slides the whole reflection off the shore into a gap; the deviation is the
    // ripple alone and is zero on calm water.
    vec3 flatN = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    ruv += (normalize(normal) - flatN).xy * uReflectRipple;
    if (ruv.x > 0.0 && ruv.x < 1.0 && ruv.y > 0.0 && ruv.y < 1.0) {
      vec3 refl = texture2D(uReflectMap, ruv).rgb;
      float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
      float fres = pow(1.0 - ndv, 3.0);
      // Deep water mirrors, the shingle at the edge does not. This used to be a harsh gate — only
      // the sea's baked depth of 60 m reached it — because the plane was at sea level and a pond
      // reflecting through the wrong plane was worse than no reflection. Now the plane is aimed at
      // the body (pickPlane), so a pond's few metres of baked depth should mirror like the sea:
      // anything past the waterline counts, and the Fresnel term is what keeps the look-down clear.
      float deep = smoothstep(0.3, 1.0, max(vWater.x, 0.0));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, refl, clamp(fres * uReflect * deep, 0.0, 1.0));
    }
  }
}
`

/** Add the reflection uniforms, the projected sample and the mix to a water shader. */
export function injectWaterReflect(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> }) {
  shader.uniforms.uReflectMap = waterReflectMap
  shader.uniforms.uReflectMatrix = waterReflectMatrix
  shader.uniforms.uReflect = waterReflectStrength
  shader.uniforms.uReflectRipple = waterReflectRipple
  shader.uniforms.uSkyRough = waterSkyRough
  shader.uniforms.uProbeAtlas = waterProbeAtlas
  shader.uniforms.uProbeCount = waterProbeCount
  shader.uniforms.uProbeWeight = waterProbeWeight
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform mat4 uReflectMatrix;\nattribute float aProbe;\nvarying vec4 vReflectUv;\nvarying float vProbe;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvReflectUv = uReflectMatrix * vec4((modelMatrix * vec4(position, 1.0)).xyz, 1.0);\nvProbe = aProbe;')
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform sampler2D uReflectMap;\nuniform float uReflect;\nuniform float uReflectRipple;\nuniform float uSkyReflect;\nuniform float uSkyRough;\nuniform sampler2D uProbeAtlas;\nuniform float uProbeCount;\nuniform float uProbeWeight;\nvarying vec4 vReflectUv;\nvarying float vProbe;')
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${SKY_BODY}\n${REFLECT_BODY}`)
}
