// Gamepad API polling with hot-plug, deadzone/curve shaping, edge detection
// and rumble. Reads the first connected standard-mapping pad.

import { shapeAxis } from './bindings'

export type PadGlyphs = 'xbox' | 'ps' | 'generic'

/**
 * How a pad's raw buttons and axes are read into the STANDARD layout, which is the only layout
 * the bindings speak: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 Back, 9 Start, 10 LS, 11 RS,
 * 12–15 the D-pad, 16 Guide; axes 0/1 the left stick, 2/3 the right.
 *
 * A pad the browser calls `mapping: "standard"` is already in it. One it does not — Rich's 8BitDo
 * Ultimate 2C on a Mac, 2026-09-30, and every Xbox-shaped HID pad Chrome reads on macOS — has
 * its triggers on AXES resting at −1, its D-pad on a HAT axis resting at 3.29, View and Start at
 * 10 and 11, and X and Y at 3 and 4. Read raw, every binding was wrong and a rebind grabbed the
 * resting trigger axis before a finger moved.
 */
export interface PadLayout {
  /** raw button index per standard index; -1 for none */
  buttons: number[]
  /** raw axis per standard stick axis (LX, LY, RX, RY) */
  axes: number[]
  /** raw axes that are the triggers, LT then RT, −1…1 with −1 at rest; -1 for none */
  triggers: [number, number]
  /** the raw axis carrying the D-pad as a hat (−1 north, clockwise in sevenths, ~3.29 at rest); -1 for none */
  hat: number
}

const IDENTITY: PadLayout = { buttons: Array.from({ length: 17 }, (_, i) => i), axes: [0, 1, 2, 3], triggers: [-1, -1], hat: -1 }
/** the macOS HID reading of an Xbox-shaped pad: 15 buttons, the triggers on axes 4/3, the hat on 9 */
const MAC_HID: PadLayout = { buttons: [0, 1, 3, 4, 6, 7, -1, -1, 10, 11, 13, 14, -1, -1, -1, -1, 12], axes: [0, 1, 2, 5], triggers: [4, 3], hat: 9 }

/** Which layout a pad is read through. Exported so a test can ask without a navigator. */
export function layoutFor(pad: { mapping: string; buttons: { length: number }; axes: { length: number } }): PadLayout {
  if (pad.mapping === 'standard') return IDENTITY
  if (pad.buttons.length === 15 && pad.axes.length >= 10) return MAC_HID
  return IDENTITY
}

/** Where a hat axis points: 0 north … 7 north-west, or -1 for centred. */
export function hatDirection(v: number): number {
  if (!Number.isFinite(v) || v < -1.01 || v > 1.01) return -1
  return Math.round((v + 1) * 3.5) % 8
}

export class GamepadSource {
  pad: Gamepad | null = null
  glyphs: PadGlyphs = 'generic'
  connected = false
  /** the layout the current pad is read through */
  layout: PadLayout = IDENTITY
  /** Last pad binding pressed this frame (for remapping UI). */
  lastPressed = ''
  onAny: ((binding: string) => void) | null = null
  private prevButtons = new Uint8Array(32)
  private curButtons = new Uint8Array(32)
  /** analog 0..1 per standard button: the triggers read from axes carry their travel here */
  private buttonValues = new Float32Array(32)
  private axes = new Float32Array(8)
  /** which axis directions were past the press threshold last frame, so a push is one edge */
  private prevAxisOn = new Uint8Array(16)
  private rumbleUntil = 0

  attach(target: Window): void {
    target.addEventListener('gamepadconnected', this.onConnect)
    target.addEventListener('gamepaddisconnected', this.onDisconnect)
  }

  detach(target: Window): void {
    target.removeEventListener('gamepadconnected', this.onConnect)
    target.removeEventListener('gamepaddisconnected', this.onDisconnect)
  }

