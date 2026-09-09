// Afterburner: what comes out of the exhausts when a boost is lit and the throttle is down.
//
// Turbo OutRun's is the reference: a small puff at the rear valance, low and central,
// coming at the camera rather than climbing the back of the car. Fire pointed at you
// foreshortens, so each flame is a short stack of additive quads that *widen* and cool
// as they come forward, guttering frame to frame so it reads as fire rather than a
// triangle. No texture: the shape is in the geometry, which stays crisp through the
// low-res pipeline instead of turning into a smudge.

import { AdditiveBlending, BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial } from 'three'

/** Quads per flame, from the pipe outward. */
const STAGES = 4
/** Colour at each stage: the hot core first, cooling as it comes at you. */
const COLOURS = [0xfff4c8, 0xffc142, 0xff7a16, 0xd8380c]

export class Flames {
  readonly mesh: Mesh
  private readonly geo = new BufferGeometry()
  private readonly pos: BufferAttribute
  private readonly col: BufferAttribute
  private readonly material: MeshBasicMaterial
  /** 0..1: how hard the flames are burning. Ramped by the caller so they light and die smoothly. */
  private strength = 0
  private flicker = 0

  constructor() {
    // Two flames × STAGES quads × 6 vertices.
    const verts = 2 * STAGES * 6
    this.pos = new BufferAttribute(new Float32Array(verts * 3), 3)
    this.col = new BufferAttribute(new Float32Array(verts * 3), 3)
    this.pos.setUsage(35048) // DynamicDraw
    this.col.setUsage(35048)
    this.geo.setAttribute('position', this.pos)
    this.geo.setAttribute('color', this.col)
    this.material = new MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false })
    this.mesh = new Mesh(this.geo, this.material)
    this.mesh.frustumCulled = false
    this.mesh.visible = false
  }

  /**
   * Place the flames under a car drawn at `x`, whose base sits at screen `y` and which is `size`
   * pixels tall. `on` is whether they should be burning at all.
   */
  update(x: number, y: number, size: number, on: boolean, dt: number): void {
    // Light fast, die slower: a boost hits instantly and trails off.
    const target = on ? 1 : 0
    const rate = on ? 14 : 5
    this.strength += (target - this.strength) * Math.min(1, rate * dt)
    if (this.strength < 0.02) {
      this.mesh.visible = false
      return
    }
    this.mesh.visible = true
    this.flicker += dt * 40
    const p = this.pos.array as Float32Array
    const c = this.col.array as Float32Array
    let v = 0
    // Twin pipes, close to the centreline and low, where a rear valance puts them.
    for (const side of [-1, 1]) {
      const px = x + side * size * 0.09
      const py = y + size * 0.12
      let tip = 0
      for (let s = 0; s < STAGES; s++) {
        // Each stage guttering on its own beat, so the two flames never pulse together.
        const gutter = 0.7 + 0.3 * Math.sin(this.flicker + s * 1.9 + (side > 0 ? 2.1 : 0))
        // Short: it is coming at the camera, so it barely climbs the screen at all.
        const len = size * 0.038 * gutter * this.strength
        // And wider as it comes, the way a plume aimed at you spreads instead of tapering.
        const halfW = size * (0.045 + s * 0.018) * (0.75 + 0.25 * gutter)
        const y0 = py + tip
        const y1 = y0 + len
        tip += len
        const rgb = COLOURS[s]
        const r = ((rgb >> 16) & 255) / 255
        const g = ((rgb >> 8) & 255) / 255
        const b = (rgb & 255) / 255
        // A quad as two triangles, opening out toward the camera.
        const wide = halfW * 1.35
        const quad = [
          [px - halfW, y0],
          [px + halfW, y0],
          [px + wide, y1],
          [px - halfW, y0],
          [px + wide, y1],
          [px - wide, y1],
        ]
        for (const [qx, qy] of quad) {
          p[v * 3] = qx
          p[v * 3 + 1] = qy
          p[v * 3 + 2] = 0
          c[v * 3] = r * this.strength
          c[v * 3 + 1] = g * this.strength
          c[v * 3 + 2] = b * this.strength
          v++
        }
      }
    }
    this.pos.needsUpdate = true
    this.col.needsUpdate = true
  }
}
