// Owns the three.js scene and everything in it. Reads SimSnapshots (prev/curr
// + alpha), never writes sim state. Styles decide how the scene is presented.

import { AmbientLight, Color, Group, HemisphereLight, PointLight, Scene, Vector3, WebGLRenderer } from 'three'
import { angleDelta, clamp, expApproach } from '@apex/engine/math/scalar'
import { Vec3 } from '@apex/engine/math/Vec3'
import type { SimEvent } from '../sim/Events'
import { SimSnapshot, TRAFFIC_KIND_CODES, type VehicleSnap } from '../sim/SimSnapshot'
import { SHIELD_MAX, SPEED_CRUISE, SPEED_MAX } from '../sim/Tuning'
import type { Track } from '../sim/track/Track'
import { CameraRig } from './CameraRig'
import { Craft } from './Craft'
import { BG_COLOR, FLOATING_ORIGIN_REBASE, FOG_DENSITY_MODERN, FOG_DENSITY_RETRO, MAX_PARTICLES, RING_SEGMENTS_MODERN } from './RenderTuning'
import { TrafficRenderer } from './TrafficRenderer'
import { makeTunnelMaterial, makeTunnelUniforms } from './tunnel/TunnelMaterial'
import { TunnelMeshPool } from './tunnel/TunnelMeshPool'
import { LaserBeam } from './vfx/LaserBeam'
import { Particles } from '@apex/engine/render/Particles'
import { ShockwaveRing } from './vfx/ShockwaveRing'
import { Sky } from '@apex/engine/render/Sky'
import { SpeedLines } from './vfx/SpeedLines'
import { TrackProps } from './vfx/TrackProps'
import type { Style, StyleFrameInfo } from '@apex/engine/render/styles/Style'
import type { RenderStats } from '@apex/engine/render/RenderStats'
import { disposeObject3D } from '@apex/engine/render/dispose'


export class RenderWorld {
  readonly renderer: WebGLRenderer
  readonly scene = new Scene()
  /** Floating-origin root: everything in sim coordinates hangs off this. */
  readonly root = new Group()
  readonly rig: CameraRig
  readonly tunnel: TunnelMeshPool
  readonly craft = new Craft()
  /** Best-run ghost, drawn translucent; hidden when there is no ghost. */
  readonly ghost = new Craft()
  readonly traffic = new TrafficRenderer()
  readonly particles = new Particles(MAX_PARTICLES)
  readonly speedLines = new SpeedLines()
  readonly laser = new LaserBeam()
  readonly shock = new ShockwaveRing()
  readonly props = new TrackProps()
  readonly sky = new Sky()
  readonly tunnelUniforms = makeTunnelUniforms()
  readonly headlight: PointLight
  readonly stats: RenderStats = { drawCalls: 0, triangles: 0, chunks: 0 }
  style: Style | null = null
  track: Track
  private readonly origin = new Vector3()
  private readonly interp: VehicleSnap
  private readonly v3 = new Vector3()
  private readonly v3b = new Vector3()
  private readonly info: StyleFrameInfo = { speedT: 0, boost: 0, shockAge: -1, dt: 0, time: 0, shield: 100, hit: 0 }
  private time = 0
  private boostGlow = 0
  private hitFlash = 0
  private retro = false
  private readonly bg = new Color(BG_COLOR)
  private xrActive = false
  private width = 1
  private height = 1
  private pixelRatio = 1
  /** Extra objects (cockpit) can attach to the camera. */
  readonly cameraRoot = new Group()

