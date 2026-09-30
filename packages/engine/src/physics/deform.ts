// Dents: the panel moves where it was hit.
//
// Rich: "Mesh deformation from the impact for cars would be awesome too."
//
// WHAT THIS IS. An impact arrives with a world-space point, a direction and an impulse. Every
// vertex of the body mesh within a radius of that point is pushed along the impact direction,
// falling off with distance, and the displacement is REMEMBERED so a second hit in the same place
// goes deeper and a hit somewhere else leaves the first dent alone. That is the whole model, and it
// is enough: a car that visibly carries its crashes is the thing people notice, and no amount of
// finite-element correctness makes a wing look more crumpled than a well-placed dip does.
//
// WHAT IT IS NOT, and the alternative that was considered and left on the shelf: Rapier 0.21 ships
// soft bodies with plastic flow (`SoftEdgePlasticFlow`, `SoftBodyCellModel.NeoHookean`), which is
// genuinely the physically right way to crumple a car — a tetrahedral lattice that yields past a
// strain threshold and stays yielded. It is also a tetrahedral lattice per car, solved every step,
// on a device that is already drawing a city. The honest split is: this file for every car on the
// street, and a soft body for the one car in a set-piece, if a set-piece ever wants one. The
// `PLAN-PHYSICS.md` note about it is there so that decision is revisited deliberately.
//
// THE THREE RULES THAT KEEP IT CHEAP AND CORRECT:
//
//   1. **The collider never deforms.** The physics shape stays the box it started as. Re-fitting a
//      convex hull per dent costs a hull build and a broad-phase update for a difference of
//      centimetres in how the car sits against a wall.
//   2. **The mesh is cloned per car.** Geometry in three.js is shared by default, and denting a
//      shared geometry dents every car in the game at once. `Deformable` clones on construction and
//      says so, because the alternative is discovered in a screenshot of twelve identical wrecks.
//   3. **The position buffer is rewritten whole, never in ranges.** `addUpdateRange` makes an
//      upload PARTIAL, and mixing a ranged write with a full one uploads a fraction of the buffer
//      and leaves the rest as it was. A dent touches a scattered handful of vertices spread across
//      the buffer, so there is no useful range anyway. Full upload, every time, and the cost is one
//      `bufferSubData` per dented car per dent — not per frame.

import type { BufferGeometry, Mesh, Object3D } from 'three'
import type { Impact } from './world'

export interface DeformOptions {
  /**
   * Metres of dent per N·s of impulse.
   *
   * The scale to hang it off: a 1400 kg car hitting a wall and losing 10 m/s delivers about
   * 14,000 N·s, which should leave a serious dent — call it 0.25 m at the worst point. That is
   * 1.8e-5 m per N·s, which is the default.
   */
  perImpulse?: number
  /** how far from the contact the dent reaches, m */
  radius?: number
  /** no vertex moves more than this from where it started, m. A panel cannot fold through the floor */
  maxDent?: number
  /** N·s below which nothing happens. Kerbs and hedges do not dent a car */
  threshold?: number
  /**
   * 0…1 of the dent taken along the surface normal instead of the impact direction.
   *
   * Pure impact direction pushes a whole flank straight through the car. Some of it along the
   * vertex's own normal makes the panel crumple inward rather than translate, which is what a dent
   * looks like.
   */
  inward?: number
}

export const DEFORM_DEFAULTS: Required<DeformOptions> = {
  perImpulse: 1.8e-5,
  radius: 1.1,
  maxDent: 0.35,
  threshold: 800,
  inward: 0.5,
}

/**
 * One deformable mesh.
 *
 * Construct it around the car's body mesh AFTER the mesh exists and before anything shares its
 * geometry. Feed it impacts; it does the rest.
 */
export class Deformable {
  readonly mesh: Mesh
  private geo: BufferGeometry
  private readonly opts: Required<DeformOptions>
  /** the shape it was born with, so a repair is a copy and not a reload */
  private readonly rest: Float32Array
  /** accumulated displacement per vertex, so dents add rather than replace */
  private readonly moved: Float32Array
  private dirty = false
  /** 0…1: the deepest dent as a fraction of `maxDent`. The HUD's "how wrecked is it" */
  damage = 0
  /** something has moved since the last `flush` */
  get pending(): boolean { return this.dirty }

