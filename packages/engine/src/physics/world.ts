// The physics world: one Rapier world, a fixed step, and the impacts that come out of it.
//
// FRAME. Physics runs in the THREE world frame — x east, y UP, z south — because that is the frame
// the meshes are already in, and a body whose pose has to be converted on the way to a matrix is a
// body that will one day be converted twice. The corridor's simulation frame (x east, y north, z
// up) stays where it is, converted once at the ECS edge exactly as it is today; nothing in this
// directory knows that frame exists.
//
// THE STEP IS FIXED, and for the same reason `ActorWorld` fixes its own: a simulation whose
// behaviour depends on the frame rate behaves differently on a GPU machine and in a swiftshader
// probe, and a vehicle is where that shows up first — suspension is a spring, and a spring
// integrated at a wandering dt changes its damping ratio as the frame rate moves. 120 Hz by
// default, matching what the hand-written car already ran at.
//
// A STALL IS NOT PAID BACK. The accumulator is capped at `maxSteps` and the remainder is DROPPED,
// not banked. Banking it means a tab that was in the background for a minute resolves a minute of
// physics in one frame, which in practice means every car in the world teleports through a
// building. Slow motion after a hitch is a bug you can see and shrug at; tunnelling is not.
//
// TWO RAPIER TRAPS THAT BIT THIS FILE INTO ITS SHAPE, both of which fail SILENTLY:
//
//   1. **A collider is invisible to queries until the world has stepped.** Spatial queries run
//      against the broad phase, and the broad phase is only brought up to date inside `world.step`.
//      Create a collider, ray-cast at it, get nothing, no error. Anything that builds colliders and
//      then asks about them — a terrain tile, a street full of signs, a bomb thrown on the frame a
//      level loaded — has to step first.
//   2. **Nothing may be written from inside a query callback.** Rapier holds a Rust borrow on the
//      body set for the duration; an `applyImpulse` or a `setBodyType` in there throws inside wasm,
//      and the query swallows the exception and carries on. `explode` in `destruction.ts` is
//      written as two passes for this reason, and the comment there has the measurement.
//
// WHAT COMES OUT. Rapier reports contact FORCE events, which are a magnitude and a direction and
// no position. Damage, dents, debris and the noise a crash makes all want the position and the
// IMPULSE, so `step` goes one level down: for every pair that fired an event it walks the contact
// manifolds and reports the point that took the biggest impulse. That is the single most useful
// thing this class does and it is why `Impact` is the type the rest of the directory is written
// against rather than Rapier's own events.

import type { Collider, EventQueue, RigidBody, World } from '@dimforge/rapier3d-compat'
import { groups, type Layer } from './layers'
import { rapier } from './rapier'

/** A contact worth telling somebody about: where, how hard, and between what. */
export interface Impact {
  /** the two colliders, in no particular order */
  a: Collider
  b: Collider
  /** world-space point of the contact that took the largest impulse */
  x: number
  y: number
  z: number
  /** the manifold normal, pointing out of `a` */
  nx: number
  ny: number
  nz: number
  /** N·s summed over every contact in the pair this step. The number damage is scaled from */
  impulse: number
  /** the largest single contact impulse, N·s — what a dent is sized from */
  peak: number
}

export interface PhysicsOptions {
  /** m/s², a magnitude; applied along -Y */
  gravity?: number
  /** fixed steps per second */
  hz?: number
  /** most steps one call to `step` may run before the rest of the backlog is dropped */
  maxSteps?: number
  /**
   * ms of a frame the steps may take before the rest of the backlog is dropped. Absent: no
   * budget, only `maxSteps`. With one, `maxSteps` can be generous: a slow RENDER costs no world
   * time (the steps are cheap and all run), and a slow SOLVE degrades to slow motion instead of a
   * spiral where more steps make a slower frame make more steps.
   */
  budgetMs?: number
  /** Rapier's constraint solver iterations. 4 is its default; a vehicle likes more */
  solverIterations?: number
  /**
   * Newtons. A contact pair whose summed force stays under this never fires an event.
   *
   * It is not cosmetic: a car sitting on its wheels is a permanent contact with a permanent force,
   * and a threshold of zero reports every one of them, every step, for ever. Default is a few
   * times a small car's weight, so resting is quiet and hitting something is not.
   */
  impactThreshold?: number
}

/** Poses kept for render interpolation: previous step, current step, per tracked body. */
interface Tracked {
  body: RigidBody
  prev: Float32Array
  cur: Float32Array
}

// Scratch, reused by every read that takes a target. `V` and `N` are both vectors and both
// live at once inside the manifold walk (a contact point and a normal), which is why there are two.
const V = { x: 0, y: 0, z: 0 }
const N = { x: 0, y: 0, z: 0 }
const Q = { x: 0, y: 0, z: 0, w: 1 }

