// Everything beside the road that a car should hit, catalogued once and streamed as colliders.
//
// Rich, 2026-09-29: "We should also collide with houses, street signs, stop lights, power line
// poles, any placed prop in the level. street signs and stop signs should detach using real physics,
// try to use their geometry to approximate weight."
//
// TWO PASSES, AND THE SPLIT IS THE WHOLE DESIGN.
//
//   `catalogue()`  walks the built scene ONCE and writes down where every prop is, how big it is,
//                  what it is made of and what it weighs. A few thousand plain records. Expensive —
//                  it decomposes an instance matrix per prop — and done at site load.
//   `WorldBodies`  streams colliders out of that catalogue by proximity, the way the trunks and the
//                  ground already do. Cheap, every frame, bounded.
//
// Doing it in one pass instead would mean re-walking `InstancedMesh` buffers every time the player
// moves, which for Crofton is 1,092 furniture instances, 120 power poles and 2,015 fence posts — and
// none of it changes.
//
// WHY THE SCENE GRAPH AND NOT THE MANIFEST. For signs, masts and poles the renderer has already done
// the hard part: it read the OSM tags, decided where a signal mast stands and which way its arm
// points, and baked that into an instance matrix. Reading the matrix back is exact and cannot drift
// from what is drawn. **Buildings are the exception** and come from the manifest instead, because
// the renderer merges all 7,506 of them into one geometry — one collider around a whole town is
// worse than none.
//
// MASS COMES FROM THE GEOMETRY (`@apex/engine/physics/massprops`), which is what Rich asked for:
// the volume of the mesh times the density of what it is made of. The two judgements geometry cannot
// make are the MATERIAL and the SOLIDITY — a drawn post is a solid box and a real one is a tube —
// and both are one value per KIND of prop rather than per prop. See `CLASSES` below.

import * as THREE from 'three'
import { estimateMass, type Material } from '@apex/engine/physics/massprops'
import type { Manifest } from '../../world/site'
import type { Site } from '../../world/scene'

/** One thing that can be hit, in world metres. */
export interface PropRecord {
  /** centre of the collider box */
  x: number
  y: number
  z: number
  /** half-extents of the box, already scaled */
  hx: number
  hy: number
  hz: number
  /** orientation, as a quaternion */
  qx: number
  qy: number
  qz: number
  qw: number
  /** kg, from the geometry */
  mass: number
  /** what it is, for the renderer to find its own record again */
  kind: string
  /** N·s that detaches it, or 0 for something that never comes off */
  breakAt: number
  /** which InstancedMesh and which slot, so a broken one can be taken out of the buffer */
  mesh?: THREE.InstancedMesh
  instance?: number
}

/**
 * What a prop is made of, how solid it really is, and whether it comes off.
 *
 * Matched against the object's NAME, longest prefix first, because the renderer already names every
 * instanced batch for exactly this sort of question (`furniture:signal:3`, `power:tower`,
 * `barrier:fence:0`). A name is a contract the renderer is already keeping.
 *
 * `solidity` is the fraction of the drawn envelope that is actually material, and for an ASSEMBLY it
 * is small, because the envelope is mostly air. The arithmetic is written down so the next person can
 * re-derive it rather than guess at it:
 *
 *   a stop sign's geometry is a 0.035 m post merged with an octagonal back plate, so its bounding box
 *   is about 0.82 × 2.4 × 0.12 m = **0.244 m³** (measured, Crofton). A real 30-inch STOP assembly is
 *   a ~2.5 kg aluminium plate on a ~14 kg post: call it 18 kg. 18 ÷ (0.244 × 7850) = **0.0094**.
 *
 * A timber power pole really is a solid pole inside its own box, so 0.8. A signal mast is a hollow
 * tube with a long arm over a big empty box, so it is small for the same reason a sign is.
 *
 * THIS IS THE ONE CALIBRATION PER CLASS. Everything else scales with the geometry: a sign twice the
 * size has eight times the envelope and eight times the mass, without anybody touching this table.
 *
 * `breakAt` is a MULTIPLE OF THE MASS rather than an absolute, so a heavy thing takes more to shift
 * than a light one without anybody typing a second number. 40 × mass means a 15 kg sign detaches at
 * 600 N·s — a 1400 kg car at 20 m/s brings an order of magnitude more than that, and a pedestrian
 * walking into one brings a hundredth of it. 0 means it never comes off.
 */
