// The part that reads a keyboard and draws to a canvas. Everything interesting is in ../sim.
//
// Input is collected into one frame per fighter and pushed into that fighter's history *before*
// the match ticks, because the sim reads input from history and nowhere else. A CPU pushes into the
// same history through the same shape of frame, which is what stops it being able to do anything a
// player cannot.

import { GameLoop } from '@apex/engine/app/GameLoop'
import { Button, type ButtonMask } from '../sim/Motion'
import { Match } from '../sim/Match'
import { Cpu, type Difficulty } from '../sim/Cpu'
import { render, type RenderOptions } from '../view/Render'

interface Pad {
  left: string[]
  right: string[]
  up: string[]
  down: string[]
  buttons: Array<[string, ButtonMask]>
}

const P1: Pad = {
  left: ['KeyA'], right: ['KeyD'], up: ['KeyW'], down: ['KeyS'],
  buttons: [
    ['KeyF', Button.LP], ['KeyG', Button.MP], ['KeyH', Button.HP],
    ['KeyC', Button.LK], ['KeyV', Button.MK], ['KeyB', Button.HK],
  ],
}

const P2: Pad = {
  left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
  buttons: [
    ['Numpad4', Button.LP], ['Numpad5', Button.MP], ['Numpad6', Button.HP],
    ['Numpad1', Button.LK], ['Numpad2', Button.MK], ['Numpad3', Button.HK],
  ],
}

/** Face buttons and shoulders, in the order a six-button layout wants them. See DESIGN.md. */
const GAMEPAD_BUTTONS: Array<[number, ButtonMask]> = [
  [2, Button.LP], [3, Button.MP], [5, Button.HP],
  [0, Button.LK], [1, Button.MK], [7, Button.HK],
]

export type Opponent = Difficulty | 'human'

export class Game {
  readonly match: Match
  readonly cpu = new Cpu('easy')
  opponent: Opponent = 'easy'
  options: RenderOptions = { debug: false, hint: true }

  private readonly ctx: CanvasRenderingContext2D
  private readonly held = new Set<string>()
  private readonly loop: GameLoop
  private readonly resize: () => void
  private readonly onKeyDown: (e: KeyboardEvent) => void
  private readonly onKeyUp: (e: KeyboardEvent) => void
  private readonly onBlur: () => void

  constructor(canvas: HTMLCanvasElement, leftId = 'kestrel', rightId = 'bollard') {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('fighter: no 2D context')
    this.ctx = ctx
    this.match = new Match(leftId, rightId)

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
        render: () => render(this.ctx, this.match, this.options),
      },
      null,
      { simHz: 60, maxSubsteps: 5 },
    )
  }

  start(): void {
    this.loop.start()
  }

  /** Keys that are not fighting: toggles, difficulty, reset. Returns true if it was one. */
  private shortcut(code: string): boolean {
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
    const m = this.match
    m.wins[0] = 0
    m.wins[1] = 0
    m.round = 1
    m.timer = 99 * 60
    m.projectiles.length = 0
    m.combo[0] = 0
    m.combo[1] = 0
    m.roundWinner = null
    m.fighters[0].reset(-160, 1)
    m.fighters[1].reset(160, -1)
    m.phase = 'intro'
    m.phaseFrame = 0
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
