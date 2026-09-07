// The pseudo-3D pass. Everything is drawn in a logical screen space with an
// orthographic camera: sky and parallax layers, then the road as trapezoids
// far → near, then sprites far → near with hill clipping, then the player car
// or the cockpit. The sim is never touched.

import { Color, LinearFilter, NearestFilter, OrthographicCamera, Scene, WebGLRenderer } from 'three'
import type { RenderStats } from '@apex/engine/render/RenderStats'
import type { Style, StyleFrameInfo } from '@apex/engine/render/styles/Style'
import type { SimEvent } from '../sim/Events'
import type { Segment, Stage } from '../sim/Road'
import type { Snapshot } from '../sim/Snapshot'
import { TRAFFIC_KINDS } from '../sim/Sim'
import { THEMES } from '../sim/Stages'
import { BAND_SEGMENTS, DRAW_SEGMENTS, FORK_SPREAD, ROAD_HALF_WIDTH, SEG_LENGTH } from '../sim/Tuning'
import { Background } from './Background'
import { Cockpit } from './Cockpit'
import { Projection } from './Projection'
import { CURVE_UNIT, FOG_MODERN, FOG_RETRO, HEADLIGHT_REACH, LANE_WIDTH, LOGICAL_HEIGHT, MAX_SPRITES, NIGHT_AMBIENT, PALETTES, RAIL_HEIGHT, RUMBLE_WIDTH, SHOULDER_WIDTH, VIEWS, type Palette } from './RenderTuning'
import { LIVERIES } from './procgen'
import { Rain } from './Rain'
import type { Theme } from '../sim/Road'
import { RoadMesh } from './RoadMesh'
import { SpriteAtlas } from './SpriteAtlas'
import { SpriteBatch } from './SpriteBatch'

export type ViewMode = keyof typeof VIEWS

const ROWS = DRAW_SEGMENTS + 2

