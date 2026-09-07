// The app: wires input → sim → snapshots → render/HUD/audio, and owns the
// screen flow (title / running / paused / summary). Everything the loop calls
// lives here.

import type { CourseDesc } from '../sim/track/SegmentDesc'
import { buildTrack } from '../sim/track/TrackBuilder'
import { Track } from '../sim/track/Track'
import { SimWorld } from '../sim/SimWorld'
import { SimSnapshot } from '../sim/SimSnapshot'
import { decodeInput, encodeInput, makeInputFrame } from '../sim/InputFrame'
import type { SimEvent } from '../sim/Events'
import { InputMap } from '../input/InputMap'
import { RenderWorld } from '../render/RenderWorld'
import { Hud } from '../render/hud/Hud'
import { ModernStyle } from '../render/styles/ModernStyle'
import { RetroStyle } from '../render/styles/RetroStyle'
import { MIN_TIME_SCALE } from '../render/RenderTuning'
import { GameLoop, type LoopClient } from './GameLoop'
import { MenuStack } from './Menus'
import { PerfOverlay } from './PerfOverlay'
import { Settings } from './Settings'
import { buildMenus } from './menus/screens'
import { COURSES } from '../sim/track/courses'
import { AudioWorld } from '../audio/AudioWorld'
import { Records } from './Records'
import { XrSession } from '../xr/XrSession'

export type GameState = 'title' | 'running' | 'paused' | 'summary'

const MPH_PER_MS = 2.23694
/** Tape capacity: 120 Hz × 15 minutes. */
const TAPE_CAPACITY = 120 * 60 * 15

export class Game implements LoopClient {
  readonly settings = new Settings()
  readonly input: InputMap
  readonly view: RenderWorld
  readonly hud: Hud
  readonly menus: MenuStack
  readonly perf: PerfOverlay
  readonly loop: GameLoop
  readonly audio = new AudioWorld()
  readonly records = new Records()
  readonly xr: XrSession
  world: SimWorld
  track: Track
  course: CourseDesc
  courseIndex = 0
  state: GameState = 'title'
  prev = new SimSnapshot()
  curr = new SimSnapshot()
  readonly held = makeInputFrame()
  readonly tape = new Int32Array(TAPE_CAPACITY)
  tapeLength = 0
  seed = 1
  /** Ghost of the best recorded run on this course, replayed alongside. */
  ghost: SimWorld | null = null
  ghostTape: Int32Array | null = null
  ghostSnap = new SimSnapshot()
  private readonly ghostInput = makeInputFrame()
  private modern: ModernStyle
  private retro: RetroStyle
  private attractTime = 0
  private readonly container: HTMLElement
  private summaryShown = false
  private endTimer = 0

  constructor(canvas: HTMLCanvasElement, container: HTMLElement) {
    this.container = container
    const s = this.settings.data
    this.input = new InputMap(s.keys, s.pad)
    this.input.attach(window)
    this.course = COURSES[0]
    this.track = buildTrack(this.course)
    this.world = new SimWorld(this.track, this.seed)
    this.view = new RenderWorld(canvas, this.track)
    this.hud = new Hud(container)
    this.menus = new MenuStack(container)
    this.perf = new PerfOverlay(container)
    this.modern = new ModernStyle(s.modern)
    this.retro = new RetroStyle(s.retro)
    this.xr = new XrSession(this)
    this.loop = new GameLoop(this, this.view.renderer)
    this.applyStyle()
    this.applyAccessibility()
    this.settings.onChange(() => {
      this.applyAccessibility()
      this.audio.setVolumes(this.settings.data.audio)
    })
    this.menus.onNavigate = () => this.audio.ui('move')
    this.menus.onSelect = () => this.audio.ui('select')
    this.audio.setVolumes(s.audio)
    window.addEventListener('resize', () => this.resize())
    window.addEventListener('blur', () => this.audio.setMuted(true))
    window.addEventListener('focus', () => this.audio.setMuted(false))
    this.resize()
    if (s.showPerf) this.perf.toggle(true)
    this.enterTitle()
  }

  // ---------------------------------------------------------------------------
  // Flow

  enterTitle(): void {
    this.state = 'title'
    this.hud.setVisible(false)
    this.setCourse(this.courseIndex)
    this.world.reset(this.seed)
    this.view.rig.reset(0)
    this.input.suppressGameplay = true
    this.menus.replace(buildMenus(this).title())
    this.showTitleCard(true)
    this.audio.setScene('title')
  }

  setCourse(index: number): void {
    this.courseIndex = (index + COURSES.length) % COURSES.length
    const course = COURSES[this.courseIndex]
    if (course !== this.course || this.track.course !== course) {
      this.course = course
      this.track = buildTrack(course)
      this.world = new SimWorld(this.track, this.seed)
      this.view.setTrack(this.track)
    }
  }

  startRun(): void {
    this.seed = (Date.now() & 0xffff) || 1
    this.startRunSeeded(this.seed)
  }

