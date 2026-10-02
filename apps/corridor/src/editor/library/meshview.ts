// A 3D preview of one generated asset, inside a panel.
//
// Ported from ext/assetlib/tool/viewer.html, which was a page served by a separate process on a
// separate port behind a tunnel — and `ext/*` is gitignored, so on a fresh clone neither the tool
// nor the library exists at all (Rich, 2026-09-28: "we don't need an external service that will be
// wiped on a fresh clone sticking around, everything needs to be folded in here").
//
// Three things came across with it because each was learned by getting it wrong:
//
//   A REAL ENVIRONMENT. These meshes keep their PBR material, and judging a clear-coat under a
//   bare directional light flatters a bad bake and punishes a good one. RoomEnvironment through
//   PMREM costs one render at start-up and is the difference between "is this car paint right"
//   being answerable and not.
//
//   DRACO IS MANDATORY AND FAILS SILENTLY. finish.mjs emits Draco, and GLTFLoader without a
//   working DRACOLoader does not warn — it rejects. An empty stage looks exactly like a bad
//   reconstruction, so the failure is shown in words.
//
//   GLASS STAYS DOUBLE-SIDED. Transmissive materials lose their far pane at FrontSide; everything
//   else needs FrontSide or the inside of the shell z-fights through the paint.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
/*
 * THE OTHER THINGS BLENDER WRITES.
 *
 * A .glb is what the game loads, but the Blender tab also produces STL, OBJ and PLY — and the
 * first version of that tab told you an STL could not be previewed, which is a message where a
 * viewer should be. These are geometry-only formats: an STL has no materials, no colours and no
 * rig, and a PLY may carry vertex colours. Loading them is four lines each; refusing to was
 * hand-waving.
 */
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { Dialog, button, el } from '../../ui/shell'
import { applyAlphaGlazing, type GlazingResult } from '../../visuals/glazing'

/**
 * The roles a game knows how to drive, and the names that mean them.
 *
 * Loose on purpose. Exporters disagree about separators and casing — `wheel_FL`, `Wheel.Fl`,
 * `wheel-front-left` are all the same thing — and a rig that fails to bind because of a full stop
 * is a bad tool rather than a bad rig. The corner suffixes are matched separately so `wheel` and
 * `fl` need not be adjacent.
 */
const ROLE_PATTERNS: [string, RegExp][] = [
  ['wheel', /wheel|tyre|tire/],
  ['steer', /steer/],
  ['suspension', /susp|damper|shock|strut|axle/],
  ['door', /door|hatch|tailgate|bonnet|hood|trunk|boot(?!.*strap)/],
  ['slew', /slew|turret|cab_rot|swing/],
  ['boom', /boom/],
  // NOT `arm`. An excavator's second boom section is a "stick" or a "dipper"; `arm` matches
  // `upper_arm` and `forearm` on every character rig, and because the first pattern wins, a
  // person's twenty-eight arm bones were being reported as excavator sticks.
  ['stick', /stick|dipper/],
  ['bucket', /bucket|blade|scoop|claw|grap/],
  ['rotor', /rotor|blade_main|tail_rotor/],
  ['propeller', /prop(?!erty)|airscrew/],
  ['control-surface', /aileron|elevator|rudder|flap|canard/],
  ['spine', /spine|torso|chest|hips|pelvis/],
  ['limb', /arm|leg|hand|foot|thigh|shin|forearm|shoulder/],
  ['head', /head|neck|jaw|eye/],
]

/**
 * Triangles, vertices, meshes and materials in a loaded scene.
 *
 * Indexed geometry counts its INDEX triples, not its positions: a cube is eight vertices and
 * twelve triangles, and counting positions/3 would report four. Materials are counted by identity
 * because a mesh list of forty that shares one material is one draw call's worth of state, which
 * is the number that matters when somebody is deciding whether to ship the raw mesh.
 */
