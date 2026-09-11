// The lobby: a dim room with the cabinets stood in a shallow arc, the one you are looking at
// square on and lit, its neighbours turned in and falling away.
//
// It is a game as far as the shell is concerned — same GameModule contract, same GameLoop, same
// post-processing — which is the point. Walking from the marquees into Turbo Radrun swaps one
// mounted module for another and nothing else about the page changes.

import { AmbientLight, BoxGeometry, Color, Fog, Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, PerspectiveCamera, PlaneGeometry, PointLight, Raycaster, RepeatWrapping, Scene, SRGBColorSpace, TextureLoader, Vector2, Vector3, WebGLRenderer } from 'three'
import { GameLoop, type LoopClient } from '@apex/engine/app/GameLoop'
import { Disposer } from '@apex/engine/app/Disposer'
import type { GameHost, GameModule, MountedGame } from '@apex/engine/app/GameModule'
import { ModernStyle } from '@apex/engine/render/styles/ModernStyle'
import { KeyboardSource } from '@apex/engine/input/KeyboardSource'
import { GamepadSource } from '@apex/engine/input/GamepadSource'
import { GAMES } from '../catalog'
import { CAB, Cabinet } from './Cabinet'
import { CabinetArt } from './CabinetArt'
import { LobbyHud } from './LobbyHud'
import { type Block, type Bounds, Walk } from './Walk'

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
/** How far out from the glass the leaned-in camera sits: close enough to read, far enough to frame. */
const ZOOM_BACK = 0.8

// --- walking ----------------------------------------------------------------
// The carousel is for choosing a game. Walking is for looking at the machines: the row stops
// sliding, stands still in a straight line with room to get in beside one, and you move instead.
// Which matters because a cabinet's two flanks are most of its artwork and the carousel, which
// keeps the selected machine square on, is the one view that never shows you either of them.

