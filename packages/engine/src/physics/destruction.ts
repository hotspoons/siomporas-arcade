// Things coming apart: what breaks, what throws it, and where the pieces go.
//
// Rich: "I do want to have things like bombs and missiles that can blow up traffic and send things
// flying. Need car wrecks and cars wrecking into buildings and trees and street signs and stop
// lights and all that and make it physically accurate."
//
// THREE PIECES, AND THE SEAM BETWEEN THEM IS THE POINT.
//
//   `Breakables`  a register of props that are fixed until something hits them hard enough. It
//                 owns the threshold and the moment of breaking, and it owns NO rendering.
//   `explode`     a radial impulse over whatever is in range, with line of sight, an upward bias
//                 and a torque. One function, no state.
//   `Debris`      a pool of loose bodies with a budget, because the alternative is a world that
//                 gets slower every time somebody hits a bin.
//
// WHY BREAKING IS A `setBodyType` AND NOT A NEW BODY. A stop sign standing in the verge is a fixed
// rigid body with a collider. When a car hits it, Rapier can flip that same body to dynamic in
// place: same handle, same collider, same pose, no gap where the sign is in two worlds or neither.
// Building a fresh dynamic body and destroying the old one does the same thing in three steps and
// loses every reference anybody held.
//
// THE PART THIS FILE DELIBERATELY DOES NOT DO: take the sign out of its `InstancedMesh`. Every
// piece of street furniture in the corridor is drawn as one instance among thousands, and a broken
// one has to be pulled out of that instance buffer and drawn as its own mesh. That is a renderer
// job with real rules about update ranges (see `three upload ranges`), so this file reports the
// break with whatever the caller attached to it — an instance index, an ECS entity, a catalog id —
// and the renderer decides. A physics module that reached into an instance buffer would be a
// physics module that only works in one game.

import type { Collider, RigidBody, Vector } from '@dimforge/rapier3d-compat'
import { QUERY } from './layers'
import { rapier } from './rapier'
import type { Impact, PhysicsWorld } from './world'

/* ================================================================================================
 * Breakables
 * ============================================================================================= */

export interface BreakableSpec {
  /**
   * N·s of impulse that breaks it.
   *
   * Some arithmetic to hang numbers off: a 1400 kg car losing 3 m/s in a hit delivers about
   * 4,200 N·s. A traffic sign on a slip base should go at a fraction of that; a mature trunk
   * should not go at all, which is what leaving it out of the register means.
   */
  threshold: number
  /** kg, once it is loose. A sign is light; a signal mast on a gantry is not */
  mass: number
  /**
   * How much of the impulse is passed on to the broken piece, 0…1.
   *
   * Under 1 because breaking costs energy — a post that shears off at its base does not leave with
   * everything the car brought. Over about 0.6 the piece outruns the car that hit it, which reads
   * as a bug even though nobody can say why.
   */
  transfer?: number
  /** whatever the caller needs to find its own record of this thing again */
  tag?: unknown
}

export interface BreakEvent {
  body: RigidBody
  collider: Collider
  /** the spec it was registered with, `tag` and all */
  spec: BreakableSpec
  /** N·s that did it */
  impulse: number
  /** where, world space */
  x: number
  y: number
  z: number
}

/**
 * The props that are fixed until they are not.
 *
 * Registration is by COLLIDER, not by body, because a compound prop — a signal mast with three
 * heads — is one body and several colliders, and which one got hit is the interesting question.
 */
export class Breakables {
  private specs = new Map<number, BreakableSpec>()
  private broken = new Set<number>()
  private listeners: ((e: BreakEvent) => void)[] = []
  private detach: () => void

  constructor(phys: PhysicsWorld) {
    this.detach = phys.onImpact((im) => this.onImpact(im))
  }

  /** Register a fixed collider as breakable. Returns it, so this reads as a decorator at a call site. */
  add(collider: Collider, spec: BreakableSpec): Collider {
    this.specs.set(collider.handle, spec)
    return collider
  }

  remove(collider: Collider) {
    this.specs.delete(collider.handle)
    this.broken.delete(collider.handle)
  }

