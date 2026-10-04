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
// The mirror camera, the oblique clipping plane that keeps the seabed out of the sky, and the
// projected sample are adapted from three.js `examples/jsm/objects/Reflector.js` (MIT).
import * as THREE from 'three'
import * as T from '../tuning'

/** the colour of the reflected scene, this frame; bound into the water material */
export const waterReflectMap = { value: null as THREE.Texture | null }
/** clip → [0,1]² projection of a world point through the mirror camera */
export const waterReflectMatrix = { value: new THREE.Matrix4() }
/** reflection share, 0..1; the live knob, read every frame from `WATER_REFLECT` */
export const waterReflectStrength = { value: 0 }
/** how far the wave normal smears the reflected image, in screen fractions */
export const waterReflectRipple = { value: 0.04 }

let planeY = 0
let registered = false
let hide: THREE.Object3D | null = null
let target: THREE.WebGLRenderTarget | null = null

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
 * Point the reflection at a water plane. `level` is the world Y of the plane (the sea), or `null`
 * when the site has no water for the mirror to show — then the pass is skipped entirely rather than
 * rendering the whole scene twice for a plane hidden under inland terrain. `group` is the water
 * itself, hidden while the mirror is drawn so the sea does not reflect the sea.
 */
export function configureWaterReflection(level: number | null, group: THREE.Object3D | null) {
  registered = level !== null
  if (level !== null) planeY = level
  hide = group
}

/**
 * Draw the reflected scene. Call once a frame, before the main render, with the same camera the
 * frame will be drawn from.
 */
export function renderWaterReflection(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  waterReflectRipple.value = T.WATER_REFLECT_RIPPLE
  const on = T.WATER_REFLECT > 0.001 && registered
  // zero it when off, or a disabled plane keeps sampling its last texture
  waterReflectStrength.value = on ? T.WATER_REFLECT : 0
  if (!on) return

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

const REFLECT_BODY = /* glsl */ `
{
  if (uReflect > 0.001) {
    vec2 ruv = vReflectUv.xy / max(vReflectUv.w, 1e-4);
    // smear the mirror with the live wave normal, or a calm sea becomes a perfect looking-glass
    ruv += normalize(normal).xy * uReflectRipple;
    if (ruv.x > 0.0 && ruv.x < 1.0 && ruv.y > 0.0 && ruv.y < 1.0) {
      vec3 refl = texture2D(uReflectMap, ruv).rgb;
      float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
      float fres = pow(1.0 - ndv, 3.0);
      // only deep water mirrors: a stream or a pond is shallow and takes almost none
      float deep = smoothstep(0.3, 2.5, max(vWater.x, 0.0));
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
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform mat4 uReflectMatrix;\nvarying vec4 vReflectUv;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvReflectUv = uReflectMatrix * vec4((modelMatrix * vec4(position, 1.0)).xyz, 1.0);')
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform sampler2D uReflectMap;\nuniform float uReflect;\nuniform float uReflectRipple;\nvarying vec4 vReflectUv;')
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${REFLECT_BODY}`)
}
