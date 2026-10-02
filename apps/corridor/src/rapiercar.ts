// The same car, driven by Rapier instead of by the hand-written model.
//
// docs/corridor/PLAN-PHYSICS.md §2.2. `PHYS_CAR` picks which of the two the viewer is driving, and
// BOTH STAY — at least until the Stunts profile has been driven back to back with the model it was
// ported from, because that comparison is the only real test of the port and no screenshot can make
// it.
//
// THE POINT OF THIS FILE IS THAT NOTHING ELSE CHANGES. The chase camera, the cockpit, the HUD line,
// the minimap, the headlight beams and `enginesound.syncFromCar` all talk to `DrivableCar`, and
// they cannot tell which model is underneath. That is why this wraps the existing `Car` rather than
// building a second body: the mesh, the glasshouse, the lamps, the beams, the dashboard and the
// wheels are forty lines of geometry apiece and there should be one of each, not two that drift.
//
// SO THERE IS A `Car` IN HERE THAT IS NEVER TICKED. Its `tick` is never called and its kinematic
// state is never read — it is the BODY, and this file poses it every frame from the rigid body's
// own transform. That is a slightly odd object to hold and it is much the cheapest correct answer:
// the alternative is extracting six hundred lines of mesh building into a third file, which would
// also break `probes/corridor-carpose.mjs`, which reads two specific lines out of `car.ts` by name.
//
// THE QUATERNION IS USED WHOLE. `Car.updateMesh` builds its orientation from yaw, then a pitch about
// local Z and a roll about local X — an Euler chain that cannot express a car on its roof, which is
// fine for a model that can never be on its roof. A Rapier body can, so this writes
// `mesh.quaternion` straight from the body and calls `poseParts` for the wheels and the steering
// wheel, which are all that is left to turn.

import * as THREE from 'three'
import type { Vehicle } from '@apex/engine/physics/vehicle'
import type { DriveProfile } from '@apex/engine/physics/profiles'
import { Car, type CarEvent, type CarInput, type DrivableCar, type Surface } from './car'
import * as T from './tuning'

const q = { x: 0, y: 0, z: 0, w: 1 }
const v3 = { x: 0, y: 0, z: 0 }
const drop = new THREE.Vector3()

export class RapierCar implements DrivableCar {
  readonly pos = new THREE.Vector3()
  readonly forward = new THREE.Vector3(1, 0, 0)
  readonly right = new THREE.Vector3(0, 0, 1)
  yaw = 0
  speed = 0
  onGrass = false
  event: CarEvent = 'none'
  readonly mesh: THREE.Group