function countGeometry(root: THREE.Object3D): { triangles: number; vertices: number; meshes: number; materials: number } {
  let triangles = 0
  let vertices = 0
  let meshes = 0
  const materials = new Set<THREE.Material>()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.geometry) return
    meshes++
    const g = m.geometry
    const pos = g.getAttribute('position')
    vertices += pos ? pos.count : 0
    triangles += g.index ? g.index.count / 3 : (pos ? pos.count / 3 : 0)
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat) materials.add(mat)
  })
  return { triangles: Math.round(triangles), vertices, meshes, materials: materials.size }
}

/** Which named roles a bone list contains, and how many bones claim each. */
function matchRoles(names: string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const raw of names) {
    // strip Rigify's machinery prefixes before matching: MCH-thigh is plumbing, not a limb
    if (/^(MCH|ORG)-/.test(raw)) continue
    const n = raw.toLowerCase().replace(/[.\-\s]+/g, '_')
    for (const [role, re] of ROLE_PATTERNS) {
      if (re.test(n)) {
        out.set(role, (out.get(role) ?? 0) + 1)
        break // first match wins: a name matches one role, not four
      }
    }
  }
  return out
}

export interface RigInfo {
  bones: number
  skinned: boolean
  /** rigify = a character authoring rig; named = roles were recognised; flat = neither */
  convention: 'rigify' | 'named' | 'flat'
  deform: number
  org: number
  mch: number
  control: number
  /** role -> how many bones claim it, e.g. { wheel: 4, steer: 1 } */
  roles: Record<string, number>
  names: string[]
}

export interface MeshViewOpts {
  /** spin the model. On by default: a still three-quarter view hides the far flank. */
  spin?: boolean
  /**
   * Remember how it was left — spin, wireframe and where the camera was — under this key.
   *
   * Rich, 2026-09-28: "it should remember last settings on refreshes". Per key rather than
   * globally, because the sample wall in the materials tab and the car in the catalog are looked
   * at from different places and neither wants the other's camera.
   */
  remember?: string
}

interface MeshPrefs {
  spin?: boolean
  wire?: boolean
  /** camera position and orbit target, in the viewer's own units */
  cam?: [number, number, number, number, number, number]
  /** how tall the viewer was left, in pixels */
  height?: number
}