/** Metres between cabinets when you are walking, and how far back off the floor they stand. */
const WALK_SPACING = 2.05
const WALK_Z = -1.25
/** Where a tap on a machine puts you: out in front of its glass, facing it. */
const WALK_STAND = 1.45
/** How far past the end machines, and how far out into the room, you can get. */
const WALK_MARGIN = 2.1
const WALK_BACK = 4.4
/** How quickly the room rearranges itself between the two views. */
const WALK_BLEND = 4.5
/** Nothing beyond this is worth lighting up as you walk past it. */
const WALK_LIGHT = 3.4

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
  /**
   * Zoomed in on the selected cabinet's screen: 0 back in the room, 1 nose against the glass. The
   * camera glides between the two, and the play button belongs to the far end of it.
   */
  private zoom = 0
  private zoomWanted = 0
  /**
   * Walking the aisle rather than scrolling the row. `walkT` is how far the room has rearranged
   * itself between the two, 0 to 1, and everything — where a cabinet stands, how lit it is, where
   * the camera is — is the same number blended by it, so there is one transition rather than five.
   */
  private walking = false
  private walkT = 0
  private readonly walk = new Walk()
  private readonly move = { fwd: 0, side: 0, turn: 0, run: false }
  /** What the move above works out to for one tick, wheel included. Kept to avoid per-tick litter. */
  private readonly moving = { fwd: 0, side: 0, turn: 0, run: false }
  /** The wheel, in walking: a shove forward rather than a step along the row. */
  private wheelPush = 0
  /** The machine the plate is currently naming, so it is only rewritten when it changes. */
  private shown = -1
  private readonly blocks: Block[]
  private readonly bounds: Bounds
  private readonly camPos = new Vector3()
  private readonly eyeAt = new Vector3()
  private readonly lookOut = new Vector3()
  private readonly ray = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly camFrom = new Vector3()
  private readonly camTo = new Vector3()
  private readonly lookAt = new Vector3()
  private readonly normal = new Vector3()
  private readonly at = new Vector3()

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
    this.hud.onWalk = () => this.setWalking(!this.walking)

    // The aisle, in the layout walking puts the machines in — which never moves, so this is worked
    // out once. A cabinet's footprint is its body; the artwork is flush with it.
    this.blocks = this.cabinets.map((_, i) => ({ x: this.walkX(i), z: WALK_Z - CAB.depth / 2, hw: CAB.width / 2, hd: CAB.depth / 2 }))
    this.bounds = {
      minX: this.walkX(0) - WALK_MARGIN,
      maxX: this.walkX(this.cabinets.length - 1) + WALK_MARGIN,
      // Far enough down the gaps between machines to stand level with their backs, which is what
      // gets you square on to a flank, and no further: behind the row there is nothing to see.
      minZ: WALK_Z - CAB.depth + 0.15,
      maxZ: WALK_BACK,
    }

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

  /** The cabinet the row has settled nearest — or, walking, the one you are standing nearest. */
  private get index(): number {
    if (this.walking) {
      let best = 0
      let near = Infinity
      for (let i = 0; i < this.cabinets.length; i++) {
        const d = Math.hypot(this.walk.feet.x - this.walkX(i), this.walk.feet.z - WALK_Z)
        if (d < near) {
          near = d
          best = i
        }
      }
      return best
    }
    return Math.max(0, Math.min(this.cabinets.length - 1, Math.round(this.target)))
  }

  /** Where a cabinet stands in the straight row you walk along. */
  private walkX(i: number): number {
    return (i - (this.cabinets.length - 1) / 2) * WALK_SPACING
  }

  /**
   * Between the two views. Walking starts you in front of whichever machine you were looking at, so
   * the room turns around you rather than teleporting you into the middle of it; coming back out
   * hands the row the machine you were standing at.
   */
  private setWalking(on: boolean): void {
    if (this.walking === on) return
    const i = this.index
    if (on) {
      this.zoomWanted = 0
      this.walk.reset(this.walkX(i), WALK_Z + WALK_STAND + 0.9, 0)
    } else {
      this.target = i
      this.pos = i
    }
    this.walking = on
    this.shown = -1
    this.hud.setWalking(on)
    this.hud.show(this.cabinets[this.index].game)
  }

  /** Walk over and stand in front of a machine. Also what a tap on a distant one means. */
  private walkToCabinet(i: number): void {
    this.walk.walkTo(this.walkX(i), WALK_Z + WALK_STAND, 0)
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

  private drag: { id: number; x: number; y: number; startPos: number; moved: number } | null = null

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    if (this.walking) {
      this.wheelPush = Math.max(-1, Math.min(1, this.wheelPush - d * 0.01))
      return
    }
    this.wheelAcc += d
    if (Math.abs(this.wheelAcc) > 60) {
      this.step(Math.sign(this.wheelAcc))
      this.wheelAcc = 0
    }
  }
  private wheelAcc = 0

  private onPointerDown(e: PointerEvent): void {
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, startPos: this.target, moved: 0 }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.id) return
    if (this.walking) {
      // Walking, a drag turns your head. Deltas are from the last move rather than from where the
      // drag started, so looking round is unbounded — a drag does not run out at the screen edge.
      const lx = e.clientX - this.drag.x
      const ly = e.clientY - this.drag.y
      this.drag.x = e.clientX
      this.drag.y = e.clientY
      this.drag.moved += Math.abs(lx) + Math.abs(ly)
      this.walk.lookBy(lx, ly)
      return
    }
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
    this.clampTarget()
    if (wasDrag) {
      this.target = Math.round(this.target)
      return
    }
    this.tap(e)
  }

  /**
   * What a tap means depends on what it landed on. Another cabinet: walk to it. The selected
   * cabinet's screen: lean in, and a play button appears — unless the tap was in the middle of the
   * screen, which is someone who has already decided, so it goes straight in. Anywhere else backs
   * out of a lean.
   *
   * This replaced "a tap anywhere starts the selected game", which made browsing the row by tapping
   * the cabinet you wanted impossible: you got whatever was in front of you instead.
   */
  private tap(e: PointerEvent): void {
    const hit = this.pickAt(e.clientX, e.clientY)
    if (this.walking) {
      // Walking: a tap on the machine you are already at, dead centre of its glass, plays it.
      // Anything else is somewhere you would like to be standing, which is the only way across the
      // room on a phone.
      if (!hit) return
      const uv = hit.screenUv
      if (hit.index === this.index && uv && Math.abs(uv.x - 0.5) < 0.22 && Math.abs(uv.y - 0.5) < 0.22) this.start()
      else this.walkToCabinet(hit.index)
      return
    }
    if (!hit) {
      this.zoomWanted = 0
      return
    }
    if (hit.index !== this.index) {
      this.zoomWanted = 0
      this.pick(hit.index)
      return
    }
    if (!hit.screenUv) {
      this.zoomWanted = 0
      return
    }
    // Dead centre is a decision; the rest of the glass is curiosity.
    const { x, y } = hit.screenUv
    if (Math.abs(x - 0.5) < 0.22 && Math.abs(y - 0.5) < 0.22) this.start()
    else this.zoomWanted = 1
  }

  /** The cabinet under a screen position, and where on its screen the ray landed, if it did. */
  private pickAt(clientX: number, clientY: number): { index: number; screenUv: { x: number; y: number } | null } | null {
    this.ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.camera)
    const hits = this.ray.intersectObject(this.row, true)
    if (!hits.length) return null
    const first = hits[0]
    for (let i = 0; i < this.cabinets.length; i++) {
      const cab = this.cabinets[i]
      let node: Object3D | null = first.object
      while (node && node !== cab.group) node = node.parent
      if (!node) continue
      const onScreen = first.object === cab.screen
      return { index: i, screenUv: onScreen && first.uv ? { x: first.uv.x, y: first.uv.y } : null }
    }
    return null
  }

  private step(dir: number): void {
    if (this.walking) {
      this.walkToCabinet(Math.max(0, Math.min(this.cabinets.length - 1, this.index + Math.sign(dir))))
      return
    }
    this.target = Math.round(this.target) + Math.sign(dir)
    this.clampTarget()
    this.hud.show(this.cabinets[this.index].game)
  }

  private pick(i: number): void {
    if (this.walking) {
      this.walkToCabinet(i)
      return
    }
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
    // The one key that means the same thing in both views.
    if (this.keys.wasPressed('KeyF') || this.pad.pressed('b3')) this.setWalking(!this.walking)
    if (this.walking) this.walkKeys()
    else this.rowKeys()
    this.keys.endFrame()
    return 1
  }
  private stickHeld = false

  private rowKeys(): void {
    const before = this.index
    if (this.keys.wasPressed('ArrowRight') || this.keys.wasPressed('KeyD') || this.pad.pressed('b15')) this.step(1)
    if (this.keys.wasPressed('ArrowLeft') || this.keys.wasPressed('KeyA') || this.pad.pressed('b14')) this.step(-1)
    if (this.keys.wasPressed('Enter') || this.keys.wasPressed('Space') || this.pad.pressed('b0') || this.pad.pressed('b9')) this.start()
    if (this.keys.wasPressed('Escape') || this.pad.pressed('b1')) this.zoomWanted = 0
    // The pad's left stick, as discrete steps rather than a continuous slide.
    const ax = this.pad.value('a0+') - this.pad.value('a0-')
    if (Math.abs(ax) > 0.6 && !this.stickHeld) {
      this.stickHeld = true
      this.step(Math.sign(ax))
    } else if (Math.abs(ax) < 0.3) this.stickHeld = false
    if (before !== this.index) {
      this.zoomWanted = 0
      this.hud.show(this.cabinets[this.index].game)
    }
  }

  /**
   * Walking: WASD or the arrows, with left and right turning rather than strafing because that is
   * what hands expect from a keyboard; A and D strafe for the ones that expect the other thing.
   */
  private walkKeys(): void {
    const k = this.keys
    const on = (...codes: string[]): number => (codes.some((c) => k.isDown(c)) ? 1 : 0)
    this.move.fwd = on('KeyW', 'ArrowUp') - on('KeyS', 'ArrowDown') + this.pad.value('a1-') - this.pad.value('a1+')
    this.move.side = on('KeyD') - on('KeyA') + this.pad.value('a0+') - this.pad.value('a0-')
    this.move.turn = on('ArrowRight') - on('ArrowLeft') + this.pad.value('a2+') - this.pad.value('a2-')
    this.move.run = k.isDown('ShiftLeft') || k.isDown('ShiftRight') || this.pad.down('b10')
    if (k.wasPressed('Enter') || k.wasPressed('Space') || this.pad.pressed('b0') || this.pad.pressed('b9')) this.start()
    if (k.wasPressed('Escape') || this.pad.pressed('b1')) this.setWalking(false)
  }

  simTick(dt: number): void {
    this.time += dt
    // Glide toward the selection, framerate-independently.
    this.pos += (this.target - this.pos) * (1 - Math.exp(-GLIDE * dt))
    if (Math.abs(this.target - this.pos) < 0.0005) this.pos = this.target
    this.entering = Math.max(0, this.entering - dt * 1.4)
    this.zoom += (this.zoomWanted - this.zoom) * (1 - Math.exp(-6 * dt))
    if (Math.abs(this.zoomWanted - this.zoom) < 0.002) this.zoom = this.zoomWanted
    this.hud.setLeaning(this.zoom > 0.5)

    const want = this.walking ? 1 : 0
    this.walkT += (want - this.walkT) * (1 - Math.exp(-WALK_BLEND * dt))
    if (Math.abs(want - this.walkT) < 0.002) this.walkT = want
    if (this.walking) {
      // Into a separate object, not back into `move`: the loop can run several catch-up ticks per
      // frame and input is read once a frame, so a shove folded into `move` would be folded in again.
      this.moving.fwd = Math.max(-1, Math.min(1, this.move.fwd + this.wheelPush))
      this.moving.side = this.move.side
      this.moving.turn = this.move.turn
      this.moving.run = this.move.run
      this.walk.step(dt, this.moving, this.blocks, this.bounds)
      this.wheelPush *= Math.exp(-5 * dt)
      const near = this.index
      if (near !== this.shown) {
        this.shown = near
        this.hud.show(this.cabinets[near].game)
      }
    }
  }

  render(_alpha: number, frameDt: number): void {
    this.layout()
    this.style.render({ speedT: 0, boost: 0, shockAge: -1, dt: frameDt, time: this.time, shield: 0, hit: 0 })
  }

  /** Place every cabinet on the arc for the row's current position. */
  private layout(): void {
    const w = this.walkT
    const near = this.index
    for (let i = 0; i < this.cabinets.length; i++) {
      const c = this.cabinets[i]
      const d = i - this.pos
      const rx = d * SPACING
      const rz = -Math.abs(d) * RECEDE
      const wx = this.walkX(i)
      c.group.position.set(rx + (wx - rx) * w, 0, rz + (WALK_Z - rz) * w)
      // Square to the row once you are walking: every machine turned to face the same way is what
      // makes an aisle, and the slight turn that reads well in the carousel reads as wonky in one.
      c.group.rotation.y = (BASE_YAW - d * TURN) * (1 - w)
      let lit = Math.max(0, 1 - Math.abs(d))
      if (w > 0.001) {
        const dist = Math.hypot(this.walk.feet.x - wx, this.walk.feet.z - (WALK_Z + 0.4))
        let close = Math.max(0, Math.min(1, (WALK_LIGHT - dist) / 2.2))
        // One attract loop plays at a time, so everything but the nearest stays under the bar that
        // starts it — otherwise standing in the middle of the row runs every video at once.
        if (i !== near) close = Math.min(close, 0.34)
        lit += (close - lit) * w
      }
      c.setSelected(lit)
    }
    // The room slides back into place as the lobby comes up, so arriving has some movement in it.
    this.camFrom.set(0, CAMERA.y, CAMERA.z * this.dolly + this.entering * 1.2)
    this.camPos.copy(this.camFrom)
    this.lookAt.set(0, CAMERA.lookY, 0)
    if (this.zoom > 0.001) {
      // Where the selected cabinet's glass is, and a spot straight out in front of it. The screen
      // leans back, so coming at it along its own normal is the only way to end up square to it.
      const cab = this.cabinets[this.index]
      cab.group.updateMatrixWorld(true)
      // Where the glass is first, then a spot out along its normal: the same vector cannot be both,
      // or the camera ends up being told to look at itself.
      this.at.copy(cab.screenCentre).applyMatrix4(cab.group.matrixWorld)
      const normal = this.normal.copy(cab.screenNormal).transformDirection(cab.group.matrixWorld).normalize()
      this.camTo.copy(this.at).addScaledVector(normal, ZOOM_BACK)
      this.camPos.lerpVectors(this.camFrom, this.camTo, this.zoom)
      this.lookAt.lerp(this.at, this.zoom)
    }
    if (w > 0.001) {
      this.camPos.lerp(this.walk.eye(this.eyeAt), w)
      this.lookAt.lerp(this.walk.lookPoint(this.lookOut), w)
    }
    this.camera.position.copy(this.camPos)
    this.camera.lookAt(this.lookAt)
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
      walk: (on = true) => this.setWalking(on),
      walker: this.walk,
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
