// Hood-camera dashboard: a simple cowl across the bottom of the screen with a
// steering wheel that turns, a speedo, a tacho and the gear. Canvas overlay,
// redrawn a few times a second; hidden in the chase view.

import type { Snapshot } from '../sim/Snapshot'

const W = 1280
const H = 300

export class Dash {
  readonly el: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private acc = 0
  units: 'mph' | 'kmh' = 'mph'

  constructor(parent: HTMLElement) {
    this.el = document.createElement('canvas')
    this.el.className = 'dash hidden'
    this.el.width = W
    this.el.height = H
    this.ctx = this.el.getContext('2d')!
    parent.appendChild(this.el)
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v)
  }

  update(snap: Snapshot, dt: number): void {
    this.acc += dt
    if (this.acc < 1 / 20) return
    this.acc = 0
    const c = this.ctx
    c.clearRect(0, 0, W, H)
    // Cowl: dark padded top edge, body-coloured scuttle beneath.
    const grad = c.createLinearGradient(0, 40, 0, H)
    grad.addColorStop(0, '#1c1e26')
    grad.addColorStop(1, '#0d0e12')
    c.fillStyle = grad
    c.beginPath()
    c.moveTo(0, H)
    c.lineTo(0, 120)
    c.quadraticCurveTo(W * 0.25, 62, W / 2, 58)
    c.quadraticCurveTo(W * 0.75, 62, W, 120)
    c.lineTo(W, H)
    c.closePath()
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,0.12)'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(0, 122)
    c.quadraticCurveTo(W * 0.25, 64, W / 2, 60)
    c.quadraticCurveTo(W * 0.75, 64, W, 122)
    c.stroke()
    // Binnacle behind the wheel with the two round gauges and the gear.
    c.fillStyle = '#080910'
    c.beginPath()
    c.moveTo(W / 2 - 330, H)
    c.lineTo(W / 2 - 290, 100)
    c.quadraticCurveTo(W / 2, 70, W / 2 + 290, 100)
    c.lineTo(W / 2 + 330, H)
    c.closePath()
    c.fill()
    const h = snap.hud
    const kmh = Math.abs(snap.car.speed) * 3.6
    const shown = this.units === 'kmh' ? kmh : kmh / 1.609
    gauge(c, W / 2 - 170, 190, 72, Math.min(1, Math.abs(snap.car.speed) / 95), String(Math.round(shown)), this.units === 'kmh' ? 'KM/H' : 'MPH', false)
    gauge(c, W / 2 + 170, 190, 72, h.rpm, snap.car.speed < -0.5 ? 'R' : String(h.gear), 'RPM', h.rpm > 0.92)
    // Wheel: rim, three spokes, hub; turns with the steer.
    c.save()
    c.translate(W / 2, H + 40)
    c.rotate(snap.car.steer * 2.6)
    c.strokeStyle = '#0c0c10'
    c.lineWidth = 24
    c.beginPath()
    c.arc(0, 0, 175, 0, Math.PI * 2)
    c.stroke()
    c.strokeStyle = '#2a2622'
    c.lineWidth = 15
    c.beginPath()
    c.arc(0, 0, 175, 0, Math.PI * 2)
    c.stroke()
    c.strokeStyle = '#8a8f98'
    c.lineWidth = 11
    for (const a of [Math.PI * 0.1, Math.PI * 0.9, Math.PI * 1.5]) {
      c.beginPath()
      c.moveTo(0, 0)
      c.lineTo(Math.cos(a) * 170, Math.sin(a) * 170)
      c.stroke()
    }
    c.fillStyle = '#15161c'
    c.beginPath()
    c.arc(0, 0, 38, 0, Math.PI * 2)
    c.fill()
    c.restore()
  }
}

function gauge(c: CanvasRenderingContext2D, x: number, y: number, r: number, t: number, big: string, small: string, hot: boolean): void {
  c.fillStyle = '#0a0a0e'
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fill()
  c.strokeStyle = '#3a3c48'
  c.lineWidth = 5
  c.beginPath()
  c.arc(x, y, r - 4, Math.PI * 0.75, Math.PI * 2.25)
  c.stroke()
  c.strokeStyle = hot ? '#ff5a3c' : '#ffb03c'
  c.lineWidth = 6
  c.beginPath()
  c.arc(x, y, r - 4, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0, Math.min(1, t)))
  c.stroke()
  const a = Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0, Math.min(1, t))
  c.strokeStyle = '#ff3b3b'
  c.lineWidth = 3
  c.beginPath()
  c.moveTo(x, y)
  c.lineTo(x + Math.cos(a) * (r - 10), y + Math.sin(a) * (r - 10))
  c.stroke()
  c.fillStyle = '#e8f6ff'
  c.textAlign = 'center'
  c.font = `bold ${Math.round(r * 0.42)}px ui-sans-serif, system-ui`
  c.fillText(big, x, y + r * 0.35)
  c.font = `${Math.round(r * 0.2)}px ui-sans-serif, system-ui`
  c.fillStyle = '#9fb8c8'
  c.fillText(small, x, y + r * 0.62)
}
