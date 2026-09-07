// Everything the browser can shake: gamepad dual-rumble, Xbox impulse-trigger
// rumble (Chromium's `trigger-rumble` effect), and phone vibration. True
// force-feedback wheels are not reachable from the web platform, so games
// express feel through these three channels. All calls are fire-and-forget and
// safe when nothing is connected.

import type { GamepadSource } from './GamepadSource'

interface HapticActuatorExt {
  effects?: string[]
  playEffect?: (type: string, params: Record<string, number>) => Promise<string>
}

export class Haptics {
  /** Master strength 0..1 from settings. */
  strength = 1
  private readonly pad: GamepadSource
  private lastTrigger = 0
  private lastMobile = 0

  constructor(pad: GamepadSource) {
    this.pad = pad
  }

  private actuator(): HapticActuatorExt | null {
    const p = this.pad.pad as (Gamepad & { vibrationActuator?: HapticActuatorExt }) | null
    return p?.vibrationActuator ?? null
  }

  get triggerRumbleSupported(): boolean {
    const a = this.actuator()
    return Boolean(a?.effects?.includes('trigger-rumble'))
  }

  /** Whole-controller rumble. */
  rumble(strong: number, weak: number, ms: number): void {
    if (this.strength <= 0) return
    this.pad.rumble(strong * this.strength, weak * this.strength, ms)
  }

  /** Impulse triggers (Xbox One/Series pads in Chromium). Falls back to nothing elsewhere. */
  triggers(left: number, right: number, ms: number): void {
    if (this.strength <= 0) return
    const a = this.actuator()
    if (!a?.playEffect || !a.effects?.includes('trigger-rumble')) return
    const now = performance.now()
    if (now - this.lastTrigger < 40) return
    this.lastTrigger = now
    try {
      void a.playEffect('trigger-rumble', { duration: ms, leftTrigger: Math.min(1, left * this.strength), rightTrigger: Math.min(1, right * this.strength) })
    } catch {
      /* unsupported */
    }
  }

  /** Phone vibration (Android browsers; iOS ignores it). */
  mobile(pattern: number | number[]): void {
    if (this.strength <= 0 || !('vibrate' in navigator)) return
    const now = performance.now()
    if (now - this.lastMobile < 60) return
    this.lastMobile = now
    try {
      navigator.vibrate(pattern)
    } catch {
      /* ignore */
    }
  }
}
