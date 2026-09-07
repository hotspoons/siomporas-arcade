// The app: title → run → results. Wires input → sim → snapshot → render/HUD/audio.

import { GameLoop, type LoopClient } from '@apex/engine/app/GameLoop'
import { MenuStack } from '@apex/engine/app/Menus'
import { PerfOverlay } from '@apex/engine/app/PerfOverlay'
import { isTouchDevice } from '@apex/engine/app/platform'
import { Haptics } from '@apex/engine/input/Haptics'
import { ModernStyle } from '@apex/engine/render/styles/ModernStyle'
import { RetroStyle } from '@apex/engine/render/styles/RetroStyle'
import { AudioWorld, STATIONS } from '../audio/AudioWorld'
import { InputMap } from '../input/InputMap'
import { TouchSource } from '../input/TouchSource'
import { RenderWorld } from '../render/RenderWorld'
import type { SimEvent } from '../sim/Events'
import { copyInput, makeInputFrame } from '../sim/InputFrame'
import { Sim } from '../sim/Sim'
import { Snapshot } from '../sim/Snapshot'
import { STAGE_BY_ID } from '../sim/Stages'
import { MAX_SUBSTEPS, SIM_HZ } from '../sim/Tuning'
import { Hud } from './Hud'
import { buildMenus } from './menus'
import { Settings } from './Settings'

export type GameState = 'title' | 'running' | 'paused' | 'results'

