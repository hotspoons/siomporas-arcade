// First-person dashboard: a canvas texture drawn a few times a second — wheel
// that turns with the steer, needle with speed, gear lamp, and the swinging
// dice that made a certain 1991 cabinet famous.

import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, NearestFilter, PlaneGeometry } from 'three'
import type { Snapshot } from '../sim/Snapshot'

const W = 1024
const H = 360

export class Cockpit {
  readonly mesh: Mesh
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly tex: CanvasTexture
  private diceAngle = 0
  private diceVel = 0
  private acc = 0
  private lastX = 0

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

  layout(width: number, height: number): void {
    const h = height * 0.36
    this.mesh.scale.set(width, h, 1)
    this.mesh.position.set(width / 2, h / 2, 0)
  }

  update(snap: Snapshot, dt: number): void {
    // Dice: a pendulum driven by lateral acceleration and bumps.
    const lateralAccel = (snap.x - this.lastX) / Math.max(dt, 1e-3)
    this.lastX = snap.x
    this.diceVel += (-this.diceAngle * 30 - this.diceVel * 3 + lateralAccel * 4 + (snap.crashT > 0 ? Math.sin(snap.time * 40) * 20 : 0)) * dt
    this.diceAngle += this.diceVel * dt
    this.acc += dt
    if (this.acc < 1 / 24) return
    this.acc = 0
    const c = this.ctx
    c.clearRect(0, 0, W, H)
    // Dash body.
    c.fillStyle = '#1b1c22'
    c.beginPath()
    c.moveTo(0, H)
    c.lineTo(0, 150)
    c.quadraticCurveTo(W * 0.5, 40, W, 150)
    c.lineTo(W, H)
    c.closePath()
    c.fill()
    c.fillStyle = '#2a2b33'
    c.fillRect(0, 170, W, 10)
    // Speedometer (left).
    const cx = W * 0.28
    const cy = H * 0.78
    c.strokeStyle = '#3a3c48'
    c.lineWidth = 16
    c.beginPath()
    c.arc(cx, cy, 90, Math.PI, Math.PI * 2)
    c.stroke()
    const t = Math.min(1, snap.speed / snap.maxSpeed)
    c.strokeStyle = t > 0.9 ? '#ff5a3c' : '#ffb03c'
    c.lineWidth = 10
    c.beginPath()
    c.arc(cx, cy, 90, Math.PI, Math.PI + Math.PI * t)
    c.stroke()
    c.fillStyle = '#e8f6ff'
    c.font = 'bold 44px ui-sans-serif, system-ui'
    c.textAlign = 'center'
    c.fillText(String(Math.round(snap.hud.speedKmh)), cx, cy - 10)
    c.font = '18px ui-sans-serif, system-ui'
    c.fillStyle = '#9fb8c8'
    c.fillText('KM/H', cx, cy + 14)
    // Gear lamp and turbo (right).
    const gx = W * 0.72
    c.fillStyle = snap.hud.gear === 1 ? '#5cff8a' : '#ffc857'
    c.font = 'bold 40px ui-sans-serif, system-ui'
    c.fillText(snap.hud.gear === 1 ? 'HI' : 'LO', gx, cy - 10)
    c.fillStyle = '#3a3c48'
    c.fillRect(gx - 60, cy + 4, 120, 10)
    c.fillStyle = snap.hud.turboActive ? '#ff5fd2' : '#4de1ff'
    c.fillRect(gx - 60, cy + 4, 120 * snap.hud.turbo, 10)
    c.fillStyle = '#9fb8c8'
    c.font = '16px ui-sans-serif, system-ui'
    c.fillText('TURBO', gx, cy + 32)
    // Steering wheel (centre), turning with the steer.
    const wx = W / 2
    const wy = H + 40
    c.save()
    c.translate(wx, wy)
    c.rotate(snap.steer * 1.2)
    c.strokeStyle = '#111'
    c.lineWidth = 26
    c.beginPath()
    c.arc(0, 0, 150, 0, Math.PI * 2)
    c.stroke()
    c.strokeStyle = '#2c2c34'
    c.lineWidth = 18
    c.beginPath()
    c.arc(0, 0, 150, 0, Math.PI * 2)
    c.stroke()
    c.lineWidth = 16
    for (const a of [Math.PI * 0.15, Math.PI * 0.85, Math.PI * 1.5]) {
      c.beginPath()
      c.moveTo(0, 0)
      c.lineTo(Math.cos(a) * 150, Math.sin(a) * 150)
      c.stroke()
    }
    c.fillStyle = '#1a1a20'
    c.beginPath()
    c.arc(0, 0, 34, 0, Math.PI * 2)
    c.fill()
    c.restore()
    // Fuzzy dice from the mirror (top centre), swinging.
    const px = W / 2
    const py = 0
    const len = 70
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
    for (const [ox, oy, col] of [
      [-16, 0, '#ff3b5c'],
      [12, 8, '#ffffff'],
    ] as const) {
      c.fillStyle = col
      c.fillRect(ox - 14, oy - 14, 28, 28)
      c.fillStyle = col === '#ffffff' ? '#222' : '#fff'
      for (const [px2, py2] of [
        [-7, -7],
        [7, 7],
        [0, 0],
      ]) c.fillRect(ox + px2 - 2, oy + py2 - 2, 4, 4)
    }
    c.restore()
    this.tex.needsUpdate = true
  }
}
