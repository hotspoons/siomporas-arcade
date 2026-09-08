// Scene owner for the driving game. Reads snapshots, never writes sim state.

import { AmbientLight, Color, DirectionalLight, Group, HemisphereLight, MeshStandardMaterial, Scene, Vector3, WebGLRenderer } from 'three'
import { Particles } from '@apex/engine/render/Particles'
import { Sky } from '@apex/engine/render/Sky'
import type { RenderStats } from '@apex/engine/render/RenderStats'
import type { Style, StyleFrameInfo } from '@apex/engine/render/styles/Style'
import type { CarSpec } from '../sim/CarSpec'
import type { SimEvent } from '../sim/Events'
import type { Snapshot } from '../sim/Snapshot'
import type { Track } from '../sim/Track'
import { CameraRig } from './CameraRig'
import { CarMesh } from './CarMesh'
import { Ground } from './Ground'
import { BG_COLOR, FOG_DENSITY_MODERN, FOG_DENSITY_RETRO, MAX_PARTICLES, TUBE_SEGMENTS_MODERN, TUBE_SEGMENTS_RETRO } from './RenderTuning'
import { RoadBuilder } from './RoadBuilder'
import { makeRoadMaterial, makeRoadUniforms } from './RoadMaterial'

export class RenderWorld {
  readonly renderer: WebGLRenderer
  readonly scene = new Scene()
  readonly root = new Group()
  readonly rig: CameraRig
  readonly roads: RoadBuilder
  readonly ground = new Ground()
  readonly sky = new Sky()
  readonly particles = new Particles(MAX_PARTICLES)
  readonly roadUniforms = makeRoadUniforms()
  readonly stats: RenderStats = { drawCalls: 0, triangles: 0, chunks: 0 }
  car: CarMesh
  style: Style | null = null
  private retro = false
  private xrActive = false
  private width = 1
  private height = 1
  private pixelRatio = 1
  private time = 0
  private readonly info: StyleFrameInfo = { speedT: 0, boost: 0, shockAge: -1, dt: 0, time: 0, shield: 100, hit: 0 }
  private readonly bg = new Color(BG_COLOR)
  private readonly v3 = new Vector3()
  private readonly v3b = new Vector3()
  private topSpeed = 80
  private currentTrack: Track | null = null
  private prevSpeed = 0

