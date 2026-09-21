// Far trees as impostors: each procedural tree variant rendered once into an atlas at eight
// yaws, then every distant tree is a camera-facing quad showing the cell closest to its viewing
// angle. Two triangles a tree, tens of thousands of trees, and it is the SAME tree the near
// field shows up close — so the switch at the LOD boundary is a change of technique, not of
// species. This is what the coast game does for its roadside sprites, brought to the corridor.
import * as THREE from 'three'
import * as T from './tuning'

export interface ImpostorSource {
  branches: THREE.Mesh
  leaves: THREE.Mesh
  nativeHeight: number
}

const YAWS = 8
const TOP = YAWS // the extra column: straight down onto the crown
const COLS = YAWS + 1
const CELL = 256

export class Impostors {
  mesh: THREE.InstancedMesh
  private target: THREE.WebGLRenderTarget
  /** per variant: the world size of a square cell for a tree of nativeHeight */
  extents: number[] = []
  private aVariant: THREE.InstancedBufferAttribute
  private aYaw: THREE.InstancedBufferAttribute
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
    geo.setAttribute('aVariant', this.aVariant)
    geo.setAttribute('aYaw', this.aYaw)
    this.material = new THREE.ShaderMaterial({
      // merge() clones uniform values and cannot clone a render-target texture (it silently becomes
      // null and every quad is discarded); the atlas is attached after the merge instead
      uniforms: { ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { cols: { value: COLS }, yaws: { value: YAWS }, rows: { value: rows }, flatPitch: { value: T.IMPOSTOR_FLAT_PITCH } }]), atlas: { value: this.target.texture } },
      vertexShader: /* glsl */ `
        attribute float aVariant;
        attribute float aYaw;
        uniform float cols;
        uniform float yaws;
        uniform float rows;
        uniform float flatPitch;
        varying vec2 vUv;
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        void main() {
          // instance origin and scale
          vec4 origin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = length(vec3(instanceMatrix[0].x, instanceMatrix[0].y, instanceMatrix[0].z));
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
          vUv = vec2((k + uv.x) / cols, (aVariant + uv.y) / rows);
          vec4 mvPosition = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D atlas;
        varying vec2 vUv;
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec4 c = texture2D(atlas, vUv);
          if (c.a < 0.5) discard;
          gl_FragColor = vec4(c.rgb, 1.0);
          #include <fog_fragment>
          #include <colorspace_fragment>
        }
      `,
      fog: !!fog,
      transparent: false,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity)
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
    renderer.setRenderTarget(this.target)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.setScissorTest(true)
    sources.forEach((src, row) => {
      const group = new THREE.Group()
      group.add(new THREE.Mesh(src.branches.geometry, src.branches.material), new THREE.Mesh(src.leaves.geometry, src.leaves.material))
      scene.add(group)
      const box = new THREE.Box3().setFromObject(group)
      const w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z)
      const e = Math.max(box.max.y, w) * 1.04
      this.extents[row] = e / src.nativeHeight
      const cam = new THREE.OrthographicCamera(-e / 2, e / 2, e, 0, 0.1, e * 4)
      for (let k = 0; k < YAWS; k++) {
        group.rotation.y = (k / YAWS) * Math.PI * 2
        cam.position.set(0, 0, e * 2)
        cam.lookAt(0, 0, 0)
        cam.position.y = 0
        // look horizontally: the ortho frustum's vertical range [0, e] is set above
        cam.updateProjectionMatrix()
        renderer.setViewport(k * CELL, row * CELL, CELL, CELL)
        renderer.setScissor(k * CELL, row * CELL, CELL, CELL)
        renderer.render(scene, cam)
      }
      // the top cell: straight down, square e×e centred on the trunk
      group.rotation.y = 0
      const top = new THREE.OrthographicCamera(-e / 2, e / 2, e / 2, -e / 2, 0.1, e * 4)
      top.position.set(0, e * 2, 0)
      top.up.set(0, 0, -1)
      top.lookAt(0, 0, 0)
      top.updateProjectionMatrix()
      renderer.setViewport(TOP * CELL, row * CELL, CELL, CELL)
      renderer.setScissor(TOP * CELL, row * CELL, CELL, CELL)
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
  tick() {
    this.material.uniforms.flatPitch.value = T.IMPOSTOR_FLAT_PITCH
  }

  commit(count: number) {
    this.mesh.count = count
    this.mesh.instanceMatrix.needsUpdate = true
    this.aVariant.needsUpdate = true
    this.aYaw.needsUpdate = true
  }

  /**
   * Hide or show ONE instance without touching the others: the scale column is zeroed (a
   * degenerate quad draws nothing) or restored from the recorded size, and only that 16-float
   * range is uploaded. Rewriting all 35k matrices every 15 m of travel was a one-second stall
   * on a phone; this is a few hundred tiny ranges.
   */
  setVisible(i: number, on: boolean, size: number) {
    const a = this.mesh.instanceMatrix.array as Float32Array
    const s = on ? size : 0
    a[i * 16] = s
    a[i * 16 + 5] = s
    a[i * 16 + 10] = s
    this.mesh.instanceMatrix.addUpdateRange(i * 16, 16)
    this.mesh.instanceMatrix.needsUpdate = true
  }

  clearRanges() {
    this.mesh.instanceMatrix.clearUpdateRanges()
  }
}
