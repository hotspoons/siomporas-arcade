// Rain: a few hundred streaks falling across the logical screen, angled by
// speed (they streak toward you as you go faster) and nudged by curves.

import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments } from 'three'

const COUNT = 420

export class Rain {
  readonly mesh: LineSegments
  enabled = false
  private readonly pos: Float32BufferAttribute
  private readonly x = new Float32Array(COUNT)
  private readonly y = new Float32Array(COUNT)
  private readonly speed = new Float32Array(COUNT)
  private width = 320
  private height = 224

  constructor() {
    this.pos = new Float32BufferAttribute(new Float32Array(COUNT * 6), 3)
    const g = new BufferGeometry()
    g.setAttribute('position', this.pos)
    this.mesh = new LineSegments(g, new LineBasicMaterial({ color: 0xb8c8dc, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false }))
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    for (let i = 0; i < COUNT; i++) {
      this.x[i] = Math.random()
      this.y[i] = Math.random()
      this.speed[i] = 0.6 + Math.random() * 0.8
    }
  }

  layout(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  update(dt: number, carSpeed: number, curveAccum: number): void {
    this.mesh.visible = this.enabled
    if (!this.enabled) return
    const W = this.width
    const H = this.height
    const len = 3 + carSpeed * 0.12
    const drift = -Math.sin(curveAccum * 0.002) * 0.12
    for (let i = 0; i < COUNT; i++) {
      this.y[i] -= this.speed[i] * dt * (1.2 + carSpeed / 60)
      this.x[i] += drift * dt
      if (this.y[i] < -0.05) {
        this.y[i] = 1.05
        this.x[i] = Math.random()
      }
      if (this.x[i] < 0) this.x[i] += 1
      if (this.x[i] > 1) this.x[i] -= 1
      const px = this.x[i] * W
      const py = this.y[i] * H
      this.pos.setXYZ(i * 2, px, py, 0)
      this.pos.setXYZ(i * 2 + 1, px + drift * len * 4, py + len, 0)
    }
    this.pos.needsUpdate = true
  }
}
