// The app: title → run → results. Wires input → sim → snapshot → render/HUD/audio.

import { GameLoop, type LoopClient } from '@apex/engine/app/GameLoop'
import { PressStart } from '@apex/engine/app/PressStart'
import type { UiEdges } from '@apex/engine/input/UiEdges'
import { MenuStack } from '@apex/engine/app/Menus'
import { TunePanel } from '@apex/engine/app/TunePanel'
import { SIM_TUNE } from '../sim/Tuning'
import { HUD_RETRO, RENDER_TUNE } from '../render/RenderTuning'
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
import { Editor } from '../editor/Editor'
import { BUILTIN_WORLD, WorldStore } from '../world/WorldStore'
import { WorldRoute, type RouteSource } from '../world/Route'
import { builtinAsWorld } from '../world/builtin'
import { checkWorld } from '../world/types'
import type { WorldData } from '../world/types'
import { keyLabel } from '@apex/engine/input/bindings'
import { Disposer } from '@apex/engine/app/Disposer'

/** Short label for a standard-mapping pad button id like 'b2'. */
function padLabel(b: string | undefined): string {
  const names: Record<string, string> = { b0: 'A', b1: 'B', b2: 'X', b3: 'Y', b4: 'LB', b5: 'RB', b6: 'LT', b7: 'RT', b8: 'SELECT', b9: 'START', b10: 'LS', b11: 'RS', b12: '↑', b13: '↓', b14: '←', b15: '→' }
  return names[b ?? ''] ?? (b ?? '?').toUpperCase()
}
import { MAX_SUBSTEPS, SIM_HZ } from '../sim/Tuning'
import { Hud } from './Hud'
import { buildMenus } from './menus'
import { Settings } from './Settings'

export type GameState = 'title' | 'running' | 'paused' | 'results' | 'editor'

