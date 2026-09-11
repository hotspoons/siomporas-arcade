// Walking the aisle: a body in the room, rather than a row that slides past a fixed camera.
//
// The lobby's default view is a carousel — whichever cabinet is selected is square on, at x = 0,
// with its neighbours turned in. That is the right way to *choose* a game and the wrong way to
// *look* at one, because a cabinet's two flanks carry most of its artwork and the carousel never
// shows you either of them properly. So this is the other half: the cabinets stand still in a
// straight row, and you move instead.
//
// Everything here is in world space. The lobby owns where the cabinets are; this owns where the
// player is and keeps them out of the furniture.

import { Vector3 } from 'three'

/** A footprint to keep out of, as a centre and half-extents on the floor plane. */
export interface Block {
  x: number
  z: number
  hw: number
  hd: number
}

/** The walls of the walkable area — the aisle, not the room, which is much bigger. */
export interface Bounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** What the player is asking for this frame; each is -1..1 except `run`. */
export interface WalkInput {
  fwd: number
  side: number
  turn: number
  run: boolean
}

/** Eye height. The same as the carousel camera's, so switching views does not jump vertically. */
export const EYE = 1.62
/** Metres per second at a walk, and the multiplier for holding shift. */
const SPEED = 2.3
const RUN = 1.9
/** Radians per second when turning on the keyboard, and radians per pixel when dragging to look. */
const TURN_RATE = 2.3
const LOOK_SENS = 0.0042
/** How quickly the walk reaches full speed and stops again. Low enough to have weight, high enough
 * not to feel like ice. */
const ACCEL = 14
/** How much room the player takes up, for staying out of the cabinets. */
const RADIUS = 0.3
/** Looking further up or down than this is how you end up staring at the carpet. */
const PITCH_MAX = 0.8
/** Standing at a machine you look down at it a little, because the glass is at chest height. */
const PITCH_REST = -0.12

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export class Walk {
  /** Where the player is standing, on the floor: y is always 0. */
  readonly feet = new Vector3()
  yaw = 0
  pitch = 0

  private readonly vel = new Vector3()
  /**
   * Where a tap sent us. Clicking a machine across the room and then walking there yourself is
   * tedious on a desktop and impossible on a phone, so a tap walks you over; any key or drag takes
   * the controls back.
   */
  private goal: { x: number; z: number; yaw: number } | null = null

  reset(x: number, z: number, yaw: number): void {
    this.feet.set(x, 0, z)
    this.yaw = yaw
    this.pitch = PITCH_REST
    this.vel.set(0, 0, 0)
    this.goal = null
  }

  /** Stand at (x, z) facing `yaw`, walking there over the next second or so. */
  walkTo(x: number, z: number, yaw: number): void {
    this.goal = { x, z, yaw }
  }

  get autoWalking(): boolean {
    return this.goal !== null
  }

  /** Dragging across the view: pixels in, radians out. */
  lookBy(dx: number, dy: number): void {
    this.goal = null
    this.yaw -= dx * LOOK_SENS
    this.pitch = clamp(this.pitch - dy * LOOK_SENS, -PITCH_MAX, PITCH_MAX)
  }

  step(dt: number, input: WalkInput, blocks: readonly Block[], bounds: Bounds): void {
    // Well clear of a drifting stick: a pad resting at 0.02 must not cancel a walk you asked for.
    const asked = Math.abs(input.fwd) + Math.abs(input.side) + Math.abs(input.turn)
    if (asked > 0.15) this.goal = null

    let wantX = 0
    let wantZ = 0
    if (this.goal) {
      const dx = this.goal.x - this.feet.x
      const dz = this.goal.z - this.feet.z
      const dist = Math.hypot(dx, dz)
      if (dist < 0.06) {
        this.goal = null
      } else {
        // Full speed until the last half-metre, so arriving settles rather than skids.
        const s = SPEED * Math.min(1, dist / 0.5)
        wantX = (dx / dist) * s
        wantZ = (dz / dist) * s
        // Turn to face the way we will be standing on the way over, not on arrival.
        const turn = Math.atan2(Math.sin(this.goal.yaw - this.yaw), Math.cos(this.goal.yaw - this.yaw))
        this.yaw += turn * (1 - Math.exp(-4 * dt))
        this.pitch += (PITCH_REST - this.pitch) * (1 - Math.exp(-4 * dt))
      }
    } else {
      this.yaw -= input.turn * TURN_RATE * dt
      // yaw = 0 looks down -z, which is the way a camera faces by default and the way the row is.
      const sin = Math.sin(this.yaw)
      const cos = Math.cos(this.yaw)
      const speed = SPEED * (input.run ? RUN : 1)
      // Forward and strafe, normalised so a diagonal is not faster than a straight line.
      const len = Math.max(1, Math.hypot(input.fwd, input.side))
      const f = (input.fwd / len) * speed
      const s = (input.side / len) * speed
      wantX = -sin * f + cos * s
      wantZ = -cos * f - sin * s
    }

    const k = 1 - Math.exp(-ACCEL * dt)
    this.vel.x += (wantX - this.vel.x) * k
    this.vel.z += (wantZ - this.vel.z) * k
    this.feet.x += this.vel.x * dt
    this.feet.z += this.vel.z * dt

    // Out of the furniture, then inside the aisle. Order matters: a cabinet pushed you sideways is
    // fine, a cabinet pushing you through a wall is not.
    for (const b of blocks) {
      const dx = this.feet.x - b.x
      const dz = this.feet.z - b.z
      const ox = b.hw + RADIUS - Math.abs(dx)
      const oz = b.hd + RADIUS - Math.abs(dz)
      if (ox <= 0 || oz <= 0) continue
      // Out along whichever way is the shorter trip.
      if (ox < oz) {
        this.feet.x = b.x + Math.sign(dx || 1) * (b.hw + RADIUS)
        this.vel.x = 0
      } else {
        this.feet.z = b.z + Math.sign(dz || 1) * (b.hd + RADIUS)
        this.vel.z = 0
      }
    }
    this.feet.x = clamp(this.feet.x, bounds.minX, bounds.maxX)
    this.feet.z = clamp(this.feet.z, bounds.minZ, bounds.maxZ)
  }

  eye(out: Vector3): Vector3 {
    return out.set(this.feet.x, EYE, this.feet.z)
  }

  /** A point a few metres along the line of sight, which is what `camera.lookAt` wants. */
  lookPoint(out: Vector3): Vector3 {
    const cp = Math.cos(this.pitch)
    return out.set(this.feet.x - Math.sin(this.yaw) * cp * 3, EYE + Math.sin(this.pitch) * 3, this.feet.z - Math.cos(this.yaw) * cp * 3)
  }
}
