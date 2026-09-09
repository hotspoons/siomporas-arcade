// Tilt steering from devicemotion gravity, orientation-aware and calibrated to
// a neutral hold. iOS gates the sensor behind a permission prompt that must
// come from a user gesture: call requestSensors() from a tap handler.

/** Below this much gravity in the screen plane the phone is flat enough that "across" is guesswork. */
const FLAT_LIMIT = 2

export class TiltSensor {
  ok = false
  private gx = 0
  private gy = 0
  private gz = 0
  private neutral = 0
  private lastT = 0
  /** Low-pass time constant, seconds. */
  smooth = 0.06
  /**
   * Which way a tilt steers: +1 = tilting the phone left steers right (the craft leans into the tilt,
   * how the tube racer reads), -1 = tilting left steers left (a steering wheel, how a car reads).
   */
  sign: 1 | -1 = 1
  onFirstReading: (() => void) | null = null
  /** The across-the-screen axis, in the device's own frame, taken at the last calibration. */
  private acrossX = 1
  private acrossY = 0
  private fromGravity = false

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

  /**
   * Take the current hold as "straight ahead", and work out which way "across the screen" is from
   * gravity rather than from the page.
   *
   * The page's own idea of its orientation is not reliable: a phone that reports angle 0 while it is
   * physically on its side leaves the steering reading the axis gravity is pointing straight down, so
   * it sits at full lock and the only way to play is to hold the phone the way the page thinks it is.
   * Gravity has no such confusion. Whichever way up the phone is being held, the direction gravity
   * points within the screen is "down on screen", and a quarter turn from it is "across" — which is
   * the axis a wheel gesture moves. Held nearly flat there is nothing in the plane to measure, so
   * that case still asks the page.
   */
  calibrate(): void {
    const inPlane = Math.hypot(this.gx, this.gy)
    this.fromGravity = inPlane > FLAT_LIMIT
    if (this.fromGravity) {
      const ux = this.gx / inPlane
      const uy = this.gy / inPlane
      // Up on screen is where gravity reads from; across is that turned a quarter, the way the user sees it.
      this.acrossX = uy
      this.acrossY = -ux
    }
    this.neutral = this.tiltDeg()
  }

  /** Re-take the neutral hold when the device is turned, so a rotation mid-game is not a hard lock. */
  watchOrientation(): void {
    const again = () => {
      if (this.ok) setTimeout(() => this.calibrate(), 250)
    }
    screen.orientation?.addEventListener?.('change', again)
    window.addEventListener('orientationchange', again)
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
      this.calibrate()
      this.onFirstReading?.()
    }
  }

  /** Tilt across the screen, degrees: the calibrated axis when we have one, else the page's. */
  tiltDeg(): number {
    if (!this.fromGravity) return this.rawTiltDeg()
    const mag = Math.hypot(this.gx, this.gy, this.gz) || 9.81
    const across = (this.gx * this.acrossX + this.gy * this.acrossY) / mag
    return (Math.asin(Math.max(-1, Math.min(1, across))) * 180) / Math.PI
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
    const deg = this.tiltDeg() - this.neutral
    const mag = Math.max(0, Math.abs(deg) - deadzoneDeg) / (rangeDeg - deadzoneDeg)
    return this.sign * Math.sign(deg) * Math.min(1, mag) ** curve
  }
}