export class PhysicsWorld {
  readonly world: World
  readonly hz: number
  readonly dt: number
  private readonly maxSteps: number
  private readonly budgetMs: number
  private readonly events: EventQueue
  private readonly threshold: number
  private carry = 0
  private tracked = new Map<number, Tracked>()
  private listeners: ((i: Impact) => void)[] = []
  private touches: ((a: Collider, b: Collider, started: boolean) => void)[] = []
  private pre: ((dt: number) => void)[] = []
  /** reused across every impact in a step: nothing in the drain loop allocates */
  private readonly impact: Impact = { a: null!, b: null!, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, impulse: 0, peak: 0 }

  /** what a probe and the HUD read */
  readonly stats = { steps: 0, bodies: 0, colliders: 0, impacts: 0, stepMs: 0, dropped: 0 }

  constructor(opts: PhysicsOptions = {}) {
    const R = rapier()
    this.hz = opts.hz ?? 120
    this.dt = 1 / this.hz
    this.maxSteps = opts.maxSteps ?? 4
    this.budgetMs = opts.budgetMs ?? Infinity
    this.threshold = opts.impactThreshold ?? 30_000
    this.world = new R.World({ x: 0, y: -(opts.gravity ?? 9.81), z: 0 })
    this.world.timestep = this.dt
    this.world.numSolverIterations = opts.solverIterations ?? 8
    // `true` = the queue clears itself at the start of every step, so an un-drained frame cannot
    // grow without bound. We drain every step anyway; this is the belt to that braces.
    this.events = new R.EventQueue(true)
  }

  /** The fraction of a step the renderer is past the last one, 0…1. Feed it to `pose`. */
  get alpha(): number {
    return this.carry / this.dt
  }

  /**
   * Advance by a real-time delta; returns how many fixed steps ran.
   *
   * Impacts are delivered to listeners DURING this call, once per step, while the manifolds are
   * still valid — Rapier's manifold and event wrappers are views into wasm memory that the next
   * step invalidates, so nothing here may be stored. The `Impact` handed to a listener is reused;
   * a listener that wants to keep one copies it.
   */
  step(realSeconds: number): number {
    const t0 = performance.now()
    this.carry += Math.max(0, realSeconds)
    let n = 0
    // at least one step whenever one is owed, then as many as the count and the budget allow
    while (this.carry >= this.dt && n < this.maxSteps && (n === 0 || performance.now() - t0 < this.budgetMs)) {
      this.carry -= this.dt
      n++
      for (const t of this.tracked.values()) t.prev.set(t.cur)
      for (const fn of this.pre) fn(this.dt)
      this.world.step(this.events)
      this.readPoses()
      if (this.touches.length) {
        this.events.drainCollisionEvents((h1, h2, started) => {
          const a = this.world.colliders.get(h1)
          const b = this.world.colliders.get(h2)
          if (!a || !b) return
          for (const fn of this.touches) fn(a, b, started)
        })
      }
      if (this.listeners.length) this.drainImpacts()
    }
    // whatever is still owed past one step is DROPPED, never paid back: a debt that carried
    // would be paid as a burst of steps next frame, which is the spiral again
    if (this.carry >= this.dt) {
      this.stats.dropped += Math.floor(this.carry / this.dt)
      this.carry = this.carry % this.dt
    }
    this.stats.steps += n
    this.stats.bodies = this.world.bodies.len()
    this.stats.colliders = this.world.colliders.len()
    this.stats.stepMs = performance.now() - t0
    return n
  }

  /* ---- the hook everything that drives a body needs -------------------------------------- */

  /**
   * Run something once per FIXED step, just before Rapier integrates it.
   *
   * This is where a vehicle sets its wheel forces, a thruster pushes, a character controller moves.
   * It has to be the fixed step and not the frame: a force applied once per frame and integrated
   * two or four times is a car whose acceleration depends on the frame rate, which is precisely
   * what fixing the step was for. Returns the function that unsubscribes.
   */
  onPreStep(fn: (dt: number) => void): () => void {
    this.pre.push(fn)
    return () => {
      const i = this.pre.indexOf(fn)
      if (i >= 0) this.pre.splice(i, 1)
    }
  }

  /* ---- impacts ------------------------------------------------------------------------- */

  /** Listen for contacts above the threshold. Returns the function that stops listening. */
  /**
   * Every collision START and END the world reports — the one kind of event a SENSOR produces.
   * A sensor is how a light breakable (a sign, a post) is made to give way instead of stopping a
   * car: it is not solid, so there is no contact impulse, only the fact of the touch.
   */
  onTouch(fn: (a: Collider, b: Collider, started: boolean) => void): () => void {
    this.touches.push(fn)
    return () => {
      const i = this.touches.indexOf(fn)
      if (i >= 0) this.touches.splice(i, 1)
    }
  }

