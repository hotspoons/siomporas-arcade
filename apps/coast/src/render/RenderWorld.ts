// The pseudo-3D pass. Everything is drawn in a logical screen space with an
// orthographic camera: sky and parallax layers, then the road as trapezoids
// far → near, then sprites far → near with hill clipping, then the player car
// or the cockpit. The sim is never touched.

import { Color, Group, LinearFilter, NearestFilter, OrthographicCamera, Scene, WebGLRenderer } from 'three'
import { expApproach } from '@apex/engine/math/scalar'
import type { RenderStats } from '@apex/engine/render/RenderStats'
import type { Style, StyleFrameInfo } from '@apex/engine/render/styles/Style'
import { disposeObject3D } from '@apex/engine/render/dispose'
import type { SimEvent } from '../sim/Events'
import type { Segment, Stage } from '../sim/Road'
import type { Snapshot } from '../sim/Snapshot'
import { TRAFFIC_KINDS } from '../sim/Sim'
import { blendPalette, gradeColor, paletteFor, vibeAt, type VibeDef } from '../world/vibes'
import { BAND_SEGMENTS, DRAW_SEGMENTS, FORK_LANES, FORK_WIDEN, ROAD_HALF_WIDTH, SEG_LENGTH, stageLinkMetres } from '../sim/Tuning'
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
import { COCKPIT_H, COCKPIT_W, Cockpit } from './Cockpit'
import { Flames } from './Flames'
import { HudLayer } from './HudLayer'
import { Projection } from './Projection'
import { FOV_DEG, MODELS_3D, BANK_BATTER, BANK_ROLL, BANK_SLOPE, BANK_TIER_COUNT, BANK_TIER_H, BANK_TIER_W, BEACH_WIDTH, CAM_BOUNCE, TUNNEL_DARK, TUNNEL_HALF_WIDTH, TUNNEL_HEIGHT, HUD_RETRO, HORIZON_ROLL_SHARE, STEER_ROLL, CURVE_UNIT, FOG_MODERN, FOG_RETRO, HEADLIGHT_REACH, LANE_WIDTH, LIGHTS_OFF_AMBIENT, LOGICAL_HEIGHT, MAX_SPRITES, NIGHT_AMBIENT, PALETTES, RAIL_HEIGHT, RUMBLE_WIDTH, SHOULDER_WIDTH, VIEWS, type Palette } from './RenderTuning'
import { LIVERIES } from './procgen'
import { Rain } from './Rain'
import type { Theme } from '../sim/Road'
import { RoadMesh, bankReach, deckHalf, groundHeight } from './RoadMesh'
import { DEFAULT_PITCH, SpriteAtlas } from './SpriteAtlas'
import { SpriteBatch } from './SpriteBatch'
import { ModelLayer } from './ModelLayer'
import { LiveAtlas } from './LiveAtlas'

export type ViewMode = keyof typeof VIEWS

const ROWS = DRAW_SEGMENTS + 2
/**
 * Screen-x buckets for the skyline (below). Four logical pixels each at the design width; what it
 * feeds is one clip line per sprite, so finer than that buys nothing.
 */
const SKY_BINS = 200
/** Segments either side of a scene change over which the ground colours crossfade. */
const SCENE_FADE = 60

