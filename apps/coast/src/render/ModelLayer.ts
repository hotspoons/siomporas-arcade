// The real meshes, instead of the sprites baked from them. Two ways, both off by default:
//
//   MODELS_3D = 1  live — the sprite, re-baked this frame instead of looked up. Every model is
//                  photographed exactly the way the atlas photographs it — same standing-up, same
//                  long lens, same distance, same lights, from `bakeView` — and the picture is
//                  dropped into the rect the sprite would have filled. Not a lookalike: the same
//                  arithmetic, so the two are the same image, and the angle need not snap to one of
//                  sixteen baked ones because there is nothing to look up.
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

import { AmbientLight, BufferAttribute, BufferGeometry, Color, DirectionalLight, HemisphereLight, type Material, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three'
import { disposeObject3D } from '@apex/engine/render/dispose'
import { glbLoader } from './loadGlb'
import { bankReach, deckHalf, groundHeight } from './RoadMesh'

import { MODELS } from './models'
import { fitModel } from './bakeView'

const DEG = Math.PI / 180
/** How wide the depth proxy is either side of the road centre, in metres. */
const GROUND_HALF = 90
/** Lateral stations of the depth proxy: the ground, the foot of the bank, the deck's edges, its centre. */
const GROUND_COLS = 7
/** Sink the proxy this far (m) so a model standing on it doesn't fight it for the same depth. */
const GROUND_BIAS = 0.08


/**
 * Distance haze and night, done to a mesh exactly the way the sprite shader does it to a sprite:
 * `mix(colour * dim, fog, amount)`, in the same linear space the road blends its own fog in. Without
 * it a model is the one thing in the frame that does not go pale as it recedes, and the far half of
 * the world reads as a cardboard cut-out pasted over the haze.
 *
 * The uniforms are per *instance*, not per kind, so the amount can differ down a row of trees. That
 * means one material per instance: three only re-uploads a program's uniforms when the material it
 * is drawing changes, so instances sharing a material would all wear whichever value was set last.
 * The program is still shared — the cache key is `onBeforeCompile.toString()`, the same for all.
 */
interface Tint {
  uTintFog: { value: Color }
  uTintAmt: { value: number }
  uTintDim: { value: number }
}
const TINT_HEAD = 'uniform vec3 uTintFog;\nuniform float uTintAmt;\nuniform float uTintDim;\n'
const TINT_MIX = '#include <opaque_fragment>\ngl_FragColor.rgb = mix( gl_FragColor.rgb * uTintDim, uTintFog, uTintAmt );'
function tintShader(this: Material, shader: { uniforms: Record<string, unknown>; fragmentShader: string }): void {
  const tint = (this.userData as { tint?: Tint }).tint
  if (!tint) return
  Object.assign(shader.uniforms, tint)
  shader.fragmentShader = TINT_HEAD + shader.fragmentShader.replace('#include <opaque_fragment>', TINT_MIX)
}

/** A private copy of a material that fogs and dims on its own, sharing `fog` with the rest of the frame. */
function tinted(mat: Material, fog: Color, out: Tint[]): Material {
  const m = mat.clone()
  const tint: Tint = { uTintFog: { value: fog }, uTintAmt: { value: 0 }, uTintDim: { value: 1 } }
  m.userData = { ...m.userData, tint }
  m.onBeforeCompile = tintShader
  out.push(tint)
  return m
}

export class ModelLayer {
  /** Both ways of posing a mesh, drawn as one pass through one lens into the style's buffer. */
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(45, 1.78, 0.4, 6000)
  /** One prototype per kind; instances clone it and share its geometry and materials. */
  private readonly protos = new Map<string, Object3D>()
  /** Each kind's fitted extents, which is all `bakeView` needs to frame it. */
  private readonly sizes = new Map<string, Vector3>()
  /** The fitted models and their extents, for whoever wants to photograph them live. */
  readonly fitted = new Map<string, { model: Object3D; fs: Vector3 }>()
  private readonly pools = new Map<string, Object3D[]>()
  private readonly cursor = new Map<string, number>()
  private readonly ground: Mesh
  private groundVerts = new Float32Array(0)
  /** The frame's fog colour, shared by reference with every instance's tint uniforms. */
  private readonly fog = new Color(1, 1, 1)
  /** Lateral stations of the proxy for the two rows of a strip (reused, not reallocated per row). */
  private readonly colA = new Float64Array(GROUND_COLS)
  private readonly colB = new Float64Array(GROUND_COLS)
  /** 1/tan(halfFov) of whatever lens this frame is using, after the world's zoom. */
  private camDepth = 1

  /** The frame's aspect, so the solid camera matches the picture the 2D pass is drawing. */
  set aspect(a: number) {
    if (this.camera.aspect !== a) {
      this.camera.aspect = a
      this.camera.updateProjectionMatrix()
    }
  }
  ready = false
  private loading = false

  constructor() {
    // The bake's lights, so a mesh is shaded the way its sprite was.
    const sun = new DirectionalLight(0xffffff, 1.6)
    sun.position.set(3, 6, 4)
    this.scene.add(new AmbientLight(0xffffff, 0.35), new HemisphereLight(0xffffff, 0x8080a0, 0.7), sun)
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
    // setPath('/'), because the model paths are relative and in the arcade the game is served
    // at /radrun — where a bare 'assets/…' would resolve against whatever menu the URL is on.
    const loader = glbLoader()
    for (const def of MODELS) {
      try {
        const model = def.file ? (await loader.loadAsync(def.file)).scene : def.build?.()
        if (model) {
          const fit = fitModel(model, def)
          this.protos.set(def.kind, fit.model)
          this.sizes.set(def.kind, fit.fs)
          // The prototype itself is never in a scene — instances are clones of it — so the live atlas
          // can borrow it to photograph without anything being reparented out from under the frame.
          this.fitted.set(def.kind, { model: fit.model, fs: fit.fs })
        }
      } catch (err) {
        console.warn(`3D models: ${def.kind} would not load; it keeps its sprite`, err)
      }
    }
    this.loading = false
    this.ready = true
  }

  /** The colour models fade into with distance; the same one the road and the sprites use. */
  setFog(color: number): void {
    this.fog.set(color)
  }

  /**
   * The view the 2D pass is drawing through: its field of view, the roll it is banking the whole
   * picture by, and the zoom it uses to keep the corners covered while rolled. This pass has its own
   * camera, so unless it wears all three the models sit level while the road tips underneath them.
   */
  begin(fovDeg: number, roll = 0, zoom = 1, ground = true): void {
    this.cursor.clear()
    // Scaling a projected image about its centre by `zoom` is the same as narrowing the lens by it.
    // Solid mode shares the world's lens, because it is standing things in the world's own places.
    // Posed mode picks its own and keeps it: the zoom is a magnification of the finished picture, so
    // folding it into the lens would make the perspective breathe every time the view banked.
    // The world's own lens, and posed placement measures against it WITHOUT the zoom: the zoom is a
    // magnification of the finished picture to keep its corners covered while it is banked, so folding
    // it in would make a posed mesh's perspective breathe every time the view rolled.
    this.camDepth = Math.tan(fovDeg * 0.5 * DEG) ** -1
    // Scaling a projected image about its centre by `zoom` is the same as narrowing the lens by it.
    const fov = (2 * Math.atan(1 / (this.camDepth * Math.max(1e-3, zoom)))) / DEG
    if (this.camera.fov !== fov) {
      this.camera.fov = fov
      this.camera.updateProjectionMatrix()
    }
    this.camera.rotation.set(0, 0, -roll)
    this.ground.visible = ground
  }

  private instance(kind: string): Object3D | null {
    const proto = this.protos.get(kind)
    if (!proto) return null
    const key = kind
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
      // clone() shares the prototype's materials; this instance needs its own so it can carry its own
      // distance haze. Geometry stays shared, and so does the compiled program.
      const tints: Tint[] = []
      obj.traverse((o) => {
        const m = o as Mesh
        if (!m.isMesh) return
        m.material = Array.isArray(m.material) ? m.material.map((mat) => tinted(mat, this.fog, tints)) : tinted(m.material, this.fog, tints)
      })
      obj.userData.tints = tints
      // The live pass puts a model's clip position in a uniform, which three cannot see, so it must
      // not be allowed to decide the model is off screen.
      obj.traverse((o) => (o.frustumCulled = false))
      pool.push(obj)
      this.scene.add(obj)
    }
    obj.visible = true
    return obj
  }

  /** How much haze this instance stands behind (0..1) and how much light reaches it (1 = full day). */
  private setTint(obj: Object3D, fogT: number, bright: number): void {
    for (const t of obj.userData.tints as Tint[]) {
      t.uTintAmt.value = fogT
      t.uTintDim.value = bright
    }
  }

  /**
   * Solid: stand the mesh at a place in front of the camera, in metres — `cx` to the side, `cy` above,
   * `cz` ahead. Not a sprite's screen position inverted back into a place: the road rows carry the
   * metres, and this is the pass that is allowed to use them as metres. `headingDeg` is the model's own
   * heading, not a viewing angle — which way it is seen from falls out of where it is standing.
   */
  addSolid(kind: string, cx: number, cy: number, cz: number, size: number, headingDeg: number, roll: number, fogT = 0, bright = 1): boolean {
    if (!(cz > 0.05)) return false
    const obj = this.instance(kind)
    if (!obj) return false
    this.setTint(obj, fogT, bright)
    obj.position.set(cx, cy, -cz)
    obj.scale.setScalar(size)
    obj.rotation.order = 'ZYX'
    // The half turn: these models face +z, and +z here is back towards the camera. Without it every
    // car in the game drives at you and every sign faces away.
    obj.rotation.set(0, (180 + headingDeg) * DEG, roll)
    return true
  }

  /**
   * The depth-only road surface, from the same rows the road was drawn from: screen x, screen y and
   * pixels-to-the-metre per row, inverted back into camera space. Wide enough to stand in for the
   * ground either side, which is what actually hides a tree over a crest.
   *
   * It carries the banked deck and the bank under its high side, not just a flat ribbon down the
   * centreline: on a bermed turn the surface you are hidden by stands metres above the centre, and a
   * proxy laid flat there hides nothing — every tree behind the berm pokes up through the tarmac.
   */
  setGround(rowCx: ArrayLike<number>, rowCy: ArrayLike<number>, rowCz: ArrayLike<number>, rowTilt: ArrayLike<number>, rows: number): void {
    const strips = Math.max(0, rows - 1)
    const quads = strips * (GROUND_COLS - 1)
    const need = quads * 6 * 3
    if (this.groundVerts.length !== need) {
      this.groundVerts = new Float32Array(need)
      this.ground.geometry.setAttribute('position', new BufferAttribute(this.groundVerts, 3))
    }
    const p = this.groundVerts
    const dh = deckHalf()
    let v = 0
    /** Where this row's profile changes slope: the ground, the foot of the bank, the deck, its centre. */
    const stations = (out: Float64Array, tilt: number): void => {
      const run = bankReach(tilt) - dh
      out[0] = -GROUND_HALF
      out[1] = -dh - (tilt < 0 ? run : 0)
      out[2] = -dh
      out[3] = 0
      out[4] = dh
      out[5] = dh + (tilt > 0 ? run : 0)
      out[6] = GROUND_HALF
    }
    const put = (n: number, u: number): void => {
      p[v++] = rowCx[n] + u
      p[v++] = rowCy[n] + groundHeight(u, rowTilt[n]) - GROUND_BIAS
      p[v++] = -rowCz[n]
    }
    const a = this.colA
    const b = this.colB
    for (let n = 0; n < strips; n++) {
      stations(a, rowTilt[n])
      stations(b, rowTilt[n + 1])
      for (let c = 0; c < GROUND_COLS - 1; c++) {
        put(n, a[c])
        put(n, a[c + 1])
        put(n + 1, b[c])
        put(n + 1, b[c])
        put(n, a[c + 1])
        put(n + 1, b[c + 1])
      }
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

  /**
   * The solid scene hangs off this layer, not off the game's scene graph, so nothing else disposes it —
   * and every instance owns its materials now, so there is real memory here to give back.
   */
  dispose(): void {
    disposeObject3D(this.scene)
    this.protos.clear()
    this.pools.clear()
    this.cursor.clear()
    this.ready = false
  }

  /** The solid pass, into whatever the style is drawing into: its depth buffer, our geometry. */
  render(renderer: WebGLRenderer): void {
    const prevClear = renderer.autoClear
    renderer.autoClear = false
    renderer.render(this.scene, this.camera)
    renderer.autoClear = prevClear
  }
}
