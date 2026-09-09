// The app: title → drive → results, plus the editor. Wires input → sim →
// snapshots → render/HUD/audio through the engine loop.

import { GameLoop, type LoopClient } from '@apex/engine/app/GameLoop'
import { PressStart } from '@apex/engine/app/PressStart'
import type { UiEdges } from '@apex/engine/input/UiEdges'
import { MenuStack } from '@apex/engine/app/Menus'
import { TunePanel } from '@apex/engine/app/TunePanel'
import { SIM_TUNE } from '../sim/Tuning'
import { RENDER_TUNE } from '../render/RenderTuning'
import { PerfOverlay } from '@apex/engine/app/PerfOverlay'
import { ModernStyle } from '@apex/engine/render/styles/ModernStyle'
import { RetroStyle } from '@apex/engine/render/styles/RetroStyle'
import { AudioWorld } from '../audio/AudioWorld'
import { Editor } from '../editor/Editor'
import { ReplayPlayer, ReplayRecorder, ReplayStore, fileName, parseReplay, type ReplayFile } from './Replay'
import { ReplayBar, SPEEDS } from './ReplayBar'
import type { CameraMode } from '../render/CameraRig'
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
import { CELL, MAX_SUBSTEPS, RESET_PENALTY, SEGMENT_PENALTY, SIM_HZ } from '../sim/Tuning'
import { BUILTIN_TRACKS } from '../sim/tracks'
import { Dash } from './Dash'
import { Hud } from './Hud'
import { buildMenus } from './menus'
import { Settings } from './Settings'
import { TrackStore } from './TrackStore'

export type GameState = 'title' | 'driving' | 'paused' | 'results' | 'editor' | 'replay'

export class Game implements LoopClient {
  readonly settings = new Settings()
  readonly tracks = new TrackStore()
  readonly input: InputMap
  readonly view: RenderWorld
  readonly hud: Hud
  readonly dash: Dash
  /** The transport along the bottom while watching: play/pause, timeline, speed, cameras. */
  readonly replayBar: ReplayBar
  readonly menus: MenuStack
  /** Attract-mode prompt, shown when the title menu is put aside. */
  private readonly pressStart: PressStart
  readonly perf: PerfOverlay
  readonly tune: TunePanel
  readonly loop: GameLoop
  readonly audio = new AudioWorld()
  readonly editor: Editor
  readonly replays = new ReplayStore()
  private readonly recorder = new ReplayRecorder()
  /** The replay being watched, and where we came from so Esc goes back there. */
  player: ReplayPlayer | null = null
  private replayFrom: GameState = 'title'
  private replayCamera: CameraMode = 'chase'
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
    this.applyExperiments()
    this.view = new RenderWorld(canvas, carById(s.carId))
    this.view.setTrack(this.track)
    this.hud = new Hud(container)
    this.dash = new Dash(container)
    this.replayBar = new ReplayBar(container, {
      togglePlay: () => this.toggleReplayPlay(),
      seek: (s) => this.player?.seek(s),
      setSpeed: (v) => {
        if (this.player) this.player.speed = v
      },
      setCamera: (m) => this.setReplayCamera(m),
      exit: () => this.stopReplay(),
    })
    this.hud.units = s.units
    this.hud.setTrack(this.track)
    this.menus = new MenuStack(container)
    this.pressStart = new PressStart(container, Boolean(this.touch))
    this.perf = new PerfOverlay(container)
    this.tune = new TunePanel(container, 'drivin', [SIM_TUNE, RENDER_TUNE])
    this.tune.context = () => {
      const c = this.sim.car
      const round = (v: number) => Math.round(v * 100) / 100
      return {
        state: this.state,
        track: this.trackData.name,
        camera: this.view.rig.mode,
        style: this.settings.data.style,
        car: this.settings.data.carId,
        pos: [round(c.pos.x), round(c.pos.y), round(c.pos.z)],
        forward: [round(c.forward.x), round(c.forward.y), round(c.forward.z)],
        cell: [Math.floor(c.pos.x / CELL), Math.floor(c.pos.z / CELL)],
        mode: c.mode,
        lanePiece: c.lane?.pieceIndex ?? -1,
        laneS: round(c.s),
        speed: round(c.speed),
        lap: this.sim.laps + 1,
        lapTime: round(this.sim.lapTime),
      }
    }
    this.editor = new Editor(container, this.tracks, {
      onTest: (data, force) => this.startDrive(data, true, force),
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
    this.showAttract(false)
    this.showTitleCard(true)
    this.audio.setRunning(false)
  }

  /** Load the selected track for the title orbit. */
  previewTrack(): void {
    // A saved track that no longer builds (no start, errors) previews the first built-in instead of taking the title down.
    const saved = this.tracks.get(this.settings.data.trackId)
    const data = saved && new Track(saved).startLane ? saved : BUILTIN_TRACKS[0]
    this.loadTrack(data)
  }

  private loadTrack(data: TrackData): void {
    this.trackData = data
    this.track = new Track(data)
    const spec = carById(this.settings.data.carId)
    this.sim = new Sim(this.track, spec, this.settings.data.laps)
    this.applyExperiments()
    this.view.setCar(spec)
    this.view.setTrack(this.track)
    this.hud.setTrack(this.track)
    this.prev = new Snapshot()
    this.curr = new Snapshot()
    this.sim.tick(0, this.held, this.curr)
    this.sim.tick(0, this.held, this.prev)
  }

  startDrive(data?: TrackData, fromEditor = false, force = false): void {
    const d = data ?? this.tracks.get(this.settings.data.trackId) ?? BUILTIN_TRACKS[0]
    const t = new Track(d)
    if (!t.valid && !force) {
      // From the title: say what's wrong right there (the HUD is hidden) and point at the editor.
      this.titleNotice(`CAN'T DRIVE “${d.name.toUpperCase()}” · ${t.errors[0] ?? 'no start piece'} · open it in the editor to fix or drive anyway`)
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
    this.recorder.start(this.trackData, this.settings.data.carId)
    this.hud.showMessage(this.trackData.name.toUpperCase(), 1.6, 'good')
    this.audio.resume()
    this.audio.setRunning(true)
  }

  /** A red line under the title logo for a few seconds (the HUD isn't shown on the title). */
  private titleNotice(text: string): void {
    const p = this.container.querySelector('.title-card p') as HTMLElement | null
    if (!p) return
    const original = p.dataset.original ?? p.textContent ?? ''
    p.dataset.original = original
    p.textContent = text
    p.classList.add('notice')
    clearTimeout(this.noticeTimer)
    this.noticeTimer = window.setTimeout(() => {
      p.textContent = original
      p.classList.remove('notice')
    }, 5000)
  }
  private noticeTimer = 0

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
    // Coming back from a test drive the editor still holds its track (and its saved id); otherwise open the
    // track we were previewing, remembering which saved track it is so Save can save over it.
    if (!this.fromEditor) {
      const id = this.settings.data.trackId
      this.editor.setData(this.trackData, id && id.startsWith('user') && this.tracks.get(id) === this.trackData ? id : this.tracks.list().find((t) => !t.builtin && t.name === this.trackData.name)?.id ?? null)
    }
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
    this.dash.units = this.settings.data.units
  }

  applyAccessibility(): void {
    const a = this.settings.data.access
    this.touch?.setTiltInvert(Boolean(this.settings.data.tiltInvert))
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
      card.innerHTML = `<h1>Drivin’</h1><p>STUNT TRACK DRIVING · WORKING TITLE</p>`
      this.container.appendChild(card)
    }
    card.classList.toggle('hidden', !v)
  }