  private readonly body: Car
  private readonly vehicle: Vehicle
  private readonly surface: Surface
  /** what `place` should put the car back on, for `recover` */
  private lastInput: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false }

  constructor(vehicle: Vehicle, surface: Surface, model?: THREE.Object3D | null) {
    this.vehicle = vehicle
    this.surface = surface
    // The body. Given the same surface so nothing in it is holding a null, but never ticked — see
    // the header. `place` on it is called once, to put the mesh somewhere before the first frame.
    this.body = new Car(surface)
    this.mesh = this.body.mesh
    // A level's chosen car, when the library could produce one. Without it this is the procedural
    // wedge, which is what every level written before today gets and is a perfectly good car.
    if (model) this.body.setBodyMesh(model)
    this.sync()
  }

  get slide(): number {
    return this.vehicle.state.slide
  }

  /**
   * Change how it handles, now, without respawning it.
   *
   * `Vehicle.applyProfile` is built for exactly this — the only state that does not survive is the
   * suspension's current compression, which resettles within a step. Rich, 2026-09-29: *"changing
   * the car's performance stats from the tuner does not seem to alter the performance"*. It did not:
   * the profile was read once, when the car was spawned, so every later change was a change to what
   * the NEXT car would be like.
   */
  setProfile(p: DriveProfile): void {
    this.vehicle.applyProfile(p)
  }

  /**
   * Hold the car onto a surface that is not the ground — the inside of a loop, a banked corkscrew.
   *
   * `up` is in THREE's frame. The engine does the turning and the pulling (`Vehicle.stick`); what
   * corridor knows, and the engine cannot, is WHICH surface you are on, which is why this is a
   * pass-through rather than something the vehicle works out for itself.
   */
  hold(up: { x: number; y: number; z: number }, dt: number, opts: { strength?: number; align?: number; pull?: number } = {}): void {
    this.vehicle.stick(up, dt, opts)
  }

  /** The body's own up, for deciding whether an assist has anything to do. */
  get up(): { x: number; y: number; z: number } {
    const v = new THREE.Vector3(0, 1, 0).applyQuaternion(this.mesh.quaternion)
    return { x: v.x, y: v.y, z: v.z }
  }

  /** What it is driving as, so a picker can show the truth rather than what it last set. */
  /** the chassis collider's handle, so an impact listener can tell the player's hits from the rest */
  get colliderHandle(): number {
    return this.vehicle.collider.handle
  }

  get profile(): DriveProfile {
    return this.vehicle.profile
  }

  /** The vehicle underneath, for the F6 panel and for a probe that wants the real state. */
  get state() {
    return this.vehicle.state
  }

  place(x: number, z: number, yaw: number) {
    const g = this.surface.heightAt(x, z) ?? 0
    // Above the ground rather than on it: the suspension settles in a step or two, and a car placed
    // exactly at ground level starts with its springs already compressed through the road.
    this.vehicle.place(x, g + T.CAR_RIDE + 0.4, z, yaw)
    this.event = 'none'
    this.sync()
  }

  /**
   * Back it out of whatever it is in, keeping the heading — stuntin's rule, and the same one the
   * kinematic car follows, because it is what Rich asked for and it should not depend on which
   * model is running.
   */
  recover(back: number) {
    const yaw = this.yaw
    const step = (d: number) => this.place(this.pos.x - this.forward.x * d, this.pos.z - this.forward.z * d, yaw)
    step(back)
    for (let i = 0; i < 6 && this.surface.treesNear(this.pos.x, this.pos.z, 2.5).length; i++) step(back * 0.6)
  }

  /**
   * One frame.
   *
   * It does NOT step the physics world — `physics.ts` owns that, and a car that stepped the world
   * would step it once per car. All this does is hand the controls over and read the result back,
   * which is why it is safe to call at whatever rate the renderer runs at.
   */
  tick(_dt: number, input: CarInput) {
    this.lastInput = input
    this.vehicle.control(input)
    this.sync()
  }

  /** Read the rigid body back into the shape the viewer expects, and pose the mesh. */
  private sync() {
    const b = this.vehicle.body
    const t = b.translation(v3)
    const r = b.rotation(q)
    this.pos.set(t.x, t.y, t.z)
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w)
    /*
     * THE MESH ORIGIN IS THE GROUND BETWEEN THE WHEELS; THE BODY ORIGIN IS THE CENTRE OF ITS BOX.
     *
     * `car.ts` builds its model with the wheel contact plane at local y = 0 — which is why its own
     * `updateMesh` subtracts `CAR_RIDE` — and a Rapier chassis' origin is the middle of the collider,
     * about 0.94 m higher on the default spec. Drawing the mesh at the body's translation therefore
     * floats the entire car a wheel-and-a-half off the road, which is precisely what it did.
     *
     * Dropped along the BODY's own down axis rather than world down, so a car on a camber, on its
     * side, or mid-roll still has its wheels where its wheels are.
     */
    drop.set(0, -this.vehicle.contactDrop, 0).applyQuaternion(this.mesh.quaternion)
    this.mesh.position.set(t.x + drop.x, t.y + drop.y, t.z + drop.z)

    // the body's own axes, from the quaternion rather than from a yaw we are keeping in parallel
    this.forward.set(1, 0, 0).applyQuaternion(this.mesh.quaternion)
    this.right.set(0, 0, 1).applyQuaternion(this.mesh.quaternion)
    // `yaw` in this app's convention is the heading of (cos yaw, 0, sin yaw), so it comes off the
    // forward vector FLATTENED — a car mid-barrel-roll still has a heading, and atan2 of the raw
    // forward would swing it wildly as the nose goes over.
    this.yaw = Math.atan2(this.forward.z, this.forward.x)

    const st = this.vehicle.state
    this.speed = st.speed
    this.event = st.event
    this.body.poseParts(this.lastInput.steer * 0.45, st.wheelSpin)
    // What the wheels are standing on, for the HUD's "grass" — the same question the surface hook
    // asks the tyres, asked once more for the readout. Cheap, and it keeps the word on screen and
    // the grip under the car from being two different opinions.
    this.onGrass = this.surface.edgeDistance(this.pos.x, this.pos.z) > T.CAR_GRASS_EDGE
  }

  setLights(on: number) {
    this.body.setLights(on)
  }

  setCockpit(on: boolean) {
    this.body.setCockpit(on)
  }

  lamps() {
    return this.body.lamps()
  }

  streaks() {
    return this.body.streaks()
  }

  /** Let it go. The vehicle's bodies belong to the physics world and have to be handed back. */
  free() {
    this.vehicle.free()
  }
}
