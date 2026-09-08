// Rain: a few hundred streaks falling across the logical screen, angled by
// speed (they streak toward you as you go faster) and nudged by curves.

import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments } from 'three'

const COUNT = 420

export class Rain {
  readonly mesh: LineSegments
  /**
   * How hard it is raining, 0..1. A vibe can bring the weather in gradually, so this
   * fades the curtain in rather than switching it on: fewer drops and thinner streaks
   * in drizzle, the full four hundred in a downpour.
   */
  intensity = 0
  private readonly material: LineBasicMaterial
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
    this.material = new LineBasicMaterial({ color: 0xb8c8dc, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false })
    this.mesh = new LineSegments(g, this.material)
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
    const wet = Math.max(0, Math.min(1, this.intensity))
    this.mesh.visible = wet > 0.02
    if (!this.mesh.visible) return
    this.material.opacity = 0.32 * wet
    // Drops past the intensity's share are parked off-screen rather than drawn short.
    const live = Math.max(1, Math.round(COUNT * (0.35 + 0.65 * wet)))
    const W = this.width
    const H = this.height
    // Driving into rain: drops fall, but they also rush past you — outward from the vanishing
    // point and toward the camera, faster the faster you go — so streaks lean away from the
    // road's centre instead of hanging straight down. Curves push the whole curtain sideways.
    const k = Math.min(1.6, carSpeed / 60)
    const len = 3 + carSpeed * 0.1
    const drift = -Math.sin(curveAccum * 0.002) * 0.12
    const vpx = 0.5
    const vpy = 0.58
    for (let i = live; i < COUNT; i++) {
      this.pos.setXYZ(i * 2, -10, -10, 0)
      this.pos.setXYZ(i * 2 + 1, -10, -10, 0)
    }
    for (let i = 0; i < live; i++) {
      const ox = this.x[i] - vpx
      const oy = this.y[i] - vpy
      this.y[i] -= this.speed[i] * dt * (1.0 + k * 0.4) - oy * k * 1.4 * dt
      this.x[i] += drift * dt + ox * k * 1.4 * dt
      if (this.y[i] < -0.05 || this.x[i] < -0.05 || this.x[i] > 1.05 || (this.y[i] > 1.05 && oy > 0)) {
        // Respawn: mostly at the top, some near the vanishing point so the flow field stays fed.
        if (Math.random() < 0.7) {
          this.y[i] = 1.05
          this.x[i] = Math.random()
        } else {
          this.x[i] = vpx + (Math.random() - 0.5) * 0.5
          this.y[i] = vpy + (Math.random() - 0.5) * 0.3
        }
      }
      const px = this.x[i] * W
      const py = this.y[i] * H
      // Streak along the drop's own motion: down, plus outward with speed.
      const sx = (drift + ox * k * 1.4) * len * 1.2
      const sy = len * (1 + k * 0.4) - oy * k * 1.4 * len * 1.2
      this.pos.setXYZ(i * 2, px, py, 0)
      this.pos.setXYZ(i * 2 + 1, px - sx, py + sy, 0)
    }
    this.pos.needsUpdate = true
  }
}
