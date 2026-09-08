// The pseudo-3D pass. Everything is drawn in a logical screen space with an
// orthographic camera: sky and parallax layers, then the road as trapezoids
// far → near, then sprites far → near with hill clipping, then the player car
// or the cockpit. The sim is never touched.

import { Color, Group, LinearFilter, NearestFilter, OrthographicCamera, Scene, WebGLRenderer } from 'three'
import { expApproach } from '@apex/engine/math/scalar'
import type { RenderStats } from '@apex/engine/render/RenderStats'
import type { Style, StyleFrameInfo } from '@apex/engine/render/styles/Style'
import type { SimEvent } from '../sim/Events'
import type { Segment, Stage } from '../sim/Road'
import type { Snapshot } from '../sim/Snapshot'
import { TRAFFIC_KINDS } from '../sim/Sim'
import { THEMES } from '../sim/Stages'
import { BAND_SEGMENTS, DRAW_SEGMENTS, FORK_SPREAD, ROAD_HALF_WIDTH, SEG_LENGTH } from '../sim/Tuning'
import { HERO_YAWS } from './models'

/** Darken (f < 1) or lighten a packed RGB colour. */
function shade(c: number, f: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f))
  const g = Math.min(255, Math.round(((c >> 8) & 255) * f))
  const b = Math.min(255, Math.round((c & 255) * f))
  return (r << 16) | (g << 8) | b
}