  /** Call once per frame before reading. */
  poll(): void {
    const pads = navigator.getGamepads?.() ?? []
    let pad: Gamepad | null = null
    for (const p of pads) {
      if (p && p.connected) {
        pad = p
        break
      }
    }
    this.pad = pad
    this.connected = pad !== null
    this.prevButtons.set(this.curButtons)
    this.curButtons.fill(0)
    this.buttonValues.fill(0)
    this.axes.fill(0)
    this.lastPressed = ''
    if (!pad) {
      this.prevAxisOn.fill(0)
      return
    }
    const id = pad.id.toLowerCase()
    this.glyphs = /xbox|xinput|045e|8bitdo|2dc8/.test(id) ? 'xbox' : /sony|dualsense|dualshock|054c|wireless controller/.test(id) ? 'ps' : 'generic'
    const L = (this.layout = layoutFor(pad))

    for (let i = 0; i < Math.min(32, L.buttons.length); i++) {
      const r = L.buttons[i]
      const b = r >= 0 ? pad.buttons[r] : undefined
      if (!b) continue
      this.buttonValues[i] = b.value > 0 ? b.value : b.pressed ? 1 : 0
      this.curButtons[i] = b.pressed || b.value > 0.5 ? 1 : 0
    }
    // the triggers as axes: −1 at rest, +1 pulled, read into LT (6) and RT (7)
    for (const [std, raw] of [[6, L.triggers[0]], [7, L.triggers[1]]] as const) {
      if (raw < 0 || raw >= pad.axes.length) continue
      const v = Math.max(0, Math.min(1, (pad.axes[raw] + 1) / 2))
      this.buttonValues[std] = v
      this.curButtons[std] = v > 0.5 ? 1 : 0
    }
    // the hat: one axis, eight directions, read into the four D-pad buttons
    if (L.hat >= 0 && L.hat < pad.axes.length) {
      const d = hatDirection(pad.axes[L.hat])
      if (d >= 0) {
        if (d === 7 || d <= 1) this.curButtons[12] = 1
        if (d >= 3 && d <= 5) this.curButtons[13] = 1
        if (d >= 5) this.curButtons[14] = 1
        if (d >= 1 && d <= 3) this.curButtons[15] = 1
        for (const i of [12, 13, 14, 15]) this.buttonValues[i] = this.curButtons[i]
      }
    }
    for (let i = 0; i < 32; i++) {
      if (this.curButtons[i] && !this.prevButtons[i]) {
        this.lastPressed = `b${i}`
        this.onAny?.(this.lastPressed)
      }
    }
    for (let i = 0; i < 4; i++) {
      const r = L.axes[i]
      const raw = r >= 0 && r < pad.axes.length ? pad.axes[r] : 0
      this.axes[i] = shapeAxis(raw)
      // A PUSH IS ONE EDGE, like a button: an axis held past the threshold — or resting there,
      // the way a trigger read raw does — must not be re-reported every frame, or a rebind takes
      // it before anything is touched and nothing else can ever be bound.
      for (const sign of [1, -1] as const) {
        const k = i * 2 + (sign > 0 ? 0 : 1)
        const on = raw * sign > 0.7 ? 1 : 0
        if (on && !this.prevAxisOn[k]) {
          const key = `a${i}${sign > 0 ? '+' : '-'}`
          this.lastPressed = key
          this.onAny?.(key)
        }
        this.prevAxisOn[k] = on
      }
    }
  }

  /** Analog value 0..1 for a binding (`b7`, `a1+`). */
  value(binding: string): number {
    if (!this.pad) return 0
    if (binding[0] === 'b') {
      const i = Number(binding.slice(1))
      return i >= 0 && i < 32 ? this.buttonValues[i] : 0
    }
    const i = Number(binding.slice(1, -1))
    const sign = binding.endsWith('+') ? 1 : -1
    const v = this.axes[i] ?? 0
    return Math.max(0, v * sign)
  }

  down(binding: string): boolean {
    return this.value(binding) > 0.5
  }

  pressed(binding: string): boolean {
    if (binding[0] !== 'b') return false
    const i = Number(binding.slice(1))
    return this.curButtons[i] === 1 && this.prevButtons[i] === 0
  }

  rumble(strong: number, weak: number, ms: number): void {
    const pad = this.pad
    if (!pad) return
    const now = performance.now()
    // Don't let a weak tick interrupt a strong impact still playing.
    if (now < this.rumbleUntil && strong < 0.6) return
    this.rumbleUntil = now + ms
    const act = (pad as Gamepad & { vibrationActuator?: GamepadHapticActuator }).vibrationActuator
    try {
      act?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak })
    } catch {
      /* not supported; fine */
    }
  }

  private readonly onConnect = () => {
    this.connected = true
  }

  private readonly onDisconnect = () => {
    this.connected = false
    this.pad = null
  }
}