  constructor(mesh: Mesh, opts: DeformOptions = {}) {
    this.mesh = mesh
    this.opts = { ...DEFORM_DEFAULTS, ...opts }
    // CLONE. Three shares geometry between meshes as a matter of course, and a dent applied to a
    // shared geometry appears on every car using it — including the ones parked two streets away.
    this.geo = mesh.geometry.clone()
    mesh.geometry = this.geo
    const pos = this.geo.getAttribute('position')
    this.rest = new Float32Array(pos.array as ArrayLike<number>)
    this.moved = new Float32Array(this.rest.length)
  }

  /**
   * Apply an impact.
   *
   * `im` is in WORLD space and the geometry is in the mesh's LOCAL space, so the point and the
   * direction are brought into local space first — via the mesh's inverse world matrix, which must
   * be up to date. A car whose matrix is stale gets its dents in the wrong place and it looks like
   * the deformation is random rather than that the matrix was old.
   *
   * THE OPTIONS ARE METRES; THE GEOMETRY IS WHATEVER THE EXPORTER USED. A reconstruction is a
   * unit cube scaled up four and a half times to be a car, so a radius of 1.1 in ITS units is the
   * whole car and a `maxDent` of 0.35 is a metre and a half. Every length here is divided by the
   * mesh's world scale first — the first version did not, and one knock folded a car into a
   * black polygonal blob the size of a bus (Rich, 2026-09-30, with a screenshot).
   */
  apply(im: Impact, intoOtherSide = false): boolean {
    const o = this.opts
    if (im.impulse < o.threshold) return false
    const depthM = Math.min(o.maxDent, im.impulse * o.perImpulse)
    if (depthM <= 1e-4) return false

    const m = this.mesh
    m.updateWorldMatrix(true, false)
    const inv = m.matrixWorld.clone().invert()
    const me = m.matrixWorld.elements
    const scale = Math.hypot(me[0], me[1], me[2]) || 1
    const radius = o.radius / scale
    const maxDent = o.maxDent / scale
    const depth = depthM / scale
    // the contact point, in local space
    const px = im.x, py = im.y, pz = im.z
    const e = inv.elements
    const lx = e[0] * px + e[4] * py + e[8] * pz + e[12]
    const ly = e[1] * px + e[5] * py + e[9] * pz + e[13]
    const lz = e[2] * px + e[6] * py + e[10] * pz + e[14]
    // the direction, rotated but not translated. The normal points out of `im.a`; a dent goes INTO
    // the panel, so whichever side this mesh is decides the sign.
    const s = intoOtherSide ? 1 : -1
    let dx = (e[0] * im.nx + e[4] * im.ny + e[8] * im.nz) * s
    let dy = (e[1] * im.nx + e[5] * im.ny + e[9] * im.nz) * s
    let dz = (e[2] * im.nx + e[6] * im.ny + e[10] * im.nz) * s
    const dl = Math.hypot(dx, dy, dz) || 1
    dx /= dl
    dy /= dl
    dz /= dl

    const pos = this.geo.getAttribute('position')
    const arr = pos.array as Float32Array
    const nrm = this.geo.getAttribute('normal')
    const nArr = nrm ? (nrm.array as Float32Array) : null
    const r2 = radius * radius
    // nowhere near this mesh: no need to walk a hundred thousand vertices to find that out
    if (!this.geo.boundingSphere) this.geo.computeBoundingSphere()
    const bs = this.geo.boundingSphere!
    if (bs.radius > 0) {
      const reach = bs.radius + radius
      if ((bs.center.x - lx) ** 2 + (bs.center.y - ly) ** 2 + (bs.center.z - lz) ** 2 > reach * reach) return false
    }
    let touched = 0
    let worst = this.damage

    for (let i = 0; i < this.rest.length; i += 3) {
      const vx = this.rest[i] - lx
      const vy = this.rest[i + 1] - ly
      const vz = this.rest[i + 2] - lz
      const d2 = vx * vx + vy * vy + vz * vz
      if (d2 > r2) continue
      // smooth falloff: 1 at the contact, 0 at the radius, flat at both ends so a dent has a lip
      const t = 1 - Math.sqrt(d2) / radius
      const fall = t * t * (3 - 2 * t)
      let ax = dx
      let ay = dy
      let az = dz
      if (nArr && o.inward > 0) {
        // mix in the vertex's own inward normal so the panel crumples rather than slides
        ax = dx * (1 - o.inward) - nArr[i] * o.inward
        ay = dy * (1 - o.inward) - nArr[i + 1] * o.inward
        az = dz * (1 - o.inward) - nArr[i + 2] * o.inward
        const al = Math.hypot(ax, ay, az) || 1
        ax /= al
        ay /= al
        az /= al
      }
      const step = depth * fall
      // clamp the TOTAL displacement, not this step's, or a panel hit twenty times folds itself
      // inside out while every individual hit looked reasonable
      const mx = this.moved[i] + ax * step
      const my = this.moved[i + 1] + ay * step
      const mz = this.moved[i + 2] + az * step
      const len = Math.hypot(mx, my, mz)
      const k = len > maxDent ? maxDent / len : 1
      this.moved[i] = mx * k
      this.moved[i + 1] = my * k
      this.moved[i + 2] = mz * k
      arr[i] = this.rest[i] + this.moved[i]
      arr[i + 1] = this.rest[i + 1] + this.moved[i + 1]
      arr[i + 2] = this.rest[i + 2] + this.moved[i + 2]
      if (len * k > worst * maxDent) worst = (len * k) / maxDent
      touched++
    }
    if (!touched) return false
    this.damage = Math.min(1, worst)
    this.dirty = true
    return true
  }

