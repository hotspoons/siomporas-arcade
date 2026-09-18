// THE ATLAS, BAKED WHILE YOU DRIVE.
//
// `SpriteAtlas` photographs every model once, at a fixed handful of angles, and ships the sheet. This
// does the same job at the same moment you need it: when the sprite pass asks for a car seen from
// 31.4° it photographs the car from 31.4° into a spare cell and hands back the frame. Same standing-up,
// same lens, same distance, same lights — all of it out of `bakeView`, the file the shipped atlas is
// baked from — so what comes back IS a sprite, not geometry that has been framed to look like one.
//
// WHY A SPRITE AND NOT THE MESH. Drawing the mesh straight into the frame gets the same silhouette and
// throws away everything that makes the thing a sprite: it is no longer a fixed-resolution picture, it
// no longer wears the atlas's filtering or its alpha cut, and it costs its full triangle count every
// frame it is on screen. A cell costs its triangles ONCE and is then a quad — which is the whole point
// of a sprite, and what makes dropping the shipped sheet affordable rather than ruinous.
//
// The cache is what does that. Roadside scenery is always seen from one angle, so it is photographed
// on its first frame and never again. What varies is traffic and the player's car, and those move
// slowly enough through the angles that a frame's misses are a handful of cells, not a sheet.

import { AmbientLight, Color, DirectionalLight, Group, HemisphereLight, LinearFilter, NearestFilter, Object3D, PerspectiveCamera, RGBAFormat, Scene, SRGBColorSpace, Vector3, Vector4, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three'

import { bakeView } from './bakeView'
import { MODEL_BY_KIND } from './models'
import { DEFAULT_PITCH, type SpriteFrame } from './SpriteAtlas'

/**
 * How finely the angles are quantised before a cell is reused, in degrees. The shipped sheet steps
 * through sixteen yaws — 22.5° apart, which is what makes a turning car visibly click from one pose to
 * the next. Three degrees is seven times finer and reads as continuous, while still letting a car hold
 * the same cell for most of a second.
 */
const YAW_STEP = 3
const PITCH_STEP = 2
/** Cells are one size here, so the packer is a grid and eviction is a counter rather than a puzzle. */
const CELL = 192
/** Cells to photograph in one frame. A miss draws stale for a frame rather than dropping one. */
const PER_FRAME = 12

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

interface Slot {
  frame: SpriteFrame
  /** The frame number this cell was last asked for, for eviction. */
  used: number
  key: string
}

export class LiveAtlas {
  private rt: WebGLRenderTarget | null = null
  private readonly scene = new Scene()
  private readonly holder = new Group()
  private readonly camera = new PerspectiveCamera(20, 1, 0.1, 100)
  /** Fitted models and their extents, handed over by whoever loaded them. */
  private models = new Map<string, { model: Object3D; fs: Vector3 }>()
  private readonly slots = new Map<string, Slot>()
  private readonly queue: { key: string; kind: string; yaw: number; pitch: number; cell: { x: number; y: number } }[] = []
  private cells = 0
  private cols = 0
  private next = 0
  private tick = 0
  size = 0

  constructor() {
    // The bake's lights, to the value, or a live cell is the same model under different weather.
    this.scene.add(new AmbientLight(0xffffff, 0.35))
    this.scene.add(new HemisphereLight(0xffffff, 0x8080a0, 0.7))
    const sun = new DirectionalLight(0xffffff, 1.6)
    sun.position.set(3, 6, 4)
    this.scene.add(sun)
    this.scene.add(this.holder)
  }

  get texture(): Texture | null {
    return this.rt?.texture ?? null
  }

  get ready(): boolean {
    return this.rt !== null && this.models.size > 0
  }

  /** The models to photograph, standing as `fitModel` left them. */
  setModels(models: Map<string, { model: Object3D; fs: Vector3 }>): void {
    this.models = models
    this.slots.clear()
    this.queue.length = 0
    this.next = 0
  }

  /** Allocate the sheet. `retro` picks the filtering the shipped atlas uses at this style. */
  init(renderer: WebGLRenderer, retro: boolean, size = 2048): void {
    if (this.rt && this.size === size) return
    this.rt?.dispose()
    const cap = renderer.capabilities.maxTextureSize
    this.size = Math.min(size, cap)
    this.rt = new WebGLRenderTarget(this.size, this.size, {
      format: RGBAFormat,
      minFilter: retro ? NearestFilter : LinearFilter,
      magFilter: retro ? NearestFilter : LinearFilter,
      generateMipmaps: false,
      colorSpace: SRGBColorSpace,
    })
    this.cols = Math.floor(this.size / CELL)
    this.cells = this.cols * this.cols
    this.slots.clear()
    this.queue.length = 0
    this.next = 0
  }

  begin(): void {
    this.tick++
  }

  /**
   * The frame for this kind at this angle, photographing it first if nobody has lately. Returns null
   * when the model is not loaded, so the caller can fall back to the shipped sheet.
   */
  frame(kind: string, yawDeg: number, pitchDeg: number): SpriteFrame | null {
    const entry = this.models.get(kind)
    if (!entry || !this.rt) return null
    // ONLY FROM ANGLES THE MANIFEST DECLARES. A sprite is a flat card standing upright, so a view from
    // steeply above cannot be drawn as one looking down — it reads as the model tipped over backwards,
    // and a car you are drawing alongside asks for 45°. The shipped sheet never showed that because it
    // only ever held the angles the kind lists; a sheet that will photograph anything has to be told.
    const def = MODEL_BY_KIND[kind]
    const yaws = def?.yaws?.length ? def.yaws : [0]
    const pitches = def?.pitches?.length ? def.pitches : [DEFAULT_PITCH]
    const yaw = yaws.length === 1 ? yaws[0] : clamp(yawDeg, Math.min(...yaws), Math.max(...yaws))
    const pitch = clamp(pitchDeg, Math.min(...pitches), Math.max(...pitches))
    const yq = Math.round(yaw / YAW_STEP) * YAW_STEP
    const pq = Math.round(pitch / PITCH_STEP) * PITCH_STEP
    const key = `${kind}|${yq}|${pq}`
    const hit = this.slots.get(key)
    if (hit) {
      hit.used = this.tick
      return hit.frame
    }
    const cell = this.take(key)
    if (!cell) return null
    const view = bakeView(entry.fs, yq, pq)
    const px = CELL / this.size
    const frame: SpriteFrame = {
      u0: (cell.x * CELL) / this.size,
      v0: (cell.y * CELL) / this.size,
      u1: (cell.x * CELL) / this.size + px,
      v1: (cell.y * CELL) / this.size + px,
      widthM: view.half * 2,
      heightM: view.half * 2,
      baseline: view.baseline,
      nearMag: view.nearMag,
    }
    this.slots.set(key, { frame, used: this.tick, key })
    this.queue.push({ key, kind, yaw: yq, pitch: pq, cell })
    return frame
  }

  /** A free cell, or the one nobody has asked for in longest. */
  private take(key: string): { x: number; y: number } | null {
    if (this.cells === 0) return null
    if (this.next < this.cells) {
      const i = this.next++
      return { x: i % this.cols, y: Math.floor(i / this.cols) }
    }
    let oldest: Slot | null = null
    for (const s of this.slots.values()) if (!oldest || s.used < oldest.used) oldest = s
    // Everything in the sheet is in this frame already: the sheet is too small for the scene, and
    // taking a cell back would tear a sprite that is about to be drawn.
    if (!oldest || oldest.used === this.tick) return null
    const f = oldest.frame
    this.slots.delete(oldest.key)
    void key
    return { x: Math.round((f.u0 * this.size) / CELL), y: Math.round((f.v0 * this.size) / CELL) }
  }

  /** Photograph whatever was asked for this frame. Call before anything draws from the sheet. */
  flush(renderer: WebGLRenderer): void {
    if (!this.rt || this.queue.length === 0) return
    const prevTarget = renderer.getRenderTarget()
    const prevAuto = renderer.autoClear
    const prevViewport = renderer.getViewport(new Vector4())
    const prevScissor = renderer.getScissor(new Vector4())
    const prevScissorTest = renderer.getScissorTest()
    const prevClear = renderer.getClearColor(new Color())
    const prevAlpha = renderer.getClearAlpha()
    const prevRatio = renderer.getPixelRatio()
    // Cells are texels, not CSS pixels: setViewport multiplies by the pixel ratio, and on a phone that
    // draws every cell 2.6× its size, over the top of its neighbours.
    renderer.setPixelRatio(1)
    renderer.setRenderTarget(this.rt)
    renderer.autoClear = false
    renderer.setClearColor(0x000000, 0)
    renderer.setScissorTest(true)
    const budget = Math.min(this.queue.length, PER_FRAME)
    for (let i = 0; i < budget; i++) {
      const job = this.queue[i]
      const entry = this.models.get(job.kind)
      if (!entry) continue
      const view = bakeView(entry.fs, job.yaw, job.pitch)
      this.holder.clear()
      this.holder.add(entry.model)
      this.camera.fov = view.fov
      this.camera.aspect = 1
      this.camera.near = view.near
      this.camera.far = view.far
      this.camera.position.copy(view.eye)
      this.camera.lookAt(view.at)
      this.camera.updateProjectionMatrix()
      renderer.setViewport(job.cell.x * CELL, job.cell.y * CELL, CELL, CELL)
      renderer.setScissor(job.cell.x * CELL, job.cell.y * CELL, CELL, CELL)
      renderer.clear(true, true, false)
      renderer.render(this.scene, this.camera)
    }
    this.holder.clear()
    this.queue.splice(0, budget)
    renderer.setScissorTest(prevScissorTest)
    renderer.setScissor(prevScissor)
    renderer.setViewport(prevViewport)
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(prevClear, prevAlpha)
    renderer.setPixelRatio(prevRatio)
    renderer.autoClear = prevAuto
  }

  dispose(): void {
    this.rt?.dispose()
    this.rt = null
    this.slots.clear()
    this.queue.length = 0
  }
}
