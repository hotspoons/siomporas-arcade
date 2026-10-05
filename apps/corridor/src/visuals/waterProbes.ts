// Per-body water reflection probes.
//
// The sky reflection in waterReflect.ts knows no plane, so it works at any water height, but it
// also knows no TREES: `scene.environment` is the sky dome alone, so an inland lake mirrors a blue
// sheet and never the wood on its own bank (Rich, 2026-10-05: "this lake is kind of lame"). The one
// planar mirror in the scene cannot help either — there is one plane, at sea level, and a pond at
// another height projects through it onto somewhere else.
//
// A reflection probe is the honest answer: render the world once, into a cube, from the water
// itself, and read it back along the reflected ray. Whatever sits around THAT body — bank, trees,
// houses, the sun — lands in the reflection. It is per body because each body has its own
// surroundings, and it is automatic because the bodies are already in the manifest.
//
// How it is packed. The water is one merged MeshStandardMaterial per look, and a standard material
// is compiled as GLSL ES 1.00, so there is no `sampler2DArray` and no per-fragment sampler array.
// Instead every probe is an EQUIRECTANGULAR strip in one 2D texture laid side by side, so the shader
// needs exactly one texture unit and a plain `sampler2D`: `u = (probeIndex + equirectUv.x) / count`.
// A body knows its probe index from a baked `aProbe` attribute (all of a body's vertices carry the
// same one), and uncaptured strips are transparent, which is the "no probe yet" flag.
//
// Cost. Capturing a probe is six scene renders, so it is opt-in (`WATER_PROBES 0`), capped, and
// done lazily: only when the eye comes within `WATER_PROBE_REACH` of a body's shore, at most one
// body a frame, and clipped to `WATER_PROBE_FAR` so only the near world is drawn. A capture is
// cached and re-taken every `WATER_PROBE_REFRESH` seconds while near, so the reflection follows the
// light. With the knob at 0 — the default — this module builds nothing and renders nothing.
//
// WHICH bodies are live is decided by the EYE, not by a build-time ranking. `WATER_PROBES` is a
// budget of how many strips may hold a capture at once; each frame the NEAREST eligible body is
// taken, and it displaces a live body only if that one is farther away. So `WATER_PROBES 1` means
// "the lake I am standing at", which is what a person means when they turn it on — not "however
// many bodies the bake happened to rank first".
import * as THREE from 'three'
import * as T from '../tuning'

/**
 * The most bodies that can carry a probe; `aProbe` is baked against this and does not change. It
 * wants to be at least the number of inland bodies in the largest world (crofton has ~257), so that
 * the lake the eye is actually at is a candidate rather than whichever ones a build-time ranking
 * happened to favour. The atlas clamps its per-probe resolution to fit this many strips in one
 * texture (`ensureTargets`), so a high cap costs capture time and memory, not correctness.
 */
export const MAX_WATER_PROBES = 512

/** one inland body a probe can be placed at; built from the manifest by water.ts */
export interface WaterProbeBody {
  id: string
  /** world x of the body centre */
  x: number
  /** world y of the water surface */
  y: number
  /** world z of the body centre */
  z: number
  /** rough half-width (m), so "near" means near the shore, not the centroid */
  radius: number
}

/**
 * The atlas, one equirect strip per body, bound into every water shader. Starts as a 1×1 black
 * texel so the sampler is always complete even before any probe exists (or in the standalone water
 * demo, which never ticks this module).
 */
const dummyAtlas = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat)
dummyAtlas.needsUpdate = true
export const waterProbeAtlas = { value: dummyAtlas as THREE.Texture }
/** number of strips in use this frame; 0 disables sampling entirely */
export const waterProbeCount = { value: 0 }
/** how much a captured probe replaces the sky radiance, 0..1 */
export const waterProbeWeight = { value: T.WATER_PROBE_WEIGHT }

let bodies: WaterProbeBody[] = []
let waterGroup: THREE.Object3D | null = null

let atlas: THREE.WebGLRenderTarget | null = null
let cubeRT: THREE.WebGLCubeRenderTarget | null = null
let cubeCam: THREE.CubeCamera | null = null
/** what the current atlas/cube were built for, so a knob change rebuilds */
let built = { res: 0, count: 0, far: 0 }
/** the cube face actually allocated: `built.res`, clamped so count strips fit in one texture */
let atlasFace = 0
let lift = 1
/** body indices whose strip holds a real capture */
const ready = new Set<number>()
/** when each strip was last captured, ms */
const capturedAt = new Map<number, number>()

