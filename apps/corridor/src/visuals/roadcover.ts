// The road mesh is the pavement. Grass, trunk bark and the coarse terrain used to trust a station
// distance, and wherever that distance and the asphalt disagree a trunk or a triangle stands in
// the lane. This draws the pavement into a top-down mask and every one of those GROUND-LEVEL
// materials discards the fragments the mask covers, so the cut is the edge the road actually
// rendered.
//
// IT IS NOT FOR CANOPIES. A crown that reaches over the lane from a tree beside it is meant to be
// there; clipping the leaf and impostor materials punched a hole in the trees above every road.
// Only bark, trunk, grass, rocks and terrain take the mask now.
import * as THREE from 'three'

/** Half-width of the mask around the eye, metres. Past this, nothing is clipped. */
const HALF = 256
const TEX = 2048

/**
 * Shared by every clipped material. One write here updates the trees, the grass and the terrain
 * on the next frame, because they all hold these same uniform objects.
 */
export const roadClipUniforms = {
  uRoadCover: { value: null as THREE.Texture | null },
  uRoadViewProj: { value: new THREE.Matrix4() },
  uRoadCoverOn: { value: 0 },
  /**
   * How far ABOVE the pavement a fragment is still "on" it, metres.
   *
   * This is the difference between cutting the sliver of ground that pokes through asphalt and
   * DELETING THE LAND above a road. 80 m is the right answer for a tree: a crown that reaches over
   * the lane from the verge is a tree that should not be there, so the whole thing goes. It is the
   * wrong answer for the GROUND: a hill over an underpass, or a slope above a road, stands inside
   * that band and was being discarded too — the fine DEM disappeared, the coarse overview showed
   * through from below, and the world read as see-through (Rich, 2026-10-06). Terrain and grass
   * take the shared value below (a thin shell at the pavement); foliage passes its own wide ceiling
   * to `installRoadClip`. The grass shader splices `ROAD_CLIP_PARS` and spreads `roadClipUniforms`
   * itself, so this default is what keeps grass blades on a hillside too.
   */
  uRoadCoverCeil: { value: 2.5 as number },
}

/**
 * Declares the mask and the test. The sample is per fragment, so a terrain triangle that
 * straddles the kerb is cut on the road's edge rather than at its own vertices.
 *
 * The mask stores the LOWEST pavement height at that ground position (an overpass does not
 * erase the ground under it). A fragment is covered when it stands on that pavement: from just
 * below the asphalt up through a tree's crown.
 */
export const ROAD_CLIP_PARS = /* glsl */ `
uniform sampler2D uRoadCover;
uniform mat4 uRoadViewProj;
uniform float uRoadCoverOn;
uniform float uRoadCoverCeil;
bool roadCovered(vec3 world) {
  if (uRoadCoverOn < 0.5) return false;
  vec4 c = uRoadViewProj * vec4(world, 1.0);
  if (c.w <= 0.0) return false;
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return false;
  float s = texture2D(uRoadCover, uv).r;
  if (s > 9000.0) return false;
  float roadY = s - 2000.0;
  return world.y > roadY - 1.2 && world.y < roadY + uRoadCoverCeil;
}
`

const ROAD_VARYING = 'varying vec3 vRoadWorld;'
const ROAD_VERTEX = /* glsl */ `
{
  vec4 roadW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    roadW = instanceMatrix * roadW;
  #endif
  vRoadWorld = (modelMatrix * roadW).xyz;
}
`
const ROAD_DISCARD = 'if (roadCovered(vRoadWorld)) discard;'

/** Pavement, not paint and not the verge. The mask's edge is this mesh's edge. */
function isPavement(name: string): boolean {
  return name.startsWith('road:') && name !== 'road:markings'
}

/**
 * Chain the clip onto a three built-in material (terrain, bark, leaves, lollipops, rocks).
 * Custom shader materials splice {@link ROAD_CLIP_PARS} themselves and share {@link roadClipUniforms}.
 */