  applyExperiments(): void {
    this.sim.crashesEnabled = this.settings.data.experiments.crashes
    this.sim.car.rocketsEnabled = this.settings.data.experiments.rockets !== false
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
        this.startDrive()
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
    if (ui.toggleTune) this.tune.toggle()
    if (ui.toggleStyle) this.toggleStyle()
    if (this.state === 'editor') {
      this.editor.tick()
      return 1
    }
    // The pause key toggles: while the pause menu is up it resumes, at any menu depth. Without this it
    // only ever paused (the menu swallowed the edge) and you had to find Escape.
    if (this.state === 'title' && this.menus.open && this.attractTick(ui)) {
      // the title screen's menu is set aside or coming back: nothing else looks at this frame
    } else if (this.menus.open) {
      // Escape is the pause key, but inside a settings screen it should step back out of that screen,
      // not out of the game: only the pause screen itself resumes.
      if (ui.pause && this.state === 'paused' && this.menus.current?.id === 'pause') this.resume()
      else if (!this.menus.isSuppressed) this.menus.handle(ui.pause && this.state === 'paused' ? { ...ui, back: true } : ui)
    } else if (this.state === 'driving') {
      if (ui.pause) this.pause()
      if (this.input.keyboard.wasPressed('KeyI') || this.input.keyboard.wasPressed('F7')) this.watchReplay()
      if (this.input.cameraEdge || this.touch?.cameraEdge) {
        this.settings.update((d) => (d.camera = d.camera === 'hood' ? 'chase' : 'hood'))
        this.applyCamera()
      }
    }
    if (this.state === 'replay') this.replayKeys(dt)
    if (this.state === 'driving') copyInput(this.input.frame, this.held)
    else this.held.throttle = this.held.brake = this.held.steer = 0
    return 1
  }

