// The lobby: a dim room with the cabinets stood in a shallow arc, the one you are looking at
// square on and lit, its neighbours turned in and falling away.
//
// It is a game as far as the shell is concerned — same GameModule contract, same GameLoop, same
// post-processing — which is the point. Walking from the marquees into Turbo Radrun swaps one
// mounted module for another and nothing else about the page changes.

import { AmbientLight, BoxGeometry, Color, Fog, Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, PointLight, RepeatWrapping, Scene, SRGBColorSpace, TextureLoader, WebGLRenderer } from 'three'
import { GameLoop, type LoopClient } from '@apex/engine/app/GameLoop'
import { Disposer } from '@apex/engine/app/Disposer'
import type { GameHost, GameModule, MountedGame } from '@apex/engine/app/GameModule'
import { ModernStyle } from '@apex/engine/render/styles/ModernStyle'
import { KeyboardSource } from '@apex/engine/input/KeyboardSource'
import { GamepadSource } from '@apex/engine/input/GamepadSource'
import { GAMES } from '../catalog'
import { Cabinet } from './Cabinet'
import { CabinetArt } from './CabinetArt'
import { LobbyHud } from './LobbyHud'

/** Metres between cabinets along the arc, and how far the outer ones fall back and turn in. */
const SPACING = 1.16
const RECEDE = 0.42
const TURN = 0.34
/**
 * Every cabinet stands turned slightly off square. Dead on, an upright is a flat rectangle and the
 * silhouette — the kicked-back screen, the shelf under the sign, the depth of the thing — is
 * invisible. A few degrees is enough to read as an object without costing the marquee its
 * legibility, and the marquee is the menu.
 */
const BASE_YAW = 0.2
/** How fast the row settles on a new selection: fraction of the remaining distance per second. */
const GLIDE = 9

// Far enough back for a whole 2 m cabinet with air around it, high enough to look slightly down —
// which puts the cabinet up in the frame, clear of the plate along the bottom, and gives the floor
// somewhere to be. Looking at a point below the cabinet's middle is what does the lifting.
const CAMERA = { y: 1.62, z: 3.2, lookY: 1.0 }

class Lobby implements LoopClient, MountedGame {
  private readonly gone = new Disposer()
  private readonly scene = new Scene()
  private readonly camera: PerspectiveCamera
  private readonly renderer: WebGLRenderer
  private readonly style: ModernStyle
  private readonly loop: GameLoop
  private readonly keys = new KeyboardSource()
  private readonly pad = new GamepadSource()
  private readonly hud: LobbyHud
  private readonly row = new Group()

  /** Where the row actually is, and where it is heading. Fractional while it glides. */
  private pos: number
  private target: number
  private time = 0
  private entering = 1
  /** Extra camera distance for a short window — see resize(). */
  private dolly = 1

  private readonly host: GameHost
  private readonly cabinets: Cabinet[]
  private readonly arts: CabinetArt[]

  constructor(host: GameHost, cabinets: Cabinet[], arts: CabinetArt[], startIndex: number) {
    this.host = host
    this.cabinets = cabinets
    this.arts = arts
    this.pos = startIndex
    this.target = startIndex

    this.renderer = new WebGLRenderer({ canvas: host.canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false })
    this.renderer.setClearColor(0x05060b, 1)
    this.gone.add(() => {
      this.renderer.dispose()
      // Hand the GL context back now rather than waiting for the canvas to be collected — a browser
      // allows only a handful at once, and the arcade makes a new one every time a game is entered.
      this.renderer.forceContextLoss()
    })

    this.camera = new PerspectiveCamera(44, 1, 0.05, 60)
    this.camera.position.set(0, CAMERA.y, CAMERA.z)
    this.camera.lookAt(0, CAMERA.lookY, 0)

    this.scene.fog = new Fog(0x05060b, 5, 20)
    // Just enough to keep an unselected cabinet from being a black rectangle. Everything that
    // actually shapes the room comes from the marquees and the ceiling strips.
    this.scene.add(new AmbientLight(0x28304a, 0.55))
    this.scene.add(new HemisphereLight(0x4a5a86, 0x120e18, 0.7))
    this.scene.add(this.row)
    for (const c of this.cabinets) this.row.add(c.group)
    this.buildRoom()

    this.style = new ModernStyle({ bloom: true, motionBlur: false, chromatic: false, grain: true, smaa: true, slowmo: false })
    this.style.attach(this.renderer, this.scene, this.camera)
    this.gone.add(() => this.style.detach())

    this.hud = new LobbyHud(host.container)
    this.gone.add(() => this.hud.dispose())
    this.hud.onPick = (i) => this.pick(i)
    this.hud.onStep = (d) => this.step(d)
    this.hud.onStart = () => this.start()

    this.keys.attach(window)
    this.pad.attach(window)
    this.gone.add(() => {
      this.keys.detach(window)
      this.pad.detach(window)
    })

    this.gone.on(window, 'resize', () => this.resize())
    // Wheel and swipe both walk the row; the canvas is the whole page so neither scrolls anything.
    this.gone.on(host.canvas, 'wheel', (e) => this.onWheel(e), { passive: false })
    this.gone.on(host.canvas, 'pointerdown', (e) => this.onPointerDown(e))
    this.gone.on(window, 'pointerup', (e) => this.onPointerUp(e))
    this.gone.on(window, 'pointermove', (e) => this.onPointerMove(e))

    this.resize()
    this.layout()
    this.hud.show(this.cabinets[this.index].game)

    this.loop = new GameLoop(this, null, { simHz: 60, maxSubsteps: 4 })
    this.gone.add(() => this.loop.stop())
    this.loop.start()
  }