  constructor(canvas: HTMLCanvasElement, track: Track) {
    this.track = track
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true, alpha: false })
    this.renderer.setClearColor(this.bg, 1)
    // Post stacks render several passes per frame; count them all.
    this.renderer.info.autoReset = false
    this.rig = new CameraRig(1)
    this.scene.add(this.root)
    this.root.add(this.cameraRoot)
    this.cameraRoot.add(this.rig.camera)

    const tunnelMat = makeTunnelMaterial(this.tunnelUniforms)
    this.tunnel = new TunnelMeshPool(track, tunnelMat)
    this.root.add(this.tunnel.root)
    this.root.add(this.craft.root)
    this.ghost.root.visible = false
    for (const m of this.ghost.materials) {
      m.transparent = true
      m.opacity = 0.3
      m.depthWrite = false
    }
    this.ghost.accentMaterial.transparent = true
    this.ghost.accentMaterial.opacity = 0.5
    this.ghost.shadow.visible = false
    this.ghost.engine.visible = false
    this.root.add(this.ghost.root)
    this.root.add(this.traffic.root)
    this.root.add(this.particles.points)
    this.root.add(this.speedLines.mesh)
    this.root.add(this.laser.root)
    this.root.add(this.shock.mesh)
    this.root.add(this.props.root)
    this.scene.add(this.sky.root)

    this.root.add(new AmbientLight(0x334466, 0.6))
    this.root.add(new HemisphereLight(0x8899cc, 0x221133, 0.7))
    this.headlight = new PointLight(0x9fd8ff, 60, 90, 1.6)
    this.root.add(this.headlight)

    this.interp = structuredCloneSnap(new SimSnapshot().vehicle)
    this.applyPalette(track.course.palette)
  }

  setTrack(track: Track): void {
    this.track = track
    this.tunnel.setTrack(track)
    this.applyPalette(track.course.palette)
    this.rig.reset(0)
  }

  /** Shift the neon palette per course. */
  applyPalette(hue: number): void {
    const u = this.tunnelUniforms
    u.uLineColor.value.setHSL(hue, 0.95, 0.55)
    u.uRibColor.value.setHSL(hue, 0.9, 0.75)
    u.uWallColor.value.setHSL((hue + 0.05) % 1, 0.45, 0.06)
    u.uBoostColor.value.setHSL((hue + 0.45) % 1, 1, 0.62)
    u.uFogColor.value.copy(this.bg)
    this.sky.setPalette(hue, this.bg)
  }

  /**
   * Give the GPU back everything. Called when the arcade unmounts the game; a standalone build
   * never reaches it, because the tab closing does the same job.
   */
  dispose(): void {
    this.style?.detach()
    this.style = null
    disposeObject3D(this.scene)
    this.renderer.dispose()
    // Release the context now rather than at the next collection: browsers cap how many live
    // WebGL contexts a page may hold, and the arcade makes a fresh one for every game entered.
    this.renderer.forceContextLoss()
  }

  setStyle(style: Style): void {
    this.style?.detach()
    this.style = style
    style.attach(this.renderer, this.scene, this.rig.camera)
    style.setXr(this.xrActive)
    this.retro = style.name === 'retro'
    this.tunnelUniforms.uFlat.value = this.retro ? 1 : 0
    this.tunnelUniforms.uFogDensity.value = this.retro ? FOG_DENSITY_RETRO : FOG_DENSITY_MODERN
    this.traffic.setRetro(this.retro)
    this.particles.setFlat(this.retro)
    style.resize(this.width, this.height, this.pixelRatio)
  }

  /** Retro geometry reductions, applied separately so they are toggleable. */
  setRetroGeometry(ringSegments: number, quantize: boolean): void {
    this.tunnel.setSegments(this.retro ? ringSegments : RING_SEGMENTS_MODERN)
    if (this.retro && quantize) this.tunnelUniforms.uSnap.value.set(320, 240)
    else this.tunnelUniforms.uSnap.value.set(0, 0)
  }

  setXr(active: boolean): void {
    this.xrActive = active
    this.style?.setXr(active)
    this.rig.controlsProjection = !active
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = width
    this.height = height
    this.pixelRatio = pixelRatio
    this.rig.camera.aspect = width / height
    this.rig.camera.updateProjectionMatrix()
    this.particles.setPixelRatio(this.retro ? 1 : pixelRatio)
    this.style?.resize(width, height, pixelRatio)
  }

  /** React to a sim event: VFX and camera shake. Audio/haptics live elsewhere. */
  onEvent(e: SimEvent): void {
    const p = e.pos
    switch (e.type) {
      case 'kill': {
        const kind = TRAFFIC_KIND_CODES[e.a]
        const big = kind === 'GATE_BOSS' ? 4 : kind === 'ARMORED' || kind === 'BLOCKER' ? 1.8 : 1
        this.particles.burst(p, Math.round(28 * big), 55 * big, 0.9, 1, 0.55, 0.25, 4 * big)
        this.particles.burst(p, Math.round(14 * big), 30 * big, 0.6, 0.4, 0.9, 1, 3 * big)
        this.rig.addShake(kind === 'GATE_BOSS' ? 0.8 : 0.12)
        break
      }
      case 'collision':
        this.particles.burst(p, 40, 40, 0.7, 1, 0.6, 0.2, 3.5)
        this.rig.addShake(0.9)
        this.hitFlash = 1
        break
      case 'hit':
        this.particles.burst(p, 16, 25, 0.4, 1, 0.3, 0.3, 2.5)
        this.rig.addShake(0.35)
        this.hitFlash = 0.6
        break
      case 'scrape':
        this.particles.burst(p, 6, 20, 0.3, 1, 0.8, 0.4, 1.6)
        break
      case 'shot_fired':
        if (e.a > 0) this.particles.burst(p, 3, 18, 0.25, 0.6, 1, 1, 1.8)
        break
      case 'gate':
        this.particles.burst(p, 60, 30, 1.2, 0.3, 0.95, 1, 5, undefined, 1)
        break
      case 'shockwave':
        this.rig.addShake(0.7)
        this.particles.burst(p, 120, 90, 0.8, 1, 0.5, 0.9, 5)
        break
      case 'pickup':
        this.particles.burst(p, 30, 22, 0.8, e.a === 0 ? 1 : 0.3, e.a === 0 ? 0.4 : 1, e.a === 0 ? 0.9 : 0.5, 3.5)
        break
      case 'ring':
        this.particles.burst(p, 40, 25, 0.9, 1, 0.85, 0.3, 4)
        break
      case 'land':
        this.particles.burst(p, 30, 35, 0.5, 0.8, 0.9, 1, 3)
        this.rig.addShake(0.4)
        break
      case 'spinout':
        this.particles.burst(p, 90, 45, 1.0, 1, 0.5, 0.2, 4)
        this.rig.addShake(1.2)
        this.hitFlash = 1
        break
      case 'crash':
        this.particles.burst(p, 200, 70, 1.6, 1, 0.5, 0.2, 6)
        this.particles.burst(p, 80, 40, 1.2, 1, 0.9, 0.6, 5)
        this.rig.addShake(1.4)
        this.hitFlash = 1
        break
      case 'enemy_shot':
        this.particles.burst(p, 4, 10, 0.3, 1, 0.4, 0.9, 2)
        break
      case 'overheat':
        this.particles.burst(p, 20, 12, 0.6, 1, 0.5, 0.1, 2.5)
        break
      default:
        break
    }
  }

  update(prev: SimSnapshot, curr: SimSnapshot, alpha: number, dt: number, ringTaken: (i: number) => boolean): void {
    this.time += dt
    const v = this.interp
    lerpVehicle(prev.vehicle, curr.vehicle, prev.tick < curr.tick ? alpha : 1, v)

    // Floating origin: rebase when the craft wanders far from it.
    this.v3.set(v.pos.x, v.pos.y, v.pos.z)
    if (this.v3.distanceTo(this.origin) > FLOATING_ORIGIN_REBASE) {
      this.origin.copy(this.v3)
      this.root.position.copy(this.origin).negate()
    }

    // Craft pose.
    const c = this.craft.root
    c.position.set(v.pos.x, v.pos.y, v.pos.z)
    this.v3.set(v.forward.x, v.forward.y, v.forward.z)
    this.v3b.set(v.up.x, v.up.y, v.up.z)
    c.up.copy(this.v3b)
    c.lookAt(this.v3.add(c.position))
    // A spin-out yaws the craft about its own up axis, like a car spinning on tarmac.
    if (v.spin > 0) c.rotateY((v.spin / 0.7) * Math.PI * 2 * (v.thetaVel >= 0 ? 1 : -1))
    c.rotateZ(v.bank)
    this.craft.shadow.visible = !v.airborne
    const throttleGlow = clamp((v.speed - SPEED_CRUISE) / (SPEED_MAX - SPEED_CRUISE), 0, 1)
    this.boostGlow = expApproach(this.boostGlow, v.onBoost ? 1 : 0, 8, dt)
    this.craft.setEngine(Math.max(throttleGlow, this.boostGlow), v.onBoost)
    this.craft.setShield(curr.hud.shield / SHIELD_MAX, dt)
    this.headlight.position.copy(c.position).addScaledVector(this.v3b, 3)

    // Camera.
    this.rig.update(v, this.track, dt, this.boostGlow)

    // World.
    this.tunnel.update(v.s)
    this.stats.chunks = this.tunnel.visibleChunks
    const u = this.tunnelUniforms
    u.uTime.value = this.time
    u.uSpeed.value = v.speed
    u.uBoostPulse.value = this.boostGlow
    this.rig.camera.getWorldPosition(u.uCameraPos.value)
    this.sky.update(u.uCameraPos.value)
    this.traffic.update(prev, curr, alpha, this.track)
    this.particles.update(dt)
    this.speedLines.update(this.track, v.s - 10, v.branch, v.speed, v.airborne, v.theta)
    this.laser.update(curr, dt, this.time)
    this.shock.update(curr, this.track)
    this.props.update(this.track, v.s, curr.hud.gatesPassed, ringTaken, this.time)
    this.hitFlash = expApproach(this.hitFlash, 0, 6, dt)

    const info = this.info
    info.speedT = clamp((v.speed - SPEED_CRUISE) / (SPEED_MAX - SPEED_CRUISE), -0.3, 1.3)
    info.boost = this.boostGlow
    info.shockAge = curr.shockAge
    info.dt = dt
    info.time = this.time
    info.shield = curr.hud.shield
    info.hit = this.hitFlash
  }

  /** Pose the ghost from its own snapshot (or hide it). */
  updateGhost(snap: SimSnapshot | null): void {
    const g = this.ghost.root
    if (!snap || snap.phase !== 'running') {
      g.visible = false
      return
    }
    g.visible = true
    const v = snap.vehicle
    g.position.set(v.pos.x, v.pos.y, v.pos.z)
    this.v3.set(v.forward.x, v.forward.y, v.forward.z)
    this.v3b.set(v.up.x, v.up.y, v.up.z)
    g.up.copy(this.v3b)
    g.lookAt(this.v3.add(g.position))
    g.rotateZ(v.bank)
  }

  render(): void {
    this.renderer.info.reset()
    this.style?.render(this.info)
    this.stats.drawCalls = this.renderer.info.render.calls
    this.stats.triangles = this.renderer.info.render.triangles
  }

  /** Warm every shader before the first real frame. */
  precompile(): void {
    this.tunnel.update(0)
    this.renderer.compile(this.scene, this.rig.camera)
  }

  get interpolated(): VehicleSnap {
    return this.interp
  }
}

