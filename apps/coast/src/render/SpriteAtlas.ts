// Bakes 3D models into a sprite atlas at startup: each (kind, yaw) is rendered
// with an orthographic camera into its own atlas cell, so the runtime is pure
// sprite scaling — the 2.5D look — while the art comes from real meshes.

import { AmbientLight, Box3, BoxGeometry, Color, Vector4, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderTarget, type Texture, type WebGLRenderer, NearestFilter, LinearFilter, RGBAFormat } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { isTouchDevice } from '@apex/engine/app/platform'

import { atlasSizeFor, cellSize, MODELS, type ModelDef } from './models'
import { ensureFonts } from './procgen'
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
  /** frames[pitchIndex * yaws.length + yawIndex] */
  frames: SpriteFrame[]
  yaws: number[]
  pitches: number[]
}

/**
 * How far back the bake camera stands, in multiples of the subject's own framed size. Small is a
 * fisheye, huge is the isometric look this replaced; six and a half is about a long lens on a model
 * on a table, which is what these sprites are pretending to be.
 */
const LENS = 6.5

/** Camera pitch (degrees above horizontal) baked for models that declare none. */
export const DEFAULT_PITCH = 9

/** The biggest atlas we will ask any device for. */
const MAX_ATLAS = 4096
/**
 * What a modest phone gets. A 4096² target is 64 MB of GPU memory, and the same again to read back
 * for the cache; a device with little memory would rather have half the cell size, which is plenty on
 * a 6-inch screen. A phone that reports 4 GB or more keeps the full-size atlas.
 */
const SMALL_DEVICE_ATLAS = 2048

/** The atlas size this device will actually give us, and the cell scale that fits the manifest into it. */
export function atlasPlan(renderer: WebGLRenderer): { size: number; cellScale: number; cap: number } {
  const gpuCap = renderer.capabilities.maxTextureSize || MAX_ATLAS
  // ?atlas=1024 forces a size, for pinning down a device that renders sprites wrongly.
  const forced = Number(new URLSearchParams(location.search).get('atlas'))
  const memoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  const modest = isTouchDevice() && memoryGb < 4
  const cap = Math.min(gpuCap, forced > 0 ? forced : modest ? SMALL_DEVICE_ATLAS : MAX_ATLAS)
  let cellScale = 1
  for (let i = 0; i < 4; i++) {
    const size = atlasSizeFor(MODELS, cellScale)
    if (size <= cap) return { size, cellScale, cap }
    cellScale /= 2
  }
  return { size: cap, cellScale: 0.125, cap }
}

export class SpriteAtlas {
  readonly kinds = new Map<string, SpriteKind>()
  texture: Texture | null = null
  ready = false
  /** The atlas actually baked: its size in pixels and the cell scale it used. */
  size = 0
  cellScale = 1
  private rt: WebGLRenderTarget | null = null

  /** The render target the atlas lives in, for anything that needs to read it back. */
  get target(): WebGLRenderTarget | null {
    return this.rt
  }

  /** Frame for a kind at a view yaw and camera pitch (degrees), or null when unknown. Nearest baked pose. */
  frame(kind: string, yaw = 0, pitch = DEFAULT_PITCH): SpriteFrame | null {
    const k = this.kinds.get(kind)
    if (!k) return null
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < k.yaws.length; i++) {
      let d = Math.abs(k.yaws[i] - yaw)
      if (d > 180) d = 360 - d
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    let bp = 0
    bestD = Infinity
    for (let i = 0; i < k.pitches.length; i++) {
      const d = Math.abs(k.pitches[i] - pitch)
      if (d < bestD) {
        bestD = d
        bp = i
      }
    }
    return k.frames[bp * k.yaws.length + best]
  }

  /** Whether the last bake() came from the IndexedDB cache. */
  fromCache = false

  async bake(renderer: WebGLRenderer, retro: boolean, onProgress?: (done: number, total: number) => void): Promise<void> {
    const plan = atlasPlan(renderer)
    this.size = plan.size
    this.cellScale = plan.cellScale
    const key = atlasKey(plan.size, plan.cellScale)
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
    // Never cache a bake the GPU gave up on: a black atlas written to IndexedDB would come back
    // every load until the bake version changed.
    if (this.rt && !renderer.getContext().isContextLost()) void saveCachedAtlas(key, renderer, this.rt, this.kinds, this.size)
  }

