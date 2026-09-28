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
  private disposed = false
  /** the size of the last thing loaded, in metres — the caller shows it */
  size: THREE.Vector3 | null = null

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

  setWireframe(on: boolean) {
    this.pivot.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
      if (m && 'wireframe' in m) m.wireframe = on
    })
  }

  /** Load a .glb. Rejects loudly in the panel rather than leaving an empty stage. */
  async load(url: string): Promise<void> {
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

  clear() {
    this.pivot.clear()
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
