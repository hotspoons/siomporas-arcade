// Gamepad API polling with hot-plug, deadzone/curve shaping, edge detection
// and rumble. Reads the first connected standard-mapping pad.

import { shapeAxis } from './bindings'

export type PadGlyphs = 'xbox' | 'ps' | 'generic'

export class GamepadSource {
  pad: Gamepad | null = null
  glyphs: PadGlyphs = 'generic'
  connected = false
  /** Last pad binding pressed this frame (for remapping UI). */
  lastPressed = ''
  onAny: ((binding: string) => void) | null = null
  private prevButtons = new Uint8Array(32)
  private curButtons = new Uint8Array(32)
  private axes = new Float32Array(8)
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
    this.axes.fill(0)
    this.lastPressed = ''
    if (!pad) return
    const id = pad.id.toLowerCase()
    this.glyphs = /xbox|xinput|045e/.test(id) ? 'xbox' : /sony|dualsense|dualshock|054c|wireless controller/.test(id) ? 'ps' : 'generic'
    for (let i = 0; i < Math.min(32, pad.buttons.length); i++) {
      const b = pad.buttons[i]
      const on = b.pressed || b.value > 0.5
      this.curButtons[i] = on ? 1 : 0
      if (on && !this.prevButtons[i]) {
        this.lastPressed = `b${i}`
        this.onAny?.(this.lastPressed)
      }
    }
    for (let i = 0; i < Math.min(8, pad.axes.length); i++) {
      this.axes[i] = shapeAxis(pad.axes[i])
      if (Math.abs(pad.axes[i]) > 0.7 && this.lastPressed === '') {
        const key = `a${i}${pad.axes[i] > 0 ? '+' : '-'}`
        this.lastPressed = key
        this.onAny?.(key)
      }
    }
  }

  /** Analog value 0..1 for a binding (`b7`, `a1+`). */
  value(binding: string): number {
    if (!this.pad) return 0
    if (binding[0] === 'b') {
      const i = Number(binding.slice(1))
      const b = this.pad.buttons[i]
      if (!b) return 0
      return b.value > 0 ? b.value : b.pressed ? 1 : 0
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
