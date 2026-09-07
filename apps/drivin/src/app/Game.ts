// The app: title → drive → results, plus the editor. Wires input → sim →
// snapshots → render/HUD/audio through the engine loop.

import { GameLoop, type LoopClient } from '@apex/engine/app/GameLoop'
import { MenuStack } from '@apex/engine/app/Menus'
import { PerfOverlay } from '@apex/engine/app/PerfOverlay'
import { ModernStyle } from '@apex/engine/render/styles/ModernStyle'
import { RetroStyle } from '@apex/engine/render/styles/RetroStyle'
import { AudioWorld } from '../audio/AudioWorld'
import { Editor } from '../editor/Editor'
import { InputMap } from '../input/InputMap'
import { TouchSource } from '../input/TouchSource'
import { isTouchDevice } from '@apex/engine/app/platform'
import { Haptics } from '@apex/engine/input/Haptics'
import { RenderWorld } from '../render/RenderWorld'
import { carById } from '../sim/CarSpec'
import type { SimEvent } from '../sim/Events'
import { copyInput, makeInputFrame } from '../sim/InputFrame'
import { Sim } from '../sim/Sim'
import { Snapshot } from '../sim/Snapshot'
import { Track, type TrackData } from '../sim/Track'
import { MAX_SUBSTEPS, SIM_HZ } from '../sim/Tuning'
import { BUILTIN_TRACKS } from '../sim/tracks'
import { Hud } from './Hud'
import { buildMenus } from './menus'
import { Settings } from './Settings'
import { TrackStore } from './TrackStore'

export type GameState = 'title' | 'driving' | 'paused' | 'results' | 'editor'

export class Game implements LoopClient {
  readonly settings = new Settings()
  readonly tracks = new TrackStore()
  readonly input: InputMap
  readonly view: RenderWorld
  readonly hud: Hud
  readonly menus: MenuStack
  readonly perf: PerfOverlay
  readonly loop: GameLoop
  readonly audio = new AudioWorld()
  readonly editor: Editor
  readonly touch: TouchSource | null = null
  readonly haptics: Haptics
  sim: Sim
  track: Track
  trackData: TrackData
  state: GameState = 'title'
  fromEditor = false
  prev = new Snapshot()
  curr = new Snapshot()
  readonly held = makeInputFrame()
  private modern: ModernStyle
  private retro: RetroStyle
  private readonly container: HTMLElement
  private resultsShown = false
  private endTimer = 0

  constructor(canvas: HTMLCanvasElement, container: HTMLElement) {
    this.container = container
    const s = this.settings.data
    this.input = new InputMap(s.keys, s.pad)
    this.input.attach(window)
    this.haptics = new Haptics(this.input.gamepad)
    this.haptics.strength = s.haptics
    if (isTouchDevice()) {
      this.touch = new TouchSource(container)
      this.input.extras.push(this.touch)
      container.classList.add('is-touch')
    }
    this.trackData = this.tracks.get(s.trackId) ?? BUILTIN_TRACKS[0]
    this.track = new Track(this.trackData)
    this.sim = new Sim(this.track, carById(s.carId), s.laps)
    this.view = new RenderWorld(canvas, carById(s.carId))
    this.view.setTrack(this.track)
    this.hud = new Hud(container)
    this.hud.units = s.units
    this.hud.setTrack(this.track)
    this.menus = new MenuStack(container)
    this.perf = new PerfOverlay(container)
    this.editor = new Editor(container, this.tracks, {
      onTest: (data) => this.startDrive(data, true),
      onExit: () => this.enterTitle(),
    })
    this.modern = new ModernStyle(s.modern)
    this.retro = new RetroStyle(s.retro)
    this.loop = new GameLoop(this, this.view.renderer, { simHz: SIM_HZ, maxSubsteps: MAX_SUBSTEPS })
    this.applyStyle()
    this.applyAccessibility()
    this.settings.onChange(() => {
      this.applyAccessibility()
      this.audio.setVolumes(this.settings.data.audio)
      this.haptics.strength = this.settings.data.haptics
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

  get currentTrackName(): string {
    return this.trackData.name
  }

  // --- flow ---

  enterTitle(): void {
    this.state = 'title'
    this.fromEditor = false
    this.editor.hide()
    this.hud.setVisible(false)
    this.touch?.setVisible(false)
    this.container.classList.remove('is-driving')
    this.input.suppressGameplay = true
    this.loop.paused = false
    this.previewTrack()
    this.view.rig.mode = 'orbit'
    this.menus.replace(buildMenus(this).title())
    this.showTitleCard(true)
    this.audio.setRunning(false)
  }

  /** Load the selected track for the title orbit. */
  previewTrack(): void {
    const data = this.tracks.get(this.settings.data.trackId) ?? BUILTIN_TRACKS[0]
    this.loadTrack(data)
  }

  private loadTrack(data: TrackData): void {
    this.trackData = data
    this.track = new Track(data)
    const spec = carById(this.settings.data.carId)
    this.sim = new Sim(this.track, spec, this.settings.data.laps)
    this.view.setCar(spec)
    this.view.setTrack(this.track)
    this.hud.setTrack(this.track)
    this.prev = new Snapshot()
    this.curr = new Snapshot()
    this.sim.tick(0, this.held, this.curr)
    this.sim.tick(0, this.held, this.prev)
  }

  startDrive(data?: TrackData, fromEditor = false): void {
    const d = data ?? this.tracks.get(this.settings.data.trackId) ?? BUILTIN_TRACKS[0]
    const t = new Track(d)
    if (!t.valid) {
      this.hud.showMessage('TRACK HAS ERRORS', 2, 'bad')
      return
    }
    this.fromEditor = fromEditor
    this.editor.hide()
    this.loadTrack(d)
    this.state = 'driving'
    this.resultsShown = false
    this.endTimer = 0
    this.menus.closeAll()
    this.showTitleCard(false)
    this.hud.setVisible(true)
    this.touch?.setVisible(true)
    this.touch?.calibrate()
    this.goImmersive()
    this.container.classList.add('is-driving')
    this.input.suppressGameplay = false
    this.loop.paused = false
    this.applyCamera()
    this.view.rig.reset()
    this.hud.showMessage(this.trackData.name.toUpperCase(), 1.6, 'good')
    this.audio.resume()
    this.audio.setRunning(true)
  }

  /** Phones: fullscreen + landscape when a drive starts (must run inside a gesture). */
  private goImmersive(): void {
    if (!this.touch) return
    this.touch.requestSensors()
    const el = document.documentElement
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' })
        .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {}))
        .catch(() => {})
    }
  }

