// Combines every input source into one InputFrame per frame (held for every
// sim tick of that frame) plus the UI-level edges the app cares about.

import { copyInput, makeInputFrame, type InputFrame } from '../sim/InputFrame'
import { type Action, type KeyBindings, type PadBindings } from './bindings'
import { GamepadSource } from '@apex/engine/input/GamepadSource'
import { KeyboardSource } from '@apex/engine/input/KeyboardSource'
import { makeUiEdges, type UiEdges } from '@apex/engine/input/UiEdges'

/** A pluggable source (XR controllers) that writes into the frame directly. */
export interface ExtraSource {
  apply(frame: InputFrame, ui: UiEdges): void
}

export type { UiEdges }

export class InputMap {
  readonly keyboard = new KeyboardSource()
  readonly gamepad = new GamepadSource()
  readonly frame = makeInputFrame()
  readonly ui: UiEdges = makeUiEdges()
  keys: KeyBindings
  pad: PadBindings
  /** Pluggable sources (touch overlay, XR controllers), applied in order. */
  readonly extras: ExtraSource[] = []
  /** When true, gameplay actions are suppressed (menus open). */
  suppressGameplay = false
  /** Frames left to zero UI edges (after a remap capture). */
  swallowFrames = 0
  /** Repeat timer so held sticks scroll menus. */
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

  detach(target: Window): void {
    this.keyboard.detach(target)
    this.gamepad.detach(target)
  }

  private keyDown(action: Action): boolean {
    const codes = this.keys[action]
    if (!codes) return false
    for (const c of codes) if (this.keyboard.isDown(c)) return true
    return false
  }

  private keyPressed(action: Action): boolean {
    const codes = this.keys[action]
    if (!codes) return false
    for (const c of codes) if (this.keyboard.wasPressed(c)) return true
    return false
  }

  private padValue(action: Action): number {
    const list = this.pad[action]
    if (!list) return 0
    let v = 0
    for (const b of list) v = Math.max(v, this.gamepad.value(b))
    return v
  }

  private padPressed(action: Action): boolean {
    const list = this.pad[action]
    if (!list) return false
    for (const b of list) if (this.gamepad.pressed(b)) return true
    return false
  }

  /** Sample every source. Call once per frame, before the sim ticks. */
  poll(dt: number): InputFrame {
    const gp = this.gamepad
    this.keyboard.beginFrame()
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
    f.fire = this.keyDown('fire') || this.padValue('fire') > 0.5
    f.shockwave = this.keyPressed('shockwave') || this.padPressed('shockwave')
    let pitch = 0
    if (this.keyDown('pitchUp')) pitch += 1
    if (this.keyDown('pitchDown')) pitch -= 1
    pitch += this.padValue('pitchUp') - this.padValue('pitchDown')
    f.pitch = Math.max(-1, Math.min(1, pitch))

    ui.pause = this.keyPressed('pause') || this.padPressed('pause')
    ui.confirm = this.keyPressed('confirm') || this.padPressed('confirm')
    ui.back = this.keyboard.wasPressed('Escape') || this.keyboard.wasPressed('Backspace') || gp.pressed('b1')
    ui.toggleStyle = this.keyboard.wasPressed('F2') || this.keyboard.wasPressed('Backquote')
    ui.togglePerf = this.keyboard.wasPressed('F3') || this.keyboard.wasPressed('Digit0')
    ui.toggleDebug = this.keyboard.wasPressed('F4')
    ui.toggleTune = this.keyboard.wasPressed('F6') || this.keyboard.wasPressed('KeyT')
    ui.any = this.keyboard.anyEdge || gp.lastPressed !== ''

    // Menu navigation with repeat.
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
    } else {
      this.menuRepeat = 0
    }
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
      f.fire = false
      f.shockwave = false
      f.pitch = 0
    }
    this.keyboard.endFrame()
    return f
  }

  /** Copy for the replay tape / hold buffer. */
  snapshotInto(out: InputFrame): void {
    copyInput(this.frame, out)
  }
}
