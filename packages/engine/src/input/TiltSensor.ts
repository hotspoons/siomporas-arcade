// Tilt steering from devicemotion gravity, orientation-aware and calibrated to
// a neutral hold. iOS gates the sensor behind a permission prompt that must
// come from a user gesture: call requestSensors() from a tap handler.

export class TiltSensor {
  ok = false
  private gx = 0
  private gy = 0
  private gz = 0
  private neutral = 0
  private lastT = 0
  /** Low-pass time constant, seconds. */
  smooth = 0.06
  onFirstReading: (() => void) | null = null

  async requestSensors(): Promise<void> {
    const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent
    try {
      if (DME?.requestPermission) {
        const r = await DME.requestPermission()
        if (r !== 'granted') return
      }
    } catch {
      /* not iOS, or denied */
    }
    if (!this.listening) {
      this.listening = true
      window.addEventListener('devicemotion', this.onMotion)
    }
  }
  private listening = false

  /** Take the current hold as "straight ahead". */
  calibrate(): void {
    this.neutral = this.rawTiltDeg()
  }

  private readonly onMotion = (e: DeviceMotionEvent) => {
    const g = e.accelerationIncludingGravity
    if (!g || g.x === null || g.y === null || g.z === null) return
    const now = performance.now()
    const dt = this.lastT ? Math.min(0.1, (now - this.lastT) / 1000) : this.smooth
    this.lastT = now
    const k = 1 - Math.exp(-dt / this.smooth)
    this.gx += (g.x - this.gx) * k
    this.gy += (g.y - this.gy) * k
    this.gz += (g.z - this.gz) * k
    if (!this.ok) {
      this.ok = true
      this.neutral = this.rawTiltDeg()
      this.onFirstReading?.()
    }
  }

  /** Tilt about the screen's vertical axis, degrees, from gravity along the screen's horizontal. */
  rawTiltDeg(): number {
    const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number
    const mag = Math.hypot(this.gx, this.gy, this.gz) || 9.81
    let along: number
    switch (angle) {
      case 90:
        along = -this.gy
        break
      case 180:
        along = -this.gx
        break
      case 270:
      case -90:
        along = this.gy
        break
      default:
        along = this.gx
    }
    return (Math.asin(Math.max(-1, Math.min(1, along / mag))) * 180) / Math.PI
  }

  /** Shaped steer in [-1, 1] given a full-lock angle and deadzone (degrees). */
  steer(rangeDeg: number, deadzoneDeg: number, curve = 1.5): number {
    if (!this.ok) return 0
    const deg = this.rawTiltDeg() - this.neutral
    const mag = Math.max(0, Math.abs(deg) - deadzoneDeg) / (rangeDeg - deadzoneDeg)
    return Math.sign(deg) * Math.min(1, mag) ** curve
  }
}
