// First-person view from inside a Group-6-style prototype: you sit low behind
// a wraparound screen, the two fender humps fill the lower corners, a thin
// rim wheel, three round gauges, a mirror with dice, and wipers when it rains.
// Drawn to a canvas texture a few times a second.

import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, NearestFilter, PlaneGeometry } from 'three'
import type { Snapshot } from '../sim/Snapshot'
import type { Livery } from './procgen'

const W = 1280
const H = 560

export class Cockpit {
  readonly mesh: Mesh
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly tex: CanvasTexture
  private diceAngle = 0
  private diceVel = 0
  private acc = 0
  private lastX = 0
  private wiper = 0
  livery: Livery = { body: 0x7fc6e8, stripe: 0xff7a1a, number: '17' }
  rain = false
  night = false

  constructor() {
    this.canvas.width = W
    this.canvas.height = H
    this.ctx = this.canvas.getContext('2d')!
    this.tex = new CanvasTexture(this.canvas)
    this.mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false }))
    this.mesh.frustumCulled = false
    this.mesh.visible = false
  }

  setRetro(retro: boolean): void {
    this.tex.minFilter = this.tex.magFilter = retro ? NearestFilter : LinearFilter
    this.tex.needsUpdate = true
  }

  /** The overlay covers the whole logical screen; most of it is transparent. */
  layout(width: number, height: number): void {
    this.mesh.scale.set(width, height, 1)
    this.mesh.position.set(width / 2, height / 2, 0)
  }

  update(snap: Snapshot, dt: number): void {
    const lateralAccel = (snap.x - this.lastX) / Math.max(dt, 1e-3)
    this.lastX = snap.x
    this.diceVel += (-this.diceAngle * 30 - this.diceVel * 3 + lateralAccel * 4 + (snap.crashT > 0 ? Math.sin(snap.time * 40) * 20 : 0)) * dt
    this.diceAngle += this.diceVel * dt
    if (this.rain) this.wiper += dt * 2.2
    this.acc += dt
    if (this.acc < 1 / 24) return
    this.acc = 0
    const c = this.ctx
    c.clearRect(0, 0, W, H)
    const bodyDark = shade(this.livery.body, 0.42)
    const bodyLight = shade(this.livery.body, 0.95)
    const bodyMid = shade(this.livery.body, 0.72)
    const stripe = '#' + this.livery.stripe.toString(16).padStart(6, '0')

    // Fender humps: big rounded shapes in the lower corners, lit from above.
    for (const side of [-1, 1]) {
      const cx = W / 2 + side * 470
      const grad = c.createRadialGradient(cx - side * 60, H - 40, 40, cx, H + 60, 420)
      grad.addColorStop(0, bodyLight)
      grad.addColorStop(0.45, bodyMid)
      grad.addColorStop(1, bodyDark)
      c.fillStyle = grad
      c.beginPath()
      c.moveTo(cx - side * 420, H)
      c.bezierCurveTo(cx - side * 380, H - 150, cx - side * 140, H - 210, cx + side * 60, H - 205)
      c.bezierCurveTo(cx + side * 260, H - 200, cx + side * 380, H - 120, cx + side * 460, H)
      c.closePath()
      c.fill()
      // Highlight line along the hump.
      c.strokeStyle = 'rgba(255,255,255,0.18)'
      c.lineWidth = 4
      c.beginPath()
      c.moveTo(cx - side * 300, H - 120)
      c.bezierCurveTo(cx - side * 120, H - 190, cx + side * 120, H - 190, cx + side * 300, H - 130)
      c.stroke()
    }
    // Nose between the humps: low, with the central stripe running away from us.
    const noseGrad = c.createLinearGradient(0, H - 210, 0, H)
    noseGrad.addColorStop(0, bodyMid)
    noseGrad.addColorStop(1, bodyDark)
    c.fillStyle = noseGrad
    c.beginPath()
    c.moveTo(W / 2 - 330, H)
    c.quadraticCurveTo(W / 2 - 250, H - 190, W / 2, H - 200)
    c.quadraticCurveTo(W / 2 + 250, H - 190, W / 2 + 330, H)
    c.closePath()
    c.fill()
    c.fillStyle = stripe
    c.beginPath()
    c.moveTo(W / 2 - 40, H)
    c.lineTo(W / 2 - 14, H - 196)
    c.lineTo(W / 2 + 14, H - 196)
    c.lineTo(W / 2 + 40, H)
    c.closePath()
    c.fill()
    // Windscreen frame: thin A-pillars at the edges and a header bar with the mirror.
    c.fillStyle = '#15161c'
    c.fillRect(0, 0, 26, H)
    c.fillRect(W - 26, 0, 26, H)
    c.fillRect(0, 0, W, 22)
    // Rain on the glass + wipers.
    if (this.rain) {
      c.fillStyle = 'rgba(200,220,255,0.10)'
      for (let i = 0; i < 40; i++) {
        const x = ((i * 137 + this.wiper * 80) % W)
        const y = (i * 89) % (H - 240)
        c.fillRect(x, y, 3, 14)
      }
      const sweep = Math.abs(Math.sin(this.wiper)) * 1.7 - 0.85
      for (const bx of [W * 0.3, W * 0.7]) {
        c.strokeStyle = '#111'
        c.lineWidth = 8
        c.beginPath()
        c.moveTo(bx, H - 200)
        c.lineTo(bx + Math.sin(sweep) * 300, H - 200 - Math.cos(sweep) * 300)
        c.stroke()
      }
    }
    // Dash: a dark cowl behind the wheel with three round gauges.
    c.fillStyle = '#1b1c22'
    c.beginPath()
    c.moveTo(W / 2 - 360, H)
    c.lineTo(W / 2 - 320, H - 120)
    c.quadraticCurveTo(W / 2, H - 170, W / 2 + 320, H - 120)
    c.lineTo(W / 2 + 360, H)
    c.closePath()
    c.fill()
    gauge(c, W / 2 - 200, H - 60, 62, snap.speed / snap.maxSpeed, String(Math.round(snap.hud.speedKmh)), 'KM/H', snap.speed / snap.maxSpeed > 0.92)
    gauge(c, W / 2, H - 78, 78, ((snap.speed / snap.maxSpeed) * 4) % 1 * 0.8 + 0.15, snap.hud.gear === 1 ? 'HI' : 'LO', 'RPM', snap.hud.turboActive)
    gauge(c, W / 2 + 200, H - 60, 62, snap.hud.turbo, snap.hud.turboActive ? 'GO' : '', 'TURBO', snap.hud.turboActive)
    // Wheel: thin rim, three spokes, turns with the steer.
    c.save()
    c.translate(W / 2, H + 60)
    c.rotate(snap.steer * 1.1)
    c.strokeStyle = '#0c0c10'
    c.lineWidth = 22
    c.beginPath()
    c.arc(0, 0, 190, 0, Math.PI * 2)
    c.stroke()
    c.strokeStyle = '#3a2a1e'
    c.lineWidth = 14
    c.beginPath()
    c.arc(0, 0, 190, 0, Math.PI * 2)
    c.stroke()
    c.strokeStyle = '#8a8f98'
    c.lineWidth = 10
    for (const a of [Math.PI * 0.12, Math.PI * 0.88, Math.PI * 1.5]) {
      c.beginPath()
      c.moveTo(0, 0)
      c.lineTo(Math.cos(a) * 185, Math.sin(a) * 185)
      c.stroke()
    }
    c.fillStyle = '#15161c'
    c.beginPath()
    c.arc(0, 0, 40, 0, Math.PI * 2)
    c.fill()
    c.restore()
    // Mirror with the road behind implied (dark glass), dice hanging beneath.
    const mx = W * 0.68
    c.fillStyle = '#0d0e12'
    c.fillRect(mx - 150, 24, 300, 70)
    c.fillStyle = this.night ? '#101828' : '#5a86b8'
    c.fillRect(mx - 142, 30, 284, 58)
    const px = mx
    const py = 94
    const len = 80
    const dx = Math.sin(this.diceAngle) * len
    const dy = Math.cos(this.diceAngle) * len
    c.strokeStyle = '#ddd'
    c.lineWidth = 2
    c.beginPath()
    c.moveTo(px, py)
    c.lineTo(px + dx, py + dy)
    c.stroke()
    c.save()
    c.translate(px + dx, py + dy)
    c.rotate(this.diceAngle)
    for (const [ox, oy, col] of [[-18, 0, '#ff3b5c'], [14, 10, '#ffffff']] as const) {
      c.fillStyle = col
      c.fillRect(ox - 16, oy - 16, 32, 32)
      c.fillStyle = col === '#ffffff' ? '#222' : '#fff'
      for (const [qx, qy] of [[-8, -8], [8, 8], [0, 0]]) c.fillRect(ox + qx - 2, oy + qy - 2, 5, 5)
    }
    c.restore()
    this.tex.needsUpdate = true
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
  // Needle.
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

function shade(hex: number, k: number): string {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k))
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k))
  const b = Math.min(255, Math.round((hex & 255) * k))
  return `rgb(${r},${g},${b})`
}
