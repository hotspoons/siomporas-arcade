// Flying the editor's camera: W/A/S/D across, Q/E to turn, R/F up and down, shift to sprint.
//
// Rich, 2026-09-29: *"It would be great to have flying controls in the editor - at least wasd + qe
// to translate and rotate the camera instead of having to do everything with zooms and sweeps with
// the mouse."*
//
// Q AND E TURN, THEY DO NOT STRAFE. Rich, 2026-09-29: *"I was hoping R and F would raise/lower and
// q and e would turn the camera left or right."* Turning is a different operation from moving and
// it is the one that makes a flown camera usable — you can already strafe with A and D.
//
// A TURN ORBITS THE TARGET AROUND THE CAMERA, which is the opposite of what the mouse drag does.
// Dragging swings the camera around a fixed target, which is right when you are studying something;
// flying wants the camera to stay put and LOOK somewhere else. So the target is rotated about the
// camera's own vertical axis, at the same distance — the orbit then derives exactly the heading you
// asked for, and the next mouse drag continues from it.
//
// IT MOVES THE ORBIT, IT DOES NOT REPLACE IT. `OrbitControls` is what every other interaction in
// this editor is built on — the drag to look, the wheel to zoom, the fly-to that frames a polygon —
// and a second camera controller fighting it for the same transform is how a camera ends up
// snapping back the moment you let go. So this moves the camera AND ITS TARGET together by the same
// vector, which is a pan in the orbit's own terms: the orbit keeps its distance and its angles, the
// next drag continues from where you flew to, and `fly-to` still works.
//
// HELD KEYS, NOT KEY REPEAT. A keydown handler that moves per event is at the mercy of the
// operating system's repeat delay — a long pause, then a burst — which reads as the camera being
// broken. Keys go into a set on keydown and out on keyup, and the movement happens on the frame,
// scaled by its own dt.
//
// THE SPEED FOLLOWS THE ZOOM. A fixed metres-per-second is unusable at both ends of this editor:
// sixty metres up, a corridor is a thing you cross in two seconds; six hundred metres up, crossing
// the site takes a minute. So the speed is a fraction of the orbit's own distance, which is the
// same number that decides how big everything looks.

import * as THREE from 'three'

/** What this needs from the host — the orbit's two vectors and whether the editor has the keyboard. */
export interface FlyCamHost {
  camera: THREE.Camera
  target: THREE.Vector3
  /** false while a dialog, a text field or another mode owns the keys */
  active: () => boolean
  /** called after a move, so the host can mark the orbit dirty */
  onMove?: () => void
}

/** Fractions of the orbit distance travelled per second. */
const SPEED = 0.9
const SPRINT = 3.2
/** radians per second of yaw on Q/E, and what shift multiplies it by */
const TURN = 1.1
const TURN_SPRINT = 2.4
/** metres per second, floor and ceiling, so it is usable at both ends of the zoom */
const MIN_MS = 4
const MAX_MS = 900

export class FlyCam {
  private held = new Set<string>()
  private host: FlyCamHost
  private v = new THREE.Vector3()
  private fwd = new THREE.Vector3()
  private right = new THREE.Vector3()
  private up = new THREE.Vector3(0, 1, 0)

  /** true while any flight key is down, so the host can hold the orbit's damping off */
  get flying(): boolean {
    return this.held.size > 0
  }

  constructor(host: FlyCamHost) {
    this.host = host
  }

  /**
   * Take a keydown. Returns true when it was a flight key and nothing else should see it.
   *
   * IT DOES NOT SWALLOW MODIFIED KEYS. Ctrl+S is a save and Ctrl+W closes a tab; a flight
   * controller that eats every W is a controller somebody turns off.
   */
  down(e: KeyboardEvent): boolean {
    if (!this.host.active() || e.ctrlKey || e.metaKey || e.altKey) return false
    const k = e.key.toLowerCase()
    if (!KEYS.has(k)) return false
    this.held.add(k)
    return true
  }

  up_(e: KeyboardEvent): void {
    this.held.delete(e.key.toLowerCase())
  }

  /** Let go of everything — the editor lost focus, or a dialog opened over it. */
  release(): void {
    this.held.clear()
  }

  /**
   * Move, if anything is held. `dt` in seconds.
   *
   * The camera and the target move by the SAME vector, which is why this composes with the orbit
   * instead of fighting it.
   */
  tick(dt: number): boolean {
    if (!this.held.size || !this.host.active()) return false
    const { camera, target } = this.host

    camera.getWorldDirection(this.fwd)
    this.fwd.y = 0
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1) // looking straight down: pick a heading
    this.fwd.normalize()
    this.right.crossVectors(this.fwd, this.up).normalize()

    const step = Math.min(0.1, dt)
    let moved = false

    // --- turning: the target swings around the camera, so the camera stays where it is ---------
    const turn = (this.held.has('q') ? 1 : 0) - (this.held.has('e') ? 1 : 0)
    if (turn) {
      const a = turn * TURN * (this.held.has('shift') ? TURN_SPRINT : 1) * step
      const dx = target.x - camera.position.x
      const dz = target.z - camera.position.z
      const c = Math.cos(a)
      const s2 = Math.sin(a)
      target.x = camera.position.x + dx * c - dz * s2
      target.z = camera.position.z + dx * s2 + dz * c
      moved = true
    }

    // --- moving --------------------------------------------------------------------------------
    this.v.set(0, 0, 0)
    if (this.held.has('w')) this.v.add(this.fwd)
    if (this.held.has('s')) this.v.sub(this.fwd)
    if (this.held.has('d')) this.v.add(this.right)
    if (this.held.has('a')) this.v.sub(this.right)
    if (this.held.has('r')) this.v.add(this.up)
    if (this.held.has('f')) this.v.sub(this.up)
    if (this.v.lengthSq() > 1e-9) {
      const dist = camera.position.distanceTo(target)
      const base = Math.max(MIN_MS, Math.min(MAX_MS, dist * SPEED))
      const speed = base * (this.held.has('shift') ? SPRINT : 1)
      this.v.normalize().multiplyScalar(speed * step)
      camera.position.add(this.v)
      target.add(this.v)
      moved = true
    }
    if (moved) this.host.onMove?.()
    return moved
  }
}

const KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'shift'])
