// Far trees as impostors: each procedural tree variant rendered once into an atlas at eight
// yaws, then every distant tree is a camera-facing quad showing the cell closest to its viewing
// angle. Two triangles a tree, tens of thousands of trees, and it is the SAME tree the near
// field shows up close — so the switch at the LOD boundary is a change of technique, not of
// species. This is what the coast game does for its roadside sprites, brought to the corridor.
import * as THREE from 'three'
import { LAMP_PARS, retro } from '../visuals/retro'
import { SPLAT_MASK_PARS, splatMaskUniforms } from '../visuals/splatmask'
import * as T from '../tuning'
import { Uploads } from '../assets/uploads'

export interface ImpostorSource {
  branches: THREE.Mesh
  leaves: THREE.Mesh
  nativeHeight: number
}

const YAWS = 8
const TOP = YAWS // the extra column: straight down onto the crown
const COLS = YAWS + 1
const CELL = 256
/**
 * Texels of transparent gutter around every cell.
 *
 * The atlas is filtered (linear, mipmapped), so a card sampling the very edge of a cell could
 * otherwise take in the neighbouring cell — the row above being a tree's flat-topped trunk base.
 * The gutter keeps the nearest opaque neighbour a margin away. (The "floating trunks" themselves
 * were the bake drawing each cell at the device pixel ratio's stride — see `bake`.)
 */
const PAD = 16


export class Impostors {
  mesh: THREE.InstancedMesh
  private target: THREE.WebGLRenderTarget
  /** per variant: the world size of a square cell for a tree of nativeHeight */
  extents: number[] = []
  private aVariant: THREE.InstancedBufferAttribute
  private aYaw: THREE.InstancedBufferAttribute
  /** 1 = solid, 0 = gone: a dither dissolve so a card does not pop when the model takes over */
  private aFade: THREE.InstancedBufferAttribute
  /**
   * What still has to reach the GPU, per attribute.
   *
   * The instance matrix and the fade are written both wholesale (a re-seat) and one slot at a time
   * (a card hidden, a card dissolving), and three treats those two as different kinds of upload.
   * Mixing them loses writes silently — see uploads.ts for which sequences and what they look like.
   */
  private matrixUploads = new Uploads()
  private fadeUploads = new Uploads()
  private material: THREE.ShaderMaterial

  private renderer: THREE.WebGLRenderer

