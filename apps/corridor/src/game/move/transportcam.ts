// Flying the library: the keyboard, the camera, and the craft in between.
//
// `transport.ts` is the physics and has no idea a camera exists. This is the thin thing that reads
// the keys, steps the craft and puts the result on the camera — deliberately thin, because
// everything here is untestable without a browser and everything that decides how a helicopter
// behaves is not.
//
// THE CONTROLS ARE THE SAME KEYS IN EVERY CRAFT, which is the point of having a library rather
// than seven modes: W/S is throttle or walk, A/D is roll or strafe, the arrows are the stick,
// Q/E is rudder or turn, R/F is the collective on the things that have one, Shift is more.
import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CRAFT, NEUTRAL, cameraFor, startState, step, type CraftKind, type CraftState, type Controls } from './transport'

/** The keys, in one place, so a help overlay and the handler cannot disagree. */
export const BINDINGS: { keys: string; does: string }[] = [
  { keys: 'W / S', does: 'throttle — or walk forward and back' },
  { keys: 'A / D', does: 'roll — or step sideways' },
  { keys: '↑ / ↓', does: 'nose down and up' },
  { keys: '← / →', does: 'roll' },
  { keys: 'Q / E', does: 'rudder, pedals, or turn on the spot' },
  { keys: 'R / F', does: 'up and down — collective, or straight up in a UFO' },
  { keys: 'Shift', does: 'more: sprint, afterburner, full collective' },
  { keys: 'Space', does: 'brake, air brake, or crouch' },
]

export class TransportControls {
  kind: CraftKind = 'walk'
  state: CraftState
  enabled = false
  private keys = new Set<string>()
  private camera: THREE.PerspectiveCamera
  private orbit: OrbitControls
  private groundAt: (x: number, z: number) => number | null
  private smoothed = new THREE.Vector3()
  private looking = false
  private lastX = 0
  private lastY = 0
  /** how far the mouse has turned the chase camera off the craft's own heading */
  private orbitYaw = 0
  private orbitPitch = 0

  constructor(camera: THREE.PerspectiveCamera, orbit: OrbitControls, canvas: HTMLElement, groundAt: (x: number, z: number) => number | null) {
    this.camera = camera
    this.orbit = orbit
    this.groundAt = groundAt
    this.state = startState({ x: camera.position.x, y: camera.position.y, z: camera.position.z })
    addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
      this.keys.add(e.code)
    })
    addEventListener('keyup', (e) => this.keys.delete(e.code))
    addEventListener('blur', () => this.keys.clear())
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2 && this.enabled) { this.looking = true; this.lastX = e.clientX; this.lastY = e.clientY }
    })
    addEventListener('pointerup', () => { this.looking = false })
    addEventListener('pointermove', (e) => {
      if (!this.looking) return
      this.orbitYaw += (e.clientX - this.lastX) * 0.005
      this.orbitPitch = Math.max(-1.2, Math.min(1.2, this.orbitPitch - (e.clientY - this.lastY) * 0.005))
      this.lastX = e.clientX
      this.lastY = e.clientY
    })
  }

  /**
   * Put a craft here, facing this way.
   *
   * Takes the camera's current position rather than a spawn point, so switching transport keeps
   * you where you were looking — changing to a helicopter should not teleport you.
   */
  take(kind: CraftKind, at?: { x: number; y: number; z: number }, yaw?: number): void {
    const p = at ?? this.camera.position
    const heading = yaw ?? Math.atan2(this.camera.position.x - this.orbit.target.x, -(this.camera.position.z - this.orbit.target.z)) + Math.PI
    this.kind = kind
    // start clear of the ground, so a craft taken while the camera was underground does not
    // spend its first second climbing out
    const gy = this.groundAt(p.x, p.z)
    const floor = (gy ?? 0) + CRAFT[kind].clearance
    const y = Math.max(p.y, floor)
    // a wing taken well above the ground is flying, not falling: `startState` gives it approach
    // speed. On the ground it starts at rest, which is a take-off run.
    this.state = startState({ x: p.x, y, z: p.z }, heading, { airborne: y > floor + 5, kind })
    this.smoothed.set(0, 0, 0)
    this.orbitYaw = 0
    this.orbitPitch = 0
  }

  /** What the keys are asking for, in the craft's own terms. */
  controls(): Controls {
    const k = this.keys
    const n = (a: string, b: string) => Number(k.has(a)) - Number(k.has(b))
    const walking = this.kind === 'walk' || this.kind === 'walk-third'
    return {
      ...NEUTRAL,
      pitch: n('ArrowUp', 'ArrowDown'),
      // A/D is a roll in an aircraft and a sidestep on foot; `roll` carries both because to the
      // physics they are the same axis — the walker reads it as strafe and says so
      roll: n('ArrowRight', 'ArrowLeft') + n('KeyD', 'KeyA'),
      yaw: n('KeyE', 'KeyQ'),
      throttle: walking || this.kind === 'ufo' ? n('KeyW', 'KeyS') : Math.max(0, n('KeyW', 'KeyS')) || (k.has('KeyW') ? 1 : 0),
      lift: n('KeyR', 'KeyF'),
      boost: k.has('ShiftLeft') || k.has('ShiftRight'),
      brake: k.has('Space'),
    }
  }

  update(dt: number): void {
    if (!this.enabled) return
    const d = Math.min(0.1, dt)
    this.state = step(this.kind, this.state, this.controls(), d, { groundAt: this.groundAt })
    const view = cameraFor(this.kind, this.state)

    if (this.kind === 'walk') {
      this.camera.position.set(view.eye.x, view.eye.y, view.eye.z)
      this.orbit.target.set(view.look.x, view.look.y, view.look.z)
      this.orbit.update()
      return
    }

    // the chase camera LAGS, which is most of what makes speed legible: a camera welded to the
    // craft shows a still image of an aeroplane with the world sliding past, and the same camera
    // catching up shows an aeroplane pulling away from you.
    const want = new THREE.Vector3(view.eye.x, view.eye.y, view.eye.z)
    if (this.orbitYaw || this.orbitPitch) {
      // the mouse swings the chase camera round the craft without changing where it is going
      const c = new THREE.Vector3(this.state.at.x, this.state.at.y, this.state.at.z)
      want.sub(c).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw)
      want.y += this.orbitPitch * want.length() * 0.6
      want.add(c)
    }
    if (this.smoothed.lengthSq() === 0) this.smoothed.copy(want)
    else this.smoothed.lerp(want, 1 - Math.exp(-6 * d))
    // never behind the terrain
    const gy = this.groundAt(this.smoothed.x, this.smoothed.z)
    if (gy !== null && this.smoothed.y < gy + 2) this.smoothed.y = gy + 2
    this.camera.position.copy(this.smoothed)
    this.orbit.target.set(view.look.x, view.look.y, view.look.z)
    this.orbit.update()
  }

  /** What the HUD says about the craft, in the units the instrument would use. */
  readout(): { craft: string; speed: number; altitude: number; stalled: boolean; grounded: boolean } {
    const gy = this.groundAt(this.state.at.x, this.state.at.z) ?? 0
    return {
      craft: CRAFT[this.kind].name,
      speed: Math.hypot(this.state.vel.x, this.state.vel.y, this.state.vel.z),
      altitude: this.state.at.y - gy,
      stalled: this.state.stalled,
      grounded: this.state.grounded,
    }
  }
}
