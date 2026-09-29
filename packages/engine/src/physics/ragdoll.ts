// A rigged character, handed over to physics.
//
// Rich: "Will also have rigged characters we'll want to add physics to as well and maybe some rag
// doll stuff."
//
// THE SHAPE OF THE PROBLEM. A character is animated: a skeleton, a clip, bones driven by keyframes.
// A ragdoll is the opposite: bodies driven by gravity and contacts, bones driven by the bodies. The
// interesting part is not either state — it is the HANDOVER, and getting it wrong is what produces
// the two classic failures. Too early, and a walking pedestrian collapses because a wing mirror
// brushed them. Too late, and a body that has already been thrown twenty metres by a car snaps back
// to a standing pose for one frame before it falls.
//
// So this file is built around `Ragdoll.from(...)` taking a POSE, not a model: the bones' current
// world transforms at the instant of the handover. Whatever animated them up to that frame — a clip,
// an IK solver, a hand-authored idle — is none of its business, and the limbs start exactly where
// the character was seen to be.
//
// LIMBS ARE CAPSULES AND JOINTS ARE SPHERICAL. A capsule is the right shape for a limb (rounded
// ends slide off kerbs instead of catching on them) and the cheapest convex shape there is.
// Spherical joints have no limits, which means a ragdoll here can fold a knee the wrong way — and
// that is a deliberate first cut: Rapier's limited joints are per-axis generic joints, which need a
// rest frame per joint, which needs the rig to be in a known bind pose. That is a real piece of work
// and it belongs after somebody has looked at a ragdoll falling over. The comment stays here so the
// next person knows it is a decision and not an oversight.
//
// WHAT IT DOES NOT DO: drive the animation back. `sync()` writes world poses; turning those into
// bone rotations against a skeleton's parent chain is the renderer's job and depends on the rig.
// `RAGDOLL_HUMANOID` names the parts so that mapping can be written once per rig.

import type { ImpulseJoint, RigidBody } from '@dimforge/rapier3d-compat'
import { rapier } from './rapier'
import type { PhysicsWorld } from './world'

/** One limb: a capsule between two points, with a mass. */
export interface LimbSpec {
  name: string
  /** the limb hangs between these two world points at the moment of the handover */
  from: { x: number; y: number; z: number }
  to: { x: number; y: number; z: number }
  radius: number
  mass: number
  /** the limb it hangs off, by name. Absent = the root */
  parent?: string
}

export interface Limb {
  name: string
  body: RigidBody
  /** metres, tip to tip: the capsule's own length, so a renderer can scale a bone to it */
  length: number
  radius: number
  joint?: ImpulseJoint
}

/**
 * A humanoid, in the order the joints have to be made: a limb's parent must exist first.
 *
 * Proportions as fractions of total height, from the usual eight-head figure. They are here so a
 * ragdoll can be built from a height alone when a rig is not to hand — a placeholder pedestrian, a
 * test, a thing thrown by an explosion in a probe.
 */
export const RAGDOLL_HUMANOID: { name: string; parent?: string; y0: number; y1: number; r: number; m: number }[] = [
  { name: 'pelvis', y0: 0.50, y1: 0.62, r: 0.11, m: 12 },
  { name: 'chest', parent: 'pelvis', y0: 0.62, y1: 0.82, r: 0.12, m: 22 },
  { name: 'head', parent: 'chest', y0: 0.86, y1: 1.00, r: 0.10, m: 5 },
  { name: 'upperArmL', parent: 'chest', y0: 0.80, y1: 0.63, r: 0.05, m: 2.5 },
  { name: 'lowerArmL', parent: 'upperArmL', y0: 0.63, y1: 0.48, r: 0.04, m: 2 },
  { name: 'upperArmR', parent: 'chest', y0: 0.80, y1: 0.63, r: 0.05, m: 2.5 },
  { name: 'lowerArmR', parent: 'upperArmR', y0: 0.63, y1: 0.48, r: 0.04, m: 2 },
  { name: 'upperLegL', parent: 'pelvis', y0: 0.50, y1: 0.28, r: 0.07, m: 8 },
  { name: 'lowerLegL', parent: 'upperLegL', y0: 0.28, y1: 0.05, r: 0.05, m: 4 },
  { name: 'upperLegR', parent: 'pelvis', y0: 0.50, y1: 0.28, r: 0.07, m: 8 },
  { name: 'lowerLegR', parent: 'upperLegR', y0: 0.28, y1: 0.05, r: 0.05, m: 4 },
]