  /** While watching: space plays/pauses, ← → scrub, ↑ ↓ speed, C or 1–4 pick a camera, Esc leaves. */
  private replayKeys(dt: number): void {
    const p = this.player
    if (!p) return
    const kb = this.input.keyboard
    if (kb.anyEdge) this.replayBar.wake()
    // Confirm rather than Space itself, so Enter and a pad's A button work the transport too (and
    // Space isn't counted twice, since it is bound to confirm).
    if (this.input.ui.confirm) this.toggleReplayPlay()
    if (kb.isDown('ArrowLeft')) p.seek(p.time - dt * 6)
    if (kb.isDown('ArrowRight')) p.seek(p.time + dt * 6)
    const step = (d: number) => {
      const i = SPEEDS.indexOf(p.speed)
      p.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.indexOf(1) : i) + d))]
    }
    if (kb.wasPressed('ArrowUp')) step(1)
    if (kb.wasPressed('ArrowDown')) step(-1)
    const cams: CameraMode[] = ['chase', 'hood', 'heli', 'tv']
    for (let i = 0; i < cams.length; i++) if (kb.wasPressed(`Digit${i + 1}`)) this.setReplayCamera(cams[i])
    if (kb.wasPressed('KeyC') || this.input.cameraEdge) this.setReplayCamera(cams[(cams.indexOf(this.replayCamera) + 1) % cams.length])
    if (this.input.ui.back || this.input.ui.pause) this.stopReplay()
  }

  // --- replays -------------------------------------------------------------------

  /** Is there a run in the buffer worth watching or saving? */
  get hasRecording(): boolean {
    return !this.recorder.empty
  }

  get recordingSeconds(): number {
    return this.recorder.length
  }

  /** Watch a file (or the run just driven when `file` is omitted). */
  watchReplay(file?: ReplayFile): void {
    const f = file ?? this.recorder.build('LASTRUN', this.curr)
    if (!f) {
      this.hud.showMessage('NOTHING RECORDED', 1.6, 'bad')
      return
    }
    this.replayFrom = this.state === 'replay' ? this.replayFrom : this.state
    this.player = new ReplayPlayer(f)
    if (this.player.count < 2) {
      this.player = null
      this.hud.showMessage('REPLAY IS EMPTY', 1.6, 'bad')
      return
    }
    // The replay's own copy of the track, so later edits can't change what you watch.
    this.loadTrack(f.trackData)
    this.state = 'replay'
    this.loop.paused = false
    this.input.suppressGameplay = true
    this.touch?.setVisible(false)
    this.menus.closeAll()
    this.showTitleCard(false)
    this.hud.setVisible(true)
    this.setReplayCamera(this.replayCamera)
    this.view.rig.reset()
    this.replayBar.setTitle(`${f.file} · ${f.track.toUpperCase()}${f.laps ? ` · ${f.laps} LAP${f.laps === 1 ? '' : 'S'}` : ''}`)
    this.replayBar.setVisible(true)
  }

  /** Play/pause. At the end of the run, play starts it again from the top rather than doing nothing. */
  private toggleReplayPlay(): void {
    const p = this.player
    if (!p) return
    if (!p.playing && p.time >= p.duration - 0.01) p.seek(0)
    p.playing = !p.playing
    this.replayBar.wake()
  }

  setReplayCamera(mode: CameraMode): void {
    this.replayCamera = mode
    this.view.rig.mode = mode
    this.hud.showMessage(`${mode === 'hood' ? 'FIRST PERSON' : mode === 'chase' ? 'THIRD PERSON' : mode === 'heli' ? 'HELICOPTER' : 'TV CAMERA'} · C CYCLES`, 1.2)
  }

  get replayCameraName(): CameraMode {
    return this.replayCamera
  }

  stopReplay(): void {
    if (this.state !== 'replay') return
    this.player = null
    this.replayBar.setVisible(false)
    this.input.suppressGameplay = false
    if (this.replayFrom === 'paused' || this.replayFrom === 'results') {
      // Back to the run we were watching from: its track, its state, its menu.
      this.loadTrack(this.trackData)
      this.state = this.replayFrom
      this.loop.paused = true
      this.menus.replace(this.replayFrom === 'paused' ? buildMenus(this).pause() : buildMenus(this).results(this.curr))
      this.applyCamera()
      return
    }
    this.enterTitle()
  }

  /** A one-line text prompt over the game (the menus are keyboard-driven, this is not). */
  prompt(message: string, value = ''): Promise<string | null> {
    return new Promise((resolve) => {
      const back = document.createElement('div')
      back.className = 'editor-dialog-back'
      const box = document.createElement('div')
      box.className = 'editor-dialog'
      const p = document.createElement('p')
      p.textContent = message
      const input = document.createElement('input')
      input.type = 'text'
      input.value = value
      input.spellcheck = false
      const row = document.createElement('div')
      row.className = 'buttons'
      const ok = document.createElement('button')
      ok.className = 'primary'
      ok.textContent = 'OK'
      const cancel = document.createElement('button')
      cancel.textContent = 'Cancel'
      row.append(ok, cancel)
      box.append(p, input, row)
      back.appendChild(box)
      this.container.appendChild(back)
      const finish = (v: string | null) => {
        back.remove()
        this.input.swallowFrames = 2
        resolve(v)
      }
      ok.addEventListener('click', () => finish(input.value))
      cancel.addEventListener('click', () => finish(null))
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(input.value)
        if (e.key === 'Escape') finish(null)
      })
      input.focus()
      input.select()
    })
  }

  /** Save what is in the buffer to A:\ under `name`. */
  saveRecording(name: string): string | null {
    const f = this.recorder.build(name, this.curr)
    if (!f) {
      this.hud.showMessage('NOTHING RECORDED', 1.6, 'bad')
      return null
    }
    const id = this.replays.save(f)
    this.hud.showMessage(id ? `SAVED ${fileName(name)}` : 'A:\\ IS FULL', 2, id ? 'good' : 'bad')
    return id
  }

  /** Write a replay out as a real file (and read one back in). */
  exportReplay(f: ReplayFile): void {
    const blob = new Blob([JSON.stringify(f)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${f.file.replace(/^A:\\/, '')}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  importReplay(text: string): void {
    const f = parseReplay(text)
    if (!f) {
      this.hud.showMessage('NOT A REPLAY FILE', 1.8, 'bad')
      return
    }
    const id = this.replays.save(f)
    if (id) this.menus.refresh()
    this.hud.showMessage(id ? `COPIED TO ${f.file}` : 'A:\\ IS FULL', 2, id ? 'good' : 'bad')
  }

  simTick(dt: number): void {
    if (this.state === 'replay') {
      this.player?.advance(dt)
      return
    }
    if (this.state !== 'driving') return
    const tmp = this.prev
    this.prev = this.curr
    this.curr = tmp
    this.sim.tick(dt, this.held, this.curr)
    this.recorder.sample(this.curr, dt)
    if (this.sim.phase === 'finished' && !this.resultsShown) {
      this.endTimer += dt
      if (this.endTimer > 1.2) this.showResults()
    }
  }

  render(alpha: number, dt: number): void {
    if (this.state === 'editor') return
    if (this.state === 'replay' && this.player) {
      const tmp = this.prev
      this.prev = this.curr
      this.curr = tmp
      this.player.write(this.curr)
      this.replayBar.update(this.player, this.replayCamera, dt)
      this.view.update(this.prev, this.curr, 1, dt)
      this.hud.update(this.curr, dt, 0)
      const hood = this.view.rig.mode === 'hood'
      this.dash.setVisible(hood)
      if (hood) this.dash.update(this.curr, dt)
      this.view.render()
      this.perf.update(this.loop.stats, this.view.stats, dt, `replay ${this.player.time.toFixed(1)}/${this.player.duration.toFixed(1)}s ${this.replayCamera}`)
      return
    }
    const events = this.sim.events
    if (events.length) events.drain(this.onEventBound)
    this.view.update(this.prev, this.curr, alpha, dt)
    if (this.state !== 'title') this.hud.update(this.curr, dt, this.sim.targetLaps)
    const hood = this.state !== 'title' && this.view.rig.mode === 'hood'
    this.dash.setVisible(hood)
    if (hood) this.dash.update(this.curr, dt)
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
        this.hud.showMessage(this.sim.crashCause ? `CRASH · ${this.sim.crashCause.toUpperCase()}` : 'CRASH', 2.5, 'bad')
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
      case 'bump':
        hp.rumble(Math.min(1, e.a / 30), 0.6, 180)
        hp.mobile(35)
        break
      case 'rocket':
        this.hud.showMessage('ROCKET JUMP!', 2.4, 'good')
        hp.rumble(1, 0.7, 700)
        hp.mobile([60, 40, 220])
        break
      case 'offroad':
        hp.rumble(0.3, 0.5, 150)
        hp.mobile(25)
        break
      case 'penalty':
        this.hud.showMessage(`+${e.a * SEGMENT_PENALTY}s · ${e.a} SEGMENT${e.a > 1 ? 'S' : ''} SKIPPED`, 2.2, 'bad')
        break
      case 'respawn':
        if (e.a === 0) this.hud.showMessage('RECOVERED', 0.8)
        else if (e.a === 2) this.hud.showMessage(`RESET · +${RESET_PENALTY}s`, 1.6, 'bad')
        break
      default:
        break
    }
  }
}
