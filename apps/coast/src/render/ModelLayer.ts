// The real meshes, instead of the sprites baked from them. Two ways, both off by default:
//
//   MODELS_3D = 1  posed — every quad swapped for its mesh, in the same screen-space scene, at the
//                  same size, in the pose the sprite was baked in. Sharper sprites and nothing else:
//                  a car still steps between baked steering angles, a tree is still seen head-on.
//
//   MODELS_3D = 2  solid — a real perspective pass over the top. Nothing is posed: every model sits
//                  at its actual place in front of the camera and is seen from wherever the camera
//                  happens to be, so a car turning sweeps continuously through the angles instead of
//                  stepping between sixteen of them, and a tree beside the road is seen from the
//                  side because it *is* beside the road.
//
// The second one works because this game's projection is an honest pinhole: scale = camDepth / z, and
// screen = centre + camera-relative × scale. That is exactly a perspective camera of the same field
// of view sitting at the origin, so a sprite's screen position and its scale inverts straight back
// into the camera-space point it came from — curve offsets, hills and banking included, because
// those are already in the numbers the sprite pass worked out. The road is still trapezoids; only
// what stands on it is real.
//
// What that does not get for free is the road hiding things: the pseudo-3D road paints in screen
// space and writes no depth. So this pass lays the road surface down as a depth-only proxy first,
// rebuilt from the same rows, and a car over the next crest goes behind the hill like it should.

import { AmbientLight, Box3, BufferAttribute, BufferGeometry, DirectionalLight, Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { MODELS, type ModelDef } from './models'

const DEG = Math.PI / 180
/** Half the ortho camera's z range, shared out among the posed meshes in a frame. */
const Z_RANGE = 30000
/** How wide the depth proxy is either side of the road centre, in metres. */
const GROUND_HALF = 90

/**
 * The bake's normalisation, so a mesh here is the size the sprite of it would have been: scaled to
 * the manifest's height in metres, standing on y = 0, centred over its own footprint.
 */
function normalise(model: Object3D, def: ModelDef): Object3D {
  model.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const sm = mat as MeshStandardMaterial
      if (sm.isMeshStandardMaterial) {
        sm.flatShading = true
        sm.metalness = Math.min(sm.metalness, 0.2)
        sm.needsUpdate = true
      }
    }
  })
  const box = new Box3().setFromObject(model)
  const size = box.getSize(new Vector3())
  const scale = (def.heightM / Math.max(1e-3, size.y)) * (def.fit ?? 1)
  model.scale.setScalar(scale)
  model.position.set(-((box.min.x + box.max.x) / 2) * scale, -box.min.y * scale, -((box.min.z + box.max.z) / 2) * scale)
  // A wrapper, so instances can be posed without disturbing the fit.
  const holder = new Group()
  holder.add(model)
  return holder
}

export class ModelLayer {
  /** Posed meshes: they live in the game's own screen-space scene, alongside the sprites. */
  readonly group = new Group()
  /** Solid meshes: a real camera, drawn as a second pass into the style's buffer. */
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(45, 1.78, 0.4, 6000)
  /** One prototype per kind; instances clone it and share its geometry and materials. */
  private readonly protos = new Map<string, Object3D>()
  private readonly pools = new Map<string, Object3D[]>()
  private readonly cursor = new Map<string, number>()
  private readonly ground: Mesh
  private groundVerts = new Float32Array(0)
  private z = 0
  private screenW = 800
  private screenH = 448
  ready = false
  private loading = false

