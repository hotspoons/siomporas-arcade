// Afterburner: what comes out of the exhausts when a boost is lit and the throttle is down.
//
// Turbo OutRun's is the reference, and its flame is not a cone — it is a little stream of round
// puffs leaving the pipes and coming at you, each swelling and cooling as it travels before it is
// gone. So that is what this is: a handful of discs per pipe, spaced along a cycle, growing and
// reddening with age. Additive, no texture — the shape is in the geometry, which stays crisp
// through the low-res pipeline instead of smudging.
//
// Where the pipes are is not guessed here. The sprite bake projects a marker at each pipe into every
// frame it renders, so this asks the frame. Fitting metres to a sprite by hand cannot work: the car
// is drawn through a lens, so its tail is magnified more than its middle, and a frame from the flank
// is twice the size of one from behind.

import { AdditiveBlending, BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial } from 'three'

import type { SpriteFrame } from './SpriteAtlas'

/** Puffs in the air per pipe at any moment. */
const PUFFS = 4
/** Sides on each puff: enough to read round at a few pixels across, cheap enough not to care. */
const SIDES = 8
/** Pipes we can draw for. */
const MAX_PIPES = 2
/**
 * A plume coming straight at the camera barely moves on screen — it swells. So a puff grows a lot and
 * drifts only a little, and what drift there is goes gently *up*, the way hot gas does. Sending it
 * down the screen instead reads as fire being poured onto the road.
 */
const RISE_M = 0.12
const LIFE_S = 0.17
/** Radius at the pipe and at the end of the run: most of the motion is this. */
const R0_M = 0.1
const R1_M = 0.36

/** Colour along a puff's life: white hot at the pipe, orange, then a dirty red as it goes out. */
const COLOURS: [number, number, number][] = [
  [1.0, 0.96, 0.82],
  [1.0, 0.74, 0.24],
  [1.0, 0.44, 0.08],
  [0.78, 0.18, 0.04],
]

export class Flames {
  readonly mesh: Mesh
  private readonly geo = new BufferGeometry()
  private readonly pos: BufferAttribute
  private readonly col: BufferAttribute
  private readonly material: MeshBasicMaterial
  /** 0..1: how hard the flames are burning. Ramped so they light and die smoothly. */
  private strength = 0
  private clock = 0

  constructor() {
    const verts = MAX_PIPES * PUFFS * SIDES * 3
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
   * Place the flames on the car sprite drawn by `frame`, `h` pixels tall with its ground contact at
   * screen (`x`, `y`) and leaning by `roll` radians — the same lean the sprite is drawn with, so the
   * fire stays bolted to the car through a banked turn. `on` is whether they should be burning.
   */
  update(x: number, y: number, h: number, frame: SpriteFrame | null, roll: number, on: boolean, dt: number): void {
    // Light fast, die slower: a boost hits instantly and trails off.
    this.strength += ((on ? 1 : 0) - this.strength) * Math.min(1, (on ? 14 : 5) * dt)
    if (this.strength < 0.02 || !frame?.exhausts) {
      this.mesh.visible = false
      return
    }
    this.mesh.visible = true
    this.clock += dt
    const p = this.pos.array as Float32Array
    const c = this.col.array as Float32Array
    p.fill(0)
    let v = 0
    const rc = Math.cos(roll)
    const rs = Math.sin(roll)
    // The frame's own centre, which is what the sprite is rolled about.
    const cx = x
    const cy = y - frame.baseline * h + h / 2
    /** A point given as an offset from the frame's centre, laid down in screen space with the lean. */
    const lean = (dx: number, dy: number): [number, number] => [cx + dx * rc - dy * rs, cy + dx * rs + dy * rc]
    /** Pixels to the metre out at the pipes, which is further from the bake camera than the car's middle. */
    const px = frame.exhausts.perMetre * h
    let side = -1
    for (const [ex, ey] of frame.exhausts.pipes) {
      const pipeDx = ex * h
      const pipeDy = ey * h
      for (let i = 0; i < PUFFS; i++) {
        // Each puff a life out of phase with the next, and the two pipes firing out of step.
        const age = (this.clock / LIFE_S + i / PUFFS + (side > 0 ? 0.37 : 0)) % 1
        const r = (R0_M + (R1_M - R0_M) * age) * px * this.strength
        // Coming at the camera: swelling in place, drifting a little apart and a little upward.
        const [ox, oy] = lean(pipeDx + side * age * 0.12 * px, pipeDy + age * RISE_M * px)
        // Brightest just off the pipe, gone by the end of the run.
        const fade = (1 - age * age) * this.strength
        const shade = COLOURS[Math.min(COLOURS.length - 1, Math.floor(age * COLOURS.length))]
        for (let s = 0; s < SIDES; s++) {
          const a0 = (s / SIDES) * Math.PI * 2
          const a1 = ((s + 1) / SIDES) * Math.PI * 2
          const tri = [
            [ox, oy],
            [ox + Math.cos(a0) * r, oy + Math.sin(a0) * r * 0.8],
            [ox + Math.cos(a1) * r, oy + Math.sin(a1) * r * 0.8],
          ]
          for (const [qx, qy] of tri) {
            p[v * 3] = qx
            p[v * 3 + 1] = qy
            p[v * 3 + 2] = 0
            c[v * 3] = shade[0] * fade
            c[v * 3 + 1] = shade[1] * fade
            c[v * 3 + 2] = shade[2] * fade
            v++
          }
        }
      }
      side = 1
    }
    this.pos.needsUpdate = true
    this.col.needsUpdate = true
  }
}