const CLASSES: { prefix: string; material: Material; solidity: number; breakMul: number }[] = [
  // signs and their posts: the things Rich asked to detach
  { prefix: 'furniture:sign', material: 'steel', solidity: 0.0094, breakMul: 40 },
  { prefix: 'furniture:blade', material: 'aluminium', solidity: 0.02, breakMul: 30 },
  { prefix: 'furniture:stop', material: 'steel', solidity: 0.0094, breakMul: 40 },
  // a signal mast is a serious piece of steel on a concrete base; it goes, but it takes a lot
  { prefix: 'furniture:signal', material: 'steel', solidity: 0.02, breakMul: 160 },
  { prefix: 'furniture', material: 'steel', solidity: 0.02, breakMul: 60 },
  /*
   * A `power:tower` is a pole with a crossarm, so its envelope is a big empty box around a thin
   * thing — 0.8 solidity gave 57 TONNES, which is a pole made of solid timber two metres square.
   * Same arithmetic as the sign: the envelope measures about 2 × 2 × 12 m = 48 m³, a real 12 m
   * distribution pole with its arm is around 600 kg, so 600 ÷ (48 × 640) = 0.02.
   *
   * It never moves, so this is a number nobody will feel — but a wrong number on a readout is a
   * wrong number somebody will eventually build on.
   */
  { prefix: 'power', material: 'timber', solidity: 0.02, breakMul: 0 },
  { prefix: 'barrier:guard_rail', material: 'steel', solidity: 0.25, breakMul: 0 },
  { prefix: 'barrier:wall', material: 'concrete', solidity: 0.9, breakMul: 0 },
  { prefix: 'barrier', material: 'timber', solidity: 0.6, breakMul: 0 },
  { prefix: 'placement', material: 'timber', solidity: 0.4, breakMul: 0 },
]

function classOf(name: string) {
  let best = CLASSES[CLASSES.length - 1]
  let bestLen = -1
  for (const c of CLASSES) {
    if (name.startsWith(c.prefix) && c.prefix.length > bestLen) {
      best = c
      bestLen = c.prefix.length
    }
  }
  return bestLen >= 0 ? best : null
}

/** Which of the site's layers hold things you can hit. The rest is paint, water and scenery. */
// NOT `blades`: the street-name signs are one merged mesh for the whole site (intersections.ts
// buildBlades), so there is no instance to give a collider to or to detach — which is why you
// drive through them (Rich, 2026-09-30: "street signs don't move when run over"). Making them
// fly means building them as instances; a static collider alone would only make them walls.
const SOLID_LAYERS = ['furniture', 'power', 'barriers', 'placements'] as const

const m4 = new THREE.Matrix4()
const pos = new THREE.Vector3()
const quat = new THREE.Quaternion()
const scl = new THREE.Vector3()

/**
 * Walk the built scene once and write down every prop.
 *
 * `max` is a ceiling on the whole catalogue, because a big site's fence posts alone are two thousand
 * and there is no point cataloguing a hedge nobody will ever hit. It is not a budget on what STANDS
 * at once — that is `WorldBodies` — it is a ceiling on the memory this list occupies.
 */