function lerpVehicle(a: VehicleSnap, b: VehicleSnap, t: number, out: VehicleSnap): void {
  out.pos.lerpVectors(a.pos, b.pos, t)
  out.forward.lerpVectors(a.forward, b.forward, t).normalize()
  out.up.lerpVectors(a.up, b.up, t).normalize()
  out.right.cross(out.forward, out.up).normalize()
  out.s = a.s + (b.s - a.s) * t
  out.theta = a.theta + angleDelta(a.theta, b.theta) * t
  out.speed = a.speed + (b.speed - a.speed) * t
  out.bank = a.bank + (b.bank - a.bank) * t
  out.spin = b.spin
  out.airborne = b.airborne
  out.branch = b.branch
  out.onBoost = b.onBoost
  out.scraping = b.scraping
  out.radius = b.radius
  out.arc = b.arc
  out.thetaVel = b.thetaVel
}

function structuredCloneSnap(v: VehicleSnap): VehicleSnap {
  return {
    pos: new Vec3().copy(v.pos),
    forward: new Vec3().copy(v.forward),
    up: new Vec3().copy(v.up),
    right: new Vec3().copy(v.right),
    s: v.s,
    theta: v.theta,
    speed: v.speed,
    bank: v.bank,
    spin: v.spin,
    airborne: v.airborne,
    branch: v.branch,
    onBoost: v.onBoost,
    scraping: v.scraping,
    radius: v.radius,
    arc: v.arc,
    thetaVel: v.thetaVel,
  }
}
