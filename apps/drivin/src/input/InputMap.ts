// Sources → one InputFrame per frame + UI edges.

import type { KeyBindings, PadBindings } from '@apex/engine/input/bindings'
import { GamepadSource } from '@apex/engine/input/GamepadSource'
import { KeyboardSource } from '@apex/engine/input/KeyboardSource'
import { makeUiEdges, type UiEdges } from '@apex/engine/input/UiEdges'
import { makeInputFrame, type InputFrame } from '../sim/InputFrame'
import type { Action } from './bindings'

export interface ExtraSource {
  apply(frame: InputFrame, ui: UiEdges): void
}

export class InputMap {
  readonly keyboard = new KeyboardSource()
  readonly gamepad = new GamepadSource()
  readonly frame = makeInputFrame()
  readonly ui: UiEdges = makeUiEdges()
  readonly extras: ExtraSource[] = []
  keys: KeyBindings
  pad: PadBindings
  suppressGameplay = false
  swallowFrames = 0
  /** Edge: camera toggle. */
  cameraEdge = false
  private menuRepeat = 0
  private lastMenuDir = 0

  constructor(keys: KeyBindings, pad: PadBindings) {
    this.keys = keys
    this.pad = pad
  }

  attach(target: Window): void {
    this.keyboard.attach(target)
    this.gamepad.attach(target)
  }

  private keyDown(a: Action): boolean {
    for (const c of this.keys[a] ?? []) if (this.keyboard.isDown(c)) return true
    return false
  }
  private keyPressed(a: Action): boolean {
    for (const c of this.keys[a] ?? []) if (this.keyboard.wasPressed(c)) return true
    return false
  }
  private padValue(a: Action): number {
    let v = 0
    for (const b of this.pad[a] ?? []) v = Math.max(v, this.gamepad.value(b))
    return v
  }
  private padPressed(a: Action): boolean {
    for (const b of this.pad[a] ?? []) if (this.gamepad.pressed(b)) return true
    return false
  }

  poll(dt: number): InputFrame {
    const gp = this.gamepad
    gp.poll()
    const f = this.frame
    const ui = this.ui
    let steer = 0
    if (this.keyDown('steerLeft')) steer -= 1
    if (this.keyDown('steerRight')) steer += 1
    steer += this.padValue('steerRight') - this.padValue('steerLeft')
    f.steer = Math.max(-1, Math.min(1, steer))
    f.throttle = Math.max(this.keyDown('throttle') ? 1 : 0, this.padValue('throttle'))
    f.brake = Math.max(this.keyDown('brake') ? 1 : 0, this.padValue('brake'))
    f.handbrake = this.keyDown('handbrake') || this.padValue('handbrake') > 0.5
    f.reset = this.keyPressed('reset') || this.padPressed('reset')
    this.cameraEdge = this.keyPressed('camera') || this.padPressed('camera')

    ui.pause = this.keyPressed('pause') || this.padPressed('pause')
    ui.confirm = this.keyPressed('confirm') || this.padPressed('confirm')
    ui.back = this.keyboard.wasPressed('Escape') || this.keyboard.wasPressed('Backspace') || gp.pressed('b1')
    ui.toggleStyle = this.keyboard.wasPressed('F2') || this.keyboard.wasPressed('Backquote')
    ui.togglePerf = this.keyboard.wasPressed('F3') || this.keyboard.wasPressed('Digit0')
    ui.toggleDebug = this.keyboard.wasPressed('F4')
    ui.toggleTune = this.keyboard.wasPressed('F6') || this.keyboard.wasPressed('KeyT')
    ui.any = this.keyboard.anyEdge || gp.lastPressed !== ''

    const dirY = (this.keyboard.isDown('ArrowDown') || this.keyboard.isDown('KeyS') || gp.value('a1+') > 0.5 || gp.down('b13') ? 1 : 0) -
      (this.keyboard.isDown('ArrowUp') || this.keyboard.isDown('KeyW') || gp.value('a1-') > 0.5 || gp.down('b12') ? 1 : 0)
    const dirX = (this.keyboard.isDown('ArrowRight') || this.keyboard.isDown('KeyD') || gp.value('a0+') > 0.5 || gp.down('b15') ? 1 : 0) -
      (this.keyboard.isDown('ArrowLeft') || this.keyboard.isDown('KeyA') || gp.value('a0-') > 0.5 || gp.down('b14') ? 1 : 0)
    const dir = dirY * 2 + dirX
    ui.menuUp = ui.menuDown = ui.menuLeft = ui.menuRight = false
    if (dir !== 0) {
      if (dir !== this.lastMenuDir) this.menuRepeat = 0
      if (this.menuRepeat <= 0) {
        ui.menuDown = dirY > 0
        ui.menuUp = dirY < 0
        ui.menuRight = dirX > 0
        ui.menuLeft = dirX < 0
        this.menuRepeat = this.lastMenuDir === dir ? 0.12 : 0.35
      }
      this.menuRepeat -= dt
    } else this.menuRepeat = 0
    this.lastMenuDir = dir

    for (const x of this.extras) x.apply(f, ui)
    if (this.swallowFrames > 0) {
      this.swallowFrames--
      ui.pause = ui.confirm = ui.back = ui.toggleStyle = ui.togglePerf = ui.toggleDebug = ui.toggleTune = ui.any = false
      ui.menuUp = ui.menuDown = ui.menuLeft = ui.menuRight = false
    }
    if (this.suppressGameplay) {
      f.steer = 0
      f.throttle = 0
      f.brake = 0
      f.handbrake = false
      f.reset = false
      this.cameraEdge = false
    }
    this.keyboard.endFrame()
    return f
  }
}
