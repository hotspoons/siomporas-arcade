// Car reflection probes.
//
// The car's paint and glass reflect `scene.environment` — the sky dome alone — plus a cube probe at
// the car (this file). Neither knows the TREES from the sky map alone: a car under a canopy, or one
// driving past a treeline, mirrors blue sky where it should mirror leaves. Rich, 2026-10-05: *"add a
// toggle for the car to use the same type of reflections instead of whatever crap is baked into the
// car now."* This is that toggle.
//
// The same idea as waterProbes.ts, and the same trade: a cube camera at the car renders the world
// once, and the paint reads it back along its own reflected ray. Unlike water there is ONE probe,
// because the reflection belongs to the car the eye is with, not to a body of water. Any car whose
// paint is NEAR that capture shares it, faded out with distance in the shader (`CAR_PROBE_REACH`,
// against `uCarProbeOrigin`), so the traffic around you picks up the same trees without a probe per
// car — and a distant car cannot get a wrong one, because it has faded back to the sky map.
//
// Modes. `CAR_PROBES 0` off: nothing is built and the injected branch is skipped. `1` live: the cube
// is re-captured while the car moves or on a timer, so the wood slides over the paint. `2` hold:
// captured once and kept, for a still shot or a cheap frame. A capture is six scene renders, so the
// near world is clipped by `CAR_PROBE_FAR` and the default — like every knob here — is off.
import * as THREE from 'three'
import * as T from '../tuning'

/** the cube the car shaders sample; null until the first capture (three binds its own empty cube) */
export const carProbeCube = { value: null as THREE.Texture | null }
/** 1 while a probe is live, so the injected shader branch is skipped entirely when off */
export const carProbeOn = { value: 0 }
/** how much the probe replaces the reflected colour, 0..1 */
export const carProbeBlend = { value: 0 }
/** the global REFLECT dial, clamped to 0..1: scales the probe so the reflect knob moves it too */
export const carProbeGain = { value: 1 }
/** fade distance (m) from the capture point; a car farther than this keeps the sky reflection */
export const carProbeReach = { value: 60 }
/** where the live probe was captured, world space; the shader fades against it */
export const carProbeOrigin = { value: new THREE.Vector3() }

let cubeRT: THREE.WebGLCubeRenderTarget | null = null
let cubeCam: THREE.CubeCamera | null = null
/** what the current cube was built for, so a knob change rebuilds */
let built = { res: 0, far: 0 }
const origin = new THREE.Vector3()
let capturedAt = 0
let primed = false
/** the face a spread refresh renders next, 0…5; -1 when no refresh is in progress */
let nextFace = -1

function disposeTargets() {
  cubeRT?.dispose()
  cubeRT = null
  cubeCam = null
  carProbeCube.value = null
  carProbeOn.value = 0
  built = { res: 0, far: 0 }
  primed = false
  nextFace = -1
}

function ensureTargets(renderer: THREE.WebGLRenderer, res: number, far: number) {
  if (cubeRT && built.res === res && built.far === far) return
  disposeTargets()
  const face = Math.max(8, Math.min(Math.round(res), renderer.capabilities.maxTextureSize))
  cubeRT = new THREE.WebGLCubeRenderTarget(face, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  })
  cubeRT.texture.colorSpace = THREE.NoColorSpace
  cubeCam = new THREE.CubeCamera(0.5, Math.max(20, far), cubeRT)
  built = { res, far }
}

/** Six scene renders from the car, into the cube the paint samples. */
function capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, hide: THREE.Object3D | null, at: THREE.Vector3, lift: number) {
  if (!cubeCam || !cubeRT) return
  const wasVisible = hide?.visible ?? false
  if (hide) hide.visible = false
  // shadows do not change between the six faces, and neither is the frame in XR
  const prevShadow = renderer.shadowMap.autoUpdate
  const prevXR = renderer.xr.enabled
  renderer.shadowMap.autoUpdate = false
  renderer.xr.enabled = false

  cubeCam.position.set(at.x, at.y + lift, at.z)
  cubeCam.updateMatrixWorld(true)
  cubeCam.update(renderer, scene)

  renderer.shadowMap.autoUpdate = prevShadow
  renderer.xr.enabled = prevXR
  if (hide) hide.visible = wasVisible

  carProbeCube.value = cubeRT.texture
  origin.copy(cubeCam.position)
  carProbeOrigin.value.copy(origin)
  capturedAt = performance.now()
  primed = true
}

/**
 * Render faces `from`…`to - 1` of the cube from where the cube camera already stands — what
 * `CubeCamera.update` does for all six, one face at a time (three 0.185: the target and face, the
 * mip level, XR off, the reversed-depth clear). The car and the shadow map are held as in `capture`.
 */