  /** The cabinet the row has settled nearest. */
  private get index(): number {
    return Math.max(0, Math.min(this.cabinets.length - 1, Math.round(this.target)))
  }

  private buildRoom(): void {
    const dark = new Color(0x0a0c16)

    const floorMat = new MeshStandardMaterial({ color: 0x3a3550, roughness: 0.72, metalness: 0.05 })
    const floor = new Mesh(new PlaneGeometry(40, 40), floorMat)
    floor.rotation.x = -Math.PI / 2
    this.scene.add(floor)
    this.gone.add(() => {
      floor.geometry.dispose()
      floorMat.dispose()
    })

    // Arcade carpet if it has been generated (see ART.md), otherwise the flat grey above.
    void new TextureLoader()
      .loadAsync('/room/carpet.webp')
      .then((tex) => {
        if (this.gone.disposed) {
          tex.dispose()
          return
        }
        tex.colorSpace = SRGBColorSpace
        tex.wrapS = tex.wrapT = RepeatWrapping
        tex.repeat.set(10, 10)
        tex.anisotropy = 8
        floorMat.map = tex
        floorMat.color.setScalar(1)
        floorMat.needsUpdate = true
        this.gone.add(() => tex.dispose())
      })
      .catch(() => {
        /* no carpet drawn yet */
      })

    // Two strips of ceiling neon: the only thing in the room that is not a cabinet, and what stops
    // the far end of the aisle reading as a void.
    const neonGeo = new BoxGeometry(30, 0.05, 0.09)
    for (const [z, tint] of [
      [-1.7, 0xff3f8a],
      [1.1, 0x2fb8ff],
    ] as const) {
      const mat = new MeshBasicMaterial({ color: tint, toneMapped: false })
      const strip = new Mesh(neonGeo, mat)
      strip.position.set(0, 3.0, z)
      this.scene.add(strip)
      const glow = new PointLight(new Color(tint), 22, 11, 2)
      glow.position.set(0, 2.8, z)
      this.scene.add(glow)
      this.gone.add(() => mat.dispose())
    }
    this.gone.add(() => neonGeo.dispose())

    const wallMat = new MeshStandardMaterial({ color: dark, roughness: 0.95 })
    const wall = new Mesh(new PlaneGeometry(40, 6), wallMat)
    wall.position.set(0, 3, -2.4)
    this.scene.add(wall)
    const ceiling = new Mesh(new PlaneGeometry(40, 12), wallMat)
    ceiling.rotation.x = Math.PI / 2
    ceiling.position.y = 3.1
    this.scene.add(ceiling)
    this.gone.add(() => {
      wall.geometry.dispose()
      ceiling.geometry.dispose()
      wallMat.dispose()
    })
  }

  // --- input ---------------------------------------------------------------