export class Game implements LoopClient {
  readonly settings = new Settings()
  readonly input: InputMap
  readonly view: RenderWorld
  readonly hud: Hud
  readonly menus: MenuStack
  /** Attract-mode prompt, shown when the title menu is put aside. */
  private readonly pressStart: PressStart
  readonly perf: PerfOverlay
  readonly tune: TunePanel
  readonly loop: GameLoop
  /** Everything the constructor hooked onto the window, ready to be unhooked. */
  private readonly gone = new Disposer()
  /**
   * Set by the arcade shell: how to leave for the marquees. Null when the game is being
   * served on its own, where there is nowhere to go and no way out is offered.
   */
  onExit: (() => void) | null = null
  readonly audio = new AudioWorld()
  readonly haptics: Haptics
  readonly touch: TouchSource | null = null
  /** Worlds: the built-in coast-to-coast route plus anything built in the editor. */
  readonly worlds = new WorldStore()
  readonly editor: Editor
  /** The world the next run will drive. */
  route: RouteSource
  /** A world handed straight over from the editor's Test drive, unsaved and all. */
  private testWorld: WorldData | null = null
  private testStart = ''
  /** The editor is holding a world we came out of (Test drive), so we can go back to it. */
  fromEditor = false
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
    this.route = this.worlds.route(s.world ?? BUILTIN_WORLD, this.seed)
    this.sim = new Sim(this.seed, s.startStage, this.route)
    this.view = new RenderWorld(canvas)
    this.view.setStage(this.sim.stage)
    this.hud = new Hud(container)
    this.hud.units = s.units
    this.menus = new MenuStack(container)
    this.pressStart = new PressStart(container, Boolean(this.touch))
    this.perf = new PerfOverlay(container)
    this.tune = new TunePanel(container, 'coast', [SIM_TUNE, RENDER_TUNE])
    this.tune.context = () => {
      const round = (v: number) => Math.round(v * 100) / 100
      const sim = this.sim
      return {
        state: this.state,
        world: this.route.worldName,
        stage: sim.stage.desc.id,
        stageName: sim.stage.desc.name,
        stageIndex: sim.stageIndex,
        route: sim.route.join(' › '),
        startStage: this.settings.data.startStage,
        seed: this.seed,
        view: this.view.view,
        style: this.settings.data.style,
        car: this.settings.data.car,
        gearbox: this.settings.data.gearbox,
        z: round(sim.z),
        x: round(sim.x),
        vibe: this.view.vibe?.id ?? sim.stage.theme.id,
        night: round(sim.nightAmount),
        rain: round(sim.rainAmount),
        segment: Math.floor(sim.z / 6),
        speed: round(sim.speed),
        gear: sim.gear,
        lights: sim.lightsOn,
        wipers: sim.wipersOn,
        timeLeft: round(sim.timeLeft),
      }
    }
    this.editor = new Editor(container, this.worlds, {
      onTest: (world, trackId) => this.testWorldRun(world, trackId),
      onExit: () => this.closeEditor(),
    })
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
    this.gone.on(window, 'resize', () => this.resize())
    this.gone.on(window, 'blur', () => this.audio.setMuted(true))
    this.gone.on(window, 'focus', () => this.audio.setMuted(false))
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
    this.showAttract(false)
    this.showTitleCard(true)
    this.audio.setRunning(false)
  }

  startRun(): void {
    this.seed = (Date.now() & 0xffff) || 1
    this.route = this.testWorld ? new WorldRoute(this.testWorld, this.seed) : this.worlds.route(this.settings.data.world ?? BUILTIN_WORLD, this.seed)
    const start = this.route.has(this.testStart || this.settings.data.startStage) ? this.testStart || this.settings.data.startStage : this.route.start
    this.sim = new Sim(this.seed, start, this.route)
    this.lastStageId = ''
    this.applyGearbox()
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
    this.view.hudLayer.setStation(STATIONS[this.settings.data.station]?.name ?? '')
    this.touch?.setVisible(true)
    this.touch?.calibrate()
    this.goImmersive()
    this.container.classList.add('is-driving')
    this.input.suppressGameplay = false
    this.loop.paused = false
    this.say(this.route.name(this.sim.startId).toUpperCase(), 1.8, 'good')
    this.audio.resume()
    this.audio.setRunning(true)
  }

  /**
   * Open the world builder. It keeps whatever it was editing when you came back from a
   * test drive; otherwise it opens the world the title screen is pointing at (the built-in
   * route arrives traced into waypoints, since sections cannot be dragged about).
   */
  openEditor(): void {
    this.state = 'editor'
    this.menus.closeAll()
    this.showTitleCard(false)
    this.hud.setVisible(false)
    this.touch?.setVisible(false)
    this.container.classList.remove('is-driving')
    this.input.suppressGameplay = true
    this.loop.paused = true
    if (!this.fromEditor) {
      const id = this.settings.data.world ?? BUILTIN_WORLD
      const data = this.worlds.get(id)
      if (data) this.editor.setWorld(data, id)
      else this.editor.setWorld(builtinAsWorld(this.worlds.freeName('Coast to Coast (copy)')), null)
    }
    this.fromEditor = true
    this.editor.show()
    this.audio.setRunning(false)
  }

  private closeEditor(): void {
    this.editor.hide()
    // fromEditor stays set: the editor is still holding that world, unsaved edits and all,
    // so the title screen offers a way straight back into it.
    this.testWorld = null
    this.testStart = ''
    this.loop.paused = false
    this.applyWorld()
    this.enterTitle()
  }

  /** Test drive: run the editor's world exactly as it stands, saved or not. */
  private testWorldRun(world: WorldData, trackId: string): void {
    const problems = checkWorld(world).filter((p) => p.level === 'error')
    if (problems.length) {
      this.editor.hide()
      this.state = 'title'
      this.menus.replace(buildMenus(this).title())
      this.say(`CAN'T DRIVE: ${problems[0].text.toUpperCase()}`, 4, 'bad')
      this.editor.show()
      this.state = 'editor'
      return
    }
    this.editor.hide()
    this.testWorld = structuredClone(world)
    this.testStart = trackId
    this.startRun()
  }

  /** Point the title screen's sim at whichever world is selected. */
  applyWorld(): void {
    const id = this.settings.data.world ?? BUILTIN_WORLD
    this.route = this.worlds.route(id, this.seed)
    if (!this.route.has(this.settings.data.startStage)) this.settings.update((d) => (d.startStage = this.route.start))
    this.sim = new Sim(this.seed, this.settings.data.startStage, this.route)
    this.lastStageId = ''
    this.applyGearbox()
    this.syncStage()
    this.sim.tick(0, this.held, this.curr)
    this.sim.tick(0, this.held, this.prev)
    this.menus.refresh()
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
    // A test drive's world was never saved; back at the title we drive whatever is selected there.
    this.testWorld = null
    this.testStart = ''
    this.applyWorld()
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

  applyGearbox(): void {
    this.sim.automatic = (this.settings.data.gearbox ?? 'manual') === 'auto'
    if (this.sim.automatic && this.sim.speed < 1) this.sim.gear = 0 // an automatic pulls away in LO
  }

  /** Say something on both HUDs; only one of them is visible. */
  private say(text: string, seconds: number, cls = ''): void {
    this.hud.showMessage(text, seconds, cls)
    this.view.hudLayer.showMessage(text, seconds, cls)
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
    this.say(this.settings.data.style.toUpperCase(), 0.8)
  }
  applyView(): void {
    this.view.view = this.settings.data.view
    this.hud.setViewHint(this.settings.data.view)
    this.view.hudLayer.setViewHint(this.settings.data.view === 'cockpit' ? 'C - CHASE VIEW' : 'C - COCKPIT VIEW')
  }
  applyCar(): void {
    this.view.setCar(this.settings.data.car)
  }
  applyStation(): void {
    this.audio.setStation(this.settings.data.station)
    this.hud.setStation(STATIONS[this.settings.data.station]?.name ?? '')
    this.view.hudLayer.setStation(STATIONS[this.settings.data.station]?.name ?? '')
  }
  applyAccessibility(): void {
    const a = this.settings.data.access
    this.touch?.setTiltInvert(Boolean(this.settings.data.tiltInvert))
    document.documentElement.style.setProperty('--hud-scale', String(a.hudScale))
    this.modern.reducedMotion = a.reducedMotion
    this.hud.units = this.settings.data.units
  }
  /**
   * The HUD is either the DOM overlay (crisp, modern) or the one painted inside the low-res buffer
   * (chunky, arcade). Only one of them is ever up, and the in-buffer one needs the retro pipeline.
   */
  private syncHudRetro(): void {
    const inBuffer = HUD_RETRO > 0.5 && this.settings.data.style === 'retro'
    this.hud.setVisible(this.state !== 'title' && !inBuffer)
    this.view.hudEnabled = this.state !== 'title'
    this.view.hudLayer.units = this.settings.data.units
  }

  /**
   * Hand the page back: stop the loop, drop the GL context and the audio hardware, and
   * unhook every listener. The arcade calls this when the player walks back out to the
   * marquees; a standalone build never does, because closing the tab does the same job.
   *
   * The DOM is not touched here. Every overlay this game made was parented to the container
   * the shell handed it, and the shell removes that whole element straight afterwards.
   */
  dispose(): void {
    this.gone.run()
    this.loop.stop()
    this.input.detach(window)
    this.editor.dispose()
    this.menus.dispose()
    this.view.dispose()
    this.audio.dispose()
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
      card.innerHTML = `<h1>Turbo Radrun</h1><p>SPRITE-SCALED ROAD RACER</p>`
      this.container.appendChild(card)
    }
    card.classList.toggle('hidden', !v)
  }

  // --- LoopClient ---
  /**
   * Title-screen attract mode. Escape puts the menu aside so the logo and the road behind it have the
   * screen to themselves, with a PRESS ENTER prompt; Enter or Start begins, anything else brings the
   * menu back. Returns true when it took the frame.
   */
  private attractTick(ui: UiEdges): boolean {
    if (this.menus.isSuppressed) {
      if (ui.confirm) {
        this.showAttract(false)
        this.startRun()
      } else if (ui.any) this.showAttract(false)
      return true // the menu is aside: it does not see this frame either way
    }
    if (ui.back) {
      this.showAttract(true)
      return true
    }
    return false
  }

  private showAttract(on: boolean): void {
    this.menus.setSuppressed(on)
    this.pressStart.setPad(this.input.gamepad.connected)
    this.pressStart.setVisible(on)
  }

  beginFrame(dt: number): number {
    const ui = this.input.ui
    this.input.poll(dt)
    if (ui.togglePerf) this.perf.toggle()
    if (this.state === 'editor') {
      this.editor.tick()
      return 1
    }
    if (ui.toggleTune) this.tune.toggle()
    if (ui.toggleStyle) this.toggleStyle()
    // The pause key toggles: while the pause menu is up it resumes, at any menu depth.
    if (this.state === 'title' && this.menus.open && this.attractTick(ui)) {
      // the title screen's menu is set aside or coming back: nothing else looks at this frame
    } else if (this.menus.open) {
      // Escape is the pause key, but inside a settings screen it should step back out of that screen,
      // not out of the game: only the pause screen itself resumes.
      if (ui.pause && this.state === 'paused' && this.menus.current?.id === 'pause') this.resume()
      else if (!this.menus.isSuppressed) this.menus.handle(ui.pause && this.state === 'paused' ? { ...ui, back: true } : ui)
    } else if (this.state === 'running') {
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
    h.wipers = false
    h.lights = false
    if (this.sim.phase !== 'driving' || this.sim.timeLeft < 20) {
      this.sim.reset()
      this.syncStage()
    }
  }

  simTick(dt: number): void {
    if (this.state === 'paused' || this.state === 'results' || this.state === 'editor') return
    const tmp = this.prev
    this.prev = this.curr
    this.curr = tmp
    this.sim.tick(dt, this.held, this.curr)
    // Edges are one-shot: the sim may tick several times per frame and must see each press once,
    // or a toggle (wipers, lights, gear) flips twice and appears dead.
    this.held.gear = this.held.turbo = this.held.wipers = this.held.lights = false
    this.syncStage()
    if (this.state === 'running' && (this.sim.phase === 'finished' || this.sim.phase === 'timeout') && !this.resultsShown) {
      this.endTimer += dt
      if (this.endTimer > 1.5) this.showResults()
    }
  }

  render(alpha: number, dt: number): void {
    if (this.state === 'editor') return
    this.syncHudRetro()
    const events = this.sim.events
    if (events.length) events.drain(this.onEventBound)
    // Paused: freeze the renderer's clock so bounce, rain and wipers hold still.
    this.view.update(this.prev, this.curr, alpha, this.state === 'paused' ? 0 : dt)
    if (this.state !== 'title') {
      this.hud.update(this.curr, dt, this.view.view === 'cockpit')
      // Prompt the manual switches while they are needed and off, labelled for whatever you're holding.
      const pad = this.input.gamepad.connected
      const k = this.settings.data.keys
      const p = this.settings.data.pad
      const wipersKey = pad ? padLabel(p.wipers?.[0]) : keyLabel(k.wipers?.[0] ?? 'KeyR')
      const lightsKey = pad ? padLabel(p.lights?.[0]) : keyLabel(k.lights?.[0] ?? 'KeyL')
      // A vibe brings the weather on gradually, so the nag follows the amount, not a flag.
      const needWipers = this.curr.rain > 0.25 && !this.curr.wipersOn && this.state === 'running'
      const needLights = this.curr.night > 0.45 && !this.curr.lightsOn && this.state === 'running'
      const turboKey = pad ? padLabel(p.turbo?.[0]) : keyLabel(k.turbo?.[0] ?? 'Space')
      this.hud.setSwitchLabels(wipersKey, lightsKey, this.touch ? '' : turboKey)
      this.hud.setSwitchNeeds(needWipers, needLights)
      this.view.hudLayer.setSwitchLabels(wipersKey, lightsKey, this.touch ? '' : turboKey)
      this.view.hudLayer.setSwitchNeeds(needWipers, needLights)
    }
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

  /** Arcade nag: the switches are manual, so remind the driver when the weather turns. */
  private switchHints(): void {
    const need: string[] = []
    if (this.sim.rainAmount > 0.25 && !this.sim.wipersOn) need.push('R · WIPERS')
    if (this.sim.nightAmount > 0.45 && !this.sim.lightsOn) need.push('L · LIGHTS')
    if (need.length) setTimeout(() => this.state === 'running' && this.say(need.join('   '), 2.4), 2400)
  }

  private readonly onEventBound = (e: SimEvent): void => this.onEvent(e)
  private onEvent(e: SimEvent): void {
    this.view.onEvent(e)
    this.audio.onEvent(e)
    const hp = this.haptics
    switch (e.type) {
      case 'wreck':
        this.say('WRECK!', 2.4, 'bad')
        hp.rumble(1, 1, 1200)
        hp.triggers(1, 1, 900)
        hp.mobile([200, 60, 200, 60, 300])
        break
      case 'wipers':
        this.say(e.a ? 'WIPERS ON' : 'WIPERS OFF', 0.8)
        break
      case 'lights':
        this.say(e.a ? 'LIGHTS ON' : 'LIGHTS OFF', 0.8)
        break
      case 'crash':
        this.say('CRASH', 1.6, 'bad')
        hp.rumble(1, 1, 600)
        hp.triggers(1, 1, 400)
        hp.mobile([100, 40, 160])
        break
      case 'bump':
        hp.rumble(0.6, 0.4, 150)
        hp.mobile(30)
        break
      case 'launch':
        hp.rumble(0.15, 0.2, 60)
        break
      case 'nearmiss':
        this.say(`NEAR MISS +${e.a}`, 1.1, 'gold')
        hp.rumble(0.2, 0.5, 90)
        hp.mobile(15)
        break
      case 'land':
        hp.rumble(Math.min(1, e.a / 25), 0.4, 160)
        hp.mobile(30)
        break
      case 'checkpoint': {
        this.say(`CHECKPOINT · ${this.sim.stage.desc.name.toUpperCase()}`, 2.2, 'good')
        hp.mobile(40)
        this.switchHints()
        break
      }
      case 'turbo':
        hp.rumble(0.4, 0.8, 300)
        this.say('BOOST', 1, 'good')
        break
      case 'turbo_earned':
        this.say(`BOOST EARNED · ${e.a} IN HAND`, 1.6, 'gold')
        hp.mobile(25)
        break
      case 'timeout':
        this.say('TIME UP', 2, 'bad')
        break
      case 'finish':
        this.say('GOAL!', 3, 'good')
        break
      default:
        break
    }
  }
}