  constructor(canvas: HTMLCanvasElement, spec: CarSpec) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false })
    this.renderer.setClearColor(this.bg, 1)
    this.renderer.info.autoReset = false
    this.rig = new CameraRig(1)
    this.scene.add(this.root)
    this.root.add(this.rig.camera)
    this.roads = new RoadBuilder(makeRoadMaterial(this.roadUniforms), new MeshStandardMaterial({ color: 0x3a4250, roughness: 0.8, flatShading: true }))
    this.root.add(this.roads.root)
    this.root.add(this.ground.mesh)
    this.scene.add(this.sky.root)
    // Clear day: deep blue overhead, pale haze at the horizon, no stars.
    this.sky.setColors(0x2f6fd0, 0xa9d3f5, BG_COLOR)
    this.sky.setStars(false)
    // Keep the dome well inside the camera's far plane or its facets get clipped into shapes.
    this.sky.root.scale.setScalar(0.4)
    this.car = new CarMesh(spec.look)
    this.root.add(this.car.root)
    this.root.add(this.particles.points)
    this.root.add(new AmbientLight(0x8fa8d0, 0.6))
    this.root.add(new HemisphereLight(0xcfe4ff, 0x4a7a3a, 0.9))
    const sun = new DirectionalLight(0xfff6e0, 1.8)
    sun.position.set(300, 500, 200)
    this.root.add(sun)
    this.topSpeed = spec.topSpeed
  }

  setCar(spec: CarSpec): void {
    this.root.remove(this.car.root)
    this.car = new CarMesh(spec.look)
    this.root.add(this.car.root)
    this.topSpeed = spec.topSpeed
  }

  setTrack(track: Track): void {
    this.currentTrack = track
    this.roads.build(track, this.retro ? TUBE_SEGMENTS_RETRO : TUBE_SEGMENTS_MODERN)
    this.stats.chunks = track.lanes.length
    this.rig.reset()
  }

  setStyle(style: Style): void {
    this.style?.detach()
    this.style = style
    style.attach(this.renderer, this.scene, this.rig.camera)
    style.setXr(this.xrActive)
    this.retro = style.name === 'retro'
    this.roadUniforms.uFlat.value = this.retro ? 1 : 0
    this.roadUniforms.uFogDensity.value = this.retro ? FOG_DENSITY_RETRO : FOG_DENSITY_MODERN
    this.ground.material.uniforms.uFlat.value = this.retro ? 1 : 0
    this.ground.material.uniforms.uFogDensity.value = this.retro ? FOG_DENSITY_RETRO : FOG_DENSITY_MODERN
    this.particles.setFlat(this.retro)
    if (this.currentTrack) this.roads.build(this.currentTrack, this.retro ? TUBE_SEGMENTS_RETRO : TUBE_SEGMENTS_MODERN)
    style.resize(this.width, this.height, this.pixelRatio)
  }

  setRetroSnap(on: boolean): void {
    this.roadUniforms.uSnap.value.set(on && this.retro ? 320 : 0, on && this.retro ? 240 : 0)
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

  onEvent(e: SimEvent): void {
    const p = e.pos
    switch (e.type) {
      case 'crash':
        this.particles.burst(p, 160, 22, 1.6, 1, 0.5, 0.2, 5)
        this.particles.burst(p, 60, 12, 2.2, 0.3, 0.3, 0.3, 6)
        this.rig.addShake(1.2)
        break
      case 'land':
        this.particles.burst(p, 24, 8, 0.8, 0.5, 0.45, 0.35, 3)
        this.rig.addShake(Math.min(1, e.a / 60))
        break
      case 'curb':
        this.particles.burst(p, 3, 4, 0.4, 0.9, 0.9, 0.8, 1.5)
        break
      case 'bump':
        this.particles.burst(p, 18, 8, 1.2, 0.6, 0.6, 0.55, 3)
        this.rig.addShake(Math.min(1, e.a / 40))
        break
      case 'offroad':
        this.particles.burst(p, 20, 6, 0.9, 0.3, 0.45, 0.2, 3)
        break
      default:
        break
    }
  }

  update(prev: Snapshot, curr: Snapshot, alpha: number, dt: number): void {
    this.time += dt
    const a = prev.tick < curr.tick && prev.phase === curr.phase ? alpha : 1
    const c = this.car.root
    const pc = prev.car
    const cc = curr.car
    c.position.set(pc.pos.x + (cc.pos.x - pc.pos.x) * a, pc.pos.y + (cc.pos.y - pc.pos.y) * a, pc.pos.z + (cc.pos.z - pc.pos.z) * a)
    this.v3.set(pc.forward.x + (cc.forward.x - pc.forward.x) * a, pc.forward.y + (cc.forward.y - pc.forward.y) * a, pc.forward.z + (cc.forward.z - pc.forward.z) * a).normalize()
    this.v3b.set(pc.up.x + (cc.up.x - pc.up.x) * a, pc.up.y + (cc.up.y - pc.up.y) * a, pc.up.z + (cc.up.z - pc.up.z) * a).normalize()
    // Car model's +x is forward: build the basis directly.
    const right = new Vector3().crossVectors(this.v3b, this.v3).normalize()
    c.matrix.makeBasis(this.v3, this.v3b, right.negate())
    c.matrix.setPosition(c.position)
    c.matrixAutoUpdate = false
    this.car.update(cc.wheelSpin, cc.steer, cc.braking)

    // Skid smoke when sliding.
    if (cc.slip > 0.6 && cc.mode === 'track' && (curr.tick & 3) === 0) this.particles.burst(cc.pos, 2, 3, 0.7, 0.7, 0.7, 0.7, 2.5)

    this.rig.update(curr, dt, this.topSpeed)
    this.rig.camera.getWorldPosition(this.roadUniforms.uCameraPos.value)
    this.ground.material.uniforms.uCameraPos.value.copy(this.roadUniforms.uCameraPos.value)
    this.roadUniforms.uTime.value = this.time
    this.sky.update(this.roadUniforms.uCameraPos.value)
    this.particles.update(dt)

    const info = this.info
    info.speedT = Math.min(1.2, cc.speed / this.topSpeed) - 0.2
    info.boost = 0
    info.shockAge = -1
    info.dt = dt
    info.time = this.time
    info.shield = 100
    info.hit = Math.min(1, Math.abs(cc.speed - this.prevSpeed) / 25)
    this.prevSpeed = cc.speed
  }

  render(): void {
    this.renderer.info.reset()
    this.style?.render(this.info)
    this.stats.drawCalls = this.renderer.info.render.calls
    this.stats.triangles = this.renderer.info.render.triangles
  }

  precompile(): void {
    this.renderer.compile(this.scene, this.rig.camera)
  }
}