export class Game implements LoopClient {
  readonly settings = new Settings()
  readonly input: InputMap
  readonly view: RenderWorld
  readonly hud: Hud
  readonly menus: MenuStack
  readonly perf: PerfOverlay
  readonly loop: GameLoop
  readonly audio = new AudioWorld()
  readonly haptics: Haptics
  readonly touch: TouchSource | null = null
  sim: Sim
  state: GameState = 'title'
  prev = new Snapshot()
  curr = new Snapshot()
  readonly held = makeInputFrame()
  seed = 1
  private modern: ModernStyle
  private retro: RetroStyle
  private readonly container: HTMLElement
  private resultsShown = false
  private endTimer = 0
  private attractTime = 0
  private lastStageId = ''

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
    this.sim = new Sim(this.seed)
    this.view = new RenderWorld(canvas)
    this.view.setStage(this.sim.stage)
    this.hud = new Hud(container)
    this.hud.units = s.units
    this.menus = new MenuStack(container)
    this.perf = new PerfOverlay(container)
    this.modern = new ModernStyle(s.modern)
    this.retro = new RetroStyle(s.retro)
    this.loop = new GameLoop(this, this.view.renderer, { simHz: SIM_HZ, maxSubsteps: MAX_SUBSTEPS })
    this.applyStyle()
    this.applyView()
    this.applyCar()
    this.applyAccessibility()
    this.settings.onChange(() => {
      this.applyAccessibility()
      this.audio.setVolumes(this.settings.data.audio)
      this.haptics.strength = this.settings.data.haptics
    })
    this.menus.onNavigate = () => this.audio.ui('move')
    this.menus.onSelect = () => this.audio.ui('select')
    this.audio.setVolumes(s.audio)
    this.audio.setStation(s.station)
    window.addEventListener('resize', () => this.resize())
    window.addEventListener('blur', () => this.audio.setMuted(true))
    window.addEventListener('focus', () => this.audio.setMuted(false))
    this.resize()
    if (s.showPerf) this.perf.toggle(true)
    this.enterTitle()
  }

  enterTitle(): void {
    this.state = 'title'
    this.hud.setVisible(false)
    this.touch?.setVisible(false)
    this.container.classList.remove('is-driving')
    this.input.suppressGameplay = true
    this.loop.paused = false
    this.sim.reset()
    this.syncStage()
    this.sim.tick(0, this.held, this.curr)
    this.sim.tick(0, this.held, this.prev)
    this.menus.replace(buildMenus(this).title())
    this.showTitleCard(true)
    this.audio.setRunning(false)
  }

  startRun(): void {
    this.seed = (Date.now() & 0xffff) || 1
    this.sim = new Sim(this.seed)
    this.syncStage()
    this.sim.tick(0, this.held, this.curr)
    this.sim.tick(0, this.held, this.prev)
    this.state = 'running'
    this.resultsShown = false
    this.endTimer = 0
    this.menus.closeAll()
    this.showTitleCard(false)
    this.hud.setVisible(true)
    this.hud.setStation(STATIONS[this.settings.data.station]?.name ?? '')
    this.touch?.setVisible(true)
    this.touch?.calibrate()
    this.goImmersive()
    this.container.classList.add('is-driving')
    this.input.suppressGameplay = false
    this.loop.paused = false
    this.hud.showMessage(STAGE_BY_ID['A'].name.toUpperCase(), 1.8, 'good')
    this.audio.resume()
    this.audio.setRunning(true)
  }

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

  pause(): void {
    if (this.state !== 'running') return
    this.state = 'paused'
    this.loop.paused = true
    this.input.suppressGameplay = true
    this.touch?.setVisible(false)
    this.menus.replace(buildMenus(this).pause())
    this.audio.setRunning(false)
  }
  resume(): void {
    if (this.state !== 'paused') return
    this.state = 'running'
    this.loop.paused = false
    this.input.suppressGameplay = false
    this.touch?.setVisible(true)
    this.menus.closeAll()
    this.audio.setRunning(true)
  }
  restart(): void {
    this.startRun()
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

  private syncStage(): void {
    if (this.sim.stage.desc.id !== this.lastStageId) {
      this.lastStageId = this.sim.stage.desc.id
      this.view.setStage(this.sim.stage)
    }
  }

  applyStyle(): void {
    const s = this.settings.data
    const style = s.style === 'retro' ? this.retro : this.modern
    if (s.style === 'retro') this.retro.rebuild()
    else this.modern.rebuild()
    this.view.setStyle(style)
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
  applyView(): void {
    this.view.view = this.settings.data.view
    this.hud.setViewHint(this.settings.data.view)
  }
  applyCar(): void {
    this.view.setCar(this.settings.data.car)
  }
  applyStation(): void {
    this.audio.setStation(this.settings.data.station)
    this.hud.setStation(STATIONS[this.settings.data.station]?.name ?? '')
  }
  applyAccessibility(): void {
    const a = this.settings.data.access
    document.documentElement.style.setProperty('--hud-scale', String(a.hudScale))
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
      card.innerHTML = `<h1>COASTLINE</h1><p>SPRITE-SCALED ROAD RACER · WORKING TITLE</p>`
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
    if (this.menus.open) this.menus.handle(ui)
    else if (this.state === 'running') {
      if (ui.pause) this.pause()
      if (this.input.viewEdge || this.touch?.viewEdge) {
        this.settings.update((d) => (d.view = d.view === 'cockpit' ? 'chase' : 'cockpit'))
        this.applyView()
      }
    }
    if (this.state === 'running') copyInput(this.input.frame, this.held)
    else if (this.state === 'title') this.attract(dt)
    return 1
  }

  /** Title autopilot: cruise the coast road behind the menu. */
  private attract(dt: number): void {
    this.attractTime += dt
    const h = this.held
    const seg = this.sim.stage.segmentAt(this.sim.z)
    h.throttle = this.sim.speed < 55 ? 1 : 0
    h.steer = Math.max(-1, Math.min(1, -this.sim.x * 3 + seg.curve * 0.15 * (this.sim.speed / 84) ** 2))
    h.brake = 0
    h.gear = false
    h.turbo = false
    if (this.sim.phase !== 'driving' || this.sim.timeLeft < 20) {
      this.sim.reset()
      this.syncStage()
    }
  }

  simTick(dt: number): void {
    if (this.state === 'paused' || this.state === 'results') return
    const tmp = this.prev
    this.prev = this.curr
    this.curr = tmp
    this.sim.tick(dt, this.held, this.curr)
    this.syncStage()
    if (this.state === 'running' && (this.sim.phase === 'finished' || this.sim.phase === 'timeout') && !this.resultsShown) {
      this.endTimer += dt
      if (this.endTimer > 1.5) this.showResults()
    }
  }

  render(alpha: number, dt: number): void {
    const events = this.sim.events
    if (events.length) events.drain(this.onEventBound)
    this.view.update(this.prev, this.curr, alpha, dt)
    if (this.state !== 'title') this.hud.update(this.curr, dt, this.view.view === 'cockpit')
    this.audio.update(this.curr, Math.abs(this.held.steer) > 0.6 && this.curr.speed > 40)
    this.feel(dt)
    this.perf.update(this.loop.stats, this.view.stats, dt, `z=${this.curr.z.toFixed(0)} x=${this.curr.x.toFixed(2)} v=${this.curr.speed.toFixed(0)} stage=${this.curr.stageId} ${this.settings.data.style}`)
    this.view.render()
  }

  private feelAcc = 0
  private feel(dt: number): void {
    if (this.state !== 'running') return
    this.feelAcc += dt
    if (this.feelAcc < 0.1) return
    this.feelAcc = 0
    if (Math.abs(this.curr.x) > 1 && this.curr.speed > 5) {
      this.haptics.rumble(0.2, 0.5, 110)
      this.haptics.mobile(15)
    }
    if (this.curr.hud.turboActive) this.haptics.triggers(0, 0.6, 110)
  }

  private readonly onEventBound = (e: SimEvent): void => this.onEvent(e)
  private onEvent(e: SimEvent): void {
    this.view.onEvent(e)
    this.audio.onEvent(e)
    const hp = this.haptics
    switch (e.type) {
      case 'crash':
        this.hud.showMessage('CRASH', 1.6, 'bad')
        hp.rumble(1, 1, 600)
        hp.triggers(1, 1, 400)
        hp.mobile([100, 40, 160])
        break
      case 'bump':
        hp.rumble(0.6, 0.4, 150)
        hp.mobile(30)
        break
      case 'checkpoint': {
        const id = this.sim.stage.desc.id
        this.hud.showMessage(`CHECKPOINT · ${STAGE_BY_ID[id].name.toUpperCase()}`, 2.2, 'good')
        hp.mobile(40)
        break
      }
      case 'turbo':
        hp.rumble(0.4, 0.8, 300)
        break
      case 'timeout':
        this.hud.showMessage('TIME UP', 2, 'bad')
        break
      case 'finish':
        this.hud.showMessage('GOAL!', 3, 'good')
        break
      default:
        break
    }
  }
}