/** What `RAGDOLL_HUMANOID`'s masses add up to: an ordinary 72 kg person. The scale for `mass`. */
export const HUMANOID_MASS = RAGDOLL_HUMANOID.reduce((a, b) => a + b.m, 0)

/** Sideways offsets for the humanoid's paired limbs, as fractions of height. */
const SIDE: Record<string, number> = {
  upperArmL: -0.10, lowerArmL: -0.11, upperLegL: -0.055, lowerLegL: -0.055,
  upperArmR: 0.10, lowerArmR: 0.11, upperLegR: 0.055, lowerLegR: 0.055,
}

export class Ragdoll {
  readonly limbs: Limb[] = []
  private byName = new Map<string, Limb>()
  private phys: PhysicsWorld

  private constructor(phys: PhysicsWorld) {
    this.phys = phys
  }

  /**
   * Build one from a list of limbs in their current world positions.
   *
   * Order matters: a limb whose `parent` has not been built yet gets no joint and floats free, which
   * is a thing you notice as an arm that stays where the person was. The builder throws instead.
   */
  static from(phys: PhysicsWorld, specs: LimbSpec[], opts: { linvel?: { x: number; y: number; z: number } } = {}): Ragdoll {
    const R = rapier()
    const rd = new Ragdoll(phys)
    for (const s of specs) {
      const dx = s.to.x - s.from.x
      const dy = s.to.y - s.from.y
      const dz = s.to.z - s.from.z
      const len = Math.hypot(dx, dy, dz)
      const half = Math.max(0.01, len / 2 - s.radius)
      const cx = (s.from.x + s.to.x) / 2
      const cy = (s.from.y + s.to.y) / 2
      const cz = (s.from.z + s.to.z) / 2
      // A capsule's own axis is +Y; rotate it onto the limb. The shortest arc from (0,1,0) to the
      // limb direction — the branch is the 180° case, where the cross product is zero and any
      // perpendicular axis will do.
      const ux = dx / (len || 1)
      const uy = dy / (len || 1)
      const uz = dz / (len || 1)
      let qx = -uz, qy = 0, qz = ux, qw = 1 + uy
      if (qw < 1e-6) {
        qx = 1
        qy = 0
        qz = 0
        qw = 0
      }
      const ql = Math.hypot(qx, qy, qz, qw) || 1

      const body = phys.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(cx, cy, cz)
          .setRotation({ x: qx / ql, y: qy / ql, z: qz / ql, w: qw / ql })
          // A limb that never sleeps is a body that twitches on the ground for ever; these settle
          // hard and stay settled.
          .setLinearDamping(0.2)
          .setAngularDamping(0.6),
      )
      if (opts.linvel) body.setLinvel(opts.linvel, true)
      const desc = R.ColliderDesc.capsule(half, s.radius).setMass(s.mass).setFriction(0.7).setRestitution(0.05)
      phys.describe(desc, 'limb')
      phys.world.createCollider(desc, body)

      const limb: Limb = { name: s.name, body, length: len, radius: s.radius }
      if (s.parent) {
        const parent = rd.byName.get(s.parent)
        if (!parent) throw new Error(`ragdoll: "${s.name}" hangs off "${s.parent}", which has not been built yet`)
        // The joint is at `from`, expressed in each body's own local frame. Anchors in world space
        // is the single most common way to build a ragdoll that explodes on its first step.
        const a1 = localOf(parent.body, s.from)
        const a2 = localOf(body, s.from)
        limb.joint = phys.world.createImpulseJoint(R.JointData.spherical(a1, a2), parent.body, body, true)
        // Limbs of the same body must not fight each other at the joint: an upper and a lower arm
        // overlap by design, and contacts between them push the elbow apart.
        limb.joint.setContactsEnabled(false)
      }
      rd.limbs.push(limb)
      rd.byName.set(s.name, limb)
    }
    return rd
  }

  /**
   * A stand-in person of a given height, standing at (x, z) on ground `y`, facing `yaw`.
   *
   * For a probe, for a placeholder, and for the moment a game has a pedestrian entity and no rig
   * behind it yet — which is where the corridor is today.
   */
  static humanoid(phys: PhysicsWorld, x: number, y: number, z: number, height = 1.75, yaw = 0, velocity?: { x: number; y: number; z: number }, mass?: number): Ragdoll {
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    const place = (side: number, h: number) => ({
      // side is across the body: yaw about +Y puts "across" along (-sin, 0, cos)
      x: x - sin * side * height,
      y: y + h * height,
      z: z + cos * side * height,
    })
    // The table's masses are a 72 kg person; `mass` scales all of them together so a heavyweight
    // and a child fall differently and a car throws them differently. Scaling the whole set rather
    // than letting a caller set limbs individually keeps the proportions, which is what stops a
    // ragdoll folding in ways a body does not.
    const k = mass && mass > 0 ? mass / HUMANOID_MASS : 1
    const specs: LimbSpec[] = RAGDOLL_HUMANOID.map((b) => ({
      name: b.name,
      parent: b.parent,
      from: place(SIDE[b.name] ?? 0, b.y0),
      to: place(SIDE[b.name] ?? 0, b.y1),
      radius: b.r * (height / 1.75),
      mass: b.m * k,
    }))
    return Ragdoll.from(phys, specs, { linvel: velocity })
  }

  get(name: string): Limb | undefined {
    return this.byName.get(name)
  }

  /** Total mass — what an explosion's impulse is scaled by, and a sanity check on a rig. */
  get mass(): number {
    let m = 0
    for (const l of this.limbs) m += l.body.mass()
    return m
  }

  /** Has the whole thing come to rest? The cue to stop syncing bones and freeze the pose. */
  get settled(): boolean {
    for (const l of this.limbs) if (!l.body.isSleeping()) return false
    return true
  }

  /** Give the whole body a shove — a car, a blast, a push. Split by mass, so it does not tear. */
  shove(ix: number, iy: number, iz: number) {
    const total = this.mass || 1
    for (const l of this.limbs) {
      const share = l.body.mass() / total
      l.body.applyImpulse({ x: ix * share, y: iy * share, z: iz * share }, true)
    }
  }

  /**
   * Read every limb's world pose out, for the renderer.
   *
   * The caller passes a sink rather than getting an array back, because this runs per character per
   * frame and a fresh array of eleven objects per character per frame is exactly the kind of thing
   * that does not show up until there are forty of them.
   */
  sync(into: (name: string, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number) => void) {
    for (const l of this.limbs) {
      const t = l.body.translation()
      const r = l.body.rotation()
      into(l.name, t.x, t.y, t.z, r.x, r.y, r.z, r.w)
    }
  }

  free() {
    for (const l of this.limbs) this.phys.world.removeRigidBody(l.body)
    this.limbs.length = 0
    this.byName.clear()
  }
}

/** A world point in a body's local frame. */
function localOf(body: RigidBody, p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const t = body.translation()
  const q = body.rotation()
  const vx = p.x - t.x
  const vy = p.y - t.y
  const vz = p.z - t.z
  // rotate by the conjugate
  const cx = -q.x, cy = -q.y, cz = -q.z, cw = q.w
  const tx = 2 * (cy * vz - cz * vy)
  const ty = 2 * (cz * vx - cx * vz)
  const tz = 2 * (cx * vy - cy * vx)
  return {
    x: vx + cw * tx + cy * tz - cz * ty,
    y: vy + cw * ty + cz * tx - cx * tz,
    z: vz + cw * tz + cx * ty - cy * tx,
  }
}