  startRunSeeded(seed: number): void {
    this.seed = seed
    this.world.reset(seed)
    this.world.tick(0, this.held, this.curr)
    this.prev = this.curr
    this.curr = new SimSnapshot()
    this.world.tick(0, this.held, this.curr)
    this.tapeLength = 0
    this.summaryShown = false
    this.endTimer = 0
    this.state = 'running'
    this.menus.closeAll()
    this.showTitleCard(false)
    this.hud.setVisible(true)
    this.input.suppressGameplay = false
    this.view.rig.reset(0)
    this.loop.paused = false
    this.setupGhost()
    this.hud.showMessage('GO', 1.0, 'good')
    this.audio.setScene('run')
    this.audio.resume()
  }

  private setupGhost(): void {
    const best = this.records.bestTape(this.course.id)
    if (best && best.seed === this.seed) {
      this.ghostTape = best.tape
      this.ghost = new SimWorld(this.track, best.seed)
    } else {
      this.ghost = null
      this.ghostTape = null
    }
  }

  pause(): void {
    if (this.state !== 'running') return
    this.state = 'paused'
    this.loop.paused = true
    this.input.suppressGameplay = true
    this.menus.replace(buildMenus(this).pause())
    this.audio.setScene('paused')
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.state = 'running'
    this.loop.paused = false
    this.input.suppressGameplay = false
    this.menus.closeAll()
    this.audio.setScene('run')
  }

  restart(): void {
    this.startRunSeeded(this.seed)
  }

  quitToTitle(): void {
    this.loop.paused = false
    this.enterTitle()
  }

  private showSummary(): void {
    this.summaryShown = true
    this.state = 'summary'
    this.input.suppressGameplay = true
    const snap = this.curr
    const entry = this.records.submit(this.course.id, {
      name: this.settings.data.playerName,
      score: snap.hud.score,
      kills: snap.hud.kills,
      gates: snap.hud.gatesPassed,
      distance: Math.round(snap.vehicle.s),
      finished: snap.phase === 'finished',
      seed: this.seed,
      date: Date.now(),
    }, this.tape.subarray(0, this.tapeLength))
    this.menus.replace(buildMenus(this).summary(snap, entry.rank, entry.isBest))
    this.audio.setScene('summary')
  }

  // ---------------------------------------------------------------------------
  // Style / settings application

  applyStyle(): void {
    const s = this.settings.data
    const style = s.style === 'retro' ? this.retro : this.modern
    if (s.style === 'retro') this.retro.rebuild()
    else this.modern.rebuild()
    this.view.setStyle(style)
    this.view.setRetroGeometry(s.retro.ringSegments, s.retro.quantizeVerts)
    this.modern.reducedMotion = s.access.reducedMotion
    // 20 Hz cadence: presentation only, and never in XR.
    const hz = s.retro.presentHz
    this.loop.presentIntervalMs = s.style === 'retro' && hz > 0 && !this.xr.active ? 1000 / hz : 0
    this.resize()
  }

  toggleStyle(): void {
    this.settings.update((d) => {
      d.style = d.style === 'retro' ? 'modern' : 'retro'
    })
    this.applyStyle()
    this.hud.showMessage(this.settings.data.style.toUpperCase(), 0.8)
  }

  applyAccessibility(): void {
    const a = this.settings.data.access
    document.documentElement.style.setProperty('--hud-scale', String(a.hudScale))
    const gain = this.settings.data.visualSpeedGain * (a.reducedMotion ? 0.35 : 1)
    this.view.rig.effectGain = this.xr.active ? this.xr.visualGain() : gain
    this.view.speedLines.gain = this.view.rig.effectGain
    this.modern.reducedMotion = a.reducedMotion
    const cb = a.colorblind
    // Hazard colour is amber by default; shift it where amber/red confusion is likely.
    this.view.tunnelUniforms.uEdgeColor.value.set(cb === 'none' ? 0xffc857 : cb === 'tritanopia' ? 0xff3b8a : 0x4d8dff)
  }

  resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    const pr = this.settings.data.style === 'retro' ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    this.view.resize(w, h, pr)
  }

  private showTitleCard(v: boolean): void {
    let card = this.container.querySelector('.title-card') as HTMLElement | null
    if (!card) {
      card = document.createElement('div')
      card.className = 'title-card'
      card.innerHTML = `<h1>APEX CONDUIT</h1><p>TUNNEL RACER · WORKING TITLE</p>`
      this.container.appendChild(card)
    }
    card.classList.toggle('hidden', !v)
  }

  // ---------------------------------------------------------------------------
  // LoopClient

  beginFrame(dt: number): number {
    const ui = this.input.ui
    this.input.poll(dt)
    if (ui.togglePerf) this.perf.toggle()
    if (ui.toggleStyle) this.toggleStyle()
    if (this.menus.open) {
      this.menus.handle(ui)
    } else if (this.state === 'running') {
      if (ui.pause) this.pause()
    }
    if (this.state === 'running') {
      this.input.snapshotInto(this.held)
    } else if (this.state === 'title') {
      this.attract(dt)
    }
    // Slow-mo is a modern-mode, non-XR, non-reduced-motion luxury.
    const s = this.settings.data
    const allowSlow = s.style === 'modern' && s.modern.slowmo && !this.xr.active && !s.access.reducedMotion
    const scale = allowSlow && this.state === 'running' ? Math.max(MIN_TIME_SCALE, this.curr.timeScale) : 1
    this.audio.setTimeScale(scale)
    return scale
  }

  /** Title-screen autopilot so the menu sits over a live run. */
  private attract(dt: number): void {
    this.attractTime += dt
    const h = this.held
    const v = this.world.vehicle
    h.steer = Math.max(-1, Math.min(1, -v.theta * 1.5 - v.thetaVel * 0.3 + Math.sin(this.attractTime * 0.7) * 0.4))
    h.throttle = 0.4
    h.brake = 0
    h.fire = Math.sin(this.attractTime * 2.1) > 0.3
    h.shockwave = false
    h.pitch = 0
    if (this.world.phase !== 'running' || v.s > this.track.length - 400) {
      this.world.reset(this.seed)
      this.view.rig.reset(0)
    }
  }

  simTick(dt: number): void {
    if (this.state === 'paused') return
    const tmp = this.prev
    this.prev = this.curr
    this.curr = tmp
    if (this.state === 'running' && this.tapeLength < TAPE_CAPACITY) {
      this.tape[this.tapeLength++] = encodeInput(this.held)
    }
    this.world.tick(dt, this.held, this.curr)
    if (this.ghost && this.ghostTape && this.state === 'running') {
      const i = this.world.tickCount - 1
      if (i >= 0 && i < this.ghostTape.length) {
        this.ghost.tick(dt, decodeInput(this.ghostTape[i], this.ghostInput), this.ghostSnap)
      }
    }
    if (this.state === 'running' && this.world.phase !== 'running') {
      // Let the crash/finish play out for a beat before the summary.
      this.endTimer += dt
      if (this.endTimer > 1.6 && !this.summaryShown) this.showSummary()
    }
  }

  render(alpha: number, dt: number): void {
    const events = this.world.events
    if (events.length) events.drain((e) => this.onEvent(e))
    this.view.update(this.prev, this.curr, alpha, dt, (i) => this.world.isRingTaken(i))
    this.view.updateGhost(this.ghost && this.state === 'running' ? this.ghostSnap : null)
    this.xr.update(this.curr, dt)
    if (this.state === 'running' || this.state === 'paused' || this.state === 'summary') {
      this.hud.update(this.curr, dt, this.view.interpolated.speed * MPH_PER_MS)
    }
    this.audio.openTarget = this.curr.vehicle.airborne ? 1 : Math.max(0, 1 - this.curr.vehicle.arc / Math.PI) * 1.2
    this.audio.update(this.curr, this.view.interpolated, dt)
    this.perf.update(this.loop.stats, this.view.stats, dt, `s=${this.curr.vehicle.s.toFixed(0)} θ=${this.curr.vehicle.theta.toFixed(2)} v=${this.curr.vehicle.speed.toFixed(0)} traffic=${this.curr.trafficCount} ${this.settings.data.style}${this.xr.active ? ' XR' : ''}`)
    this.view.render()
  }

  private onEvent(e: SimEvent): void {
    this.view.onEvent(e)
    this.audio.onEvent(e)
    const pad = this.input.gamepad
    switch (e.type) {
      case 'gate':
        this.hud.showMessage(`CHECKPOINT  +20s`, 1.4, 'good')
        pad.rumble(0.3, 0.6, 120)
        break
      case 'collision':
        this.hud.hitFlash(1)
        pad.rumble(1, 0.6, 220)
        break
      case 'hit':
        this.hud.hitFlash(0.6)
        pad.rumble(0.6, 0.3, 120)
        break
      case 'shockwave':
        pad.rumble(1, 1, 400)
        break
      case 'overheat':
        this.hud.showMessage('OVERHEAT', 0.9, 'bad')
        pad.rumble(0.2, 0.9, 300)
        break
      case 'combo':
        this.hud.showMessage(`×${this.curr.hud.combo.toFixed(2).replace(/\.?0+$/, '')} COMBO`, 0.8)
        break
      case 'charge_earned':
        this.hud.showMessage('SHOCKWAVE +1', 1.0, 'good')
        break
      case 'launch':
        this.hud.showMessage('AIRBORNE', 0.9)
        break
      case 'crash':
        this.hud.showMessage('WRECKED', 2.5, 'bad')
        this.hud.hitFlash(1)
        pad.rumble(1, 1, 600)
        break
      case 'fall':
        this.hud.showMessage('OVER THE EDGE', 2, 'bad')
        break
      case 'timeout':
        this.hud.showMessage('TIME UP', 2.5, 'bad')
        break
      case 'finish':
        this.hud.showMessage('COURSE COMPLETE', 3, 'good')
        break
      case 'boss_spawn':
        this.hud.showMessage('GATE GUARDIAN', 1.5, 'bad')
        break
      case 'pickup':
        this.hud.showMessage(e.a === 0 ? 'SHOCKWAVE CHARGE' : 'SHIELD', 0.8, 'good')
        break
      default:
        break
    }
  }
}