export function catalogue(site: Site, opts: { max?: number; maxHalf?: number } = {}): PropRecord[] & { merged?: number } {
  const out: PropRecord[] = []
  const max = opts.max ?? 20000
  /** biggest half-extent a single prop may have. Anything larger is a merged batch — see `push` */
  const maxHalf = opts.maxHalf ?? 12
  let merged = 0
  const layers = site.layers as unknown as Record<string, THREE.Object3D | undefined>

  for (const name of SOLID_LAYERS) {
    const layer = layers[name]
    if (!layer) continue
    layer.traverse((o) => {
      if (out.length >= max) return
      const inst = o as THREE.InstancedMesh
      const mesh = o as THREE.Mesh
      const isInst = inst.isInstancedMesh === true
      if (!isInst && !mesh.isMesh) return
      /*
       * A `:face` BATCH IS NOT A SECOND PROP.
       *
       * `furniture.ts` draws a sign as two instanced batches — the post-and-backplate assembly, and
       * the printed face laid on it. They occupy the same space, so cataloguing both gives every
       * sign TWO colliders and TWO entries in the breakables register, and knocking one over leaves
       * the other standing in mid-air. The assembly's envelope already contains the face.
       */
      const nm = o.name || name
      if (/:face$|:lens(es)?$|:paint$/.test(nm)) return
      const cls = classOf(nm)
      if (!cls) return
      const geo = mesh.geometry
      if (!geo?.getAttribute?.('position')) return
      if (!geo.boundingBox) geo.computeBoundingBox()
      const bb = geo.boundingBox!
      const size = new THREE.Vector3().subVectors(bb.max, bb.min)
      const centre = new THREE.Vector3().addVectors(bb.max, bb.min).multiplyScalar(0.5)
      /*
       * A SIGNAL IS ITS POST, NOT ITS ARM. The geometry's box spans the mast AND the arm hanging
       * the heads over the road, so the collider was a wall across the carriageway at head height
       * — driving under the lights hit it and sent the post flying without touching it (Rich,
       * 2026-09-30: "like there is an invisible wall here"). The post stands at the geometry's
       * origin; the box is the post's width and the whole height, and the arm is not solid.
       */
      if (nm.startsWith('furniture:signal')) {
        size.x = 0.5
        size.z = 0.5
        centre.x = 0
        centre.z = 0
      }

      /*
       * MASS ONCE PER BATCH, NOT ONCE PER PROP.
       *
       * Every instance of an `InstancedMesh` shares one geometry, so the volume integral runs once
       * for a thousand signs and each instance scales it by its own scale cubed. Running it per
       * instance would be a thousand passes over the same triangles for a thousand identical
       * answers.
       *
       * The positions are the geometry's OWN, which are near its own origin — `massProperties` says
       * plainly that it wants local coordinates, because every tetrahedron is measured from the
       * origin and a shape a kilometre out loses precision subtracting itself back.
       */
      const p = geo.getAttribute('position').array as ArrayLike<number>
      const idx = geo.index ? (geo.index.array as ArrayLike<number>) : null
      const base = estimateMass(p, idx, cls.material, { solidity: cls.solidity, minKg: 1 })

      /*
       * A MERGED BATCH IS NOT A PROP, and this is the check that tells them apart.
       *
       * `furniture.ts` merges whole runs of fence, rail and wall into chunk geometries — one mesh
       * covering hundreds of metres. A bounding box around one of those is not a fence, it is a wall
       * across a neighbourhood, and it would stop a car in the middle of a field. Measured on
       * Crofton before this guard: 7 `barrier:fence` records, the largest weighing 228,000 tonnes,
       * which is what a fence run looks like when you weigh its bounding box.
       *
       * So anything whose footprint is larger than a prop can be is skipped and counted. The honest
       * consequence is that merged fences and walls are NOT collidable yet; a box per run would need
       * the runs broken back into segments, which is the renderer's data rather than its geometry.
       */
      const push = (matrix: THREE.Matrix4) => {
        matrix.decompose(pos, quat, scl)
        // the box's centre is the geometry's own centre, carried through the instance's transform
        const c = centre.clone().multiply(scl).applyQuaternion(quat).add(pos)
        const kg = base.kg * Math.abs(scl.x * scl.y * scl.z)
        const footX = (size.x * Math.abs(scl.x)) / 2
        const footZ = (size.z * Math.abs(scl.z)) / 2
        if (Math.max(footX, footZ) > maxHalf) { merged++; return }
        out.push({
          x: c.x, y: c.y, z: c.z,
          hx: Math.max(0.02, (size.x * scl.x) / 2),
          hy: Math.max(0.02, (size.y * scl.y) / 2),
          hz: Math.max(0.02, (size.z * scl.z) / 2),
          qx: quat.x, qy: quat.y, qz: quat.z, qw: quat.w,
          mass: kg,
          kind: nm,
          breakAt: cls.breakMul > 0 ? kg * cls.breakMul : 0,
        })
      }

      if (isInst) {
        for (let i = 0; i < inst.count && out.length < max; i++) {
          inst.getMatrixAt(i, m4)
          // instance matrices are in the InstancedMesh's own space; put them in the world's
          m4.premultiply(inst.matrixWorld)
          push(m4)
          const r = out[out.length - 1]
          if (r) { r.mesh = inst; r.instance = i }
        }
      } else {
        mesh.updateWorldMatrix(true, false)
        push(mesh.matrixWorld)
      }
    })
  }

  // ---- buildings, from the manifest rather than from the merged mesh
  out.push(...buildingRecords(site.manifest, site.groundAt, max - out.length))
  return Object.assign(out, { merged })
}