  onImpact(fn: (i: Impact) => void): () => void {
    this.listeners.push(fn)
    return () => {
      const i = this.listeners.indexOf(fn)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  private drainImpacts() {
    const im = this.impact
    this.events.drainContactForceEvents((ev) => {
      const a = this.world.colliders.get(ev.collider1())
      const b = this.world.colliders.get(ev.collider2())
      if (!a || !b) return
      im.a = a
      im.b = b
      im.impulse = 0
      im.peak = 0
      im.x = im.y = im.z = 0
      im.nx = im.ny = im.nz = 0
      // The event says how hard; the manifold says where. Walk every manifold of the pair, sum the
      // impulses, and keep the point that took the biggest one — that is where the dent goes and
      // where the sparks come off.
      //
      // `flipped` says the manifold's normal points out of collider2 rather than collider1, so it
      // is negated: an `Impact` always reports the normal pointing out of `a`, whichever order
      // Rapier happened to store the pair in. Getting this wrong dents the car from the inside.
      this.world.contactPair(a, b, (m, flipped) => {
        const s = flipped ? -1 : 1
        const contacts = m.numSolverContacts()
        for (let i = 0; i < contacts; i++) {
          const imp = m.contactImpulse(i)
          im.impulse += imp
          if (imp <= im.peak) continue
          const p = m.solverContactPoint(i, V)
          if (!p) continue
          im.peak = imp
          im.x = p.x
          im.y = p.y
          im.z = p.z
          const n = m.normal(N)
          im.nx = n.x * s
          im.ny = n.y * s
          im.nz = n.z * s
        }
      })
      // A pair can fire a force event and still have no solver contacts by the time we look (the
      // solver pushed them apart within the step). Reporting a zero-impulse impact at the origin
      // would put a dent in the middle of the world, so it is dropped instead.
      if (im.peak <= 0) return
      this.stats.impacts++
      for (const fn of this.listeners) fn(im)
    })
  }

  /* ---- bodies and colliders ------------------------------------------------------------- */

  /**
   * The collider settings every caller in this repo wants: a layer, and the events that make
   * impacts appear.
   *
   * Call it on a `ColliderDesc` before `createCollider`. It is a function rather than a default
   * because Rapier's descs are builders and a silent default would be one more thing that is true
   * in the engine and not in a game that built its desc by hand.
   */
  describe<T extends { setCollisionGroups: (g: number) => T; setSolverGroups: (g: number) => T; setActiveEvents: (e: number) => T; setContactForceEventThreshold: (t: number) => T }>(desc: T, layer: Layer, opts: { events?: boolean } = {}): T {
    const R = rapier()
    const g = groups(layer)
    desc.setCollisionGroups(g).setSolverGroups(g)
    if (opts.events !== false) desc.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(this.threshold)
    return desc
  }

  /* ---- render interpolation -------------------------------------------------------------- */

  /**
   * Follow a body's pose across steps so the renderer can interpolate.
   *
   * WHY IT IS OPT-IN. At 120 Hz and 60 fps the renderer sees every other step, and a body drawn at
   * its raw step pose judders by exactly one step of motion — 0.25 m at 30 m/s, which is visible on
   * the player's car and invisible on a bin bag. Tracking costs two poses and a copy per step, so
   * the car and the things being looked at get it and a thousand pieces of debris do not.
   */
  track(body: RigidBody) {
    if (this.tracked.has(body.handle)) return
    const cur = new Float32Array(7)
    this.readPose(body, cur)
    this.tracked.set(body.handle, { body, prev: cur.slice(), cur })
  }

  untrack(body: RigidBody) {
    this.tracked.delete(body.handle)
  }

  private readPose(body: RigidBody, into: Float32Array) {
    const t = body.translation(V)
    const r = body.rotation(Q)
    into[0] = t.x
    into[1] = t.y
    into[2] = t.z
    into[3] = r.x
    into[4] = r.y
    into[5] = r.z
    into[6] = r.w
  }

  private readPoses() {
    for (const t of this.tracked.values()) this.readPose(t.body, t.cur)
  }

  /**
   * A tracked body's pose, interpolated to `alpha`.
   *
   * Returns false for a body nothing is tracking rather than inventing a pose, so "the car does not
   * move" has one obvious cause instead of two.
   */
  pose(body: RigidBody, out: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }): boolean {
    const t = this.tracked.get(body.handle)
    if (!t) return false
    const a = this.alpha
    const p = t.prev
    const c = t.cur
    out.x = p[0] + (c[0] - p[0]) * a
    out.y = p[1] + (c[1] - p[1]) * a
    out.z = p[2] + (c[2] - p[2]) * a
    // nlerp, shortest arc. A slerp would be more correct and neither the eye nor a 1/120 s arc can
    // tell; what the eye CAN tell is a quaternion that took the long way round, hence the dot flip.
    let d = p[3] * c[3] + p[4] * c[4] + p[5] * c[5] + p[6] * c[6]
    const s = d < 0 ? -1 : 1
    let qx = p[3] + (c[3] * s - p[3]) * a
    let qy = p[4] + (c[4] * s - p[4]) * a
    let qz = p[5] + (c[5] * s - p[5]) * a
    let qw = p[6] + (c[6] * s - p[6]) * a
    const len = Math.hypot(qx, qy, qz, qw) || 1
    out.qx = qx / len
    out.qy = qy / len
    out.qz = qz / len
    out.qw = qw / len
    return true
  }

  /** Everything, gone. A level change is a new world, not one with the old world's ghosts. */
  free() {
    this.tracked.clear()
    this.listeners.length = 0
    this.pre.length = 0
    this.events.free()
    this.world.free()
  }
}