export function installRoadClip(mat: THREE.Material, ceil = 80): void {
  const ud = mat.userData as { roadClip?: boolean }
  if (ud.roadClip) return
  ud.roadClip = true
  const prev = mat.onBeforeCompile
  const prevKey = mat.customProgramCacheKey
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer)
    if (shader.fragmentShader.includes('uRoadCover')) return
    Object.assign(shader.uniforms, roadClipUniforms)
    // A ceiling of its own: the shared 80 is for foliage. Assigning a fresh object (not mutating
    // the shared one) keeps terrain at its tight band while trunks and crowns keep the wide one.
    shader.uniforms.uRoadCoverCeil = { value: ceil }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROAD_VARYING}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ROAD_VERTEX}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROAD_VARYING}\n${ROAD_CLIP_PARS}`)
      .replace('#include <clipping_planes_fragment>', `${ROAD_DISCARD}\n#include <clipping_planes_fragment>`)
  }
  mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}|roadclip|${ceil}`
}

/**
 * Orthographic pavement mask for the neighbourhood around the eye. Refreshed as the eye moves
 * and as new road meshes arrive. The main camera never sees this pass.
 */
export class RoadCover {
  private renderer: THREE.WebGLRenderer
  private target: THREE.WebGLRenderTarget
  private cam = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, 1, 2000)
  private mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
    // The camera looks down, so a larger depth is a lower road. GreaterEqual keeps that one
    // where a bridge and the street under it share a column.
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.GreaterEqualDepth,
    vertexShader: /* glsl */ `
      varying vec3 vCoverWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vCoverWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vCoverWorld;
      void main() {
        gl_FragColor = vec4(vCoverWorld.y + 2000.0, 0.0, 0.0, 1.0);
      }
    `,
  })
  private lastX = Number.NaN
  private lastZ = Number.NaN
  private lastCount = -1

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer
    this.target = new THREE.WebGLRenderTarget(TEX, TEX, {
      format: THREE.RedFormat,
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    })
    this.target.texture.generateMipmaps = false
    this.target.texture.colorSpace = THREE.NoColorSpace
    roadClipUniforms.uRoadCover.value = this.target.texture
  }

  /** Draw `root`'s pavement into the mask and publish the matrix the shaders project with. */
  refresh(root: THREE.Object3D, eye: THREE.Vector3): void {
    let count = 0
    root.traverse((o) => {
      if (o instanceof THREE.Mesh && isPavement(o.name)) count++
    })
    if (count === this.lastCount && Math.hypot(eye.x - this.lastX, eye.z - this.lastZ) < 8) return
    this.lastCount = count
    this.lastX = eye.x
    this.lastZ = eye.z
    if (!count) {
      roadClipUniforms.uRoadCoverOn.value = 0
      return
    }

    const hidden: THREE.Object3D[] = []
    const swapped: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = []
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      if (!isPavement(o.name)) {
        if (o.visible) {
          hidden.push(o)
          o.visible = false
        }
        return
      }
      swapped.push({ mesh: o, material: o.material })
      o.material = this.mat
    })

    this.cam.position.set(eye.x, eye.y + 250, eye.z)
    this.cam.up.set(0, 0, -1)
    this.cam.lookAt(eye.x, eye.y, eye.z)
    this.cam.updateProjectionMatrix()
    this.cam.updateMatrixWorld()

    const prevTarget = this.renderer.getRenderTarget()
    const prevAlpha = this.renderer.getClearAlpha()
    const prevColor = new THREE.Color()
    this.renderer.getClearColor(prevColor)
    const prevAuto = this.renderer.autoClear
    const prevShadow = this.renderer.shadowMap.autoUpdate
    const gl = this.renderer.getContext()
    try {
      this.renderer.shadowMap.autoUpdate = false
      this.renderer.autoClear = false
      this.renderer.setRenderTarget(this.target)
      // Depth clears to 0 so GreaterEqual keeps the farther (lower) pavement. Colour clears to
      // the empty sentinel. Three's own clear colour is 0..1, which cannot hold either value.
      gl.clearColor(9999, 0, 0, 1)
      gl.clearDepth(0)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.clearDepth(1)
      this.renderer.render(root, this.cam)
      roadClipUniforms.uRoadViewProj.value.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse)
      roadClipUniforms.uRoadCoverOn.value = 1
    } finally {
      this.renderer.setRenderTarget(prevTarget)
      this.renderer.setClearColor(prevColor, prevAlpha)
      this.renderer.autoClear = prevAuto
      this.renderer.shadowMap.autoUpdate = prevShadow
      for (const s of swapped) s.mesh.material = s.material
      for (const o of hidden) o.visible = true
    }
  }

  dispose(): void {
    this.target.dispose()
    this.mat.dispose()
    if (roadClipUniforms.uRoadCover.value === this.target.texture) {
      roadClipUniforms.uRoadCover.value = null
      roadClipUniforms.uRoadCoverOn.value = 0
    }
  }
}
