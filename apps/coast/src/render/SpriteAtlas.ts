// Bakes 3D models into a sprite atlas at startup: each (kind, yaw) is rendered
// with an orthographic camera into its own atlas cell, so the runtime is pure
// sprite scaling — the 2.5D look — while the art comes from real meshes.

import { AmbientLight, Box3, BoxGeometry, Color, Vector4, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial, Object3D, OrthographicCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderTarget, type Texture, type WebGLRenderer, NearestFilter, LinearFilter, RGBAFormat } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

import { ATLAS_SIZE, MODELS, type ModelDef } from './models'
import { applyAtlasFilters, atlasKey, loadCachedAtlas, saveCachedAtlas } from './AtlasCache'

export interface SpriteFrame {
  /** UV rect in the atlas (0..1). */
  u0: number
  v0: number
  u1: number
  v1: number
  /** World size in metres of the rendered box. */
  widthM: number
  heightM: number
  /** Where the ground contact sits inside the frame (0 = bottom). */
  baseline: number
}

export interface SpriteKind {
  def: ModelDef
  frames: SpriteFrame[]
  yaws: number[]
}

export class SpriteAtlas {
  readonly kinds = new Map<string, SpriteKind>()
  texture: Texture | null = null
  ready = false
  private rt: WebGLRenderTarget | null = null

  /** Frame for a kind at a view yaw (degrees), or null when unknown. */
  frame(kind: string, yaw = 0): SpriteFrame | null {
    const k = this.kinds.get(kind)
    if (!k) return null
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < k.yaws.length; i++) {
      const d = Math.abs(k.yaws[i] - yaw)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return k.frames[best]
  }

  /** Whether the last bake() came from the IndexedDB cache. */
  fromCache = false

  async bake(renderer: WebGLRenderer, retro: boolean, onProgress?: (done: number, total: number) => void): Promise<void> {
    const key = atlasKey()
    const cached = await loadCachedAtlas(key)
    if (cached) {
      applyAtlasFilters(cached.texture, retro)
      this.texture = cached.texture
      this.kinds.clear()
      for (const [k, v] of cached.kinds) this.kinds.set(k, v)
      this.ready = true
      this.fromCache = true
      onProgress?.(MODELS.length, MODELS.length)
      return
    }
    await this.render(renderer, retro, onProgress)
    if (this.rt) void saveCachedAtlas(key, renderer, this.rt, this.kinds)
  }