  private drag: { id: number; x: number; startPos: number; moved: number } | null = null

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    this.wheelAcc += d
    if (Math.abs(this.wheelAcc) > 60) {
      this.step(Math.sign(this.wheelAcc))
      this.wheelAcc = 0
    }
  }
  private wheelAcc = 0

  private onPointerDown(e: PointerEvent): void {
    this.drag = { id: e.pointerId, x: e.clientX, startPos: this.target, moved: 0 }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.id) return
    const dx = e.clientX - this.drag.x
    this.drag.moved = Math.max(this.drag.moved, Math.abs(dx))
    // A drag moves the row directly, one cabinet per quarter of the viewport.
    this.target = this.drag.startPos - dx / (window.innerWidth * 0.25)
    this.clampTarget()
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.id) return
    const wasDrag = this.drag.moved > 12
    this.drag = null
    if (wasDrag) this.target = Math.round(this.target)
    else this.start() // a tap on the cabinet in front of you is a coin in the slot
    this.clampTarget()
  }

  private step(dir: number): void {
    this.target = Math.round(this.target) + Math.sign(dir)
    this.clampTarget()
    this.hud.show(this.cabinets[this.index].game)
  }

  private pick(i: number): void {
    this.target = i
    this.clampTarget()
    this.hud.show(this.cabinets[this.index].game)
  }

  private clampTarget(): void {
    this.target = Math.max(0, Math.min(this.cabinets.length - 1, this.target))
  }

  private start(): void {
    const game = this.cabinets[this.index].game
    // So coming back out of a game puts you in front of it again rather than at the far end.
    try {
      sessionStorage.setItem('arcade.at', game.id)
    } catch {
      /* private browsing */
    }
    this.host.router.push([game.id])
  }

  // --- frame ---------------------------------------------------------------

  /**
   * Input is read here and not in simTick: the loop can run several catch-up ticks in one frame,
   * and an edge survives until the frame ends, so a single arrow press stepped the row twice.
   */
  beginFrame(): number {
    this.keys.beginFrame()
    this.pad.poll()

    const before = this.index
    if (this.keys.wasPressed('ArrowRight') || this.keys.wasPressed('KeyD') || this.pad.pressed('b15')) this.step(1)
    if (this.keys.wasPressed('ArrowLeft') || this.keys.wasPressed('KeyA') || this.pad.pressed('b14')) this.step(-1)
    if (this.keys.wasPressed('Enter') || this.keys.wasPressed('Space') || this.pad.pressed('b0') || this.pad.pressed('b9')) this.start()
    // The pad's left stick, as discrete steps rather than a continuous slide.
    const ax = this.pad.value('a0+') - this.pad.value('a0-')
    if (Math.abs(ax) > 0.6 && !this.stickHeld) {
      this.stickHeld = true
      this.step(Math.sign(ax))
    } else if (Math.abs(ax) < 0.3) this.stickHeld = false
    if (before !== this.index) this.hud.show(this.cabinets[this.index].game)

    this.keys.endFrame()
    return 1
  }
  private stickHeld = false

  simTick(dt: number): void {
    this.time += dt
    // Glide toward the selection, framerate-independently.
    this.pos += (this.target - this.pos) * (1 - Math.exp(-GLIDE * dt))
    if (Math.abs(this.target - this.pos) < 0.0005) this.pos = this.target
    this.entering = Math.max(0, this.entering - dt * 1.4)
  }

  render(_alpha: number, frameDt: number): void {
    this.layout()
    this.style.render({ speedT: 0, boost: 0, shockAge: -1, dt: frameDt, time: this.time, shield: 0, hit: 0 })
  }

  /** Place every cabinet on the arc for the row's current position. */
  private layout(): void {
    for (let i = 0; i < this.cabinets.length; i++) {
      const c = this.cabinets[i]
      const d = i - this.pos
      c.group.position.set(d * SPACING, 0, -Math.abs(d) * RECEDE)
      c.group.rotation.y = BASE_YAW - d * TURN
      c.setSelected(Math.max(0, 1 - Math.abs(d)))
    }
    // The room slides back into place as the lobby comes up, so arriving has some movement in it.
    this.camera.position.z = CAMERA.z * this.dolly + this.entering * 1.2
    this.camera.lookAt(0, CAMERA.lookY, 0)
  }

  private resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // The plate along the bottom is sized in text, so it takes a roughly fixed slab of the window —
    // which is a small share of a laptop and a large share of a phone held sideways. Stand further
    // back on a short window so the cabinet still clears it.
    const short = Math.max(0, Math.min(1, (620 - h) / 320))
    this.dolly = 1 + short * 0.3
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.style.resize(w, h, dpr)
  }

  dispose(): void {
    this.gone.run()
    for (const c of this.cabinets) c.dispose()
    for (const a of this.arts) a.dispose()
    this.scene.clear()
  }

  get bridge(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {
      lobby: this,
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      pick: (i: number) => this.pick(i),
      start: () => this.start(),
    }
    Object.defineProperty(ctx, 'at', { get: () => this.cabinets[this.index].game.id, enumerable: true })
    return ctx
  }
}

export const lobby: GameModule = {
  id: '',
  async mount(host: GameHost): Promise<MountedGame> {
    host.status('LOADING')
    const arts = await Promise.all(GAMES.map((g) => CabinetArt.load(g.id)))
    const cabinets = GAMES.map((g, i) => new Cabinet(g, arts[i]))
    // Come back to the cabinet you last walked away from, not always to the first one.
    let last: string | null = null
    try {
      last = sessionStorage.getItem('arcade.at')
    } catch {
      /* private browsing */
    }
    const startIndex = Math.max(
      0,
      GAMES.findIndex((g) => g.id === last),
    )
    host.status(null)
    return new Lobby(host, cabinets, arts, startIndex)
  },
}