/**
 * A box per building, from the manifest's own footprints.
 *
 * NOT from the scene graph: `buildings.ts` merges every footprint on the site into one geometry —
 * 7,506 of them at Crofton — so there is nothing per-building to read back, and a single collider
 * around the merged mesh would be one box over a whole town.
 *
 * An axis-aligned box around the footprint ring, which is a coarse but honest approximation: a
 * terrace reads as a terrace, an L-shaped house reads as its own bounding box, and a car that hits
 * either of them stops. A convex hull per footprint is the refinement, and it is not worth doing
 * before somebody has driven into a house and said what is wrong with it.
 */
function buildingRecords(manifest: Manifest, groundAt: (x: number, z: number) => number | null, room: number): PropRecord[] {
  const out: PropRecord[] = []
  const list = manifest.buildings
  if (!Array.isArray(list)) return out
  for (const b of list) {
    if (out.length >= room) break
    const ring = b.ring
    if (!Array.isArray(ring) || ring.length < 3) continue
    const h = Math.max(2.5, b.height_m ?? 6)
    // the ring's centroid, in SITE metres (x east, y north)
    let sx = 0, sy = 0
    for (const pt of ring) { sx += pt[0]; sy += pt[1] }
    const cxs = sx / ring.length
    const cys = sy / ring.length
    // The world frame is (east, up, -north), so site y becomes -z. Getting this wrong mirrors every
    // house across the road — visible, and the sort of thing that gets blamed on the bake.
    const cx = cxs
    const cz = -cys
    const g = groundAt(cx, cz)
    if (g === null) continue

    if (b.rect && b.rect.w > 0 && b.rect.d > 0) {
      /*
       * THE ORIENTED BOX, which is the whole reason to read `rect` rather than the ring's extent.
       *
       * `rect.yaw_deg` is a MATH angle counter-clockwise from east naming the footprint's LONG axis
       * in site coordinates (see `buildings.ts`, which builds its gables along the same axis). A
       * rotation about world +Y by that same angle takes local +X to (cos a, 0, −sin a) — which is
       * that long axis carried into the world frame — so the angle passes straight through and the
       * box's local X is the building's length.
       *
       * A diagonal terrace is the case that makes this worth it: its axis-aligned extent is half as
       * big again as the house, and a car would stop in the garden.
       */
      const a = (b.rect.yaw_deg * Math.PI) / 180
      out.push({
        x: cx, y: g + h / 2, z: cz,
        hx: b.rect.w / 2, hy: h / 2, hz: b.rect.d / 2,
        qx: 0, qy: Math.sin(a / 2), qz: 0, qw: Math.cos(a / 2),
        mass: b.rect.w * b.rect.d * h * 350 * 0.05,
        kind: 'building',
        breakAt: 0,
      })
      continue
    }

    // no rotated rectangle in the bake: fall back to the ring's own extent, axis aligned
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const pt of ring) {
      if (pt[0] < minX) minX = pt[0]
      if (pt[0] > maxX) maxX = pt[0]
      if (pt[1] < minY) minY = pt[1]
      if (pt[1] > maxY) maxY = pt[1]
    }
    if (!Number.isFinite(minX)) continue
    out.push({
      x: (minX + maxX) / 2, y: g + h / 2, z: -(minY + maxY) / 2,
      hx: Math.max(0.5, (maxX - minX) / 2), hy: h / 2, hz: Math.max(0.5, (maxY - minY) / 2),
      qx: 0, qy: 0, qz: 0, qw: 1,
      // A building's massing is mostly air, and it is fixed anyway — the mass is here for
      // completeness rather than because anything will ever move it.
      mass: (maxX - minX) * (maxY - minY) * h * 350 * 0.05,
      kind: 'building',
      breakAt: 0,
    })
  }
  return out
}