  constructor(renderer: THREE.WebGLRenderer, sources: ImpostorSource[], capacity: number, fog: THREE.FogExp2 | null) {
    this.renderer = renderer
    const rows = sources.length
    this.target = new THREE.WebGLRenderTarget(CELL * COLS, CELL * rows, { format: THREE.RGBAFormat, colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter })
    this.bake(renderer, sources)

    const geo = new THREE.PlaneGeometry(1, 1)
    geo.translate(0, 0.5, 0) // anchored at the foot
    this.aVariant = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    this.aYaw = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    this.aFade = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1)
    geo.setAttribute('aVariant', this.aVariant)
    geo.setAttribute('aYaw', this.aYaw)
    geo.setAttribute('aFade', this.aFade)
    this.material = new THREE.ShaderMaterial({
      // merge() clones uniform values and cannot clone a render-target texture (it silently becomes
      // null and every quad is discarded); the atlas is attached after the merge instead
      uniforms: { ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { cols: { value: COLS }, yaws: { value: YAWS }, rows: { value: rows }, flatPitch: { value: T.IMPOSTOR_FLAT_PITCH }, uAtlasPad: { value: PAD / CELL }, uAtlasInner: { value: (CELL - 2 * PAD) / CELL } }]), atlas: { value: this.target.texture }, uLight: { value: 1 }, uLightTint: { value: new THREE.Color(1, 1, 1) }, uMatch: { value: 1.65 }, uHue: { value: 0 }, uSat: { value: 1 }, ...retro.uniforms, uLampGain: { value: 1 }, ...splatMaskUniforms() },
      vertexShader: /* glsl */ `
        attribute float aVariant;
        attribute float aYaw;
        attribute float aFade;
        varying float vFade;
        varying vec3 vCardWorld;
        uniform float cols;
        uniform float yaws;
        uniform float rows;
        uniform float flatPitch;
        uniform float uAtlasPad;
        uniform float uAtlasInner;
        varying vec2 vUv;
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        void main() {
          vFade = aFade;
          // instance origin and scale
          vec4 origin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = length(vec3(instanceMatrix[0].x, instanceMatrix[0].y, instanceMatrix[0].z));
          // a hidden card (near-set handover, or a spare tree past the draw radius) is on the GPU
          // and not drawn. The instance is still visited; this sends it off-screen before the
          // billboard work.
          if (s < 1e-4) {
            vUv = vec2(0.0);
            vCardWorld = origin.xyz;
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          vec3 toCam = cameraPosition - origin.xyz;
          float ang = atan(toCam.x, toCam.z);
          float pitch = atan(toCam.y, length(toCam.xz)); // 0 = level with the tree, pi/2 = overhead
          vec3 right = normalize(vec3(cos(ang), 0.0, -sin(ang)));
          vec3 world;
          float k;
          if (pitch > flatPitch) {
            // steep view: a vertical card would fan out over everything behind it (the road,
            // seen from a hill, vanished under canopy). Lay the card FLAT at crown height and
            // show the top-down cell instead.
            vec3 fwd = normalize(vec3(-sin(ang), 0.0, -cos(ang)));
            world = origin.xyz + vec3(0.0, s * 0.62, 0.0) + right * position.x * s + fwd * (position.y - 0.5) * s;
            k = yaws;
          } else {
            world = origin.xyz + right * position.x * s + vec3(0.0, position.y * s, 0.0);
            float rel = ang - aYaw;
            k = mod(floor(rel / 6.2831853 * yaws + 0.5), yaws);
          }
          vUv = vec2((k + uAtlasPad + uv.x * uAtlasInner) / cols, (aVariant + uAtlasPad + uv.y * uAtlasInner) / rows);
          vCardWorld = world;
          vec4 mvPosition = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D atlas;
        // The atlas was baked under a fixed studio light, so without this a far tree GLOWS at
        // night while everything lit by the scene goes dark (Rich, 2026-09-26). uLight is the
        // scene's own day/night level and uLightTint its colour, so a card dims and cools with
        // everything else.
        uniform float uLight;
        uniform vec3 uLightTint;
        // The atlas is baked under a dimmer sun than the live trees get, so a card of the same
        // tree reads dark beside the mesh. uMatch is that gap, and only the cards see it.
        uniform float uMatch;
        uniform float uHue;
        uniform float uSat;
        varying vec2 vUv;
        varying float vFade;
        varying vec3 vCardWorld;
        ${LAMP_PARS}
        ${SPLAT_MASK_PARS}
        uniform float uLampGain;
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        void main() {
          // no road clip: an impostor is a whole tree, mostly canopy, and a far tree leaning over
          // the lane is the roadside picture. Only trunks and ground carry the mask.
          splatDissolve(vCardWorld);
          #include <logdepthbuf_fragment>
          vec4 c = texture2D(atlas, vUv);
          // DITHER, not alpha blending. This material is alpha-TESTED and opaque -- see
          // transparent:false on the material and the discard below -- because 35k camera-facing
          // quads cannot be depth-sorted against each other at any sensible cost. A card
          // therefore dissolves by
          // discarding a growing share of its pixels instead of going translucent: no blending,
          // no sort, no change to the render pass. The R2 low-discrepancy sequence gives a
          // stable, well-spread pattern per screen pixel in one dot product.
          float dith = fract(dot(gl_FragCoord.xy, vec2(0.75487766, 0.56984029)));
          if (c.a < 0.5 || vFade <= dith) discard;
          // brightness, hue and colour gain are the panel's, so a card can be matched to the
          // model beside it without rebaking the atlas
          float ha = radians(uHue);
          vec3 yiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c.rgb;
          float hc = cos(ha), hs = sin(ha);
          yiq.yz = vec2(yiq.y * hc - yiq.z * hs, yiq.y * hs + yiq.z * hc);
          vec3 graded = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * yiq;
          graded = mix(vec3(dot(graded, vec3(0.299, 0.587, 0.114))), graded, uSat) * uMatch;
          vec3 lamp = c.rgb * lampDiffuse(vCardWorld, normalize(cameraPosition - vCardWorld), uLampGain);
          gl_FragColor = vec4(graded * uLight * uLightTint + lamp, 1.0);
          #include <fog_fragment>
          #include <colorspace_fragment>
        }
      `,
      fog: !!fog,
      transparent: false,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity)
    /*
     * THREE'S OWN SIGNAL THAT THE UPLOAD HAPPENED, and the only correct one.
     *
     * Not the frame loop: the renderer uploads an attribute when it next DRAWS it, which is not
     * every frame — a frame that culls this mesh uploads nothing, and clearing the pending set on
     * a timer throws away writes that were never sent. `onUpload` fires after `bufferSubData`.
     */
    this.mesh.instanceMatrix.onUpload(() => this.matrixUploads.uploaded())
    this.aFade.onUpload(() => this.fadeUploads.uploaded())
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.name = 'impostors'
  }

  /** Re-render the atlas (after a season change recolours the leaves). */
  rebake(sources: ImpostorSource[]) {
    this.bake(this.renderer, sources)
  }

  /** Render every variant at every yaw into the atlas, lit like the scene. */
  private bake(renderer: THREE.WebGLRenderer, sources: ImpostorSource[]) {
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x5a5040, 0.9))
    const sun = new THREE.DirectionalLight(0xfff2dc, 1.6)
    sun.position.set(-3, 4, 2.5)
    scene.add(sun)
    const prevTarget = renderer.getRenderTarget()
    const prevClear = new THREE.Color()
    renderer.getClearColor(prevClear)
    const prevAlpha = renderer.getClearAlpha()
    const prevViewport = renderer.getViewport(new THREE.Vector4())
    const prevScissor = renderer.getScissor(new THREE.Vector4())
    const prevScissorTest = renderer.getScissorTest()
    // `setViewport` is in CSS pixels and three scales it by the device pixel ratio, but the atlas
    // is sized in texels. On a 1.25-DPR display every cell was drawn at 320 texels on a 320-texel
    // stride while the card shader samples 256-texel cells: rows and columns drifted, so a card's
    // top took in the previous row's flat trunk base — the bare "floating trunk" above the canopy.
    // Hand three CSS pixels that scale back to the texel rect we actually want.
    const dpr = renderer.getPixelRatio()
    renderer.setRenderTarget(this.target)
    // Clear the WHOLE atlas, not just whatever viewport the renderer was left with. A rebake (a
    // season change recolours the leaves) used to clear only the live view's corner, so the
    // previous bake's trees survived in the rest of the target and a card sampled a stale trunk
    // floating in empty sky (Rich, 2026-10-05). Point viewport and scissor at the target first.
    renderer.setViewport(0, 0, this.target.width / dpr, this.target.height / dpr)
    renderer.setScissor(0, 0, this.target.width / dpr, this.target.height / dpr)
    renderer.setScissorTest(true)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    sources.forEach((src, row) => {
      const group = new THREE.Group()
      group.add(new THREE.Mesh(src.branches.geometry, src.branches.material), new THREE.Mesh(src.leaves.geometry, src.leaves.material))
      scene.add(group)
      const box = new THREE.Box3().setFromObject(group)
      const w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z)
      const e = Math.max(box.max.y, w) * 1.04
      this.extents[row] = e / src.nativeHeight
      // one cell is `e` world units across, drawn into CELL - 2*PAD texels, so the gutter is this
      // many world units; the tree still spans [0, e] and the card maps uv to that inner band
      const pad = (e * PAD) / (CELL - 2 * PAD)
      const span = e + 2 * pad
      const cam = new THREE.OrthographicCamera(-e / 2 - pad, e / 2 + pad, e + pad, -pad, 0.1, span * 4)
      for (let k = 0; k < YAWS; k++) {
        group.rotation.y = (k / YAWS) * Math.PI * 2
        cam.position.set(0, 0, e * 2)
        cam.lookAt(0, 0, 0)
        cam.position.y = 0
        // look horizontally: the tree's range [0, e] sits inside the gutter in the frustum above
        cam.updateProjectionMatrix()
        renderer.setViewport(k * CELL / dpr, row * CELL / dpr, CELL / dpr, CELL / dpr)
        renderer.setScissor(k * CELL / dpr, row * CELL / dpr, CELL / dpr, CELL / dpr)
        renderer.render(scene, cam)
      }
      // the top cell: straight down, square e×e centred on the trunk
      group.rotation.y = 0
      const top = new THREE.OrthographicCamera(-e / 2 - pad, e / 2 + pad, e / 2 + pad, -e / 2 - pad, 0.1, span * 4)
      top.position.set(0, e * 2, 0)
      top.up.set(0, 0, -1)
      top.lookAt(0, 0, 0)
      top.updateProjectionMatrix()
      renderer.setViewport(TOP * CELL / dpr, row * CELL / dpr, CELL / dpr, CELL / dpr)
      renderer.setScissor(TOP * CELL / dpr, row * CELL / dpr, CELL / dpr, CELL / dpr)
      renderer.render(scene, top)
      scene.remove(group)
    })
    // put the renderer back exactly as found: a viewport left at the last atlas cell renders the
    // whole scene into a 256 px corner and the page looks empty
    renderer.setRenderTarget(prevTarget)
    renderer.setViewport(prevViewport)
    renderer.setScissor(prevScissor)
    renderer.setScissorTest(prevScissorTest)
    renderer.setClearColor(prevClear, prevAlpha)
  }

  /**
   * Place instance i and upload only that matrix.
   *
   * Not for a frame that also `commit`s: a range registered beside a full upload makes three send
   * only the range. Call `set` and then `commit` when the whole buffer should go.
   */
  place(i: number, x: number, y: number, z: number, h: number, variant: number, yaw: number, m: THREE.Matrix4) {
    this.set(i, x, y, z, h, variant, yaw, m)
    const start = i * 16
    this.matrixUploads.mark(start, 16)
    if (this.matrixUploads.shouldRegister()) this.mesh.instanceMatrix.addUpdateRange(start, 16)
    this.mesh.instanceMatrix.needsUpdate = true
    this.aVariant.needsUpdate = true
    this.aYaw.needsUpdate = true
  }

  /** Place instance i: a tree of height h at (x, ground y, z) drawn as variant v with base yaw. */
  set(i: number, x: number, y: number, z: number, h: number, variant: number, yaw: number, m: THREE.Matrix4) {
    const s = h * this.extents[variant]
    m.makeScale(s, s, s)
    m.setPosition(x, y, z)
    this.mesh.setMatrixAt(i, m)
    this.aVariant.setX(i, variant)
    this.aYaw.setX(i, yaw)
  }

  /** Push the current knob values into the shader. */
  /** the scene's day/night light level and its colour; the atlas was baked under a fixed light */
  setLight(level: number, tint: THREE.Color) {
    this.material.uniforms.uLight.value = level
    ;(this.material.uniforms.uLightTint.value as THREE.Color).copy(tint)
  }

  tick() {
    this.material.uniforms.flatPitch.value = T.IMPOSTOR_FLAT_PITCH
    this.material.uniforms.uMatch.value = T.IMPOSTOR_LIGHT
    this.material.uniforms.uHue.value = T.IMPOSTOR_HUE
    this.material.uniforms.uSat.value = T.IMPOSTOR_COLOR
    this.material.uniforms.uLampGain.value = T.HEADLIGHT_BOUNCE
  }

  /** The baked atlas, so a shadow card can cast the same silhouette. */
  get atlas(): THREE.Texture {
    return this.target.texture
  }

  variantAt(i: number): number {
    return this.aVariant.getX(i)
  }

  yawAt(i: number): number {
    return this.aYaw.getX(i)
  }

  extentAt(variant: number): number {
    return this.extents[variant] ?? 1
  }

  get rows(): number {
    return Math.max(1, this.extents.length)
  }

  /**
   * A full rewrite has just happened: every matrix, every variant, every yaw.
   *
   * `markAll` matters as much as `needsUpdate` does. To three, a non-empty update-range list means
   * "send only these", so a ranged write registered after this would demote the whole rewrite to a
   * partial upload and the rest of it would never arrive — see uploads.ts.
   */
  commit(count: number) {
    this.mesh.count = count
    // ranges registered earlier this frame would demote this rewrite to a partial upload
    this.mesh.instanceMatrix.clearUpdateRanges()
    this.aFade.clearUpdateRanges()
    this.aVariant.clearUpdateRanges()
    this.aYaw.clearUpdateRanges()
    this.matrixUploads.markAll()
    this.fadeUploads.markAll()
    this.mesh.instanceMatrix.needsUpdate = true
    this.aFade.needsUpdate = true
    this.aVariant.needsUpdate = true
    this.aYaw.needsUpdate = true
  }

  /**
   * Hide or show ONE instance without touching the others: the scale column is zeroed (a
   * degenerate quad draws nothing) or restored from the recorded size, and only that 16-float
   * range is uploaded. Rewriting all 35k matrices every 15 m of travel was a one-second stall
   * on a phone; this is a few hundred tiny ranges.
   */
  /**
   * How solid instance `i` is, 0..1. One float written, not sixteen — this is cheaper than the
   * matrix write `setVisible` does, which matters because the fade band is re-evaluated every
   * time the near set moves.
   */
  setFade(i: number, f: number) {
    const a = this.aFade.array as Float32Array
    if (a[i] === f) return
    a[i] = f
    this.fadeUploads.mark(i, 1)
    if (this.fadeUploads.shouldRegister()) this.aFade.addUpdateRange(i, 1)
    this.aFade.needsUpdate = true
  }

  setVisible(i: number, on: boolean, size: number) {
    const a = this.mesh.instanceMatrix.array as Float32Array
    const s = on ? size : 0
    a[i * 16] = s
    a[i * 16 + 5] = s
    a[i * 16 + 10] = s
    this.matrixUploads.mark(i * 16, 16)
    if (this.matrixUploads.shouldRegister()) this.mesh.instanceMatrix.addUpdateRange(i * 16, 16)
    this.mesh.instanceMatrix.needsUpdate = true
  }

  /** What is still pending, for a probe: the bug it exists for is invisible from the CPU array. */
  uploadState() {
    return {
      matrixAll: this.matrixUploads.pendingAll,
      matrixRanges: this.matrixUploads.pendingRanges.length,
      fadeAll: this.fadeUploads.pendingAll,
      fadeRanges: this.fadeUploads.pendingRanges.length,
      // the pair that matters: if `sent` ever lags `marked`, a write never reached the GPU
      matrixMarked: this.matrixUploads.marked,
      matrixSent: this.matrixUploads.sent,
      fadeMarked: this.fadeUploads.marked,
      fadeSent: this.fadeUploads.sent,
    }
  }
}
