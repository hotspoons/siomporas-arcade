// Phone controls: tilt to steer (gravity from devicemotion, calibrated to a
// neutral hold), hot zones for throttle/brake/fire/shockwave/pause, a drag
// fallback for steering when sensors are unavailable. The overlay is DOM;
// zones are tracked per pointer so several fingers work at once.

import { TiltSensor } from '@apex/engine/input/TiltSensor'
import type { InputFrame } from '../sim/InputFrame'
import type { ExtraSource, UiEdges } from './InputMap'

/** Degrees of tilt from neutral that equals full steer. */
const TILT_RANGE_DEG = 22
const TILT_DEADZONE_DEG = 1.5
/** Drag fallback: pixels for full steer. */
const DRAG_RANGE_PX = 140

type Zone = 'throttle' | 'brake' | 'fire' | 'shock' | 'pause' | 'calib' | 'none'

export class TouchSource implements ExtraSource {
  readonly el: HTMLElement
  enabled = true
  readonly sensor = new TiltSensor()
  private readonly pointers = new Map<number, { zone: Zone; x0: number; x: number }>()
  private tilt = 0
  /** Base: the craft leans into the tilt, which reads right for a tube racer. */
  private readonly tiltBase: 1 | -1 = 1

  /** Settings: flip which way a tilt steers (the game's own default is applied on top of this). */
  setTiltInvert(invert: boolean): void {
    this.sensor.sign = invert ? ((-this.tiltBase) as 1 | -1) : this.tiltBase
  }
  private shockEdge = false
  private pauseEdge = false
  private calibrateEdge = false
  private readonly zones = new Map<Zone, HTMLElement>()

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'touch hidden'
    this.el.innerHTML = `
      <div class="zone throttle" data-zone="throttle"><span>THRUST</span></div>
      <div class="zone brake" data-zone="brake"><span>BRAKE</span></div>
      <div class="zone fire" data-zone="fire"><span>FIRE</span></div>
      <div class="zone shock" data-zone="shock"><span>SHOCK</span></div>
      <div class="zone pause" data-zone="pause"><span>II</span></div>
      <div class="zone calib" data-zone="calib"><span>⟲ TILT</span></div>
      <div class="tilt-hint">tilt to steer</div>
    `
    parent.appendChild(this.el)
    for (const z of this.el.querySelectorAll<HTMLElement>('[data-zone]')) this.zones.set(z.dataset.zone as Zone, z)
    this.sensor.onFirstReading = () => this.el.classList.add('sensors')
    this.el.addEventListener('pointerdown', this.onDown, { passive: false })
    this.el.addEventListener('pointermove', this.onMove, { passive: false })
    this.el.addEventListener('pointerup', this.onUp)
    this.el.addEventListener('pointercancel', this.onUp)
    this.el.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v)
    if (!v) this.pointers.clear()
  }

  get sensorsOk(): boolean {
    return this.sensor.ok
  }

  /** Must be called from a user gesture (iOS permission prompt). Safe to repeat. */
  async requestSensors(): Promise<void> {
    await this.sensor.requestSensors()
  }

  /** Take the current hold as "straight ahead". */
  calibrate(): void {
    this.sensor.calibrate()
  }

  private zoneAt(x: number, y: number): Zone {
    for (const [zone, el] of this.zones) {
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return zone
    }
    return 'none'
  }

  private readonly onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return
    e.preventDefault()
    void this.requestSensors()
    const zone = this.zoneAt(e.clientX, e.clientY)
    this.pointers.set(e.pointerId, { zone, x0: e.clientX, x: e.clientX })
    if (zone === 'shock') this.shockEdge = true
    if (zone === 'pause') this.pauseEdge = true
    if (zone === 'calib') this.calibrateEdge = true
    this.zones.get(zone)?.classList.add('held')
  }

  private readonly onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    if (!p) return
    e.preventDefault()
    p.x = e.clientX
    // Sliding a finger between the throttle and brake pads switches them.
    if (p.zone === 'throttle' || p.zone === 'brake') {
      const z = this.zoneAt(e.clientX, e.clientY)
      if ((z === 'throttle' || z === 'brake') && z !== p.zone) {
        this.zones.get(p.zone)?.classList.remove('held')
        p.zone = z
        this.zones.get(z)?.classList.add('held')
      }
    }
  }

  private readonly onUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    if (p) this.zones.get(p.zone)?.classList.remove('held')
    this.pointers.delete(e.pointerId)
  }

  apply(frame: InputFrame, ui: UiEdges): void {
    if (!this.enabled) return
    let throttle = false
    let brake = false
    let fire = false
    let drag = 0
    for (const p of this.pointers.values()) {
      if (p.zone === 'throttle') throttle = true
      else if (p.zone === 'brake') brake = true
      else if (p.zone === 'fire') fire = true
      else if (p.zone === 'none') drag = Math.max(-1, Math.min(1, (p.x - p.x0) / DRAG_RANGE_PX))
    }
    // Steering: tilt when we have it, otherwise a horizontal drag anywhere free.
    this.tilt = this.sensor.ok ? this.sensor.steer(TILT_RANGE_DEG, TILT_DEADZONE_DEG) : drag
    if (this.tilt !== 0) frame.steer = Math.max(-1, Math.min(1, frame.steer + this.tilt))
    if (throttle) {
      frame.throttle = 1
      frame.pitch = Math.max(frame.pitch, 1)
    }
    if (brake) {
      frame.brake = 1
      frame.pitch = Math.min(frame.pitch, -1)
    }
    if (fire) frame.fire = true
    if (this.shockEdge) frame.shockwave = true
    if (this.pauseEdge) ui.pause = true
    if (this.calibrateEdge) this.calibrate()
    if (this.pointers.size) ui.any = true
    this.shockEdge = false
    this.pauseEdge = false
    this.calibrateEdge = false
  }
}