export class RenderWorld {
  readonly renderer: WebGLRenderer
  readonly scene = new Scene()
  readonly camera = new OrthographicCamera(0, 320, 224, 0, -10, 10)
  readonly proj = new Projection()
  readonly atlas = new SpriteAtlas()
  readonly road = new RoadMesh()
  readonly sprites = new SpriteBatch(MAX_SPRITES)
  readonly background = new Background()
  readonly cockpit = new Cockpit()
  readonly rain = new Rain()
  private theme: Theme | null = null
  private heroKind = 'hero_gulf'
  readonly stats: RenderStats = { drawCalls: 0, triangles: 0, chunks: 0 }
  style: Style | null = null
  view: ViewMode = 'chase'
  stage: Stage | null = null
  palette: Palette = PALETTES.coast
  private retro = false
  private width = 1
  private height = 1
  private pixelRatio = 1
  private time = 0
  private camY = 0
  private bounce = 0
  private readonly info: StyleFrameInfo = { speedT: 0, boost: 0, shockAge: -1, dt: 0, time: 0, shield: 100, hit: 0 }
  // Per-row projection scratch (near → far).
  private readonly rowX = new Float32Array(ROWS)
  private readonly rowY = new Float32Array(ROWS)
  private readonly rowScale = new Float32Array(ROWS)
  private readonly rowValid = new Uint8Array(ROWS)
  private readonly rowClip = new Float32Array(ROWS)
  private readonly rowFog = new Float32Array(ROWS)
  private readonly segVisible = new Uint8Array(ROWS)
  private readonly carOrder: number[] = []
  private themeId = ''
  private hit = 0

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false })
    this.renderer.info.autoReset = false
    this.renderer.setClearColor(new Color(0x000000), 1)
    this.scene.add(this.background.sky, this.background.clouds, this.background.far, this.background.near, this.road.mesh, this.sprites.mesh, this.rain.mesh, this.cockpit.mesh)
    this.background.sky.renderOrder = 0
    this.background.clouds.renderOrder = 1
    this.background.far.renderOrder = 2
    this.background.near.renderOrder = 3
    this.road.mesh.renderOrder = 4
    this.sprites.mesh.renderOrder = 5
    this.rain.mesh.renderOrder = 6
    this.cockpit.mesh.renderOrder = 7
  }

  async bake(onProgress?: (d: number, t: number) => void): Promise<void> {
    await this.atlas.bake(this.renderer, this.retro, onProgress)
    if (this.atlas.texture) this.sprites.setAtlas(this.atlas.texture)
    // The bake drives the renderer directly; put the main output back the way the style wants it.
    this.resize(this.width, this.height, this.pixelRatio)
    this.renderer.setClearColor(new Color(this.palette.skyBottom), 1)
  }

  setStage(stage: Stage): void {
    this.stage = stage
    const theme = THEMES[stage.desc.theme]
    this.theme = theme
    this.palette = PALETTES[theme.palette] ?? PALETTES.coast
    this.background.setPalette(this.palette, theme.backdrop, this.retro)
    this.road.setFog(this.palette.fog)
    this.sprites.setFog(this.palette.fog)
    this.renderer.setClearColor(new Color(this.palette.skyBottom), 1)
    this.themeId = theme.id
    this.cockpit.rain = Boolean(theme.rain)
    this.cockpit.night = Boolean(theme.night)
    this.rain.enabled = Boolean(theme.rain)
  }

  /** Hero car: a prototype livery id or 'formula'. */
  setCar(id: string): void {
    this.heroKind = id === 'formula' ? 'formula' : `hero_${id in LIVERIES ? id : 'gulf'}`
    this.cockpit.livery = LIVERIES[id] ?? LIVERIES.gulf
  }

  setStyle(style: Style): void {
    this.style?.detach()
    this.style = style
    style.attach(this.renderer, this.scene, this.camera)
    this.retro = style.name === 'retro'
    this.cockpit.setRetro(this.retro)
    if (this.atlas.texture) this.atlas.texture.minFilter = this.atlas.texture.magFilter = this.retro ? NearestFilter : LinearFilter
    if (this.atlas.texture) this.atlas.texture.needsUpdate = true
    if (this.stage) this.background.setPalette(this.palette, THEMES[this.stage.desc.theme].backdrop, this.retro)
    this.resize(this.width, this.height, this.pixelRatio)
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = width
    this.height = height
    this.pixelRatio = pixelRatio
    // Logical resolution: arcade height in retro, sharper in modern.
    const H = this.retro ? LOGICAL_HEIGHT : 448
    const W = Math.round((H * width) / Math.max(1, height))
    this.proj.width = W
    this.proj.height = H
    this.camera.left = 0
    this.camera.right = W
    this.camera.top = H
    this.camera.bottom = 0
    this.camera.updateProjectionMatrix()
    this.cockpit.layout(W, H)
    this.rain.layout(W, H)
    this.style?.resize(width, height, pixelRatio)
  }

  onEvent(e: SimEvent): void {
    if (e.type === 'crash') this.hit = 1
    if (e.type === 'bump') this.hit = Math.max(this.hit, 0.5)
  }

  update(prev: Snapshot, curr: Snapshot, alpha: number, dt: number): void {
    this.time += dt
    const stage = this.stage
    if (!stage) return
    const a = prev.tick < curr.tick && prev.stageId === curr.stageId ? alpha : 1
    const z = prev.z + (curr.z - prev.z) * a
    const x = prev.x + (curr.x - prev.x) * a
    const speed = curr.speed
    const view = VIEWS[this.view]
    const P = this.proj
    const W = P.width
    const H = P.height

    // Camera follows the road height under the player, smoothly; bounce with speed.
    const groundY = stage.heightAt(z)
    const targetCamY = groundY + view.camHeight
    this.camY = this.camY === 0 ? targetCamY : this.camY + (targetCamY - this.camY) * Math.min(1, dt * 8)
    this.bounce = speed > 5 ? Math.sin(this.time * 28) * 0.05 * (speed / 84) : 0
    const camY = this.camY + this.bounce
    const camZ = z - view.playerAhead
    const camX = x * ROAD_HALF_WIDTH
    const base = Math.max(0, Math.floor(camZ / SEG_LENGTH))
    const pct = (camZ - base * SEG_LENGTH) / SEG_LENGTH
    const segs = stage.segments
    const last = segs.length - 1
    const fogK = this.retro ? FOG_RETRO : FOG_MODERN

    // Pass 1, near → far: accumulate the curve, project rows, resolve hill clipping.
    let xOff = 0
    let dx = -(segs[Math.min(base, last)].curve * CURVE_UNIT * pct)
    let maxY = -Infinity
    for (let n = 0; n <= DRAW_SEGMENTS; n++) {
      const seg = segs[Math.min(base + n, last)]
      let zRel = (base + n) * SEG_LENGTH - camZ
      // The row under the camera projects behind it; pin it just in front so the
      // nearest quad always reaches the bottom of the screen instead of popping.
      if (n === 0 && zRel < 0.6) zRel = 0.6
      if (zRel < 0.3) {
        this.rowValid[n] = 0
      } else {
        const scale = P.scaleAt(zRel)
        this.rowScale[n] = scale
        this.rowX[n] = P.screenX(xOff - camX, scale)
        this.rowY[n] = P.screenY(seg.y0 - camY, scale)
        this.rowValid[n] = 1
        this.rowFog[n] = 1 - Math.exp(-((zRel * fogK) ** 2))
      }
      this.rowClip[n] = maxY
      // A segment is visible when its far edge rises above everything nearer.
      this.segVisible[n] = 0
      if (n > 0 && this.rowValid[n - 1] && this.rowValid[n] && this.rowY[n] > maxY) {
        this.segVisible[n - 1] = 1
        maxY = this.rowY[n]
      }
      xOff += dx
      dx += seg.curve * CURVE_UNIT
    }

    // Pass 2, far → near: grass, shoulders, rumble, tarmac, lanes, guardrails.
    // At night everything outside the headlight cone falls to NIGHT_AMBIENT.
    this.road.begin()
    const pal = this.palette
    const night = Boolean(this.theme?.night)
    const lanes = this.theme?.lanes ?? 3
    const rails = Boolean(this.theme?.rails)
    for (let n = DRAW_SEGMENTS - 1; n >= 0; n--) {
      if (!this.segVisible[n]) continue
      const seg = segs[Math.min(base + n, last)]
      const band = Math.floor((base + n) / BAND_SEGMENTS) % 2
      const x1 = this.rowX[n]
      const y1 = this.rowY[n]
      const s1 = this.rowScale[n]
      const x2 = this.rowX[n + 1]
      const y2 = this.rowY[n + 1]
      const s2 = this.rowScale[n + 1]
      const fog = this.rowFog[n]
      const zRel = (base + n) * SEG_LENGTH - camZ
      const dim = night ? NIGHT_AMBIENT + (1 - NIGHT_AMBIENT) * Math.exp(-zRel / HEADLIGHT_REACH) : 1
      this.road.setDim(dim)
      this.road.quad(W / 2, y1, W, W / 2, y2, W, band ? pal.grassA : pal.grassB, fog)
      const roads = seg.fork >= 0 ? 2 : 1
      const spread = seg.fork >= 0 ? seg.fork * FORK_SPREAD * ROAD_HALF_WIDTH : 0
      for (let r = 0; r < roads; r++) {
        const side = roads === 2 ? (r === 0 ? -1 : 1) : 0
        const cx1 = x1 + side * spread * s1
        const cx2 = x2 + side * spread * s2
        const w1 = ROAD_HALF_WIDTH * s1
        const w2 = ROAD_HALF_WIDTH * s2
        this.road.quad(cx1, y1, w1 + (RUMBLE_WIDTH + SHOULDER_WIDTH) * s1, cx2, y2, w2 + (RUMBLE_WIDTH + SHOULDER_WIDTH) * s2, pal.shoulder, fog)
        this.road.quad(cx1, y1, w1 + RUMBLE_WIDTH * s1, cx2, y2, w2 + RUMBLE_WIDTH * s2, band ? pal.rumbleA : pal.rumbleB, fog)
        this.road.quad(cx1, y1, w1, cx2, y2, w2, band ? pal.roadA : pal.roadB, fog)
        // Solid edge lines, dashed lane dividers.
        for (const e of [-1, 1]) this.road.quad(cx1 + e * (w1 - LANE_WIDTH * s1 * 1.5), y1, LANE_WIDTH * s1 * 0.8, cx2 + e * (w2 - LANE_WIDTH * s2 * 1.5), y2, LANE_WIDTH * s2 * 0.8, pal.lane, fog)
        if (band) {
          for (let l = 1; l < lanes; l++) {
            const f = -1 + (2 * l) / lanes
            this.road.quad(cx1 + f * w1, y1, LANE_WIDTH * s1, cx2 + f * w2, y2, LANE_WIDTH * s2, pal.lane, fog)
          }
        }
        if (rails && seg.fork < 0) {
          // Guardrail: a thin bright band standing RAIL_HEIGHT above the shoulder edge, with a dark post every other segment.
          for (const e of [-1, 1]) {
            const rx1 = cx1 + e * (w1 + (RUMBLE_WIDTH + 0.6) * s1)
            const rx2 = cx2 + e * (w2 + (RUMBLE_WIDTH + 0.6) * s2)
            this.road.quad(rx1, y1 + RAIL_HEIGHT * s1 * 0.75, 0.12 * s1, rx2, y2 + RAIL_HEIGHT * s2 * 0.75, 0.12 * s2, pal.rail, fog)
            if (band) this.road.quad(rx1, y1, 0.08 * s1, rx1, y1 + RAIL_HEIGHT * s1, 0.08 * s1, 0x444444, fog)
          }
        }
      }
    }
    this.road.setDim(1)
    this.road.end()

    // Pass 3, far → near: scenery and traffic sprites.
    this.sprites.begin()
    const carOrder = this.carOrder
    carOrder.length = 0
    for (let i = 0; i < curr.trafficCount; i++) carOrder.push(i)
    carOrder.sort((i, j) => curr.trafficZ[j] - curr.trafficZ[i])
    let carPtr = 0
    for (let n = DRAW_SEGMENTS - 1; n >= 0; n--) {
      if (!this.rowValid[n]) continue
      const seg = segs[Math.min(base + n, last)]
      const clip = Math.max(this.rowClip[n], -1e9)
      // Cars whose z falls in this segment.
      const zStart = (base + n) * SEG_LENGTH
      while (carPtr < carOrder.length && curr.trafficZ[carOrder[carPtr]] >= zStart) {
        const ci = carOrder[carPtr++]
        const cz = curr.trafficZ[ci]
        if (cz < zStart + SEG_LENGTH && this.rowValid[n + 1]) {
          const t = (cz - zStart) / SEG_LENGTH
          const sc = this.rowScale[n] + (this.rowScale[n + 1] - this.rowScale[n]) * t
          const sx = this.rowX[n] + (this.rowX[n + 1] - this.rowX[n]) * t
          const sy = this.rowY[n] + (this.rowY[n + 1] - this.rowY[n]) * t
          const kind = TRAFFIC_KINDS[curr.trafficKind[ci]]
          const rel = curr.trafficX[ci] - x
          const frame = this.atlas.frame(kind, rel > 0.3 ? -20 : rel < -0.3 ? 20 : 0)
          if (frame) this.sprites.add(sx + curr.trafficX[ci] * ROAD_HALF_WIDTH * sc, sy, frame.heightM * sc, frame, this.rowFog[n], this.brightAt((base + n) * SEG_LENGTH - camZ), clip)
        }
      }
      if (seg.runway) continue
      this.drawSegmentSprites(seg, n, clip, this.brightAt((base + n) * SEG_LENGTH - camZ))
    }
    // Player car.
    if (view.drawPlayer) {
      const scale = P.scaleAt(view.playerAhead)
      const py = P.screenY(groundY - camY, scale)
      let steerFrame = Math.round(curr.steer * 3)
      if (curr.crashT > 0) steerFrame = Math.round(Math.sin(curr.crashT * 40) * 3)
      // Baked yaw > 0 shows the car's right flank (nose left); steering right must show the left flank.
      const yaw = steerFrame === 0 ? 0 : steerFrame > 0 ? -[12, 24, 38][steerFrame - 1] : [12, 24, 38][-steerFrame - 1]
      const frame = this.atlas.frame(this.heroKind, yaw)
      if (frame) this.sprites.add(W / 2 + curr.steer * 2, py + (curr.crashT > 0 ? Math.abs(Math.sin(curr.crashT * 20)) * 12 : 0), frame.heightM * scale, frame, 0, 1, -1e9)
    }
    this.sprites.end()

    // Background parallax and horizon.
    const slopeAhead = stage.heightAt(z + 60) - groundY
    this.background.layout(W, H, H / 2 - slopeAhead * 0.9 - (this.camY - groundY - view.camHeight) * 0.5)
    this.background.update(curr.curveAccum, groundY)
    this.cockpit.mesh.visible = this.view === 'cockpit'
    if (this.cockpit.mesh.visible) this.cockpit.update(curr, dt)
    this.rain.update(dt, speed, curr.curveAccum)
    this.background.updateClouds(dt, speed)

    this.hit = Math.max(0, this.hit - dt * 3)
    const info = this.info
    info.speedT = speed / 84 - 0.3
    info.boost = curr.hud.turboActive ? 1 : 0
    info.dt = dt
    info.time = this.time
    info.hit = this.hit
    this.stats.chunks = this.atlas.kinds.size
  }

  private brightAt(zRel: number): number {
    if (!this.theme?.night) return 1
    return NIGHT_AMBIENT + (1 - NIGHT_AMBIENT) * Math.exp(-Math.max(0, zRel) / HEADLIGHT_REACH)
  }

  private drawSegmentSprites(seg: Segment, n: number, clip: number, bright: number): void {
    const sc = this.rowScale[n]
    for (const sp of seg.sprites) {
      const frame = this.atlas.frame(sp.kind)
      if (!frame) continue
      const sx = this.rowX[n] + sp.offset * ROAD_HALF_WIDTH * sc
      // Lit signage and towers glow through the night.
      const glow = sp.kind.startsWith('sign') || sp.kind.startsWith('tower') || sp.kind === 'diner' || sp.kind === 'motel' || sp.kind === 'gas' || sp.kind === 'arch' ? Math.max(bright, 0.85) : bright
      this.sprites.add(sx, this.rowY[n], frame.heightM * sp.scale * sc, frame, this.rowFog[n], glow, clip)
    }
  }

  render(): void {
    this.renderer.info.reset()
    this.style?.render(this.info)
    this.stats.drawCalls = this.renderer.info.render.calls
    this.stats.triangles = this.renderer.info.render.triangles
  }

  get themeName(): string {
    return this.themeId
  }
}
