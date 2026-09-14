// The part that reads a keyboard and draws to a canvas. Everything interesting is in ../sim.
//
// Input is collected into one frame per fighter and pushed into that fighter's history *before*
// the match ticks, because the sim reads input from history and nowhere else. A CPU pushes into the
// same history through the same shape of frame, which is what stops it being able to do anything a
// player cannot.
//
// Art loads in the background and the match does not wait for it: the sim is complete without a
// single sprite, so the fight starts as boxes and the sprites appear as their atlases arrive.

import { GameLoop } from '@apex/engine/app/GameLoop'
import { Button, type ButtonMask } from '../sim/Motion'
import { Match } from '../sim/Match'
import { CHARACTERS } from '../sim/Character'
import { Cpu, type Difficulty } from '../sim/Cpu'
import { render, type RenderOptions, type Scene } from '../view/Render'
import { loadCharacterArt, loadFxArt, loadStageArt } from '../view/Sprites'

interface Pad {
  left: string[]
  right: string[]
  up: string[]
  down: string[]
  buttons: Array<[string, ButtonMask]>
}

const PPP = Button.LP | Button.MP | Button.HP
const KKK = Button.LK | Button.MK | Button.HK

const P1: Pad = {
  left: ['KeyA'], right: ['KeyD'], up: ['KeyW'], down: ['KeyS'],
  buttons: [
    ['KeyF', Button.LP], ['KeyG', Button.MP], ['KeyH', Button.HP],
    ['KeyC', Button.LK], ['KeyV', Button.MK], ['KeyB', Button.HK],
    ['KeyN', PPP], ['KeyM', KKK],
  ],
}

const P2: Pad = {
  left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
  buttons: [
    ['Numpad4', Button.LP], ['Numpad5', Button.MP], ['Numpad6', Button.HP],
    ['Numpad1', Button.LK], ['Numpad2', Button.MK], ['Numpad3', Button.HK],
    ['Numpad7', PPP], ['Numpad8', KKK],
  ],
}

/** Face buttons and shoulders, in the order a six-button layout wants them. See DESIGN.md. */
const GAMEPAD_BUTTONS: Array<[number, ButtonMask]> = [
  [2, Button.LP], [3, Button.MP], [5, Button.HP],
  [0, Button.LK], [1, Button.MK], [7, Button.HK],
  [4, PPP], [6, KKK],
]

export type Opponent = Difficulty | 'human'

export interface GameSettings {
  p1?: string
  p2?: string
  stage?: string
}

export class Game {
  match: Match
  readonly cpu = new Cpu('easy')
  opponent: Opponent = 'easy'
  options: RenderOptions = { debug: false, hint: true }
  readonly scene: Scene = { chars: [null, null], stage: null, fx: null }
  stage: string

  private readonly ctx: CanvasRenderingContext2D
  private readonly held = new Set<string>()
  private readonly loop: GameLoop
  private readonly resize: () => void
  private readonly onKeyDown: (e: KeyboardEvent) => void
  private readonly onKeyUp: (e: KeyboardEvent) => void
  private readonly onBlur: () => void

  constructor(canvas: HTMLCanvasElement, settings: GameSettings = {}) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('fighter: no 2D context')
    this.ctx = ctx
    this.stage = settings.stage ?? 'airbase'
    this.match = new Match(settings.p1 ?? 'ryu', settings.p2 ?? 'zangief')
    void this.loadArt()