  /** The actual bake: load every model and render its cells into the atlas target. */
  private async render(renderer: WebGLRenderer, retro: boolean, onProgress?: (done: number, total: number) => void): Promise<void> {
    const loader = new GLTFLoader()
    const scene = new Scene()
    scene.add(new AmbientLight(0xffffff, 0.35))
    scene.add(new HemisphereLight(0xffffff, 0x8080a0, 0.7))
    const sun = new DirectionalLight(0xffffff, 1.6)
    sun.position.set(3, 6, 4)
    scene.add(sun)
    const holder = new Group()
    scene.add(holder)

    this.rt = new WebGLRenderTarget(ATLAS_SIZE, ATLAS_SIZE, { format: RGBAFormat, minFilter: retro ? NearestFilter : LinearFilter, magFilter: retro ? NearestFilter : LinearFilter, generateMipmaps: false, colorSpace: SRGBColorSpace })
    const prevTarget = renderer.getRenderTarget()
    const prevClear = renderer.autoClear
    const prevViewport = renderer.getViewport(new Vector4())
    const prevClearColor = renderer.getClearColor(new Color())
    const prevClearAlpha = renderer.getClearAlpha()
    renderer.setRenderTarget(this.rt)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.autoClear = false

    // Shelf packer.
    let shelfY = 0
    let shelfH = 0
    let cursorX = 0
    const place = (size: number) => {
      if (cursorX + size > ATLAS_SIZE) {
        cursorX = 0
        shelfY += shelfH
        shelfH = 0
      }
      if (shelfY + size > ATLAS_SIZE) console.warn(`sprite atlas overflow: ${ATLAS_SIZE}px is too small for the manifest`)
      const cell = { x: cursorX, y: shelfY, size }
      cursorX += size
      shelfH = Math.max(shelfH, size)
      return cell
    }

    let done = 0
    // Big cells first: shelf packing wastes far less that way.
    const order = [...MODELS].sort((a, b) => b.cell - a.cell)
    for (const def of order) {
      let model: Object3D | null = null
      if (def.build) model = def.build()
      else {
        try {
          const gltf = await loader.loadAsync(def.file)
          model = gltf.scene
        } catch (err) {
          console.warn(`sprite bake: ${def.file} failed, using placeholder`, err)
          model = placeholder(def)
        }
      }
      // Flat-shaded, no textures beyond the kit's colour map: keep it crisp.
      model.traverse((o) => {
        const m = o as Mesh
        if (m.isMesh) {
          const mats = Array.isArray(m.material) ? m.material : [m.material]
          for (const mat of mats) {
            const sm = mat as MeshStandardMaterial
            if (sm.isMeshStandardMaterial) {
              sm.flatShading = true
              sm.metalness = Math.min(sm.metalness, 0.2)
              sm.needsUpdate = true
            }
          }
        }
      })
      holder.clear()
      holder.add(model)
      const box = new Box3().setFromObject(model)
      const size = new Vector3()
      box.getSize(size)
      const scale = (def.heightM / Math.max(1e-3, size.y)) * (def.fit ?? 1)
      model.scale.setScalar(scale)
      model.position.set(-((box.min.x + box.max.x) / 2) * scale, -box.min.y * scale, -((box.min.z + box.max.z) / 2) * scale)
      const fitted = new Box3().setFromObject(model)
      const fs = new Vector3()
      fitted.getSize(fs)
      const radius = Math.max(fs.x, fs.z) * 0.5
      const frames: SpriteFrame[] = []
      for (const yaw of def.yaws) {
        const cell = place(def.cell)
        // Camera behind the model looking forward (+z is the model's front in the kits), slightly from above.
        const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200)
        const yawR = (yaw * Math.PI) / 180
        const pitch = 0.16
        cam.position.set(Math.sin(yawR) * 40, fs.y / 2 + Math.sin(pitch) * 40, -Math.cos(yawR) * 40)
        cam.lookAt(0, fs.y / 2, 0)
        const halfW = Math.max(radius, fs.y / 2) * 1.02
        const halfH = fs.y / 2 * 1.02 + Math.sin(pitch) * radius
        const half = Math.max(halfW, halfH)
        cam.left = -half
        cam.right = half
        cam.top = half
        cam.bottom = -half
        cam.updateProjectionMatrix()
        renderer.setViewport(cell.x, cell.y, cell.size, cell.size)
        renderer.setScissor(cell.x, cell.y, cell.size, cell.size)
        renderer.setScissorTest(true)
        renderer.render(scene, cam)
        frames.push({
          u0: cell.x / ATLAS_SIZE,
          v0: cell.y / ATLAS_SIZE,
          u1: (cell.x + cell.size) / ATLAS_SIZE,
          v1: (cell.y + cell.size) / ATLAS_SIZE,
          widthM: half * 2,
          heightM: half * 2,
          baseline: 0.5 - fs.y / 2 / (half * 2) - (Math.sin(pitch) * radius) / (half * 2) * 0.5,
        })
      }
      this.kinds.set(def.kind, { def, frames, yaws: def.yaws })
      done++
      onProgress?.(done, MODELS.length)
    }
    renderer.setScissorTest(false)
    renderer.setRenderTarget(prevTarget)
    renderer.setViewport(prevViewport)
    renderer.setClearColor(prevClearColor, prevClearAlpha)
    renderer.autoClear = prevClear
    this.texture = this.rt.texture
    this.ready = true
    this.fromCache = false
  }
}

/** A coloured box stand-in when a model fails to load. */
function placeholder(def: ModelDef): Object3D {
  const g = new Group()
  const box = new Mesh(new BoxGeometry(1, def.heightM, 1), new MeshStandardMaterial({ color: 0xff00ff }))
  box.position.y = def.heightM / 2
  g.add(box)
  return g
}