export class MeshView {
  readonly root = el('div', 'meshview')
  private readonly canvas = el('canvas', 'meshview-canvas')
  private readonly status = el('div', 'meshview-status')
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.005, 200)
  private readonly controls: OrbitControls
  private readonly pivot = new THREE.Group()
  private readonly grid: THREE.GridHelper
  private readonly loader: GLTFLoader
  private readonly observer: ResizeObserver
  private spin: boolean
  private wire = false
  private running = false
  private readonly prefKey: string | null
  private prefs: MeshPrefs = {}
  /** set while a load is applying a remembered camera, so it is not saved back mid-flight */
  private restoring = false
  /** Turn the placed model about its up axis and seat it again. What the orientation control drives. */
  setYawDeg(deg: number): void {
    this.yawDeg = deg
    if (this.placed) this.#seat(this.placed)
  }

  /** the model turned as asked, centred, sitting on the grid; returns its size */
  #seat(root: THREE.Object3D): THREE.Vector3 {
    root.rotation.y = (this.yawDeg * Math.PI) / 180
    root.position.set(0, 0, 0)
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    const centre = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    root.position.sub(centre)
    root.position.y += size.y / 2 // sit it on the grid rather than through it
    return size
  }

  /** resolves when the current `load()` has settled, so a caller can inspect what arrived */
  loaded: Promise<void> = Promise.resolve()
  private disposed = false
  /** what `#place` put on the pivot, so an orientation can be applied after the fact */
  private placed: THREE.Object3D | null = null
  private yawDeg = 0
  /** the size of the last thing loaded, in metres — the caller shows it */
  size: THREE.Vector3 | null = null
  /**
   * WHAT IS ACTUALLY IN THE FILE, counted after it loads.
   *
   * The reason to look at the raw reconstruction beside the finished one is to find out what the
   * decimation cost: "236k triangles down to 41k" is the answer, and two file sizes are not — a
   * Draco'd file is a tenth the bytes of the same geometry, so comparing sizes tells you about
   * the compressor rather than about the model.
   */
  stats: { triangles: number; vertices: number; meshes: number; materials: number } | null = null
  /** what `src/glazing.ts` found and turned into glass on the last load */
  glazed: GlazingResult | null = null
  private skeletonHelper: THREE.SkeletonHelper | null = null
  private skinned: THREE.SkinnedMesh | null = null
  /** what the last load was, so a panel can say "no materials, and that is the format" */
  format: 'gltf' | 'stl' | 'obj' | 'ply' = 'gltf'
  /**
   * Bones found OUTSIDE a skin.
   *
   * A character is skinned: its mesh deforms with the bones. A car is not — its wheels are
   * separate meshes parented to nodes that rotate, which is a rig with no skinning anywhere in
   * it. Looking only at `skeleton.bones` finds nothing on a vehicle and reports it unrigged.
   */
  private boneRoots: THREE.Object3D[] = []
  /** the dot that says which bone is which, in the rig editor */
  private boneMark: THREE.Mesh | null = null
  private readonly textures = new THREE.TextureLoader()

  constructor(o: MeshViewOpts = {}) {
    this.prefKey = o.remember ? `apex-meshview.${o.remember}` : null
    if (this.prefKey) {
      try { this.prefs = JSON.parse(localStorage.getItem(this.prefKey) ?? '{}') as MeshPrefs } catch { this.prefs = {} }
    }
    this.spin = this.prefs.spin ?? o.spin ?? true
    this.wire = this.prefs.wire ?? false
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 0.7))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(3, 5, 4)
    this.scene.add(key)

    this.grid = new THREE.GridHelper(4, 40, 0x3a4250, 0x232a34)
    this.grid.material.transparent = true
    this.grid.material.opacity = 0.55
    this.scene.add(this.grid, this.pivot)

    this.controls = new OrbitControls(this.camera, this.canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.07
    // where you left it, kept when you let go rather than on every frame of a drag
    this.controls.addEventListener('end', () => this.savePrefs())

    const draco = new DRACOLoader().setDecoderPath('/assets/vendor/draco/')
    this.loader = new GLTFLoader().setDRACOLoader(draco)

    this.status.hidden = true
    this.root.append(this.canvas, this.status)

    /*
     * DRAG THE BOTTOM EDGE, AND IT STAYS THAT SIZE.
     *
     * A fixed aspect ratio is right for a thumbnail and wrong for the thing you are judging a
     * reconstruction with — how tall it should be depends on the model and on the screen, and
     * neither of those is known here. The height is kept with the spin and the camera, under the
     * same key, so it comes back the way it was left.
     */
    if (this.prefs.height) this.setHeight(this.prefs.height)
    const grip = el('div', 'meshview-grip')
    grip.title = 'drag to resize'
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      const from = this.root.getBoundingClientRect().height
      const y0 = e.clientY
      const move = (m: PointerEvent) => this.setHeight(from + (m.clientY - y0))
      const up = () => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        this.savePrefs()
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
    })
    this.root.append(grip)
    // The canvas has no intrinsic size inside a panel that resizes, so its box is the authority.
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(this.canvas)
  }

  private resize() {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** Start drawing. Cheap to call repeatedly; does nothing if already running. */
  start() {
    if (this.running || this.disposed) return
    this.running = true
    this.resize()
    this.renderer.setAnimationLoop(() => {
      if (this.spin) this.pivot.rotation.y += 0.0045
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    })
  }

  /**
   * Stop drawing. A preview in a collapsed group or a closed dialog that keeps its loop running
   * is a GPU spinning for nobody — the same thing the engine audio had to learn about a hidden tab.
   */
  stop() {
    this.running = false
    this.renderer.setAnimationLoop(null)
  }

  setSpin(on: boolean) {
    this.spin = on
    this.savePrefs()
  }

  /** What the toggles should say when they are built — the remembered value, not a hard-coded one. */
  get spinning(): boolean {
    return this.spin
  }

  get wireframe(): boolean {
    return this.wire
  }

  /** Between a thumbnail and most of a screen; anything outside that is a mis-drag. */
  private setHeight(px: number): void {
    const h = Math.round(Math.max(140, Math.min(Math.max(240, innerHeight - 160), px)))
    this.height = h
    this.root.style.height = `${h}px`
    this.root.style.aspectRatio = 'auto'
    this.root.style.maxHeight = 'none'
    this.resize()
  }

  private height = 0

  private savePrefs(): void {
    if (!this.prefKey || this.restoring) return
    const c = this.camera.position
    const t = this.controls.target
    this.prefs = { spin: this.spin, wire: this.wire, cam: [c.x, c.y, c.z, t.x, t.y, t.z], height: this.height || this.prefs.height }
    try { localStorage.setItem(this.prefKey, JSON.stringify(this.prefs)) } catch { /* private window */ }
  }

  /**
   * The same viewer, big, over everything.
   *
   * Rich, 2026-09-28: "we need the ability to pop it out larger". The ROOT IS MOVED rather than a
   * second viewer being made: a MeshView is a WebGL context and a loaded glb, and making another
   * one costs both and starts it looking somewhere else. It goes back where it came from when the
   * dialog closes.
   */
  popOut(title = 'Model'): void {
    const home = this.root.parentElement
    const next = this.root.nextSibling
    const d = new Dialog({
      title,
      icon: 'cube',
      size: 'xl',
      movable: true,
      onClose: () => {
        this.root.classList.remove('big')
        if (home) home.insertBefore(this.root, next)
        this.resize()
      },
    })
    this.root.classList.add('big')
    d.body.append(this.root)
    d.footer(
      button({ label: 'Reset the view', icon: 'arrow-uturn-left', variant: 'ghost', onClick: () => this.frame() }),
      button({ label: 'Done', variant: 'primary', onClick: () => d.close() }),
    )
    d.open()
    this.start()
    // the box it is in changed, and a canvas does not notice on its own until the observer fires
    requestAnimationFrame(() => this.resize())
  }

  /**
   * Show the skeleton over the mesh.
   *
   * Only meaningful for a character. `SkeletonHelper` draws every bone in the hierarchy, which on
   * a Rigify rig is seven hundred of them — see `rig()` for why that number is not a mistake.
   */
  setSkeleton(on: boolean) {
    const from = this.skinned
      ? this.skinned.skeleton.bones[0]?.parent ?? this.skinned
      : this.boneRoots[0]?.parent ?? this.boneRoots[0]
    if (on && !this.skeletonHelper && from) {
      const h = new THREE.SkeletonHelper(from)
      // over the mesh rather than inside it: a skeleton hidden by the skin it drives is no help
      const m = h.material as THREE.LineBasicMaterial
      m.depthTest = false
      m.transparent = true
      m.opacity = 0.9
      h.renderOrder = 2
      this.skeletonHelper = h
      this.pivot.add(h)
    }
    if (this.skeletonHelper) this.skeletonHelper.visible = on
  }

  /**
   * What kind of rig this is.
   *
   * NOT CHARACTERS ONLY. Rich, 2026-09-28: "we want to also make this work to rig vehicles
   * (suspension, wheels) and potentially things like an excavator, basically anything we are
   * building into our asset lib." Those are rigs in exactly the sense that matters — a named
   * hierarchy the game drives — and they look nothing like a character rig:
   *
   *   a character   700 bones, four naming classes, a skinned mesh, weights that matter
   *   a car         a dozen: four wheels, a steering axis, four suspension travels, doors
   *   an excavator  a kinematic chain: slew, boom, stick, bucket
   *
   * So there are two questions, and only the first is about counting. **Which convention is
   * this**, and **which bones have ROLES the game knows how to drive**. A car's rig is useless
   * unless something can find the front-left wheel; the fact that it has eleven bones is not the
   * interesting part.
   *
   * Roles are matched on the name, because that is all a glb carries. The patterns are
   * deliberately loose — exporters disagree about separators and casing, and a rig that fails to
   * bind because somebody wrote `Wheel.FL` instead of `wheel_fl` is a bad tool, not a bad rig.
   */
  rig(): RigInfo | null {
    if (!this.skinned && !this.boneRoots.length) return null
    const bones = this.skinned
      ? this.skinned.skeleton.bones.map((b) => b.name)
      : this.boneRoots.map((b) => b.name)
    const count = (p: string) => bones.filter((n) => n.startsWith(p)).length
    const deform = count('DEF-')
    const org = count('ORG-')
    const mch = count('MCH-')
    // Rigify is unmistakable: no other convention emits these three prefixes together.
    const rigify = deform > 0 && mch > 0
    const roles = matchRoles(bones)
    return {
      bones: bones.length,
      skinned: !!this.skinned,
      convention: rigify ? 'rigify' : roles.size ? 'named' : 'flat',
      // only meaningful for rigify; zero elsewhere, and the caller does not show them
      deform, org, mch, control: bones.length - deform - org - mch,
      roles: Object.fromEntries(roles),
      names: bones,
    }
  }

  /**
   * Light one bone up, so a name in a list becomes a thing in the model.
   *
   * A rig editor is forty names and no way to tell which is the near-side front wheel; clicking
   * one has to point at it. The marker is drawn over everything (`depthTest: false`) because a
   * wheel bone is inside the wheel.
   */
  highlightBone(name: string | null): void {
    if (!this.boneMark) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0x2ee6c0, depthTest: false, transparent: true, opacity: 0.85, toneMapped: false }),
      )
      m.renderOrder = 30
      m.visible = false
      this.scene.add(m)
      this.boneMark = m
    }
    const mark = this.boneMark
    if (!name) { mark.visible = false; return }
    let found: THREE.Object3D | null = null
    this.pivot.traverse((o) => { if (!found && o.name === name) found = o })
    if (!found) { mark.visible = false; return }
    mark.position.setFromMatrixPosition((found as THREE.Object3D).matrixWorld)
    // sized against the model, so it is a dot on a car and a dot on a water tower
    const r = this.size ? Math.max(this.size.x, this.size.y, this.size.z) : 1
    mark.scale.setScalar(Math.max(0.005, r * 0.02))
    mark.visible = true
  }

  /**
   * Where every bone is, in the model's own frame.
   *
   * For the rig editor to work out which of four wheel bones is the near-side front one. Taken
   * relative to `pivot` rather than in world space on purpose: the preview spins, and a reading
   * that changes with the turntable would have the front wheels swapping ends as you watch.
   *
   * No axis convention is asserted here — a glb carries whatever the exporter felt like, and
   * deciding which way is forward is the caller's problem, with the model on screen to check it
   * against. All this promises is that the four readings are in one consistent frame.
   */
  bonePlaces(): Record<string, { x: number, y: number, z: number }> {
    const out: Record<string, { x: number, y: number, z: number }> = {}
    const v = new THREE.Vector3()
    this.pivot.updateWorldMatrix(true, true)
    this.pivot.traverse((o) => {
      if (!(o as THREE.Bone).isBone || !o.name || out[o.name]) return
      v.setFromMatrixPosition(o.matrixWorld)
      this.pivot.worldToLocal(v)
      out[o.name] = { x: v.x, y: v.y, z: v.z }
    })
    return out
  }

  setWireframe(on: boolean) {
    this.wire = on
    this.pivot.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
      if (m && 'wireframe' in m) m.wireframe = on
    })
    this.savePrefs()
  }

  /** Put the camera back where a freshly loaded model would have put it. */
  frame(): void {
    const s = this.size
    const r = s ? Math.max(s.x, s.y, s.z) || 1 : 1
    this.camera.position.set(r * 1.5, r * 0.85, r * 2.0)
    this.controls.target.set(0, (s?.y ?? 1) / 2, 0)
    this.controls.update()
    this.savePrefs()
  }

  /**
   * Load a model. Rejects loudly in the panel rather than leaving an empty stage.
   *
   * glTF is the rich case — materials, a rig, the alpha glazing. STL, OBJ and PLY are geometry,
   * and the viewer says so rather than pretending the grey is the asset's colour.
   */
  load(url: string): Promise<void> {
    this.loaded = this.#load(url)
    return this.loaded
  }

  /** What the URL is, by extension — the query string is not part of the name. */
  private static formatOf(url: string): 'gltf' | 'stl' | 'obj' | 'ply' {
    const ext = (url.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
    return ext === 'stl' ? 'stl' : ext === 'obj' ? 'obj' : ext === 'ply' ? 'ply' : 'gltf'
  }

  /**
   * The geometry-only formats, as something to look at.
   *
   * ONE MATERIAL, and it is honest about being ours: an STL carries no colour at all, so any
   * colour here is the viewer's invention. Flat-shaded, because these come out of Blender as
   * triangle soup with no normals worth smoothing and a smooth shader makes a facetted mesh look
   * like a melted one.
   */
  async #loadPlain(url: string, format: 'stl' | 'obj' | 'ply'): Promise<THREE.Object3D> {
    const material = () => new THREE.MeshStandardMaterial({
      color: 0x9aa4b2, roughness: 0.65, metalness: 0.0, flatShading: true, side: THREE.DoubleSide,
    })
    if (format === 'obj') {
      const obj = await new OBJLoader().loadAsync(url)
      obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = material() })
      return obj
    }
    const geometry = format === 'stl'
      ? await new STLLoader().loadAsync(url)
      : await new PLYLoader().loadAsync(url)
    // STL has no normals of its own worth trusting and PLY often has none at all
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
    const mat = material()
    // a PLY may carry per-vertex colour, which IS the asset's own and should win over ours
    if (geometry.getAttribute('color')) { mat.vertexColors = true; mat.color.setHex(0xffffff) }
    const root = new THREE.Object3D()
    root.add(new THREE.Mesh(geometry, mat))
    return root
  }

  async #load(url: string): Promise<void> {
    this.clear()
    this.say('loading…')
    try {
      const format = MeshView.formatOf(url)
      if (format !== 'gltf') return await this.#place(await this.#loadPlain(url, format), format)
      const gltf = await this.loader.loadAsync(url)
      if (this.disposed) return
      const root = gltf.scene
      root.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const m = mesh.material as THREE.MeshPhysicalMaterial
        // Glass keeps both faces; everything else is front-only so the inside of the shell does
        // not z-fight through the paint. `applyAlphaGlazing` below runs AFTER this and puts
        // DoubleSide back on the materials that turn out to have windows in them — through which
        // the inside of the far panels is exactly what you are meant to see.
        if (!(m && m.transmission > 0)) m.side = THREE.FrontSide
      })
      // Find the skinned mesh, if this is a character rather than a prop.
      this.skinned = null
      this.boneRoots = []
      root.traverse((o) => {
        const sm = o as THREE.SkinnedMesh
        if (sm.isSkinnedMesh && !this.skinned) this.skinned = sm
        if ((o as THREE.Bone).isBone) this.boneRoots.push(o)
      })
      /*
       * THE GLAZING THE RECONSTRUCTOR ALREADY DREW.
       *
       * TRELLIS.2 writes the window mask into the base colour texture's ALPHA and exports the
       * material as OPAQUE, so it is there in every asset and nothing has ever switched it on.
       * See src/glazing.ts — this is the one call, and it is a no-op on a file that already
       * declares transmission or on anything with no transparent texels.
       */
      this.glazed = applyAlphaGlazing(root)

      await this.#place(root, 'gltf')
    } catch (e) {
      // GLTFLoader REJECTS on undecodable Draco rather than warning, so this is the only place
      // the difference between "no mesh" and "a mesh we cannot read" is visible.
      this.say(`could not load the mesh — ${(e as Error).message}`)
    }
  }

  /**
   * Centre it, sit it on the grid, frame it, and count it — the half of loading that is the same
   * whatever the file was.
   */
  async #place(root: THREE.Object3D, format: 'gltf' | 'stl' | 'obj' | 'ply'): Promise<void> {
    if (this.disposed) return
    this.placed = root
    const size = this.#seat(root)
    this.pivot.add(root)

    const r = Math.max(size.x, size.y, size.z) || 1
    // which way is which: the asset form's orientation control turns the model until its front
    // is along the red (+X) axis, and it needs the axis to be visible to do it
    const axes = new THREE.AxesHelper(r * 0.75)
    axes.name = 'axes'
    this.pivot.add(axes)
    this.grid.scale.setScalar(r)
    this.camera.position.set(r * 1.5, r * 0.85, r * 2.0)
    this.controls.target.set(0, size.y / 2, 0)
    this.controls.update()
    this.size = size
    this.stats = countGeometry(root)
    this.format = format
    // the wireframe choice is remembered, and the materials it applies to did not exist until now
    if (this.wire) this.setWireframe(true)
    /*
     * AND THE CAMERA, IF THERE IS ONE REMEMBERED — but only if it is a sane distance for THIS
     * model. A camera kept from a two-metre car applied to a unit-normalised prop puts you
     * inside it, which looks exactly like a failed load.
     */
    const cam = this.prefs.cam
    if (cam && Number.isFinite(cam[0])) {
      const dist = Math.hypot(cam[0] - cam[3], cam[1] - cam[4], cam[2] - cam[5])
      if (dist > r * 0.4 && dist < r * 20) {
        this.restoring = true
        this.camera.position.set(cam[0], cam[1], cam[2])
        this.controls.target.set(cam[3], cam[4], cam[5])
        this.controls.update()
        this.restoring = false
      }
    }
    this.say(null)
  }

  /**
   * Show a tileable material on a sample wall.
   *
   * EIGHT METRES ACROSS, fixed, so the grid reads as metres and two materials can be compared by
   * eye: at `metres_per_tile` 2 you see four courses across the wall, at 0.5 you see sixteen.
   * That ratio IS the thing being judged — a texture whose tile size is wrong looks perfectly
   * good on its own and absurd on a building.
   *
   * DoubleSide, and the spin is left to the caller: a single-sided plane on a spinning pivot is
   * invisible for half of every turn, which looks exactly like a texture that failed to load.
   */
  /**
   * A material, one way or the other.
   *
   * `tiled` is a sample wall eight metres across, which is the only way to judge
   * `metres_per_tile` — it is legible as a RATIO: at 2 m you count four courses across it, at
   * 0.5 m sixteen. `flat` is one tile filling the frame, which is the only way to judge the
   * PIXELS: whether the albedo is full of JPEG mush, whether the normal map is inverted.
   *
   * ONE VIEWER, TWO MODES, rather than a viewer and a lightbox. Rich, 2026-09-28: "These buttons
   * are confusing, they do kind of the same thing. Why isn't the tiled vs up close just an option
   * in the viewer?" — so it is, and the map being looked at is part of the same choice.
   */
  async showMaterial(m: {
    metres_per_tile: number
    albedo: string
    normal?: string
    roughness?: string
    /** 'tiled' is the sample wall; the others show that one map, flat and unlit */
    mode?: 'tiled' | 'albedo' | 'normal' | 'roughness'
  }): Promise<void> {
    const mode = m.mode ?? 'tiled'
    if (mode !== 'tiled') return this.showFlat(mode === 'albedo' ? m.albedo : mode === 'normal' ? m.normal : m.roughness, mode)
    this.clear()
    this.say('loading…')
    const WALL_M = 8
    const repeat = WALL_M / Math.max(0.01, m.metres_per_tile)
    const load = (url?: string) => new Promise<THREE.Texture | null>((resolve) => {
      if (!url) return resolve(null)
      this.textures.load(url, (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping
        t.repeat.set(repeat, repeat)
        t.anisotropy = 8
        resolve(t)
      }, undefined, () => resolve(null))
    })
    const [map, normalMap, roughnessMap] = await Promise.all([load(m.albedo), load(m.normal), load(m.roughness)])
    if (this.disposed) return
    if (!map) { this.say('could not load the albedo map'); return }
    map.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, side: THREE.DoubleSide })
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(WALL_M, WALL_M), mat)
    wall.position.y = WALL_M / 2
    this.pivot.add(wall)
    this.grid.scale.setScalar(WALL_M / 4)
    this.camera.position.set(0, WALL_M * 0.5, WALL_M * 1.25)
    this.controls.target.set(0, WALL_M / 2, 0)
    this.controls.update()
    this.size = new THREE.Vector3(WALL_M, WALL_M, 0)
    this.say(null)
  }

  /**
   * One map, flat, filling the frame, and NOT lit.
   *
   * MeshBasicMaterial on purpose: this is the picture, not a surface. Lighting a normal map with
   * the room environment shows you what the room looks like reflected in a picture of a normal
   * map, which is worse than useless — it hides exactly the inverted-green mistake you are looking
   * for.
   */
  private async showFlat(url: string | undefined, what: string): Promise<void> {
    this.clear()
    if (!url) { this.say(`no ${what} map`); return }
    this.say('loading…')
    const tex = await new Promise<THREE.Texture | null>((resolve) => {
      this.textures.load(url, (t) => resolve(t), undefined, () => resolve(null))
    })
    if (this.disposed) return
    if (!tex) { this.say(`could not load the ${what} map`); return }
    // the albedo is colour; a normal and a roughness map are DATA and must not be gamma-decoded
    tex.colorSpace = what === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace
    tex.anisotropy = 8
    const size = 4
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false }),
    )
    plane.position.y = size / 2
    this.pivot.add(plane)
    this.grid.visible = false
    this.camera.position.set(0, size / 2, size * 1.05)
    this.controls.target.set(0, size / 2, 0)
    this.controls.update()
    this.size = new THREE.Vector3(size, size, 0)
    this.say(null)
  }

  clear() {
    this.grid.visible = true
    if (this.boneMark) this.boneMark.visible = false
    this.stats = null
    this.glazed = null
    this.pivot.clear()
    this.skeletonHelper = null
    this.skinned = null
    this.boneRoots = []
    this.size = null
  }

  /**
   * Render and read the pixels back IN THE SAME TURN, for probes.
   *
   * A WebGL canvas without `preserveDrawingBuffer` is cleared once it has been composited, so a
   * `drawImage` from a later turn reads an empty buffer and reports a blank stage — which is
   * indistinguishable from the real failure this preview exists to make visible. The viewer
   * learned the same thing and exposes `corridor.drawFrame` for it.
   */
  capture(w = 120, h = 90): { min: number; max: number; mean: number } {
    this.renderer.render(this.scene, this.camera)
    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const g = off.getContext('2d')!
    g.drawImage(this.canvas, 0, 0, w, h)
    const d = g.getImageData(0, 0, w, h).data
    let min = 255
    let max = 0
    let sum = 0
    for (let i = 0; i < d.length; i += 4) {
      const l = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722
      if (l < min) min = l
      if (l > max) max = l
      sum += l
    }
    return { min: +min.toFixed(1), max: +max.toFixed(1), mean: +(sum / (d.length / 4)).toFixed(1) }
  }

  private say(message: string | null) {
    this.status.textContent = message ?? ''
    this.status.hidden = !message
  }

  dispose() {
    this.disposed = true
    this.stop()
    this.observer.disconnect()
    this.controls.dispose()
    this.clear()
    this.renderer.dispose()
  }
}