    this.resize = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const r = canvas.getBoundingClientRect()
      canvas.width = Math.max(320, Math.round(r.width * dpr))
      canvas.height = Math.max(180, Math.round(r.height * dpr))
    }
    this.onKeyDown = (e: KeyboardEvent): void => {
      if (this.shortcut(e.code)) {
        e.preventDefault()
        return
      }
      this.held.add(e.code)
      // Arrows and space scroll the page otherwise, which is the whole window jumping mid-round.
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault()
    }
    this.onKeyUp = (e: KeyboardEvent): void => void this.held.delete(e.code)
    this.onBlur = (): void => void this.held.clear()

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('resize', this.resize)
    this.resize()

    this.loop = new GameLoop(
      {
        beginFrame: () => 1,
        simTick: () => this.tick(),
        render: () => render(this.ctx, this.match, this.scene, this.options),
      },
      null,
      { simHz: 60, maxSubsteps: 5 },
    )
  }

  start(): void {
    this.loop.start()
  }

  /** Fetch whatever art exists for the current pair and the stage. Missing art is not an error. */
  private async loadArt(): Promise<void> {
    const [a, b] = this.match.fighters.map((f) => f.character)
    const [ca, cb, stage, fx] = await Promise.all([
      loadCharacterArt(a.art),
      loadCharacterArt(b.art),
      this.scene.stage?.id === this.stage ? Promise.resolve(this.scene.stage) : loadStageArt(this.stage),
      this.scene.fx ? Promise.resolve(this.scene.fx) : loadFxArt(),
    ])
    // The pair may have changed while we were fetching; only dress the fighters we fetched for.
    const [na, nb] = this.match.fighters.map((f) => f.character)
    if (na === a) this.scene.chars[0] = ca
    if (nb === b) this.scene.chars[1] = cb
    this.scene.stage = stage
    this.scene.fx = fx
  }

  /** New pair, new match. Keeps the opponent setting and the toggles. */
  setFighters(p1: string, p2: string): void {
    this.match = new Match(p1, p2)
    this.scene.chars = [null, null]
    this.cpu.reset()
    this.options.hint = true
    void this.loadArt()
  }

  /** Keys that are not fighting: toggles, difficulty, reset, who is fighting. Returns true if it was one. */
  private shortcut(code: string): boolean {
    const ids = CHARACTERS.map((c) => c.id)
    const [p1, p2] = this.match.fighters.map((f) => f.character.id)
    switch (code) {
      case 'F1':
        this.options.debug = !this.options.debug
        return true
      case 'F2':
        this.setOpponent(this.opponent === 'dummy' ? 'easy' : 'dummy')
        return true
      case 'Digit1':
        this.setOpponent('guard')
        return true
      case 'Digit2':
        this.setOpponent('easy')
        return true
      case 'Digit3':
        this.setOpponent('hard')
        return true
      case 'Digit4':
        this.setOpponent('human')
        return true
      // 5..8 pick player one from the first four; minus and equals walk player one along the whole
      // roster and 9 and 0 walk player two, so the keys do not run out as it grows.
      case 'Digit5':
      case 'Digit6':
      case 'Digit7':
      case 'Digit8': {
        const id = ids[Number(code.slice(-1)) - 5]
        if (id) this.setFighters(id, p2)
        return true
      }
      case 'Digit9':
      case 'Digit0': {
        const step = code === 'Digit0' ? 1 : ids.length - 1
        this.setFighters(p1, ids[(ids.indexOf(p2) + step) % ids.length])
        return true
      }
      case 'Minus':
      case 'Equal': {
        const step = code === 'Equal' ? 1 : ids.length - 1
        this.setFighters(ids[(ids.indexOf(p1) + step) % ids.length], p2)
        return true
      }
      case 'KeyR':
        this.reset()
        return true
      case 'KeyP':
        this.loop.paused = !this.loop.paused
        return true
      default:
        return false
    }
  }

  setOpponent(o: Opponent): void {
    this.opponent = o
    if (o !== 'human') this.cpu.difficulty = o
    this.cpu.reset()
  }

  reset(): void {
    this.match.restart()
    this.cpu.reset()
    this.options.hint = true
  }

  private tick(): void {
    const [a, b] = this.match.fighters
    if (this.match.phase === 'fight' && this.match.phaseFrame > 4) this.options.hint = false

    const p1 = this.readPad(P1, this.readGamepad())
    a.history.push(p1.x, p1.y, p1.buttons)

    if (this.opponent === 'human') {
      const p2 = this.readPad(P2, null)
      b.history.push(p2.x, p2.y, p2.buttons)
    } else {
      const c = this.cpu.decide(b, a)
      b.history.push(c.x, c.y, c.buttons)
    }

    this.match.tick()
    if (this.match.over && this.match.phaseFrame > 240) this.reset()
  }

  private readPad(pad: Pad, gp: { x: number; y: number; buttons: ButtonMask } | null): { x: number; y: number; buttons: ButtonMask } {
    const on = (codes: string[]): boolean => codes.some((c) => this.held.has(c))
    let x = (on(pad.right) ? 1 : 0) - (on(pad.left) ? 1 : 0)
    let y = (on(pad.up) ? 1 : 0) - (on(pad.down) ? 1 : 0)
    let buttons = 0
    for (const [code, mask] of pad.buttons) if (this.held.has(code)) buttons |= mask
    if (gp) {
      if (gp.x !== 0) x = gp.x
      if (gp.y !== 0) y = gp.y
      buttons |= gp.buttons
    }
    return { x, y, buttons }
  }

  private readGamepad(): { x: number; y: number; buttons: ButtonMask } | null {
    const pads = navigator.getGamepads?.() ?? []
    const gp = Array.from(pads).find((p) => p?.connected)
    if (!gp) return null
    const dead = 0.4
    let x = Math.abs(gp.axes[0] ?? 0) > dead ? Math.sign(gp.axes[0]) : 0
    let y = Math.abs(gp.axes[1] ?? 0) > dead ? -Math.sign(gp.axes[1]) : 0
    if (gp.buttons[14]?.pressed) x = -1
    if (gp.buttons[15]?.pressed) x = 1
    if (gp.buttons[12]?.pressed) y = 1
    if (gp.buttons[13]?.pressed) y = -1
    let buttons = 0
    for (const [i, mask] of GAMEPAD_BUTTONS) if (gp.buttons[i]?.pressed) buttons |= mask
    return { x, y, buttons }
  }

  dispose(): void {
    this.loop.stop()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('resize', this.resize)
  }
}
