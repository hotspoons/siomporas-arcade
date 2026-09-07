// In-world HUD for VR: a canvas texture on a small plane in the cockpit at a
// comfortable focal distance. Never screen-space.

import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three'
import type { SimSnapshot } from '../sim/SimSnapshot'
import { LASER_HEAT_MAX, SHIELD_MAX } from '../sim/Tuning'

export class XrHud {
  readonly mesh: Mesh
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly tex: CanvasTexture
  private acc = 0

  constructor() {
    this.canvas.width = 512
    this.canvas.height = 192
    this.ctx = this.canvas.getContext('2d')!
    this.tex = new CanvasTexture(this.canvas)
    this.tex.colorSpace = SRGBColorSpace
    this.tex.minFilter = LinearFilter
    this.mesh = new Mesh(new PlaneGeometry(0.62, 0.23), new MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false }))
    this.mesh.position.set(0, -0.3, -0.88)
    this.mesh.rotation.x = -0.35
    this.mesh.renderOrder = 998
    this.mesh.visible = false
  }

  update(snap: SimSnapshot, dt: number, mph: number): void {
    this.acc += dt
    if (this.acc < 1 / 15) return
    this.acc = 0
    const c = this.ctx
    const w = this.canvas.width
    const h = this.canvas.height
    c.clearRect(0, 0, w, h)
    c.fillStyle = 'rgba(6,4,15,0.55)'
    c.fillRect(0, 0, w, h)
    const hud = snap.hud
    c.textAlign = 'center'
    c.fillStyle = hud.timer < 10 ? '#ff3b5c' : '#e8f6ff'
    c.font = 'bold 64px ui-sans-serif, system-ui'
    c.fillText(hud.timer.toFixed(1), w / 2, 70)
    c.font = 'bold 28px ui-sans-serif, system-ui'
    c.fillStyle = '#e8f6ff'
    c.fillText(`${Math.round(mph)} MPH`, w / 2, 110)
    c.textAlign = 'left'
    c.font = '20px ui-sans-serif, system-ui'
    c.fillStyle = '#9fb8c8'
    c.fillText(`SCORE ${hud.score.toLocaleString()}`, 16, 34)
    c.textAlign = 'right'
    c.fillText(`GATES ${hud.gatesPassed}/${hud.gatesTotal}`, w - 16, 34)
    // Bars.
    bar(c, 16, 140, 220, 16, hud.shield / SHIELD_MAX, hud.shield < 35 ? '#ff3b5c' : '#25e8ff')
    bar(c, w - 236, 140, 220, 16, hud.heat / LASER_HEAT_MAX, hud.heatLocked ? '#ff3b5c' : '#ffc857')
    c.textAlign = 'left'
    c.fillStyle = '#9fb8c8'
    c.font = '14px ui-sans-serif, system-ui'
    c.fillText('SHIELD', 16, 174)
    c.textAlign = 'right'
    c.fillText('LASER', w - 16, 174)
    c.textAlign = 'center'
    for (let i = 0; i < 3; i++) {
      c.fillStyle = i < hud.charges ? '#ff5fd2' : 'rgba(255,95,210,0.25)'
      c.fillRect(w / 2 - 30 + i * 24, 150, 12, 12)
    }
    this.tex.needsUpdate = true
  }
}

function bar(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t: number, color: string): void {
  c.fillStyle = 'rgba(255,255,255,0.12)'
  c.fillRect(x, y, w, h)
  c.fillStyle = color
  c.fillRect(x, y, w * Math.max(0, Math.min(1, t)), h)
}
