// Phone controls: tilt to steer, GAS right thumb, BRAKE left thumb, GEAR and
// TURBO pills, view / pause / recalibrate pads. Drag fallback for steering.

import { TiltSensor } from '@apex/engine/input/TiltSensor'
import type { UiEdges } from '@apex/engine/input/UiEdges'
import type { InputFrame } from '../sim/InputFrame'
import type { ExtraSource } from './InputMap'

type Zone = 'gas' | 'brake' | 'gear' | 'turbo' | 'wipers' | 'lights' | 'view' | 'pause' | 'calib' | 'none'

export class TouchSource implements ExtraSource {
  readonly el: HTMLElement
  readonly tilt = new TiltSensor()
  /** Base: a car steers like a wheel — tilt the phone left and you go left. */
  private readonly tiltBase: 1 | -1 = -1

  /** Settings: flip which way a tilt steers (the game's own default is applied on top of this). */
  setTiltInvert(invert: boolean): void {
    this.tilt.sign = invert ? ((-this.tiltBase) as 1 | -1) : this.tiltBase
  }
  viewEdge = false
  private readonly pointers = new Map<number, { zone: Zone; x0: number; x: number }>()
  private edges = { gear: false, turbo: false, wipers: false, lights: false, view: false, pause: false, calib: false }
  private readonly zones = new Map<Zone, HTMLElement>()

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'touch hidden'
    this.el.innerHTML = `
      <div class="zone brake" data-zone="brake"><span>BRAKE</span></div>
      <div class="zone gas" data-zone="gas"><span>GAS</span></div>
      <div class="zone gear" data-zone="gear"><span>GEAR</span></div>
      <div class="zone turbo" data-zone="turbo"><span>TURBO</span></div>
      <div class="zone wipers" data-zone="wipers"><span>WIPERS</span></div>
      <div class="zone lights" data-zone="lights"><span>LIGHTS</span></div>
      <div class="zone view" data-zone="view"><span>VIEW</span></div>
      <div class="zone pause" data-zone="pause"><span>II</span></div>
      <div class="zone calib" data-zone="calib"><span>⟲ TILT</span></div>
      <div class="tilt-hint">tilt to steer</div>`
    parent.appendChild(this.el)
    for (const z of this.el.querySelectorAll<HTMLElement>('[data-zone]')) this.zones.set(z.dataset.zone as Zone, z)
    this.tilt.onFirstReading = () => this.el.classList.add('sensors')
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
  requestSensors(): void {
    void this.tilt.requestSensors()
  }
  calibrate(): void {
    this.tilt.calibrate()
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
    this.requestSensors()
    const zone = this.zoneAt(e.clientX, e.clientY)
    this.pointers.set(e.pointerId, { zone, x0: e.clientX, x: e.clientX })
    if (zone === 'gear' || zone === 'turbo' || zone === 'wipers' || zone === 'lights' || zone === 'view' || zone === 'pause' || zone === 'calib') this.edges[zone] = true
    this.zones.get(zone)?.classList.add('held')
  }
  private readonly onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    if (!p) return
    e.preventDefault()
    p.x = e.clientX
  }
  private readonly onUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    if (p) this.zones.get(p.zone)?.classList.remove('held')
    this.pointers.delete(e.pointerId)
  }
  apply(frame: InputFrame, ui: UiEdges): void {
    let gas = false
    let brake = false
    let drag = 0
    for (const p of this.pointers.values()) {
      if (p.zone === 'gas') gas = true
      else if (p.zone === 'brake') brake = true
      else if (p.zone === 'none') drag = Math.max(-1, Math.min(1, (p.x - p.x0) / 140))
    }
    const steer = this.tilt.ok ? this.tilt.steer(22, 1.5) : drag
    if (steer !== 0) frame.steer = Math.max(-1, Math.min(1, frame.steer + steer))
    if (gas) frame.throttle = 1
    if (brake) frame.brake = 1
    if (this.edges.gear) frame.gear = true
    if (this.edges.turbo) frame.turbo = true
    if (this.edges.wipers) frame.wipers = true
    if (this.edges.lights) frame.lights = true
    if (this.edges.pause) ui.pause = true
    if (this.edges.calib) this.calibrate()
    this.viewEdge = this.edges.view
    if (this.pointers.size) ui.any = true
    this.edges = { gear: false, turbo: false, wipers: false, lights: false, view: false, pause: false, calib: false }
  }
}