  constructor() {
    // The bake's lights in both scenes, so a mesh is shaded the way its sprite was.
    for (const parent of [this.group, this.scene]) {
      const sun = new DirectionalLight(0xffffff, 1.6)
      sun.position.set(3, 6, 4)
      parent.add(new AmbientLight(0xffffff, 0.35), new HemisphereLight(0xffffff, 0x8080a0, 0.7), sun)
    }
    this.group.visible = false
    // Depth only: it exists so hills and the road's own crest can hide what is behind them.
    this.ground = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ colorWrite: false }))
    this.ground.frustumCulled = false
    this.ground.renderOrder = -1
    this.scene.add(this.ground)
  }

  /**
   * Load every model in the manifest. The atlas throws its copies away once they are baked — and when
   * the atlas comes back from the browser's cache it never loads any at all — so this is a second,
   * deliberate load, paid for only by someone who asks for it.
   */
  async load(): Promise<void> {
    if (this.ready || this.loading) return
    this.loading = true
    const loader = new GLTFLoader()
    for (const def of MODELS) {
      try {
        const model = def.file ? (await loader.loadAsync(def.file)).scene : def.build?.()
        if (model) this.protos.set(def.kind, normalise(model, def))
      } catch (err) {
        console.warn(`3D models: ${def.kind} would not load; it keeps its sprite`, err)
      }
    }
    this.loading = false
    this.ready = true
  }

  /** The logical screen and the field of view this frame is drawn with. */
  begin(w: number, h: number, fovDeg: number): void {
    this.cursor.clear()
    this.screenW = w
    this.screenH = h
    if (this.camera.fov !== fovDeg || this.camera.aspect !== w / h) {
      this.camera.fov = fovDeg
      this.camera.aspect = w / Math.max(1, h)
      this.camera.updateProjectionMatrix()
    }
    // Ordering for the posed pass is by depth: each mesh gets a slab of the ortho camera's z range
    // roughly as deep as its own geometry, handed out in the order the sprite pass draws — far first.
    this.z = -Z_RANGE
  }

  private instance(kind: string, solid: boolean): Object3D | null {
    const proto = this.protos.get(kind)
    if (!proto) return null
    const key = solid ? `s:${kind}` : `f:${kind}`
    let pool = this.pools.get(key)
    if (!pool) {
      pool = []
      this.pools.set(key, pool)
    }
    const i = this.cursor.get(key) ?? 0
    this.cursor.set(key, i + 1)
    let obj = pool[i]
    if (!obj) {
      obj = proto.clone()
      obj.userData.kind = kind
      // Over the road and the sprites, like a sprite would be. renderOrder does not reach a group's
      // children, so leaving it at zero paints every mesh *under* the road it is standing on.
      if (!solid) obj.traverse((o) => (o.renderOrder = 6))
      pool.push(obj)
      ;(solid ? this.scene : this.group).add(obj)
    }
    obj.visible = true
    return obj
  }

  /**
   * Posed: put the mesh where its sprite would have been drawn — ground contact at screen (`x`, `y`),
   * the frame `h` pixels tall, seen from `yawDeg` / `pitchDeg`, leaning by `roll`. Returns false when
   * this kind has no mesh, so the caller can draw the sprite instead.
   */
  addPosed(kind: string, x: number, y: number, h: number, frame: { heightM: number; nearMag?: number }, yawDeg: number, pitchDeg: number, roll: number): boolean {
    if (h <= 0) return false
    // The near field is where this stops being a comparison. A sprite whose quad is four screens tall
    // and half a screen off the side costs nothing and shows a sliver of trunk; the same thing as
    // geometry is a mesh the size of a stadium leaning over the road, and it eats the whole z range
    // the rest of the frame has to share. Those keep their sprites.
    if (h > this.screenH * 2.5 || x < -this.screenW || x > this.screenW * 2) return false
    const obj = this.instance(kind, false)
    if (!obj) return false
    // Sized as the sprite is: pixels to the metre at the frame's centre plane, times half the lens
    // magnification — the sprite's near end is `nearMag` bigger than its far end, and a flat mesh can
    // only pick one number out of that gradient. The middle of it is what matches by eye.
    const mag = 1 + ((frame.nearMag ?? 1) - 1) * 0.5
    obj.scale.setScalar((h / Math.max(1e-3, frame.heightM)) * mag)
    // Yaw turns the mesh to face the way the bake camera stood (which is behind the car, hence the
    // half turn); pitch tips it towards the viewer the way a camera above the road sees it; roll is
    // the bank. Applied in that order, in world space, about the ground contact.
    obj.rotation.order = 'ZXY'
    obj.rotation.set(pitchDeg * DEG, (yawDeg + 180) * DEG, roll)
    this.z += Math.min(h * 1.2 + 3, 240)
    obj.position.set(x, y, this.z)
    return true
  }

  /**
   * Solid: put the mesh at the camera-relative point its sprite was standing on. `sx`/`sy` are where
   * the sprite pass put its ground contact and `scale` is the pixels-to-the-metre it drew it at,
   * which together invert to a place in front of the camera. `headingDeg` is the model's own heading,
   * not a viewing angle — which way it is seen from falls out of where it is.
   */
  addSolid(kind: string, sx: number, sy: number, scale: number, size: number, headingDeg: number, roll: number): boolean {
    if (scale <= 1e-4) return false
    const obj = this.instance(kind, true)
    if (!obj) return false
    const camDepth = 1 / Math.tan(this.camera.fov * 0.5 * DEG)
    const cz = (camDepth * (this.screenH / 2)) / scale
    obj.position.set((sx - this.screenW / 2) / scale, (sy - this.screenH / 2) / scale, -cz)
    obj.scale.setScalar(size)
    obj.rotation.order = 'ZYX'
    obj.rotation.set(0, headingDeg * DEG, roll)
    return true
  }

  /**
   * The depth-only road surface, from the same rows the road was drawn from: screen x, screen y and
   * pixels-to-the-metre per row, inverted back into camera space. Wide enough to stand in for the
   * ground either side, which is what actually hides a tree over a crest.
   */
  setGround(rowX: ArrayLike<number>, rowY: ArrayLike<number>, rowScale: ArrayLike<number>, rows: number): void {
    const quads = Math.max(0, rows - 1)
    const need = quads * 6 * 3
    if (this.groundVerts.length !== need) {
      this.groundVerts = new Float32Array(need)
      this.ground.geometry.setAttribute('position', new BufferAttribute(this.groundVerts, 3))
    }
    const p = this.groundVerts
    const camDepth = 1 / Math.tan(this.camera.fov * 0.5 * DEG)
    let v = 0
    const put = (n: number, side: number): void => {
      const s = Math.max(1e-4, rowScale[n])
      p[v++] = (rowX[n] - this.screenW / 2) / s + side * GROUND_HALF
      p[v++] = (rowY[n] - this.screenH / 2) / s
      p[v++] = -((camDepth * (this.screenH / 2)) / s)
    }
    for (let n = 0; n < quads; n++) {
      put(n, -1)
      put(n, 1)
      put(n + 1, -1)
      put(n + 1, -1)
      put(n, 1)
      put(n + 1, 1)
    }
    ;(this.ground.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true
    this.ground.geometry.setDrawRange(0, quads * 6)
  }

  end(): void {
    for (const [key, pool] of this.pools) {
      const used = this.cursor.get(key) ?? 0
      for (let i = used; i < pool.length; i++) pool[i].visible = false
    }
  }

  /** The solid pass, into whatever the style is drawing into: its depth buffer, our geometry. */
  render(renderer: WebGLRenderer): void {
    const prevClear = renderer.autoClear
    renderer.autoClear = false
    renderer.render(this.scene, this.camera)
    renderer.autoClear = prevClear
  }
}