  openEditor(): void {
    this.state = 'editor'
    this.menus.closeAll()
    this.showTitleCard(false)
    this.hud.setVisible(false)
    this.touch?.setVisible(false)
    this.container.classList.remove('is-driving')
    this.input.suppressGameplay = true
    this.loop.paused = true
    this.editor.setData(this.fromEditor ? this.editor.current : this.trackData, null)
    this.editor.show()
    this.audio.setRunning(false)
  }

  pause(): void {
    if (this.state !== 'driving') return
    this.state = 'paused'
    this.loop.paused = true
    this.input.suppressGameplay = true
    this.touch?.setVisible(false)
    this.menus.replace(buildMenus(this).pause())
    this.audio.setRunning(false)
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.state = 'driving'
    this.loop.paused = false
    this.input.suppressGameplay = false
    this.touch?.setVisible(true)
    this.menus.closeAll()
    this.audio.setRunning(true)
  }

  restart(): void {
    this.startDrive(this.trackData, this.fromEditor)
  }

  quitToTitle(): void {
    this.loop.paused = false
    this.enterTitle()
  }

  private showResults(): void {
    this.resultsShown = true
    this.state = 'results'
    this.input.suppressGameplay = true
    this.touch?.setVisible(false)
    this.menus.replace(buildMenus(this).results(this.curr))
    this.audio.setRunning(false)
  }

  // --- settings application ---

  applyStyle(): void {
    const s = this.settings.data
    const style = s.style === 'retro' ? this.retro : this.modern
    if (s.style === 'retro') this.retro.rebuild()
    else this.modern.rebuild()
    this.view.setStyle(style)
    this.view.setRetroSnap(s.retro.quantizeVerts)
    this.modern.reducedMotion = s.access.reducedMotion
    const hz = s.retro.presentHz
    this.loop.presentIntervalMs = s.style === 'retro' && hz > 0 ? 1000 / hz : 0
    this.resize()
  }

  toggleStyle(): void {
    this.settings.update((d) => (d.style = d.style === 'retro' ? 'modern' : 'retro'))
    this.applyStyle()
    this.hud.showMessage(this.settings.data.style.toUpperCase(), 0.8)
  }

  applyCamera(): void {
    if (this.state === 'title') return
    this.view.rig.mode = this.settings.data.camera === 'hood' ? 'hood' : 'chase'
  }

  applyAccessibility(): void {
    const a = this.settings.data.access
    document.documentElement.style.setProperty('--hud-scale', String(a.hudScale))
    this.view.rig.effectGain = a.reducedMotion ? 0.35 : 1
    this.modern.reducedMotion = a.reducedMotion
    this.hud.units = this.settings.data.units
  }

  resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    const pr = this.settings.data.style === 'retro' ? 1 : Math.min(window.devicePixelRatio || 1, this.touch ? 1.5 : 2)
    this.view.resize(w, h, pr)
  }

  private showTitleCard(v: boolean): void {
    let card = this.container.querySelector('.title-card') as HTMLElement | null
    if (!card) {
      card = document.createElement('div')
      card.className = 'title-card'
      card.innerHTML = `<h1>HARD LINE</h1><p>STUNT TRACK DRIVING · WORKING TITLE</p>`
      this.container.appendChild(card)
    }
    card.classList.toggle('hidden', !v)
  }

  // --- LoopClient ---

  beginFrame(dt: number): number {
    const ui = this.input.ui
    this.input.poll(dt)
    if (ui.togglePerf) this.perf.toggle()
    if (ui.toggleStyle) this.toggleStyle()
    if (this.state === 'editor') {
      this.editor.tick()
      return 1
    }
    if (this.menus.open) this.menus.handle(ui)
    else if (this.state === 'driving') {
      if (ui.pause) this.pause()
      if (this.input.cameraEdge || this.touch?.cameraEdge) {
        this.settings.update((d) => (d.camera = d.camera === 'hood' ? 'chase' : 'hood'))
        this.applyCamera()
      }
    }
    if (this.state === 'driving') copyInput(this.input.frame, this.held)
    else this.held.throttle = this.held.brake = this.held.steer = 0
    return 1
  }

  simTick(dt: number): void {
    if (this.state !== 'driving') return
    const tmp = this.prev
    this.prev = this.curr
    this.curr = tmp
    this.sim.tick(dt, this.held, this.curr)
    if (this.sim.phase === 'finished' && !this.resultsShown) {
      this.endTimer += dt
      if (this.endTimer > 1.2) this.showResults()
    }
  }

  render(alpha: number, dt: number): void {
    if (this.state === 'editor') return
    const events = this.sim.events
    if (events.length) events.drain(this.onEventBound)
    this.view.update(this.prev, this.curr, alpha, dt)
    if (this.state !== 'title') this.hud.update(this.curr, dt, this.sim.targetLaps)
    this.audio.update(this.curr)
    this.feel(dt)
    this.perf.update(this.loop.stats, this.view.stats, dt, `${this.curr.car.mode} lane=${this.curr.car.laneId} s=${this.curr.car.s.toFixed(0)} v=${this.curr.car.speed.toFixed(1)} ${this.settings.data.style}`)
    this.view.render()
  }

  private feelAcc = 0

  /** Continuous haptics: slide → weak rumble, braking with slip → left trigger, wheelspin-ish → right. */
  private feel(dt: number): void {
    if (this.state !== 'driving') return
    this.feelAcc += dt
    if (this.feelAcc < 0.1) return
    this.feelAcc = 0
    const c = this.curr.car
    if (c.mode !== 'track') return
    const h = this.held
    if (c.slip > 0.35) {
      this.haptics.rumble(0, c.slip * 0.6, 110)
      if (c.onGrass) this.haptics.mobile(15)
    }
    if (c.onGrass && c.speed > 8) this.haptics.rumble(0.15, 0.35, 110)
    const left = h.brake > 0.5 && c.slip > 0.3 ? Math.min(1, c.slip) : 0
    const right = h.throttle > 0.5 && c.slip > 0.5 ? Math.min(1, c.slip * 0.7) : 0
    if (left > 0 || right > 0) this.haptics.triggers(left, right, 110)
  }

  private readonly onEventBound = (e: SimEvent): void => this.onEvent(e)

  private onEvent(e: SimEvent): void {
    this.view.onEvent(e)
    this.audio.onEvent(e)
    const hp = this.haptics
    switch (e.type) {
      case 'crash':
        this.hud.showMessage('CRASH', 2.5, 'bad')
        hp.rumble(1, 1, 500)
        hp.triggers(1, 1, 400)
        hp.mobile([120, 40, 200])
        break
      case 'lap':
        this.hud.showMessage(`LAP ${e.a}`, 1.2, 'good')
        hp.mobile(30)
        break
      case 'land':
        hp.rumble(Math.min(1, e.a / 50), 0.4, 140)
        hp.triggers(0.5, 0.5, 120)
        hp.mobile(40)
        break
      case 'launch':
        hp.rumble(0.2, 0.2, 60)
        break
      case 'curb':
        hp.rumble(0.05, 0.45, 50)
        hp.mobile(8)
        break
      case 'offroad':
        hp.rumble(0.3, 0.5, 150)
        hp.mobile(25)
        break
      case 'lost':
        this.hud.showMessage('LOST — BACK ON TRACK', 1.5, 'bad')
        break
      case 'respawn':
        if (e.a === 0) this.hud.showMessage('RESET', 0.8)
        break
      default:
        break
    }
  }
}