  /** The actual bake: load every model and render its cells into the atlas target. */
  private async render(renderer: WebGLRenderer, retro: boolean, onProgress?: (done: number, total: number) => void): Promise<void> {
    await ensureFonts()
    const loader = new GLTFLoader()
    const scene = new Scene()
    scene.add(new AmbientLight(0xffffff, 0.35))
    scene.add(new HemisphereLight(0xffffff, 0x8080a0, 0.7))
    const sun = new DirectionalLight(0xffffff, 1.6)
    sun.position.set(3, 6, 4)
    scene.add(sun)
    const holder = new Group()
    scene.add(holder)

    const prevTarget = renderer.getRenderTarget()
    const prevClear = renderer.autoClear
    const prevViewport = renderer.getViewport(new Vector4())
    const prevClearColor = renderer.getClearColor(new Color())
    const prevClearAlpha = renderer.getClearAlpha()
    const prevPixelRatio = renderer.getPixelRatio()
    // Atlas cells are texels, not CSS pixels. setViewport and setScissor multiply by the renderer's
    // pixel ratio, so on a phone every cell was drawn 2.6× its size, spilling over its neighbours,
    // while the frames still pointed at the cell it was supposed to fit in — which is why sprites
    // came out as the wrong slice of the atlas on a high-DPI screen and were perfect at ratio 1.
    renderer.setPixelRatio(1)
    // Ask for the planned size, then check the driver actually gave us something to draw into. A
    // framebuffer it quietly refused takes every render that follows and produces nothing, and the
    // sprites come out as black rectangles — with no error anywhere, which is what a phone did.
    let atlasPx = this.size || atlasPlan(renderer).size
    const gl = renderer.getContext()
    for (;;) {
      this.rt?.dispose()
      this.rt = new WebGLRenderTarget(atlasPx, atlasPx, { format: RGBAFormat, minFilter: retro ? NearestFilter : LinearFilter, magFilter: retro ? NearestFilter : LinearFilter, generateMipmaps: false, colorSpace: SRGBColorSpace })
      renderer.setRenderTarget(this.rt)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      if (status === gl.FRAMEBUFFER_COMPLETE || atlasPx <= 512) break
      console.warn(`sprite atlas: the GPU would not give us a ${atlasPx}px target (status 0x${status.toString(16)}); trying ${atlasPx / 2}px`)
      atlasPx /= 2
      this.cellScale /= 2
    }
    this.size = atlasPx
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.autoClear = false

    // Shelf packer.
    let shelfY = 0
    let shelfH = 0
    let cursorX = 0
    const place = (cell: number) => {
      if (cursorX + cell > atlasPx) {
        cursorX = 0
        shelfY += shelfH
        shelfH = 0
      }
      if (shelfY + cell > atlasPx) console.warn(`sprite atlas overflow: ${atlasPx}px is too small for the manifest`)
      const placed = { x: cursorX, y: shelfY, size: cell }
      cursorX += cell
      shelfH = Math.max(shelfH, cell)
      return placed
    }

    let done = 0
    // Big cells first: shelf packing wastes far less that way.
    const order = [...MODELS].sort((a, b) => b.cell - a.cell)
    for (const def of order) {
      // Hand the frame back between models. Baking every cell in one go blocks the main thread for
      // seconds on a phone, which is long enough for the browser to decide the page is wedged and
      // drop the GL context — and a dropped context bakes a black atlas.
      if (done) await new Promise<void>((r) => requestAnimationFrame(() => r()))
      if (renderer.getContext().isContextLost()) {
        console.warn('sprite bake: the GL context went away part way through')
        break
      }
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
      const frames: SpriteFrame[] = []
      const pitches = def.pitches ?? [DEFAULT_PITCH]
      for (const pitchDeg of pitches) for (const yaw of def.yaws) {
        const cell = place(cellSize(def, this.cellScale))
        const yawR = (yaw * Math.PI) / 180
        const pitch = (pitchDeg * Math.PI) / 180
        // Fit the frame to what this view actually shows (a car from behind is half as wide as
        // from the side) so the cell's pixels go on the car, not on empty margin.
        const projW = Math.abs(Math.cos(yawR)) * fs.x + Math.abs(Math.sin(yawR)) * fs.z
        const projD = Math.abs(Math.sin(yawR)) * fs.x + Math.abs(Math.cos(yawR)) * fs.z
        const halfW = Math.max(projW / 2, fs.y / 2) * 1.02
        const halfH = (fs.y / 2) * 1.02 + Math.sin(pitch) * (projD / 2)
        const subject = Math.max(halfW, halfH)
        // Perspective, not orthographic. An ortho bake gives the near and far ends of a car exactly
        // the same width, which is why these sprites read as isometric drawings rather than as
        // photographs of a model — and photographs of models is what the arcade sprites of the era
        // were. So: a long lens a few subject-widths back, the same lens for everything from a
        // wheel to a tower, and the frame still measured at the model's centre plane so nothing
        // downstream has to know the difference.
        const dist = subject * LENS
        // The near half of the model projects larger than the centre plane does, so the frame has to
        // open up by that much or the nose comes off against the edge of the cell.
        const half = subject * (dist / Math.max(dist * 0.4, dist - projD / 2))
        const cam = new PerspectiveCamera(2 * Math.atan(half / dist) * (180 / Math.PI), 1, dist * 0.15, dist + projD + fs.y + 10)
        const horiz = dist * Math.cos(pitch)
        cam.position.set(Math.sin(yawR) * horiz, fs.y / 2 + Math.sin(pitch) * dist, -Math.cos(yawR) * horiz)
        cam.lookAt(0, fs.y / 2, 0)
        cam.updateProjectionMatrix()
        renderer.setViewport(cell.x, cell.y, cell.size, cell.size)
        renderer.setScissor(cell.x, cell.y, cell.size, cell.size)
        renderer.setScissorTest(true)
        renderer.render(scene, cam)
        frames.push({
          u0: cell.x / atlasPx,
          v0: cell.y / atlasPx,
          u1: (cell.x + cell.size) / atlasPx,
          v1: (cell.y + cell.size) / atlasPx,
          widthM: half * 2,
          heightM: half * 2,
          baseline: 0.5 - fs.y / 2 / (half * 2) - ((Math.sin(pitch) * projD) / 2 / (half * 2)) * 0.5,
        })
      }
      this.kinds.set(def.kind, { def, frames, yaws: def.yaws, pitches })
      done++
      onProgress?.(done, MODELS.length)
    }
    renderer.setScissorTest(false)
    renderer.setRenderTarget(prevTarget)
    renderer.setPixelRatio(prevPixelRatio)
    renderer.setViewport(prevViewport)
    renderer.setClearColor(prevClearColor, prevClearAlpha)
    renderer.autoClear = prevClear
    this.texture = this.rt.texture
    this.ready = true
    this.fromCache = false
    if (renderer.capabilities.maxTextureSize) {
      console.info(
        `%c[atlas] ${atlasPx}px, cells ×${this.cellScale}, GPU max ${renderer.capabilities.maxTextureSize}px`,
        'color:#39ff81',
      )
    }
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