/** Closest baked hero view to a yaw in (-180, 180]. */
function nearestYaw(yaw: number): number {
  let best = 0
  let bestD = Infinity
  for (const y of HERO_YAWS) {
    let d = Math.abs(y - yaw)
    if (d > 180) d = 360 - d
    if (d < bestD) {
      bestD = d
      best = y
    }
  }
  return best
}
import { Background } from './Background'
import { Cockpit } from './Cockpit'
import { Projection } from './Projection'
import { BANK_ROLL, BANK_TIERS, BANK_TIER_COUNT, BANK_TIER_H, BANK_TIER_W, BEACH_WIDTH, HORIZON_ROLL_SHARE, STEER_ROLL, CURVE_UNIT, FOG_MODERN, FOG_RETRO, HEADLIGHT_REACH, LANE_WIDTH, LIGHTS_OFF_AMBIENT, LOGICAL_HEIGHT, MAX_SPRITES, NIGHT_AMBIENT, PALETTES, RAIL_HEIGHT, RUMBLE_WIDTH, SHOULDER_WIDTH, VIEWS, type Palette } from './RenderTuning'
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
  /** Everything that tilts in a banked turn (the cockpit and the rain on the glass do not). */
  private readonly world = new Group()
  private readonly inner = new Group()
  private steerRoll = 0
  private bankRoll = 0
  private lightsOn = false
  private theme: Theme | null = null
  private heroKind = 'hero_gulf'
  /** Dev: when set, one sprite kind is drawn huge in the middle of the screen. */
  previewKind: string | null = null
  previewYaw = 0
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
    this.inner.add(this.background.sky, this.background.clouds, this.background.far, this.background.near, this.road.mesh, this.sprites.mesh)
    this.world.add(this.inner)
    this.scene.add(this.world, this.rain.mesh, this.cockpit.mesh)
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
    this.background.setPalette(this.palette, theme.backdrop, this.retro, Boolean(theme.night))
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
    if (this.stage) this.background.setPalette(this.palette, THEMES[this.stage.desc.theme].backdrop, this.retro, Boolean(THEMES[this.stage.desc.theme].night))
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
    // The world pivots about the screen centre for banked turns.
    this.world.position.set(W / 2, H / 2, 0)
    this.inner.position.set(-W / 2, -H / 2, 0)
    this.cockpit.layout(W, H)
    this.rain.layout(W, H)
    this.style?.resize(width, height, pixelRatio)
  }

  onEvent(e: SimEvent): void {
    if (e.type === 'crash' || e.type === 'wreck') this.hit = 1
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
    this.lightsOn = curr.lightsOn

    // Camera follows the road height under the player, smoothly; bounce with speed.
    const groundY = stage.heightAt(z)
    const camZ = z - view.playerAhead
    // Ride the ground directly under the camera: any lag here lets the near row
    // climb above the bottom edge on hills (the flashing band).
    // Airborne: the cockpit rides the whole jump; the chase camera lifts only part way so the car visibly leaves the road.
    this.camY = stage.heightAt(camZ) + view.camHeight + curr.airY * (view.drawPlayer ? 0.4 : 1)
    this.bounce = speed > 5 ? Math.sin(this.time * 28) * 0.05 * (speed / 84) : 0
    const camY = this.camY + this.bounce
    const camX = x * ROAD_HALF_WIDTH
    // Negative when the camera trails the stage start; those rows reuse segment 0 (a straight lead-in).
    const base = Math.floor(camZ / SEG_LENGTH)
    const pct = (camZ - base * SEG_LENGTH) / SEG_LENGTH
    const segs = stage.segments
    const last = segs.length - 1
    const segAt = (i: number) => segs[Math.max(0, Math.min(i, last))]
    const fogK = this.retro ? FOG_RETRO : FOG_MODERN

    // Roll has two sources. Steering gives the horizon a subtle transient lean while the
    // wheel is turned (the cockpit stays level). Banked curves step the cockpit up in lane
    // tiers, Rad Mobile style: each outer lane you climb adds BANK_ROLL, plateauing after
    // BANK_TIERS lanes; the horizon takes the same subtle share of that steady lean.
    const bank = segAt(base + 2).bank
    const curveHere = segAt(base + 2).curve
    let bankTarget = 0
    if (bank > 0 && Math.abs(curveHere) > 0.05) {
      const outside = Math.max(0, -Math.sign(curveHere) * x) // 0 at centre, 1 at the high edge
      const tier = Math.min(BANK_TIERS, Math.floor(outside / LANE_WIDTH + 0.5))
      bankTarget = Math.sign(curveHere) * bank * tier * BANK_ROLL
    }
    this.steerRoll = expApproach(this.steerRoll, curr.steer * STEER_ROLL * Math.min(1, speed / 40), 4, dt)
    this.bankRoll = expApproach(this.bankRoll, bankTarget, 5, dt)
    const shake = curr.wreck ? Math.sin(this.time * 26) * 0.14 * (1 - curr.crashT) : 0
    const horizon = (this.steerRoll + this.bankRoll + shake) * HORIZON_ROLL_SHARE
    const roll = this.bankRoll + shake
    // First person: a crash spins the whole view round once (a wreck, twice) — the Rad Mobile tumble.
    const spin = !view.drawPlayer && curr.crashT > 0 ? (curr.wreck ? Math.min(1, curr.crashT / 0.7) * 2 : Math.min(1, curr.crashT / 0.85)) * Math.PI * 2 : 0
    this.world.rotation.z = horizon + spin
    const cover = 1 + Math.abs(horizon) * 1.6 + Math.abs(Math.sin(spin)) * 1.1
    this.world.scale.set(cover, cover, 1)
    this.cockpit.mesh.rotation.z = -roll
    const ccover = 1 + Math.abs(roll) * 1.3
    this.cockpit.mesh.scale.set(W * ccover, H * ccover, 1)

    // Pass 1, near → far: accumulate the curve, project rows, resolve hill clipping.
    let xOff = 0
    let dx = -(segAt(base).curve * CURVE_UNIT * pct)
    let maxY = -Infinity
    for (let n = 0; n <= DRAW_SEGMENTS; n++) {
      const seg = segAt(base + n)
      let zRel = (base + n) * SEG_LENGTH - camZ
      // Rows at or behind the camera project behind it; pin them just in front (in
      // order) so the nearest quads always reach the bottom of the screen. Dropping a
      // row instead left a one-frame gap whenever the camera crossed a segment edge.
      if (zRel < 0.6 + n * 0.01) zRel = 0.6 + n * 0.01
      {
        const scale = P.scaleAt(zRel)
        this.rowScale[n] = scale
        this.rowX[n] = P.screenX(xOff - camX, scale)
        this.rowY[n] = P.screenY(seg.y0 - camY, scale)
        if (n === 0) this.rowY[n] = Math.min(this.rowY[n], -4)
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
      const seg = segAt(base + n)
      const band = Math.floor((base + n) / BAND_SEGMENTS) % 2
      const x1 = this.rowX[n]
      const y1 = this.rowY[n]
      const s1 = this.rowScale[n]
      const x2 = this.rowX[n + 1]
      const y2 = this.rowY[n + 1]
      const s2 = this.rowScale[n + 1]
      const fog = this.rowFog[n]
      const zRel = (base + n) * SEG_LENGTH - camZ
      this.road.setDim(night ? this.brightAt(zRel) : 1)
      this.road.quad(W / 2, y1, W, W / 2, y2, W, band ? pal.grassA : pal.grassB, fog)
      if (seg.bank > 0.05 && Math.abs(seg.curve) > 0.05) {
        // Terraced banking on the outside of the curve: stepped shelves climbing away from the road.
        const side = -Math.sign(seg.curve)
        const b0 = ROAD_HALF_WIDTH + RUMBLE_WIDTH + SHOULDER_WIDTH
        for (let k = 0; k < BANK_TIER_COUNT; k++) {
          const lo = b0 + k * BANK_TIER_W
          const hi = lo + BANK_TIER_W + (k === BANK_TIER_COUNT - 1 ? 60 : 0)
          const h = (k + 1) * BANK_TIER_H * seg.bank
          const col = shade(k % 2 ? pal.grassB : pal.grassA, 1 - 0.12 * (k + 1))
          this.road.quad(x1 + side * ((lo + hi) / 2) * s1, y1 + h * s1, ((hi - lo) / 2) * s1, x2 + side * ((lo + hi) / 2) * s2, y2 + h * s2, ((hi - lo) / 2) * s2, col, fog)
        }
      }
      if (seg.shore && pal.water !== undefined) {
        // The sea against the road: a sliver of beach past the shoulder, then water to the screen edge.
        const side = seg.shore
        const b0 = ROAD_HALF_WIDTH + RUMBLE_WIDTH + SHOULDER_WIDTH
        const b1 = b0 + BEACH_WIDTH
        this.road.quad(x1 + side * ((b0 + b1) / 2) * s1, y1, ((b1 - b0) / 2) * s1, x2 + side * ((b0 + b1) / 2) * s2, y2, ((b1 - b0) / 2) * s2, pal.sand ?? pal.shoulder, fog)
        this.road.quad(x1 + side * (b1 * s1 + W), y1, W, x2 + side * (b1 * s2 + W), y2, W, pal.water, fog)
        // Surf: a foam line that runs up the beach and slides back, each stretch of shore on its own beat,
        // with a paler wash behind it where the last wave just broke.
        const beat = this.time * 1.9 + (base + n) * 0.23
        const run = Math.max(0, Math.sin(beat)) ** 1.6 * 3.2
        const foamW = 0.9 + 0.6 * Math.max(0, Math.sin(beat * 2.1))
        const wash = 1.6 + 1.2 * Math.max(0, Math.sin(beat - 1.2))
        this.road.quad(x1 + side * (b1 - run + wash / 2) * s1, y1, (wash / 2) * s1, x2 + side * (b1 - run + wash / 2) * s2, y2, (wash / 2) * s2, shade(pal.water, 1.35), fog)
        this.road.quad(x1 + side * (b1 - run) * s1, y1, (foamW / 2) * s1, x2 + side * (b1 - run) * s2, y2, (foamW / 2) * s2, 0xf4fbff, fog)
      }
      // An intersection: a road crosses the whole screen with its own edge lines.
      if (seg.crossing) {
        this.road.quad(W / 2, y1, W, W / 2, y2, W, pal.roadA, fog)
        this.road.quad(W / 2, y1, W, W / 2, y1 + (y2 - y1) * 0.12, W, pal.lane, fog)
        this.road.quad(W / 2, y2 - (y2 - y1) * 0.12, W, W / 2, y2, W, pal.lane, fog)
      }
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
        if (seg.closed && side === 0) {
          // Roadworks: a concrete jersey barrier along the lane line with an orange stripe on top.
          const e = seg.closed
          const jx1 = cx1 + e * 0.5 * w1
          const jx2 = cx2 + e * 0.5 * w2
          this.road.quad(jx1, y1 + 0.45 * s1, 0.36 * s1, jx2, y2 + 0.45 * s2, 0.36 * s2, 0xd4d2ca, fog)
          this.road.quad(jx1, y1 + 0.85 * s1, 0.3 * s1, jx2, y2 + 0.85 * s2, 0.3 * s2, 0xe8801a, fog)
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
      const seg = segAt(base + n)
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
          const yaw = curr.trafficYaw[ci]
          // Pose from the real view geometry: how far off to the side the car sits versus how far ahead
          // gives the flank angle, and the height difference (hills) versus distance gives the pitch —
          // descending you look down onto roofs, climbing you look up at bumpers. The chase camera sits
          // higher than the cockpit's eye line, so it adds more downward pitch.
          const dz = Math.max(6, cz - camZ)
          const viewYaw = yaw === 0 ? (Math.atan2((curr.trafficX[ci] - x) * ROAD_HALF_WIDTH, dz) * 180) / Math.PI : yaw
          const viewPitch = (view.drawPlayer ? 9 : 2) + (Math.atan2(camY - stage.heightAt(cz), dz) * 180) / Math.PI
          const frame = this.atlas.frame(kind, viewYaw, viewPitch)
          if (frame) this.sprites.add(sx + curr.trafficX[ci] * ROAD_HALF_WIDTH * sc, sy, frame.heightM * sc, frame, this.rowFog[n], this.brightAt((base + n) * SEG_LENGTH - camZ), clip)
        }
      }
      if (seg.runway || base + n < 0) continue
      this.drawSegmentSprites(seg, n, clip, this.brightAt((base + n) * SEG_LENGTH - camZ))
    }
    // Player car.
    if (view.drawPlayer) {
      const scale = P.scaleAt(view.playerAhead)
      const py = P.screenY(groundY + curr.airY - camY, scale)
      const steerFrame = Math.round(curr.steer * 3)
      // Baked yaw > 0 shows the car's right flank (nose left); steering right must show the left flank.
      let yaw = steerFrame === 0 ? 0 : steerFrame > 0 ? -[12, 24, 38][steerFrame - 1] : [12, 24, 38][-steerFrame - 1]
      if (curr.crashT > 0) {
        // A crash spins the car a full turn on the spot; a wreck spins it through the air, then it lies still.
        const t = curr.crashT
        const turn = curr.wreck ? (t < 0.7 ? Math.min(1, t / 0.4) * 1.5 : 0) : t
        yaw = nearestYaw(((turn * 360 + 180) % 360) - 180)
      }
      const frame = this.atlas.frame(this.heroKind, yaw)
      let hop = curr.crashT > 0 ? Math.abs(Math.sin(curr.crashT * 20)) * 12 : 0
      let squash = 1
      if (curr.wreck) {
        // The classic: yeeted into the air, a couple of bounces, then it lies there crushed until the reset.
        const t = curr.crashT
        if (t < 0.4) hop = Math.sin((t / 0.4) * Math.PI) * H * 0.42
        else if (t < 0.58) hop = Math.abs(Math.sin(((t - 0.4) / 0.18) * Math.PI)) * H * 0.12
        else if (t < 0.7) hop = Math.abs(Math.sin(((t - 0.58) / 0.12) * Math.PI)) * H * 0.04
        else {
          hop = 0
          squash = 0.62
        }
      }
      if (frame) this.sprites.add(W / 2 + curr.steer * 2, py + hop, frame.heightM * scale * squash, frame, 0, 1, -1e9)
    }
    if (this.previewKind) {
      const f = this.atlas.frame(this.previewKind, this.previewYaw)
      if (f) this.sprites.add(W / 2, H * 0.12, H * 0.75, f, 0, 1, -1e9)
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
    // Headlights are a switch you have to find; without them the night is very dark.
    if (!this.lightsOn) return NIGHT_AMBIENT * LIGHTS_OFF_AMBIENT
    return NIGHT_AMBIENT + (1 - NIGHT_AMBIENT) * Math.exp(-Math.max(0, zRel) / HEADLIGHT_REACH)
  }

  private drawSegmentSprites(seg: Segment, n: number, clip: number, bright: number): void {
    const sc = this.rowScale[n]
    for (const sp of seg.sprites) {
      const frame = this.atlas.frame(sp.kind)
      if (!frame) continue
      const sx = this.rowX[n] + sp.offset * ROAD_HALF_WIDTH * sc
      // The sunset stage is all silhouettes; otherwise lit signage and towers glow through the night.
      const glow = this.theme?.silhouette ? 0.04 : sp.kind.startsWith('sign') || sp.kind.startsWith('tower') || sp.kind === 'diner' || sp.kind === 'motel' || sp.kind === 'gas' || sp.kind === 'arch' ? Math.max(bright, 0.85) : bright
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
