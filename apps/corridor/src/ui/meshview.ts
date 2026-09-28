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
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { el } from './shell'

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
  private running = false
  /** resolves when the current `load()` has settled, so a caller can inspect what arrived */
  loaded: Promise<void> = Promise.resolve()
  private disposed = false
  /** the size of the last thing loaded, in metres — the caller shows it */
  size: THREE.Vector3 | null = null
  private skeletonHelper: THREE.SkeletonHelper | null = null
  private skinned: THREE.SkinnedMesh | null = null
  /**
   * Bones found OUTSIDE a skin.
   *
   * A character is skinned: its mesh deforms with the bones. A car is not — its wheels are
   * separate meshes parented to nodes that rotate, which is a rig with no skinning anywhere in
   * it. Looking only at `skeleton.bones` finds nothing on a vehicle and reports it unrigged.
   */
  private boneRoots: THREE.Object3D[] = []
  private readonly textures = new THREE.TextureLoader()

  constructor(o: MeshViewOpts = {}) {
    this.spin = o.spin ?? true
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

    const draco = new DRACOLoader().setDecoderPath('/assets/vendor/draco/')
    this.loader = new GLTFLoader().setDRACOLoader(draco)

    this.status.hidden = true
    this.root.append(this.canvas, this.status)
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

  setWireframe(on: boolean) {
    this.pivot.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
      if (m && 'wireframe' in m) m.wireframe = on
    })
  }

  /** Load a .glb. Rejects loudly in the panel rather than leaving an empty stage. */
  load(url: string): Promise<void> {
    this.loaded = this.#load(url)
    return this.loaded
  }

  async #load(url: string): Promise<void> {
    this.clear()
    this.say('loading…')
    try {
      const gltf = await this.loader.loadAsync(url)
      if (this.disposed) return
      const root = gltf.scene
      root.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const m = mesh.material as THREE.MeshPhysicalMaterial
        // Glass keeps both faces; everything else is front-only so the inside of the shell does
        // not z-fight through the paint.
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
      const box = new THREE.Box3().setFromObject(root)
      const centre = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      root.position.sub(centre)
      root.position.y += size.y / 2 // sit it on the grid rather than through it
      this.pivot.add(root)

      const r = Math.max(size.x, size.y, size.z) || 1
      this.grid.scale.setScalar(r)
      this.camera.position.set(r * 1.5, r * 0.85, r * 2.0)
      this.controls.target.set(0, size.y / 2, 0)
      this.controls.update()
      this.size = size
      this.say(null)
    } catch (e) {
      // GLTFLoader REJECTS on undecodable Draco rather than warning, so this is the only place
      // the difference between "no mesh" and "a mesh we cannot read" is visible.
      this.say(`could not load the mesh — ${(e as Error).message}`)
    }
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
  async showMaterial(m: { metres_per_tile: number; albedo: string; normal?: string; roughness?: string }): Promise<void> {
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

  clear() {
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