  onBreak(fn: (e: BreakEvent) => void): () => void {
    this.listeners.push(fn)
    return () => {
      const i = this.listeners.indexOf(fn)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  /** How many are still standing. For a probe, and for "clear the street" goals. */
  get standing(): number {
    return this.specs.size - this.broken.size
  }

  private onImpact(im: Impact) {
    this.consider(im.a, im, 1)
    this.consider(im.b, im, -1)
  }

  private consider(c: Collider, im: Impact, sign: number) {
    const spec = this.specs.get(c.handle)
    if (!spec || this.broken.has(c.handle)) return
    if (im.impulse < spec.threshold) return
    // The normal points out of `a`; the thing being broken should be pushed the way the hit was
    // travelling, which is INTO it — so out of the other one.
    this.break(c, spec, im.impulse, im.x, im.y, im.z, -sign * im.nx, -sign * im.ny, -sign * im.nz)
  }

  /**
   * Break one, now, whatever it was hit with. Public because an explosion breaks things without
   * ever touching them, and so does a script.
   */
  break(c: Collider, spec: BreakableSpec, impulse: number, x: number, y: number, z: number, dx: number, dy: number, dz: number) {
    const R = rapier()
    if (this.broken.has(c.handle)) return
    const body = c.parent()
    if (!body) return
    this.broken.add(c.handle)
    body.setBodyType(R.RigidBodyType.Dynamic, true)
    // A fixed body has no mass properties worth the name — Rapier does not need them, so a prop's
    // collider is usually massless. It needs one the moment it is loose, or it either does not move
    // or moves like a feather in a hurricane.
    body.setAdditionalMass(spec.mass, true)
    const t = (spec.transfer ?? 0.35) * impulse
    body.applyImpulseAtPoint({ x: dx * t, y: dy * t, z: dz * t }, { x, y, z }, true)
    const e: BreakEvent = { body, collider: c, spec, impulse, x, y, z }
    for (const fn of this.listeners) fn(e)
  }

  /** Is this one already down? */
  isBroken(c: Collider): boolean {
    return this.broken.has(c.handle)
  }

  /**
   * Break one because something went off nearby rather than because something hit it.
   *
   * Here rather than in `explode` so the register keeps its own spec table private: an explosion
   * should not have to know how breakables are indexed to be able to flatten a row of signs.
   * Returns whether anything actually broke.
   */
  blast(c: Collider, impulse: number, x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean {
    const spec = this.specs.get(c.handle)
    if (!spec || this.broken.has(c.handle)) return false
    if (impulse < spec.threshold) return false
    this.break(c, spec, impulse, x, y, z, dx, dy, dz)
    return true
  }

  free() {
    this.detach()
    this.specs.clear()
    this.broken.clear()
    this.listeners.length = 0
  }
}

/* ================================================================================================
 * Explosions
 * ============================================================================================= */

export interface Blast {
  x: number
  y: number
  z: number
  /** metres; nothing past this feels anything */
  radius: number
  /**
   * N·s delivered to a 1 kg body at the centre.
   *
   * Scaled by mass at the point of application, so a pedestrian and a bus get the same *velocity*
   * change rather than the same impulse — which is wrong physics and right game feel. Pass
   * `massScaled: false` for the other one.
   */
  impulse: number
  /**
   * 0…1 of the impulse redirected UPWARD regardless of geometry.
   *
   * This is the single knob that decides whether an explosion reads. A pure radial impulse on a car
   * standing on the ground pushes it mostly sideways along the ground, and it slides. Cars are
   * supposed to LEAVE the ground, and every game that looks right about this cheats exactly here.
   */
  lift?: number
  /** rad/s of tumble given to whatever it throws, scaled by the same falloff */
  spin?: number
  /** true: a body shadowed by a wall feels nothing. Costs one ray per body */
  lineOfSight?: boolean
  /** impulse above which a breakable in range simply breaks, N·s. 0 = never */
  breakAt?: number
  massScaled?: boolean
}

const EPS = 1e-4

/**
 * Throw everything in range.
 *
 * Falloff is linear in distance rather than inverse-square. Inverse-square is what physics does and
 * it is useless here: it is infinite at the centre and negligible at half the radius, so a grenade
 * is either a teleport or nothing at all, and the radius stops meaning anything a designer can
 * place. Linear gives a blast an edge you can see, which is what a radius is for.
 *
 * Returns how many bodies it moved — a probe's way of asking whether the explosion found anything.
 */
export function explode(phys: PhysicsWorld, blast: Blast, breakables?: Breakables): number {
  const R = rapier()
  const world = phys.world
  const at = { x: blast.x, y: blast.y, z: blast.z }
  const noRot = { x: 0, y: 0, z: 0, w: 1 }
  const lift = blast.lift ?? 0.45
  const spin = blast.spin ?? 6

  /*
   * TWO PASSES, AND THIS IS NOT AN OPTIMISATION — IT IS THE ONLY THING THAT WORKS.
   *
   * Rapier's spatial queries hold a Rust borrow on the rigid-body set for as long as the callback
   * runs. Touching a body from inside one — `applyImpulse`, `setBodyType`, anything that writes —
   * throws `recursive use of an object detected which would lead to unsafe aliasing in rust` from
   * wasm, and that exception does NOT come out to the caller: the query swallows it, carries on to
   * the next collider, and returns normally. The first version of this function did exactly that,
   * and it reported "0 bodies moved" for an explosion sitting on top of three cars, with no error
   * anywhere and every ingredient testing fine in isolation.
   *
   * So the query only LOOKS. Everything that writes happens after it has returned.
   */
  const hitColliders: Collider[] = []
  const hitBodies: RigidBody[] = []
  const seen = new Set<number>()
  world.intersectionsWithShape(
    at,
    noRot,
    new R.Ball(blast.radius),
    (c: Collider) => {
      const body = c.parent()
      if (!body) return true
      hitColliders.push(c)
      if (!seen.has(body.handle)) {
        seen.add(body.handle)
        hitBodies.push(body)
      }
      return true
    },
    undefined,
    QUERY.blast,
  )

  // Line of sight is also a query, so it is done here — between the two passes, while nothing is
  // being written and nothing is borrowed.
  const lit = new Map<number, boolean>()
  if (blast.lineOfSight) {
    for (const body of hitBodies) {
      const p = body.translation()
      const dx = p.x - blast.x
      const dy = p.y - blast.y
      const dz = p.z - blast.z
      const d = Math.hypot(dx, dy, dz)
      if (d <= EPS) {
        lit.set(body.handle, true)
        continue
      }
      const hit = world.castRay(new R.Ray(at, { x: dx / d, y: dy / d, z: dz / d }), d, true, undefined, QUERY.solid)
      lit.set(body.handle, !hit || hit.collider.parent()?.handle === body.handle)
    }
  }

  // Pass two: write.
  if (breakables && blast.breakAt) {
    for (const c of hitColliders) {
      if (breakables.isBroken(c)) continue
      const body = c.parent()
      if (!body) continue
      const p = body.translation()
      let dx = p.x - blast.x
      let dy = p.y - blast.y
      let dz = p.z - blast.z
      const d = Math.hypot(dx, dy, dz)
      const falloff = Math.max(0, 1 - d / blast.radius)
      if (falloff <= 0) continue
      if (blast.lineOfSight && lit.get(body.handle) === false) continue
      const j = blast.impulse * falloff
      if (j < blast.breakAt) continue
      if (d > EPS) {
        dx /= d
        dy /= d
        dz /= d
      } else {
        dx = 0
        dy = 1
        dz = 0
      }
      breakables.blast(c, j, p.x, p.y, p.z, dx, dy, dz)
    }
  }

  let moved = 0
  for (const body of hitBodies) {
    if (!body.isDynamic()) continue
    if (blast.lineOfSight && lit.get(body.handle) === false) continue
    const p = body.translation()
    let dx = p.x - blast.x
    let dy = p.y - blast.y
    let dz = p.z - blast.z
    const d = Math.hypot(dx, dy, dz)
    const falloff = Math.max(0, 1 - d / blast.radius)
    if (falloff <= 0) continue
    if (d < EPS) {
      dx = 0
      dy = 1
      dz = 0
    } else {
      dx /= d
      dy /= d
      dz /= d
    }
    // the lift: swing the direction toward straight up, then renormalise, so the total impulse is
    // the same however much of it was redirected
    dy += lift
    const n = Math.hypot(dx, dy, dz) || 1
    dx /= n
    dy /= n
    dz /= n

    const mass = body.mass() || 1
    const j = blast.impulse * falloff * (blast.massScaled === false ? 1 : mass)
    body.applyImpulse({ x: dx * j, y: dy * j, z: dz * j }, true)
    if (spin > 0) {
      // A deterministic tumble from the body's own handle: the same explosion throws the same car
      // the same way twice, which is what makes a crash worth re-running in a probe.
      const h = Math.imul(body.handle | 0, 2654435761)
      const rx = (((h >>> 3) & 255) / 255 - 0.5) * 2
      const ry = (((h >>> 11) & 255) / 255 - 0.5) * 2
      const rz = (((h >>> 19) & 255) / 255 - 0.5) * 2
      const s = spin * falloff * mass
      body.applyTorqueImpulse({ x: rx * s, y: ry * s, z: rz * s }, true)
    }
    moved++
  }
  return moved
}

/* ================================================================================================
 * Debris
 * ============================================================================================= */

export interface DebrisOptions {
  /** how many loose pieces may exist at once. The oldest goes when the budget is spent */
  budget?: number
  /** a piece that has been asleep this long is taken back, seconds */
  lifetime?: number
}

/**
 * A budgeted pool of loose bodies.
 *
 * THE BUDGET IS THE WHOLE CLASS. Wreckage is the one thing in a game that accumulates without any
 * decision being made: every crash adds pieces, nothing ever removes them, and an hour into a
 * session the physics step is the frame. A cap with an oldest-out rule means the worst case is
 * known before anybody plays, and "how many pieces can we afford" becomes a number somebody can
 * change rather than a thing discovered in a bug report.
 *
 * It does not draw anything either. `spawn` hands back the body; what it looks like is the
 * renderer's, and `onRetire` is how the renderer learns a piece is gone.
 */
export class Debris {
  private live: { body: RigidBody; born: number; still: number }[] = []
  private retirees: ((body: RigidBody) => void)[] = []
  private budget: number
  private lifetime: number
  private phys: PhysicsWorld
  private detach: () => void
  private clock = 0

  constructor(phys: PhysicsWorld, opts: DebrisOptions = {}) {
    this.phys = phys
    this.budget = opts.budget ?? 120
    this.lifetime = opts.lifetime ?? 20
    this.detach = phys.onPreStep((dt) => this.tick(dt))
  }

  get count(): number {
    return this.live.length
  }

  onRetire(fn: (body: RigidBody) => void): () => void {
    this.retirees.push(fn)
    return () => {
      const i = this.retirees.indexOf(fn)
      if (i >= 0) this.retirees.splice(i, 1)
    }
  }

  /**
   * One loose piece: a box of the given half-extents at the given place, with a shove.
   *
   * A box and not the real shape, because debris is seen for two seconds while tumbling and a
   * convex hull of the actual panel costs a decomposition nobody will look at.
   */
  spawn(at: Vector, half: Vector, mass: number, impulse?: Vector, spin?: Vector): RigidBody {
    const R = rapier()
    if (this.live.length >= this.budget) this.retire(0)
    const body = this.phys.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
        // Debris sleeps as soon as it is still, and that is what makes a hundred pieces affordable:
        // an island of sleeping bodies costs the broad phase and nothing else.
        .setLinearDamping(0.1)
        .setAngularDamping(0.25),
    )
    const desc = R.ColliderDesc.cuboid(half.x, half.y, half.z).setMass(mass).setRestitution(0.2).setFriction(0.8)
    // no contact events: a hundred pieces of a bonnet reporting every tap is the event queue's
    // whole budget, and nothing is listening for "a hubcap touched the kerb"
    this.phys.describe(desc, 'debris', { events: false })
    this.phys.world.createCollider(desc, body)
    if (impulse) body.applyImpulse(impulse, true)
    if (spin) body.applyTorqueImpulse(spin, true)
    this.live.push({ body, born: this.clock, still: 0 })
    return body
  }

  private tick(dt: number) {
    this.clock += dt
    for (let i = this.live.length - 1; i >= 0; i--) {
      const d = this.live[i]
      if (d.body.isSleeping()) d.still += dt
      else d.still = 0
      if (d.still > this.lifetime) this.retire(i)
    }
  }

  private retire(i: number) {
    const d = this.live[i]
    this.live.splice(i, 1)
    for (const fn of this.retirees) fn(d.body)
    this.phys.world.removeRigidBody(d.body)
  }

  /** Everything, gone — a level change, or a script clearing the street. */
  clear() {
    while (this.live.length) this.retire(0)
  }

  free() {
    this.detach()
    this.clear()
    this.retirees.length = 0
  }
}