// the cube → equirect pass: a full-screen quad, one strip of the atlas per call
const convertScene = new THREE.Scene()
const convertCam = new THREE.Camera()
const convertMat = new THREE.ShaderMaterial({
  uniforms: { uCube: { value: null } },
  depthTest: false,
  depthWrite: false,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform samplerCube uCube;
    varying vec2 vUv;
    const float PI = 3.141592653589793;
    void main() {
      // the inverse of three's equirectUv: (u, v) back to a unit direction
      float lon = (vUv.x - 0.5) * 2.0 * PI;
      float lat = (vUv.y - 0.5) * PI;
      float cl = cos(lat);
      vec3 d = vec3(cl * cos(lon), sin(lat), cl * sin(lon));
      gl_FragColor = vec4(textureCube(uCube, d).rgb, 1.0);
    }
  `,
})
const convertQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), convertMat)
convertQuad.frustumCulled = false
convertScene.add(convertQuad)

/** Called once by buildWater with the chosen bodies and the water group to hide during a capture. */
export function registerWaterProbes(list: WaterProbeBody[], group: THREE.Object3D) {
  bodies = list
  waterGroup = group
  ready.clear()
  capturedAt.clear()
}

function disposeTargets() {
  atlas?.dispose()
  atlas = null
  cubeRT?.dispose()
  cubeRT = null
  cubeCam = null
  waterProbeAtlas.value = dummyAtlas
  waterProbeCount.value = 0
  ready.clear()
  capturedAt.clear()
  built = { res: 0, count: 0, far: 0 }
}

function ensureTargets(renderer: THREE.WebGLRenderer, count: number, res: number, far: number) {
  if (atlas && built.count === count && built.res === res && built.far === far) return
  disposeTargets()
  // one 2D strip per body, side by side: clamp the face so the whole atlas stays inside the driver's
  // texture limit. With a handful of bodies this is just `res`; with a hundred, the strip gets shorter
  // rather than the texture failing to allocate.
  const cap = renderer.capabilities.maxTextureSize
  const face = Math.max(8, Math.min(Math.round(res), Math.floor(cap / (2 * Math.max(1, count)))))
  atlasFace = face
  const eqW = face * 2
  atlas = new THREE.WebGLRenderTarget(eqW * count, face, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  })
  atlas.texture.colorSpace = THREE.NoColorSpace
  // zero every strip: an uncaptured body reads alpha 0, which is how the shader knows to keep the sky
  const prev = renderer.getRenderTarget()
  const prevColour = renderer.getClearColor(new THREE.Color())
  const prevAlpha = renderer.getClearAlpha()
  renderer.setClearColor(0x000000, 0)
  renderer.setRenderTarget(atlas)
  renderer.clear(true, false, false)
  renderer.setRenderTarget(prev)
  renderer.setClearColor(prevColour, prevAlpha)
  waterProbeAtlas.value = atlas.texture

  cubeRT = new THREE.WebGLCubeRenderTarget(face, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  })
  cubeRT.texture.colorSpace = THREE.NoColorSpace
  cubeCam = new THREE.CubeCamera(0.5, Math.max(20, far), cubeRT)
  built = { res, count, far }
}

/** Six scene renders from the body, converted in place into its strip of the atlas. */
function captureProbe(renderer: THREE.WebGLRenderer, scene: THREE.Scene, i: number) {
  if (!atlas || !cubeCam || !cubeRT) return
  const b = bodies[i]
  if (!b) return
  const wasVisible = waterGroup?.visible ?? false
  if (waterGroup) waterGroup.visible = false
  // shadows do not change between the six faces, and neither is the frame in XR
  const prevShadow = renderer.shadowMap.autoUpdate
  const prevXR = renderer.xr.enabled
  renderer.shadowMap.autoUpdate = false
  renderer.xr.enabled = false

  cubeCam.position.set(b.x, b.y + lift, b.z)
  cubeCam.updateMatrixWorld(true)
  cubeCam.update(renderer, scene)

  convertMat.uniforms.uCube.value = cubeRT.texture
  const prevTarget = renderer.getRenderTarget()
  const prevAuto = renderer.autoClear
  const eqW = atlasFace * 2
  // the quad spans the viewport, so the viewport IS the strip; no clear, or later strips would wipe
  renderer.autoClear = false
  renderer.setRenderTarget(atlas)
  renderer.setViewport(i * eqW, 0, eqW, atlasFace)
  renderer.render(convertScene, convertCam)
  renderer.setViewport(0, 0, atlas.width, atlas.height)
  renderer.autoClear = prevAuto
  renderer.setRenderTarget(prevTarget)

  renderer.shadowMap.autoUpdate = prevShadow
  renderer.xr.enabled = prevXR
  if (waterGroup) waterGroup.visible = wasVisible

  ready.add(i)
  capturedAt.set(i, performance.now())
}

/**
 * Capture or refresh at most one probe this frame. Call once a frame, before the main render, with
 * the frame's camera. A no-op — and free — while `WATER_PROBES` is 0 or the fancy water is off.
 */
export function tickWaterProbes(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
  // every candidate gets a strip, so any body the eye nears can be captured; the knob is the number
  // that may be LIVE at once, and the nearest wins the budget. A strip with alpha 0 is not live.
  const depth = Math.min(MAX_WATER_PROBES, bodies.length)
  const enabled = T.WATER_FANCY >= 0.5 && T.WATER_PROBES > 0 && depth > 0
  waterProbeCount.value = enabled ? depth : 0
  waterProbeWeight.value = Math.max(0, Math.min(1, T.WATER_PROBE_WEIGHT))
  if (!enabled) {
    if (atlas) disposeTargets()
    return
  }
  const far = Math.max(20, T.WATER_PROBE_FAR)
  ensureTargets(renderer, depth, Math.max(16, Math.round(T.WATER_PROBE_RES)), far)
  lift = T.WATER_PROBE_LIFT
  const budget = Math.max(1, Math.min(depth, Math.round(T.WATER_PROBES)))

  const now = performance.now()
  const refreshMs = T.WATER_PROBE_REFRESH > 0 ? T.WATER_PROBE_REFRESH * 1000 : Infinity
  const reach = T.WATER_PROBE_REACH
  let pick = -1
  let best = Infinity
  for (let i = 0; i < depth; i++) {
    const b = bodies[i]
    if (!b) continue
    const d = Math.hypot(b.x - camera.position.x, b.z - camera.position.z) - b.radius
    if (d > reach) continue
    const stale = !ready.has(i) || now - (capturedAt.get(i) ?? -Infinity) > refreshMs
    if (stale && d < best) {
      best = d
      pick = i
    }
  }
  if (pick < 0) return
  // a new body may only take a strip if the budget is free, or if a live body is FARTHER than the
  // one we want. Displacing only farther bodies is what stops two nearby lakes from trading the
  // strip every frame; the nearest budget's worth simply stays put.
  if (!ready.has(pick) && ready.size >= budget && !evictFartherThan(renderer, camera, best)) return
  captureProbe(renderer, scene, pick)
}

/** Free the strip of the farthest live body whose SHORE is farther than `d`, if any. True if freed. */
function evictFartherThan(renderer: THREE.WebGLRenderer, camera: THREE.Camera, d: number): boolean {
  let victim = -1
  let victimD = d
  for (const i of ready) {
    const b = bodies[i]
    if (!b) continue
    const dist = Math.hypot(b.x - camera.position.x, b.z - camera.position.z) - b.radius
    if (dist > victimD) {
      victimD = dist
      victim = i
    }
  }
  if (victim < 0) return false
  clearStrip(renderer, victim)
  ready.delete(victim)
  capturedAt.delete(victim)
  return true
}

/** Blank one strip back to alpha 0, which is the shader's "this body has no probe". */
function clearStrip(renderer: THREE.WebGLRenderer, i: number) {
  if (!atlas) return
  const eqW = atlasFace * 2
  const prevTarget = renderer.getRenderTarget()
  const prevColour = renderer.getClearColor(new THREE.Color())
  const prevAlpha = renderer.getClearAlpha()
  const prevScissor = renderer.getScissorTest()
  renderer.setClearColor(0x000000, 0)
  renderer.setRenderTarget(atlas)
  renderer.setScissorTest(true)
  renderer.setScissor(i * eqW, 0, eqW, atlasFace)
  renderer.clear(true, false, false)
  renderer.setScissorTest(prevScissor)
  renderer.setRenderTarget(prevTarget)
  renderer.setClearColor(prevColour, prevAlpha)
}