function captureFaces(renderer: THREE.WebGLRenderer, scene: THREE.Scene, hide: THREE.Object3D | null, from: number, to: number) {
  if (!cubeCam || !cubeRT) return
  const wasVisible = hide?.visible ?? false
  if (hide) hide.visible = false
  const prevShadow = renderer.shadowMap.autoUpdate
  const prevXR = renderer.xr.enabled
  renderer.shadowMap.autoUpdate = false
  renderer.xr.enabled = false
  if (cubeCam.coordinateSystem !== renderer.coordinateSystem) {
    cubeCam.coordinateSystem = renderer.coordinateSystem
    cubeCam.updateCoordinateSystem()
  }
  const target = renderer.getRenderTarget()
  const face = renderer.getActiveCubeFace()
  const mip = renderer.getActiveMipmapLevel()
  const reversed = renderer.state.buffers.depth.getReversed()
  const cams = cubeCam.children as THREE.Camera[]
  for (let i = from; i < Math.min(6, to); i++) {
    renderer.setRenderTarget(cubeRT, i, cubeCam.activeMipmapLevel)
    if (reversed && renderer.autoClear === false) renderer.clearDepth()
    renderer.render(scene, cams[i])
  }
  renderer.setRenderTarget(target, face, mip)
  renderer.shadowMap.autoUpdate = prevShadow
  renderer.xr.enabled = prevXR
  if (hide) hide.visible = wasVisible
  cubeRT.texture.needsPMREMUpdate = true
}

/**
 * Capture or refresh the car probe at most once a frame. Call before the main render with the car's
 * world position and the car object to keep out of its own reflection. Free while `CAR_PROBES` is 0.
 */
export function tickCarProbe(renderer: THREE.WebGLRenderer, scene: THREE.Scene, at: THREE.Vector3, hide: THREE.Object3D | null) {
  const mode = Math.round(T.CAR_PROBES)
  carProbeBlend.value = Math.max(0, Math.min(1, T.CAR_PROBE_BLEND))
  carProbeReach.value = Math.max(1, T.CAR_PROBE_REACH)
  if (mode <= 0) {
    carProbeOn.value = 0
    if (cubeRT) disposeTargets()
    return
  }
  const far = Math.max(20, T.CAR_PROBE_FAR)
  ensureTargets(renderer, Math.max(8, Math.round(T.CAR_PROBE_RES)), far)
  carProbeOn.value = 1
  // A teleport — a level rebuild, a respawn — must re-anchor whatever mode we are in, or every car
  // would reflect a place it is no longer at. Distance from the last capture is that signal.
  let due = !primed || origin.distanceTo(at) > far
  if (mode === 1) {
    const refreshMs = T.CAR_PROBE_REFRESH > 0 ? T.CAR_PROBE_REFRESH * 1000 : Infinity
    const move = T.CAR_PROBE_MOVE > 0 ? T.CAR_PROBE_MOVE : Infinity
    due = due || performance.now() - capturedAt >= refreshMs || origin.distanceTo(at) >= move
  }
  /*
   * SPREAD THE REFRESH. A capture is six scene renders — 48 ms in one frame on the DC Beltway, every
   * CAR_PROBE_REFRESH, the rhythmic spike in Rich's frame graph (2026-10-08). A timed or moved
   * refresh now renders CAR_PROBE_SPREAD faces a frame from one fixed point, so the cube is redone
   * over six frames at ~8 ms each. The FIRST capture and a teleport are still whole, so the paint
   * never shows a cube from somewhere else.
   */
  const perFrame = Math.max(1, Math.min(6, Math.round(T.CAR_PROBE_SPREAD)))
  if (nextFace >= 0 && primed && origin.distanceTo(at) <= far) {
    captureFaces(renderer, scene, hide, nextFace, nextFace + perFrame)
    nextFace += perFrame
    if (nextFace >= 6) { nextFace = -1; capturedAt = performance.now() }
    return
  }
  if (!due) return
  if (!primed || origin.distanceTo(at) > far || perFrame >= 6) {
    nextFace = -1
    capture(renderer, scene, hide, at, T.CAR_PROBE_LIFT)
    return
  }
  // begin a spread refresh: the camera stands where the car is now for all six faces
  cubeCam!.position.set(at.x, at.y + T.CAR_PROBE_LIFT, at.z)
  cubeCam!.updateMatrixWorld(true)
  origin.copy(cubeCam!.position)
  carProbeOrigin.value.copy(origin)
  captureFaces(renderer, scene, hide, 0, perFrame)
  nextFace = perFrame >= 6 ? -1 : perFrame
  if (nextFace < 0) capturedAt = performance.now()
}