export class RenderWorld {
  readonly renderer: WebGLRenderer
  readonly scene = new Scene()
  // The z range is wide because the 3D-models layer stacks real geometry through it; everything
  // else in this scene sits at z ~ 0 and is painted in order.
  readonly camera = new OrthographicCamera(0, 320, 224, 0, -60000, 60000)
  readonly proj = new Projection()
  readonly atlas = new SpriteAtlas()
  readonly road = new RoadMesh()
  readonly sprites = new SpriteBatch(MAX_SPRITES)
  readonly models = new ModelLayer()
  /** Sprites photographed this frame instead of looked up; MODELS_3D = 1. See LiveAtlas. */
  readonly live = new LiveAtlas()
  readonly flames = new Flames()
  readonly background = new Background()
  readonly cockpit = new Cockpit()
  readonly rain = new Rain()
  /** Everything that tilts in a banked turn (the cockpit and the rain on the glass do not). */
  private readonly world = new Group()
  private readonly inner = new Group()
  private steerRoll = 0
  private bankRoll = 0
  private lightsOn = false
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
  private readonly rowFog = new Float32Array(ROWS)
  /** The same rows in camera space, metres: lateral, vertical, and distance ahead. 3D reads these. */
  private readonly rowCx = new Float32Array(ROWS)
  private readonly rowCy = new Float32Array(ROWS)
  private readonly rowCz = new Float32Array(ROWS)
  /** Banking slope per row (screen-y per lateral metre, ×scale), so sprites sit on the tilted road. */
  private readonly rowTilt = new Float32Array(ROWS)
  /** The arcade HUD drawn inside the low-res buffer (retro only; see HudLayer). */
  readonly hudLayer = new HudLayer()
  /** False on the title screen, where a score and a clock over the logo make no sense. */
  hudEnabled = true
  private readonly segVisible = new Uint8Array(ROWS)
  /**
   * THE SKYLINE, and the only thing that hides anything in the 2D pass. Per row, the highest the
   * ground gets anywhere nearer than it, bucketed by screen x — the profile of the whole drawn road,
   * crest and camber and bank together, not a horizon line plus a pile of cases for the bits that
   * stand above it. A sprite is cut where the ground in front of it reaches, at its own screen x.
   */
  private readonly sky = new Float32Array(ROWS * SKY_BINS)
  /** The running skyline pass 1 folds each row into as it walks near → far. */
  private readonly skyRun = new Float32Array(SKY_BINS)
  private readonly carOrder: number[] = []
  private themeId = ''
  private hit = 0
  /** Ungraded ground palette per scene the stage runs through (Segment.scene indexes it). */
  private scenePals: Palette[] = [PALETTES.coast]
  /** The vibe in force at the camera, or null on a stage that has none (the built-in route). */
  vibe: VibeDef | null = null
  private nightAmt = 0
  private rainAmt = 0
  private silAmt = 0
  /** The look we are handing over FROM at a checkpoint, and how many metres of the handover are left. */
  private fadeFrom: { pal: Palette; night: number; rain: number; sil: number; fog: number } | null = null
  private fadeLeft = 0
  private fadeSpan = 1
  private fogScale = 1
  private bgKey = ''
  private clearRgb = -1
  private readonly clearColor = new Color()
  private lastZ = 0

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false })
    this.renderer.info.autoReset = false
    this.renderer.setClearColor(new Color(0x000000), 1)
    this.inner.add(this.background.sky, this.background.clouds, this.background.far, this.background.near, this.road.mesh, this.flames.mesh, this.sprites.mesh)
    this.world.add(this.inner)
    this.scene.add(this.world, this.rain.mesh, this.cockpit.mesh, this.hudLayer.mesh)
    this.background.sky.renderOrder = 0
    this.background.clouds.renderOrder = 1
    this.background.far.renderOrder = 2
    this.background.near.renderOrder = 3
    this.road.mesh.renderOrder = 4
    this.sprites.mesh.renderOrder = 5
    // Behind the car, over the road: the flames come out from under the tail.
    this.flames.mesh.renderOrder = 4
    this.rain.mesh.renderOrder = 6
    this.cockpit.mesh.renderOrder = 7
    this.hudLayer.mesh.renderOrder = 8
  }

  async bake(onProgress?: (d: number, t: number) => void): Promise<void> {
    await this.atlas.bake(this.renderer, this.retro, onProgress)
    if (this.atlas.texture) this.sprites.setAtlas(this.atlas.texture)
    // The bake drives the renderer directly; put the main output back the way the style wants it.
    this.resize(this.width, this.height, this.pixelRatio)
    this.renderer.setClearColor(new Color(this.palette.skyBottom), 1)
  }

  setStage(stage: Stage, handover = false): void {
    // Hold on to the light we are leaving. The new stage's road starts at the line; its weather does not.
    if (handover && this.stage && stageLinkMetres() > 0) {
      this.fadeFrom = { pal: this.palette, night: this.nightAmt, rain: this.rainAmt, sil: this.silAmt, fog: this.fogScale }
      this.fadeLeft = stageLinkMetres()
      this.fadeSpan = this.fadeLeft
    } else {
      this.fadeFrom = null
      this.fadeLeft = 0
    }
    this.stage = stage
    this.scenePals = stage.scenes.map((s) => PALETTES[s.palette] ?? PALETTES.coast)
    this.themeId = stage.theme.id
    this.bgKey = ''
    this.refreshLook(0, false)
  }

  /**
   * Work out what the world looks like at z and push it at the renderer: the scene's
   * own ground colours (crossfaded where one scene hands over to the next), under the
   * vibe's sky, with night and rain as amounts rather than switches.
   *
   * Built-in stages carry no vibes, so they take their theme's palette untouched — the
   * hand-picked look of the coast-to-coast route is not up for reinterpretation.
   */
  private refreshLook(z: number, lightsOn: boolean): void {
    const stage = this.stage
    if (!stage) return
    const base = this.sceneBase(Math.floor(z / SEG_LENGTH))
    const theme = stage.themeAt(z)
    const vibe = stage.vibes.length ? vibeAt(stage.vibes, stage.fractionAt(z)) : null
    this.vibe = vibe
    if (vibe) {
      this.nightAmt = vibe.night
      this.rainAmt = vibe.rain
      this.silAmt = vibe.silhouette
      this.palette = paletteFor(base, vibe)
      this.fogScale = vibe.fogK
    } else {
      this.nightAmt = theme.night ? 1 : 0
      this.rainAmt = theme.rain ? 1 : 0
      this.silAmt = theme.silhouette ? 1 : 0
      this.palette = base
      this.fogScale = 1
    }
    // Coming out of a checkpoint, the stage we left is still most of what you can see: blend out of it
    // over STAGE_FADE_M so the seam is a change in the weather rather than a cut.
    const from = this.fadeFrom
    if (from) {
      const t = 1 - Math.max(0, this.fadeLeft) / Math.max(1, this.fadeSpan)
      const e = t * t * (3 - 2 * t)
      this.palette = blendPalette(from.pal, this.palette, e)
      this.nightAmt = from.night + (this.nightAmt - from.night) * e
      this.rainAmt = from.rain + (this.rainAmt - from.rain) * e
      this.silAmt = from.sil + (this.silAmt - from.sil) * e
      this.fogScale = from.fog + (this.fogScale - from.fog) * e
      if (this.fadeLeft <= 0) this.fadeFrom = null
    }
    // The parallax layers are canvas textures, so re-drawing them costs an upload: only do it when the
    // scene (or the pipeline's filtering) under them changes — and through a handover, in steps, because
    // a blend that moves every frame would redraw and re-upload every frame.
    const step = from ? `|${Math.round((1 - this.fadeLeft / Math.max(1, this.fadeSpan)) * 12)}` : ''
    const key = `${theme.backdrop}|${base.far.toString(16)}|${base.near.toString(16)}|${base.clouds.toString(16)}|${this.retro ? 'r' : 'm'}${step}`
    if (key !== this.bgKey) {
      this.bgKey = key
      this.background.setPalette(from ? blendPalette(from.pal, base, 1 - Math.max(0, this.fadeLeft) / Math.max(1, this.fadeSpan)) : base, theme.backdrop, this.retro, this.nightAmt, key)
    }
    this.background.setSky(this.palette, this.nightAmt, vibe ? gradeColor(0xffffff, vibe) : 0xffffff)
    this.road.setFog(this.palette.fog)
    this.sprites.setFog(this.palette.fog)
    this.models.setFog(this.palette.fog)
    if (this.palette.skyBottom !== this.clearRgb) {
      this.clearRgb = this.palette.skyBottom
      this.renderer.setClearColor(this.clearColor.set(this.clearRgb), 1)
    }
    this.rain.intensity = this.rainAmt
    this.cockpit.rain = this.rainAmt > 0.2
    this.cockpit.night = this.nightAmt > 0.5
    void lightsOn
  }

  /**
   * The scene's ungraded palette at a segment, crossfaded across a scene change so
   * the ground does not switch colour on one row.
   */
  private sceneBase(segIndex: number): Palette {
    const stage = this.stage
    if (!stage) return PALETTES.coast
    const segs = stage.segments
    const last = Math.max(0, stage.length - 1)
    const i = Math.max(0, Math.min(last, segIndex))
    const here = segs[i].scene
    if (this.scenePals.length < 2) return this.scenePals[0] ?? PALETTES.coast
    let other = here
    let mix = 0
    for (let k = 1; k <= SCENE_FADE; k++) {
      const b = segs[Math.max(0, i - k)].scene
      if (b !== here) {
        other = b
        mix = 0.5 - k / (2 * SCENE_FADE)
        break
      }
    }
    if (!mix) {
      for (let k = 1; k <= SCENE_FADE; k++) {
        const f = segs[Math.min(last, i + k)].scene
        if (f !== here) {
          other = f
          mix = 0.5 - k / (2 * SCENE_FADE)
          break
        }
      }
    }
    const a = this.scenePals[here] ?? PALETTES.coast
    if (!mix || other === here) return a
    return blendPalette(a, this.scenePals[other] ?? a, Math.max(0, mix))
  }

  /** Hero car: a prototype livery id or 'formula'. */
  setCar(id: string): void {
    this.heroKind = id === 'formula' ? 'formula' : `hero_${id in LIVERIES ? id : 'gulf'}`
    this.cockpit.livery = LIVERIES[id] ?? LIVERIES.gulf
  }

  /**
   * Give the GPU back everything. Called when the arcade unmounts the game; a standalone build
   * never reaches it, because the tab closing does the same job.
   */
  dispose(): void {
    this.atlas.dispose()
    this.style?.detach()
    this.style = null
    disposeObject3D(this.scene)
    this.models.dispose()
    this.live.dispose()
    this.renderer.dispose()
    // Release the context now rather than at the next collection: browsers cap how many live
    // WebGL contexts a page may hold, and the arcade makes a fresh one for every game entered.
    this.renderer.forceContextLoss()
  }

  setStyle(style: Style): void {
    this.style?.detach()
    this.style = style
    style.attach(this.renderer, this.scene, this.camera)
    this.retro = style.name === 'retro'
    this.cockpit.setRetro(this.retro)
    if (this.atlas.texture) this.atlas.texture.minFilter = this.atlas.texture.magFilter = this.retro ? NearestFilter : LinearFilter
    if (this.atlas.texture) this.atlas.texture.needsUpdate = true
    // The layer textures are filtered per pipeline, so a style change re-bakes them.
    this.bgKey = ''
    if (this.stage) this.refreshLook(this.lastZ, this.lightsOn)
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
    this.hudLayer.layout(W, H)
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
    // A handover is measured in road, not in seconds: stopping does not finish it and flooring it
    // does not skip it. `z` restarts at each checkpoint, so only forward progress counts.
    if (this.fadeLeft > 0) this.fadeLeft -= Math.max(0, z - this.lastZ)
    this.lastZ = z
    // Time of day and weather can move under you along a track, so the look is a
    // per-frame question now, not a per-stage one.
    this.refreshLook(z, curr.lightsOn)

    // Camera follows the road height under the player, smoothly; bounce with speed.
    const groundY = stage.heightAt(z)
    const camZ = z - view.playerAhead
    // Ride the ground directly under the camera: any lag here lets the near row
    // climb above the bottom edge on hills (the flashing band).
    // Airborne: the cockpit rides the whole jump; the chase camera lifts only part way so the car visibly leaves the road.
    // On a banked curve the camera rides the tilted surface at its own lateral position.
    const camSeg = stage.segmentAt(camZ)
    const camTilt = camSeg.bank > 0.02 && Math.abs(camSeg.curve) > 0.02 ? -Math.sign(camSeg.curve) * camSeg.bank * BANK_SLOPE : 0
    this.camY = stage.heightAt(camZ) + view.camHeight + curr.airY * (view.drawPlayer ? 0.4 : 1) + groundHeight(x * ROAD_HALF_WIDTH, camTilt)
    // Road bounce only while actually driving: a finished or timed-out run sits still.
    this.bounce = curr.phase === 'driving' && speed > 5 ? Math.sin(this.time * 28) * CAM_BOUNCE * (speed / 84) : 0
    const camY = this.camY + this.bounce
    const camX = x * ROAD_HALF_WIDTH
    // Negative when the camera trails the stage start; those rows reuse segment 0 (a straight lead-in).
    const base = Math.floor(camZ / SEG_LENGTH)
    const pct = (camZ - base * SEG_LENGTH) / SEG_LENGTH
    const segs = stage.segments
    const last = segs.length - 1
    const segAt = (i: number) => segs[Math.max(0, Math.min(i, last))]
    const fogK = (this.retro ? FOG_RETRO : FOG_MODERN) * this.fogScale

    // Roll has two sources. Steering gives the horizon a subtle transient lean while the
    // wheel is turned (the cockpit stays level). Banked curves step the cockpit up in lane
    // tiers, Rad Mobile style: each outer lane you climb adds BANK_ROLL, plateauing after
    // BANK_TIERS lanes; the horizon takes the same subtle share of that steady lean.
    // The car sits on the banked surface, so the whole view rolls by the bank angle under it: the road
    // reads level beneath you and the horizon tilts (Rad Mobile). Steering adds a subtle transient.
    const bankTarget = -Math.atan(camTilt) * BANK_ROLL
    this.steerRoll = expApproach(this.steerRoll, curr.steer * STEER_ROLL * Math.min(1, speed / 40), 4, dt)
    this.bankRoll = expApproach(this.bankRoll, bankTarget, 5, dt)
    const shake = curr.wreck ? Math.sin(this.time * 26) * 0.14 * (1 - curr.crashT) : 0
    const horizon = this.steerRoll * HORIZON_ROLL_SHARE + this.bankRoll + shake * HORIZON_ROLL_SHARE
    const roll = shake
    // First person: a crash spins the car round once (a wreck, twice) — a yaw, the same spin the
    // chase camera shows from outside. Rows shear sideways by depth × tan(yaw), the road leaves the
    // screen, and while you face backwards there is only grass and sky; the skyline wraps once per turn.
    const spinYaw = !view.drawPlayer && curr.crashT > 0 ? (curr.wreck ? Math.min(1, curr.crashT / 0.7) * 2 : Math.min(1, curr.crashT / 0.85)) * Math.PI * 2 : 0
    const yawWrapped = Math.atan2(Math.sin(spinYaw), Math.cos(spinYaw))
    const behind = Math.abs(yawWrapped) > Math.PI / 2 - 0.1
    const yawTan = behind ? 0 : Math.tan(yawWrapped)
    this.world.rotation.z = horizon
    // A W×H picture rotated by the roll must scale up to keep the viewport corners covered, or the clear
    // colour shows as flickering dark wedges at the edges (worse the wider the window).
    const aspect = Math.max(W, H) / Math.min(W, H)
    const cover = Math.cos(horizon) + aspect * Math.abs(Math.sin(horizon)) + 0.02
    this.world.scale.set(cover, cover, 1)
    this.cockpit.mesh.rotation.z = -roll
    // The cockpit keeps its own aspect: scale to cover the screen and crop (sides on tall windows, top on wide ones).
    const ccover = 1 + Math.abs(roll) * 1.3
    const cf = Math.max(W / COCKPIT_W, H / COCKPIT_H) * ccover
    this.cockpit.mesh.scale.set(COCKPIT_W * cf, COCKPIT_H * cf, 1)
    this.cockpit.mesh.position.set(W / 2, (COCKPIT_H * cf) / 2, 0)

    // Pass 1, near → far: accumulate the curve, project rows, resolve hill clipping.
    let xOff = 0
    let dx = -(segAt(base).curve * CURVE_UNIT * pct)
    let maxY = -Infinity
    this.skyRun.fill(-1e9)
    for (let n = 0; n <= DRAW_SEGMENTS; n++) {
      const seg = segAt(base + n)
      let zRel = (base + n) * SEG_LENGTH - camZ
      // Rows at or behind the camera project behind it; pin them just in front (in
      // order) so the nearest quads always reach the bottom of the screen. Dropping a
      // row instead left a one-frame gap whenever the camera crossed a segment edge.
      if (zRel < 0.6 + n * 0.01) zRel = 0.6 + n * 0.01
      {
        // Camera space first, in metres — this is the row. Everything else is a view of it: the screen
        // position the 2D pass paints, and the place the 3D pass stands a model.
        const cx = xOff - camX + zRel * yawTan
        const cy = seg.y0 - camY
        const scale = P.scaleAt(zRel)
        this.rowCx[n] = cx
        this.rowCy[n] = cy
        this.rowCz[n] = zRel
        this.rowScale[n] = scale
        this.rowTilt[n] = seg.bank > 0.02 && Math.abs(seg.curve) > 0.02 ? -Math.sign(seg.curve) * seg.bank * BANK_SLOPE : 0
        this.rowX[n] = P.screenX(cx, scale)
        this.rowY[n] = P.screenY(cy, scale)
        if (n === 0) this.rowY[n] = Math.min(this.rowY[n], -4)
        this.rowValid[n] = behind ? 0 : 1
        this.rowFog[n] = 1 - Math.exp(-((zRel * fogK) ** 2))
      }
      // The skyline so far is what stands between *this* row and the camera, so take it before this
      // row is folded in.
      this.sky.set(this.skyRun, n * SKY_BINS)
      if (this.rowValid[n]) {
        // Fold this row's ground into the running skyline: its own profile where the road is, flat
        // ground either side of that. One sweep, whatever the row is doing.
        const s1 = this.rowScale[n]
        const t = this.rowTilt[n]
        const y1 = this.rowY[n]
        const reach = bankReach(t) * s1
        const lo = (this.rowX[n] - reach) / W
        const hi = (this.rowX[n] + reach) / W
        for (let b = 0; b < SKY_BINS; b++) {
          const f = (b + 0.5) / SKY_BINS
          const top = t !== 0 && f > lo && f < hi ? y1 + groundHeight((f * W - this.rowX[n]) / s1, t) * s1 : y1
          if (top > this.skyRun[b]) this.skyRun[b] = top
        }
      }
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
    // Night is an amount, not a switch: a vibe can bring it on over a few hundred metres.
    const nightAmt = this.nightAmt
    const night = nightAmt > 0.02
    // Facing away from the road mid-spin: just the ground up to the horizon.
    if (behind) this.road.quad(W / 2, -H, W, W / 2, H * 0.5, W, pal.grassA, 0)
    const scenes = stage.scenes
    for (let n = DRAW_SEGMENTS - 1; n >= 0; n--) {
      if (!this.segVisible[n]) continue
      const seg = segAt(base + n)
      // Road width and guardrail follow the scene this segment belongs to, so a track
      // can narrow from a four-lane city street to a two-lane coast road as you drive.
      const rowTheme: Theme = scenes[seg.scene] ?? scenes[0]
      const lanes = rowTheme.lanes
      const rails = rowTheme.rails
      const band = Math.floor((base + n) / BAND_SEGMENTS) % 2
      const x1 = this.rowX[n]
      const y1 = this.rowY[n]
      const s1 = this.rowScale[n]
      const x2 = this.rowX[n + 1]
      const y2 = this.rowY[n + 1]
      const s2 = this.rowScale[n + 1]
      const fog = this.rowFog[n]
      const zRel = (base + n) * SEG_LENGTH - camZ
      // Banked curve: tilt the plane about the centreline, outer edge up (Rad Mobile's berms). Each row
      // edge uses its own slope so neighbouring quads share vertices exactly.
      this.road.setTilt(x1, s1, this.rowTilt[n], x2, s2, this.rowTilt[n + 1])
      // Inside a tunnel it is night whatever the sky says: headlights or a dim bore, lit strips on the ceiling.
      const inTunnel = seg.tunnel
      // Night: everything sits at one dark ambient (no distance wedges); the headlights paint two lit strips
      // on the tarmac below, Rad Mobile style, so the light is on the road ahead, not smeared over the scene.
      const nightDim = NIGHT_AMBIENT * (curr.lightsOn ? 1 : LIGHTS_OFF_AMBIENT)
      const ambientDim = inTunnel ? (curr.lightsOn ? Math.max(TUNNEL_DARK, 0.5) : TUNNEL_DARK) : 1 + (nightDim - 1) * nightAmt
      const beam = (nightAmt > 0.15 || inTunnel) && curr.lightsOn ? Math.exp(-Math.max(0, zRel) / HEADLIGHT_REACH) * (inTunnel ? 1 : nightAmt) : 0
      this.road.setDim(ambientDim)
      const grassCol = inTunnel ? 0x2a2a30 : band ? pal.grassA : pal.grassB
      if (this.rowTilt[n] !== 0 || this.rowTilt[n + 1] !== 0) {
        // Banked deck: the ground is drawn as two flat strips outside the deck. A single full-width quad
        // would have a corner on the raised deck and smear the lift across the whole screen.
        const bo = ROAD_HALF_WIDTH + RUMBLE_WIDTH + SHOULDER_WIDTH
        this.road.quadFlat(x1 - bo * s1 - W, y1, W, x2 - bo * s2 - W, y2, W, grassCol, fog)
        this.road.quadFlat(x1 + bo * s1 + W, y1, W, x2 + bo * s2 + W, y2, W, grassCol, fog)
        this.road.quadFlat(x1, y1, bo * s1, x2, y2, bo * s2, shade(grassCol, 0.8), fog)
      } else this.road.quad(W / 2, y1, W, W / 2, y2, W, grassCol, fog)
      if (inTunnel) {
        // Walls up from the road's edges, a ceiling over them, a lit strip every few segments.
        const hw = TUNNEL_HALF_WIDTH
        const ch = TUNNEL_HEIGHT
        const wallCol = band ? 0x50505a : 0x484850
        for (const e of [-1, 1]) this.road.quad4(x1 + e * hw * s1, y1, x1 + e * hw * s1, y1 + ch * s1, x2 + e * hw * s2, y2 + ch * s2, x2 + e * hw * s2, y2, wallCol, fog)
        this.road.quad(x1, y1 + ch * s1, hw * s1, x2, y2 + ch * s2, hw * s2, 0x3a3a42, fog)
        if ((base + n) % 5 === 0) {
          this.road.setDim(1)
          this.road.quad(x1, y1 + (ch - 0.2) * s1, 1.2 * s1, x2, y2 + (ch - 0.2) * s2, 1.2 * s2, 0xfff2c0, fog * 0.5)
          this.road.setDim(ambientDim)
        }
        if (seg.portal) {
          // The entrance face: a wall of hillside with the bore cut out of it.
          this.road.setDim(night ? this.brightAt(zRel) : 1)
          const top = y1 + (ch + 9) * s1
          const face = 0x6a6258
          this.road.quad4(x1 - W * 3, y1, x1 - W * 3, top, x1 - hw * s1, top, x1 - hw * s1, y1, face, fog)
          this.road.quad4(x1 + hw * s1, y1, x1 + hw * s1, top, x1 + W * 3, top, x1 + W * 3, y1, face, fog)
          this.road.quad4(x1 - hw * s1, y1 + ch * s1, x1 - hw * s1, top, x1 + hw * s1, top, x1 + hw * s1, y1 + ch * s1, face, fog)
          this.road.quad4(x1 - (hw + 1.2) * s1, y1, x1 - (hw + 1.2) * s1, y1 + (ch + 1.2) * s1, x1 + (hw + 1.2) * s1, y1 + (ch + 1.2) * s1, x1 + (hw + 1.2) * s1, y1, 0x3a3630, fog)
          this.road.quad4(x1 - hw * s1, y1, x1 - hw * s1, y1 + ch * s1, x1 + hw * s1, y1 + ch * s1, x1 + hw * s1, y1, 0x0c0c10, 0)
        }
      }
      if (seg.shore && pal.water !== undefined) {
        // The sea against the road: a sliver of beach past the shoulder, then water to the screen edge.
        const side = seg.shore
        const b0 = ROAD_HALF_WIDTH + RUMBLE_WIDTH + SHOULDER_WIDTH
        const b1 = b0 + BEACH_WIDTH
        this.road.quadFlat(x1 + side * ((b0 + b1) / 2) * s1, y1, ((b1 - b0) / 2) * s1, x2 + side * ((b0 + b1) / 2) * s2, y2, ((b1 - b0) / 2) * s2, pal.sand ?? pal.shoulder, fog)
        this.road.quadFlat(x1 + side * (b1 * s1 + W), y1, W, x2 + side * (b1 * s2 + W), y2, W, pal.water, fog)
        // Surf: a foam line that runs up the beach and slides back, each stretch of shore on its own beat,
        // with a paler wash behind it where the last wave just broke.
        const beat = this.time * 1.9 + (base + n) * 0.23
        const run = Math.max(0, Math.sin(beat)) ** 1.6 * 3.2
        const foamW = 0.9 + 0.6 * Math.max(0, Math.sin(beat * 2.1))
        const wash = 1.6 + 1.2 * Math.max(0, Math.sin(beat - 1.2))
        this.road.quadFlat(x1 + side * (b1 - run + wash / 2) * s1, y1, (wash / 2) * s1, x2 + side * (b1 - run + wash / 2) * s2, y2, (wash / 2) * s2, shade(pal.water, 1.35), fog)
        this.road.quadFlat(x1 + side * (b1 - run) * s1, y1, (foamW / 2) * s1, x2 + side * (b1 - run) * s2, y2, (foamW / 2) * s2, 0xf4fbff, fog)
      }
      // An intersection: a road crosses the whole screen with its own edge lines.
      if (seg.crossing) {
        this.road.quadFlat(W / 2, y1, W, W / 2, y2, W, pal.roadA, fog)
        this.road.quadFlat(W / 2, y1, W, W / 2, y1 + (y2 - y1) * 0.12, W, pal.lane, fog)
        this.road.quadFlat(W / 2, y2 - (y2 - y1) * 0.12, W, W / 2, y2, W, pal.lane, fog)
      }
      if (this.rowTilt[n] !== 0 && Math.sign(this.rowTilt[n]) === Math.sign(this.rowTilt[n + 1] || this.rowTilt[n])) {
        // The deck's high side comes back down to the ground on a graded bank, not off a wall: a sheer
        // face is a flat dark slab seen almost edge-on, which is the black wedge that used to sit in the
        // grass on the outside of every turn. Drawn only where both rows agree on which side is high —
        // across an S-bend's crossover the bank would twist through itself.
        const side = Math.sign(this.rowTilt[n])
        const bo = deckHalf()
        const drop1 = Math.abs(this.rowTilt[n]) * this.road.plateau
        const drop2 = Math.abs(this.rowTilt[n + 1]) * this.road.plateau
        const wx1 = x1 + side * bo * s1
        const wx2 = x2 + side * bo * s2
        // Down the slope and out: the foot of the bank sits BANK_BATTER metres further out per metre of drop.
        const fx1 = wx1 + side * drop1 * BANK_BATTER * s1
        const fx2 = wx2 + side * drop2 * BANK_BATTER * s2
        this.road.quad4(fx1, y1, wx1, y1 + drop1 * s1, wx2, y2 + drop2 * s2, fx2, y2, shade(grassCol, 0.74), fog)
        // Terraces above the deck on the outside, if any are configured.
        for (let k = 0; k < BANK_TIER_COUNT; k++) {
          const lo = bo + k * BANK_TIER_W
          const hi = lo + BANK_TIER_W
          const h = (k + 1) * BANK_TIER_H * seg.bank
          const col = shade(k % 2 ? pal.grassB : pal.grassA, 1 - 0.12 * (k + 1))
          this.road.quad(x1 + side * ((lo + hi) / 2) * s1, y1 + h * s1, ((hi - lo) / 2) * s1, x2 + side * ((lo + hi) / 2) * s2, y2 + h * s2, ((hi - lo) / 2) * s2, col, fog)
        }
      }
      // A fork is one road that widens, so it is drawn as one road that widens — two carriageways with a
      // median between them is the thing it is replacing. Four lanes across it, two feeding each way.
      const grow = seg.fork >= 0 ? 1 + seg.fork * FORK_WIDEN : 1
      {
        const cx1 = x1
        const cx2 = x2
        const w1 = ROAD_HALF_WIDTH * grow * s1
        const w2 = ROAD_HALF_WIDTH * grow * s2
        this.road.quad(cx1, y1, w1 + (RUMBLE_WIDTH + SHOULDER_WIDTH) * s1, cx2, y2, w2 + (RUMBLE_WIDTH + SHOULDER_WIDTH) * s2, pal.shoulder, fog)
        this.road.quad(cx1, y1, w1 + RUMBLE_WIDTH * s1, cx2, y2, w2 + RUMBLE_WIDTH * s2, band ? pal.rumbleA : pal.rumbleB, fog)
        this.road.quad(cx1, y1, w1, cx2, y2, w2, band ? pal.roadA : pal.roadB, fog)
        if (beam > 0.04) {
          // Headlight strips: one per lamp, converging on the horizon, fading with reach.
          const lit = shade(band ? pal.roadA : pal.roadB, 1.25 + 0.25 * beam)
          this.road.setDim(Math.min(1, ambientDim + (0.72 - ambientDim) * beam))
          for (const e of [-1, 1]) this.road.quad(cx1 + e * 0.45 * w1, y1, 0.34 * w1, cx2 + e * 0.45 * w2, y2, 0.34 * w2, lit, fog)
        }
        // Solid edge lines, dashed lane dividers (bright inside the beams).
        for (const e of [-1, 1]) this.road.quad(cx1 + e * (w1 - LANE_WIDTH * s1 * 1.5), y1, LANE_WIDTH * s1 * 0.8, cx2 + e * (w2 - LANE_WIDTH * s2 * 1.5), y2, LANE_WIDTH * s2 * 0.8, pal.lane, fog)
        // Through the fork the lane count goes to FORK_LANES, and the middle one is solid: that is the
        // line you are choosing a side of, and it wants to read as a decision rather than a lane change.
        const marks = seg.fork >= 0 ? FORK_LANES : lanes
        for (let l = 1; l < marks; l++) {
          const mid = seg.fork >= 0 && l * 2 === marks
          if (!band && !mid) continue
          const f = -1 + (2 * l) / marks
          const lw = mid ? LANE_WIDTH * 1.6 : LANE_WIDTH
          this.road.quad(cx1 + f * w1, y1, lw * s1, cx2 + f * w2, y2, lw * s2, pal.lane, fog)
        }
        if (seg.closed) {
          // Roadworks: a concrete jersey barrier along the lane line with an orange stripe on top.
          const e = seg.closed
          const jx1 = cx1 + e * 0.5 * w1
          const jx2 = cx2 + e * 0.5 * w2
          this.road.quad(jx1, y1 + 0.45 * s1, 0.36 * s1, jx2, y2 + 0.45 * s2, 0.36 * s2, 0xd4d2ca, fog)
          this.road.quad(jx1, y1 + 0.85 * s1, 0.3 * s1, jx2, y2 + 0.85 * s2, 0.3 * s2, 0xe8801a, fog)
        }
        this.road.setDim(ambientDim)
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
    // 3D models instead of sprites, when asked for and once they are in memory. 1 poses the meshes
    // exactly where the sprites were; 2 puts a real camera on them.
    const want3D = MODELS_3D >= 1.5 ? 2 : MODELS_3D > 0.5 ? 1 : 0
    if (want3D && !this.models.ready) void this.models.load()
    const mode = this.models.ready ? want3D : 0
    // Live sprites: the same pass, drawing from a sheet photographed this frame rather than shipped.
    const posed = mode === 1
    const solid = mode === 2
    if (posed && !this.live.ready) {
      this.live.init(this.renderer, this.retro)
      this.live.setModels(this.models.fitted)
    }
    const liveOn = posed && this.live.ready && this.live.texture !== null
    if (liveOn) this.live.begin()
    if (this.atlas.texture) this.sprites.setAtlas(liveOn ? this.live.texture! : this.atlas.texture)
    // One 3D pass through one lens, whichever way the meshes are being posed. Only solid mode stands
    // them in real places, so only solid mode has a ground to bury them in.
    this.models.scene.visible = solid
    if (this.style) this.style.extra = solid ? this.renderSolid : null
    this.models.aspect = W / H
    this.models.begin(FOV_DEG, horizon, cover, solid)
    if (solid) this.models.setGround(this.rowCx, this.rowCy, this.rowCz, this.rowTilt, ROWS)
    this.sprites.begin()
    const carOrder = this.carOrder
    carOrder.length = 0
    for (let i = 0; i < curr.trafficCount; i++) carOrder.push(i)
    carOrder.sort((i, j) => curr.trafficZ[j] - curr.trafficZ[i])
    let carPtr = 0
    for (let n = DRAW_SEGMENTS - 1; n >= 0; n--) {
      if (!this.rowValid[n]) continue
      const seg = segAt(base + n)
      // Cars whose z falls in this segment.
      const zStart = (base + n) * SEG_LENGTH
      while (carPtr < carOrder.length && curr.trafficZ[carOrder[carPtr]] >= zStart) {
        const ci = carOrder[carPtr++]
        const cz = curr.trafficZ[ci]
        if (cz < zStart + SEG_LENGTH && this.rowValid[n + 1]) {
          const t = (cz - zStart) / SEG_LENGTH
          const sc = this.rowScale[n] + (this.rowScale[n + 1] - this.rowScale[n]) * t
          const sx = this.rowX[n] + (this.rowX[n + 1] - this.rowX[n]) * t
          // Every part of the sprite's position is read between the two rows it sits between, the bank
          // lift included. Taking the lift from the near row alone made a car hop each time it crossed
          // a row boundary — a bobbing that got comical on a banked turn, where the lift is metres.
          const lat = curr.trafficX[ci] * ROAD_HALF_WIDTH
          const lift0 = this.tiltLift(n, lat)
          const sy = this.rowY[n] + (this.rowY[n + 1] - this.rowY[n]) * t + lift0 + (this.tiltLift(n + 1, lat) - lift0) * t
          const kind = TRAFFIC_KINDS[curr.trafficKind[ci]]
          const yaw = curr.trafficYaw[ci]
          // Pose from the real view geometry: how far off to the side the car sits versus how far ahead
          // gives the flank angle, and the height difference (hills) versus distance gives the pitch —
          // descending you look down onto roofs, climbing you look up at bumpers. The chase camera sits
          // higher than the cockpit's eye line, so it adds more downward pitch.
          const dz = Math.max(6, cz - camZ)
          const viewYaw = yaw === 0 ? (Math.atan2((curr.trafficX[ci] - x) * ROAD_HALF_WIDTH, dz) * 180) / Math.PI : yaw
          // How far above this car the camera actually sits. The sprite pass adds a bias on top, which is
          // there to bend the choice of baked frame toward the flattering one — a mesh needs no such help,
          // and wearing the bias it drives along with its nose in the air.
          const groundPitch = (Math.atan2(camY - stage.heightAt(cz), dz) * 180) / Math.PI
          const viewPitch = (view.drawPlayer ? 9 : 2) + groundPitch
          // Live: photographed at the angle it is actually seen from, not snapped to one of sixteen.
          const frame = (liveOn ? this.live.frame(kind, viewYaw, viewPitch) : null) ?? this.atlas.frame(kind, viewYaw, viewPitch)
          const tsx = sx + lat * sc
          // Roll comes between the rows too, so a car does not snap upright halfway through a bank.
          const roll = Math.atan(this.rowTilt[n] + (this.rowTilt[n + 1] - this.rowTilt[n]) * t)
          if (!frame) continue
          // A mesh takes the same haze and the same light the sprite of it would have: it is the one
          // thing in the frame that could otherwise stay bright green a kilometre away.
          const fogT = this.rowFog[n]
          const bright = this.brightAt((base + n) * SEG_LENGTH - camZ)
          // Solid: the car's own heading, not the angle it happens to be seen from — that comes out
          // of where it is standing once there is a real camera.
          // In metres, between the same two rows the sprite is read between — the road's own numbers,
          // not its screen position taken apart again.
          if (
            solid &&
            this.models.addSolid(
              kind,
              this.rowCx[n] + (this.rowCx[n + 1] - this.rowCx[n]) * t + lat,
              this.rowCy[n] + (this.rowCy[n + 1] - this.rowCy[n]) * t + groundHeight(lat, this.rowTilt[n]),
              this.rowCz[n] + (this.rowCz[n + 1] - this.rowCz[n]) * t,
              1,
              yaw,
              roll,
              fogT,
              bright,
            )
          )
            continue
          const clipHere = this.clipAt(n, tsx)
          this.sprites.add(tsx, sy, frame.heightM * sc, frame, fogT, bright, clipHere, roll)
        }
      }
      if (seg.runway || base + n < 0) continue
      this.drawSegmentSprites(seg, n, this.brightAt((base + n) * SEG_LENGTH - camZ), liveOn, solid)
    }
    // Player car.
    if (view.drawPlayer) {
      const scale = P.scaleAt(view.playerAhead)
      const py = P.screenY(groundY + curr.airY - camY, scale) + this.tiltLift(1, curr.x * ROAD_HALF_WIDTH) * (scale / Math.max(1e-6, this.rowScale[1]))
      const steerFrame = Math.round(curr.steer * 3)
      // Baked yaw > 0 shows the car's right flank (nose left); steering right must show the left flank.
      let yaw = steerFrame === 0 ? 0 : steerFrame > 0 ? -[12, 24, 38][steerFrame - 1] : [12, 24, 38][-steerFrame - 1]
      // A mesh can hold any angle, so it gets the steering and the crash spin continuously rather
      // than snapped to whichever of the sixteen baked views is nearest.
      let spinDeg = -curr.steer * 38
      if (curr.crashT > 0) {
        // A crash spins the car a full turn on the spot; a wreck spins it through the air, then it lies still.
        const t = curr.crashT
        const turn = curr.wreck ? (t < 0.7 ? Math.min(1, t / 0.4) * 1.5 : 0) : t
        spinDeg = ((turn * 360 + 180) % 360) - 180
        yaw = nearestYaw(spinDeg)
      }
      const frame = (liveOn ? this.live.frame(this.heroKind, spinDeg, DEFAULT_PITCH) : null) ?? this.atlas.frame(this.heroKind, yaw)
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
      const carX = W / 2 + curr.steer * 2
      const carSize = frame ? frame.heightM * scale * squash : 0
      const heroRoll = Math.atan(this.rowTilt[1])
      // Solid takes the steering angle continuously instead of the nearest of sixteen baked ones,
      // which is the whole point of it.
      // The hero in metres too: `playerAhead` in front of the camera, which is riding directly over it —
      // so it is at the camera's own lateral, give or take the lean the sprite pass puts on it.
      const heroLat = curr.x * ROAD_HALF_WIDTH
      const drawn =
        (solid &&
          this.models.addSolid(
            this.heroKind,
            (curr.steer * 2) / scale,
            groundY + curr.airY - camY + groundHeight(heroLat, this.rowTilt[1]) + hop / scale,
            view.playerAhead,
            squash,
            spinDeg,
            heroRoll,
          ))
      if (frame && !drawn) this.sprites.add(carX, py + hop, carSize, frame, 0, 1, -1e9, heroRoll)
      // Afterburner: boost lit and the throttle down, and not while the car is a wreck.
      this.flames.update(carX, py + hop, carSize, frame, Math.atan(this.rowTilt[1]), curr.hud.turboActive && curr.throttle > 0.1 && curr.crashT <= 0, dt)
    }
    if (this.previewKind) {
      const f = this.atlas.frame(this.previewKind, this.previewYaw)
      if (f) this.sprites.add(W / 2, H * 0.12, H * 0.75, f, 0, 1, -1e9)
    }
    this.sprites.end()
    this.models.end()

    // Background parallax and horizon.
    const slopeAhead = stage.heightAt(z + 60) - groundY
    this.background.layout(W, H, H / 2 - slopeAhead * 0.9 - (this.camY - groundY - view.camHeight) * 0.5)
    this.background.update(curr.curveAccum + spinYaw / (Math.PI * 2) / 0.0006, groundY)
    this.cockpit.mesh.visible = this.view === 'cockpit'
    if (this.cockpit.mesh.visible) this.cockpit.update(curr, dt)
    // The in-buffer HUD only exists in the retro pipeline, and only when asked for.
    this.hudLayer.mesh.visible = this.hudEnabled && this.retro && HUD_RETRO > 0.5
    this.hudLayer.cockpit = this.view === 'cockpit'
    if (this.hudLayer.mesh.visible) this.hudLayer.update(curr, dt)
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
    const nightAmt = this.nightAmt
    if (nightAmt <= 0.02) return 1
    // Headlights are a switch you have to find; without them the night is very dark.
    const dark = this.lightsOn ? NIGHT_AMBIENT + (1 - NIGHT_AMBIENT) * Math.exp(-Math.max(0, zRel) / HEADLIGHT_REACH) : NIGHT_AMBIENT * LIGHTS_OFF_AMBIENT
    return 1 + (dark - 1) * nightAmt
  }

  private drawSegmentSprites(seg: Segment, n: number, bright: number, live = false, solid = false): void {
    const sc = this.rowScale[n]
    for (const sp of seg.sprites) {
      const frame = (live ? this.live.frame(sp.kind, 0, DEFAULT_PITCH) : null) ?? this.atlas.frame(sp.kind)
      if (!frame) continue
      const sx = this.rowX[n] + sp.offset * ROAD_HALF_WIDTH * sc
      const lat = sp.offset * ROAD_HALF_WIDTH
      const sy = this.rowY[n] + this.tiltLift(n, lat)
      const clipHere = this.clipAt(n, sx)
      // Lit signage and towers glow through the night; a silhouette vibe (the sunset) flattens
      // everything roadside to a cut-out instead, and blends in as the sun goes down.
      const lit = sp.kind.startsWith('sign') || sp.kind.startsWith('tower') || sp.kind === 'diner' || sp.kind === 'motel' || sp.kind === 'gas' || sp.kind === 'arch' ? Math.max(bright, 0.85) : bright
      const glow = this.silAmt > 0.01 ? lit + (0.04 - lit) * this.silAmt : lit
      const h = frame.heightM * sp.scale * sc
      if (solid && this.models.addSolid(sp.kind, this.rowCx[n] + lat, this.rowCy[n] + groundHeight(lat, this.rowTilt[n]), this.rowCz[n], sp.scale, 0, 0, this.rowFog[n], glow)) continue
      this.sprites.add(sx, sy, h, frame, this.rowFog[n], glow, clipHere)
    }
  }

  /**
   * Where a sprite standing at row `n`, screen x `screenX`, gets cut: the skyline — how high the ground
   * between it and the camera reaches at that screen x. Crest, camber and bank are the same question
   * and this is the one answer to it.
   */
  private clipAt(n: number, screenX: number): number {
    const b = Math.floor((screenX / Math.max(1, this.proj.width)) * SKY_BINS)
    return this.sky[n * SKY_BINS + (b < 0 ? 0 : b >= SKY_BINS ? SKY_BINS - 1 : b)]
  }

  /** Screen-y of the ground at a lateral offset (metres) on row n — the bank included, so a tree on it stands on it. */
  private tiltLift(n: number, lateralM: number): number {
    const t = this.rowTilt[n]
    if (!t) return 0
    return groundHeight(lateralM, t) * this.rowScale[n]
  }

  /** The solid-model pass, handed to the style so it lands in the style's own buffer. */
  private readonly renderSolid = (r: WebGLRenderer): void => this.models.render(r)

  render(): void {
    // Photograph whatever the sprite pass asked for before anything draws from the sheet.
    this.live.flush(this.renderer)
    this.renderer.info.reset()
    this.style?.render(this.info)
    this.stats.drawCalls = this.renderer.info.render.calls
    this.stats.triangles = this.renderer.info.render.triangles
  }

  get themeName(): string {
    return this.themeId
  }
}