  /**
   * Push the changes to the GPU. Call once per frame, not once per impact.
   *
   * NO UPDATE RANGES. `addUpdateRange` turns the next upload PARTIAL and the ranges persist until
   * something clears them, so a ranged write followed by a full one uploads only the range — which
   * is how a mesh ends up half-updated with nothing in the console. A dent touches vertices
   * scattered through the buffer anyway, so the whole thing goes up.
   */
  flush(): boolean {
    if (!this.dirty) return false
    const pos = this.geo.getAttribute('position')
    pos.needsUpdate = true
    // Normals go stale the moment a vertex moves, and a dent with the old normals is a flat patch
    // that catches the light exactly as it did before — i.e. invisible, which is the failure mode
    // this line exists to avoid.
    this.geo.computeVertexNormals()
    this.geo.computeBoundingSphere()
    this.dirty = false
    return true
  }

  /** Straighten it out. The body shop, the respawn, the editor's undo. */
  repair() {
    const pos = this.geo.getAttribute('position')
    const arr = pos.array as Float32Array
    arr.set(this.rest)
    this.moved.fill(0)
    this.damage = 0
    this.dirty = true
    this.flush()
  }
}

/**
 * Wire a whole car up: every mesh under an object becomes deformable, and impacts on its collider
 * are routed to whichever of them is nearest the contact.
 *
 * WHY NEAREST AND NOT ALL. A car is a body, a glasshouse, four wheels and a pair of lamps. Sending
 * one impact to all of them dents the wheels on the far side, which looks exactly like the physics
 * has come loose. The nearest mesh by bounding sphere is right nearly always and cheap always.
 */
export class DeformableBody {
  readonly parts: Deformable[] = []

  constructor(root: Object3D, opts: DeformOptions = {}, accept: (m: Mesh) => boolean = () => true) {
    root.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh || !m.geometry?.getAttribute?.('position')) return
      if (!accept(m)) return
      this.parts.push(new Deformable(m, opts))
    })
  }

  /** The deepest dent on any part, 0…1. */
  get damage(): number {
    let d = 0
    for (const p of this.parts) d = Math.max(d, p.damage)
    return d
  }

  apply(im: Impact): boolean {
    let best: Deformable | null = null
    let bestD = Infinity
    for (const p of this.parts) {
      p.mesh.updateWorldMatrix(true, false)
      const g = p.mesh.geometry
      if (!g.boundingSphere) g.computeBoundingSphere()
      const c = g.boundingSphere!.center
      const e = p.mesh.matrixWorld.elements
      const wx = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12]
      const wy = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13]
      const wz = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14]
      const d = (wx - im.x) ** 2 + (wy - im.y) ** 2 + (wz - im.z) ** 2
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    return best ? best.apply(im) : false
  }

  flush() {
    for (const p of this.parts) p.flush()
  }

  repair() {
    for (const p of this.parts) p.repair()
  }
}