/* ---- the swap: a broken prop leaves its instance buffer and becomes its own mesh --------------- */

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

/**
 * Take one instance out of an `InstancedMesh` and hand back a standalone mesh that looks the same.
 *
 * THIS IS THE HALF THAT MAKES A DETACHED SIGN VISIBLE. The physics body is only half the job: a sign
 * whose collider has toppled while its drawn instance stands there is a ghost, and reads as the
 * physics not working at all.
 *
 * It SHARES the geometry and the material rather than cloning them — the loose sign is the same sign,
 * so it should be the same triangles and the same texture, and cloning either would double the
 * memory for every prop anybody knocks over.
 *
 * Hiding the instance is a zero-scale matrix and a FULL upload (`needsUpdate = true`), deliberately
 * not `addUpdateRange`: a range makes the NEXT upload partial and the ranges persist until something
 * clears them, so one ranged write followed by a full one anywhere else in the frame uploads only
 * the range. The buffers here are a few thousand matrices; a full upload on the frame a sign is hit
 * is cheaper than the class of bug the other way costs.
 */
export function detachInstance(rec: PropRecord): THREE.Object3D | null {
  const inst = rec.mesh
  if (!inst || rec.instance === undefined) return null
  inst.setMatrixAt(rec.instance, ZERO)
  inst.instanceMatrix.needsUpdate = true
  const loose = new THREE.Mesh(inst.geometry, inst.material as THREE.Material)
  loose.name = `${rec.kind}:detached`
  loose.castShadow = inst.castShadow
  loose.receiveShadow = inst.receiveShadow
  /*
   * THE FACE GOES WITH THE POST. A sign is two batches — the post, and its painted face — with the
   * same instance index in each; only the post was detached, and the face batch was zeroed by
   * nothing, so the sign vanished and a bare post flew off (Rich, 2026-09-30). Every companion
   * batch beside the post (`<name>:face`, `<name>:lenses`) is zeroed and comes along as a child.
   */
  const siblings = (inst.parent?.children ?? []).filter((c) => c !== inst && c.name.startsWith(`${inst.name}:`) && (c as THREE.InstancedMesh).isInstancedMesh)
  if (!siblings.length) return loose
  const group = new THREE.Group()
  group.name = loose.name
  group.add(loose)
  for (const s of siblings as THREE.InstancedMesh[]) {
    if (rec.instance >= s.count) continue
    s.setMatrixAt(rec.instance, ZERO)
    s.instanceMatrix.needsUpdate = true
    const part = new THREE.Mesh(s.geometry, s.material as THREE.Material)
    part.name = `${s.name}:detached`
    group.add(part)
  }
  return group
}

/**
 * Where a detached mesh has to be drawn, given where its BODY is.
 *
 * The collider is a box around the prop's bounding box, and its centre is not the geometry's origin
 * — a sign's origin is at its foot and its box is centred halfway up the post. So the mesh hangs off
 * the body by the offset between the two, rotated into the body's frame. Getting this wrong stands
 * the sign a metre away from its own collider, which looks like the collider being in the wrong
 * place.
 */
export function detachedOffset(rec: PropRecord, into: THREE.Vector3): THREE.Vector3 {
  const inst = rec.mesh
  if (!inst) return into.set(0, 0, 0)
  const geo = inst.geometry
  if (!geo.boundingBox) geo.computeBoundingBox()
  const bb = geo.boundingBox!
  // the geometry's own centre, which is where the collider box sits; the mesh origin is at 0
  return into.set(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, -(bb.max.z + bb.min.z) / 2)
}
