// Dents on whatever was hit: the engine's `Deformable`, hung on each mesh of an object the first
// time it takes a knock.
//
// Rich, 2026-09-30: *"we were supposed to have elastic collisions and mesh deformations and all
// that for crashes."* The engine has had the deformer since the physics landed; nothing in the
// corridor called it. A reconstruction's clones SHARE geometry, so `Deformable` clones the
// geometry to the mesh on construction — otherwise one crash would crumple every car wearing
// that model.
//
// THREE THINGS LEARNED THE FIRST NIGHT IT RAN:
//
//   1. The dent is applied on the CPU and has to be FLUSHED to the GPU. Nothing did, so the first
//      knock (whatever had accumulated before the next render) showed and every later one was
//      invisible. `flushDents()` runs once a frame from the main loop.
//   2. A reconstruction is ~130k vertices. Walking them costs about a millisecond, and
//      `computeVertexNormals` after a flush costs several. A pile-up delivers impacts every step,
//      so each object is dented at most every `DENT_EVERY_MS`, and at most `FLUSH_PER_FRAME`
//      meshes are re-normalled per frame — the rest wait a frame, which nobody can see.
//   3. Cloning 130k vertices mid-frame is a visible stall on the first hit, and the old code did
//      it TWICE (once here, once in `Deformable`). Once now.

import * as THREE from 'three'
import { Deformable, DEFORM_DEFAULTS } from '@apex/engine/physics/deform'
import type { Impact } from '@apex/engine/physics/world'

const dented = new WeakMap<THREE.Mesh, Deformable>()
/** the last time an object was dented, so a pile-up does not dent it 120 times a second */
const lastDent = new WeakMap<THREE.Object3D, number>()
/** meshes with a dent that has not reached the GPU yet */
const pending = new Set<Deformable>()
/** Deformables alive (made and not yet released): each is a full copy of a mesh, ×3, plus its GPU buffers */
let live = 0

/** How many vertices a mesh may have and still be dented; a reconstruction is under it. */
const MAX_VERTS = 200_000
/** ms between dents on one object: a crash still lands several, a resting pile lands none */
const DENT_EVERY_MS = 90
/** ms of normal recomputes and uploads a frame; at least one mesh goes whatever it costs */
const FLUSH_MS_PER_FRAME = 1.5

/**
 * Dent every mesh of `root` around an impact. `intoOtherSide` is true when this object belongs to
 * the impact's `b` collider (the normal points out of `a`). Returns how many meshes moved.
 */
export function dentObject(root: THREE.Object3D, im: Impact, intoOtherSide: boolean): number {
  // below the dent threshold there is nothing to do — checked HERE, before a `Deformable` is
  // made, because making one clones the geometry, and a kerb tap was cloning 130k vertices
  if (im.impulse < DEFORM_DEFAULTS.threshold) return 0
  const now = performance.now()
  const last = lastDent.get(root) ?? -1e9
  if (now - last < DENT_EVERY_MS) return 0
  let n = 0
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.geometry?.attributes?.position) return
    if (m.geometry.attributes.position.count > MAX_VERTS) return
    let d = dented.get(m)
    if (!d) {
      // DENT THE COPY THE DETAIL LEVEL WANTS. A car that has just come into range wears its full
      // geometry until the next ranking pass hands it the simplified copy, and a dent in that
      // window cloned the full 101k-vertex car and pinned it there (setDetail leaves a dented mesh
      // alone): 7–20 ms a flush, again (2026-10-08). If the copy exists, wear it first.
      const ud = m.userData as { lodLow?: THREE.BufferGeometry; lodFull?: THREE.BufferGeometry; lodWant?: number }
      if (ud.lodLow && ud.lodWant !== undefined && ud.lodWant < 1 && m.geometry === ud.lodFull) m.geometry = ud.lodLow
      d = new Deformable(m)
      dented.set(m, d)
      live++
    }
    if (d.apply(im, intoOtherSide)) {
      n++
      pending.add(d)
    }
  })
  if (n) lastDent.set(root, now)
  return n
}

/** Push this frame's dents to the GPU. Once per frame, from the main loop. Returns how many went. */
export function flushDents(): number {
  let n = 0
  const deadline = performance.now() + FLUSH_MS_PER_FRAME
  for (const d of pending) {
    if (n > 0 && performance.now() >= deadline) break
    pending.delete(d)
    if (d.flush()) n++
  }
  return n
}

/**
 * Straighten every dented mesh under `root` and FREE its dent: the recycled wreck, the R key, a
 * car that left the player's sight. The mesh goes back to the shared geometry it was cloned from,
 * which is exactly the undented shape, and the clone and its GPU buffers are released (see
 * `Deformable.dispose`). Returns how many meshes were released.
 */
export function releaseObject(root: THREE.Object3D): number {
  let n = 0
  root.traverse((o) => {
    const m = o as THREE.Mesh
    const d = dented.get(m)
    if (!d) return
    d.dispose()
    dented.delete(m)
    live--
    pending.delete(d)
    n++
  })
  return n
}

/** Straighten every dented mesh under `root`. A release: a repaired car carries no clone. */
export function repairObject(root: THREE.Object3D): number {
  return releaseObject(root)
}

/** how many meshes carry a dent clone right now — the bound the traffic layer holds, for a probe */
export function dentedMeshes(): number {
  return live
}

/** how many meshes are waiting for a flush — for a probe */
export function pendingDents(): number {
  return pending.size
}
