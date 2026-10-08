/**
 * A lighter copy of a geometry, simplified in a worker (simplify.worker.ts), cached per source.
 *
 * The copy has its OWN, compact vertex attributes: only the vertices the shorter index still uses,
 * renumbered. It used to share the source's attributes and carry only a new index, which looked
 * free — but a 5% copy of a traffic car then had 4,052 triangles over 101,532 vertices, and every
 * per-vertex cost downstream was still the full car's: a dent cloned and re-normalled 101k vertices,
 * forty dented cars held 216 MB of clones, and each upload moved megabytes (2026-10-08). Every
 * clone of an asset (they share geometry) asks once and gets the same copy.
 *
 * Never dispose a copy made here: it is shared by every mesh drawn from the same source, and lives
 * as long as the page, like the asset cache it came from.
 */
import * as THREE from 'three'

let worker: Worker | null = null
let seq = 0
const waiting = new Map<number, (r: { indices?: Uint32Array; remap?: Uint32Array; unique?: number; failed?: string }) => void>()
const cache = new Map<string, Promise<THREE.BufferGeometry | null>>()

function simplifier(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./simplify.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const d = e.data as { id: number; indices?: Uint32Array; remap?: Uint32Array; unique?: number; failed?: string }
      waiting.get(d.id)?.(d)
      waiting.delete(d.id)
    }
  }
  return worker
}

/**
 * `attr` with only the vertices the compact index uses, in their new order. `remap[old]` is the new
 * slot, or a value past `unique` for a vertex the simplified mesh dropped. Null for an attribute
 * that cannot be copied this way (interleaved).
 */
function compact(attr: THREE.BufferAttribute, remap: Uint32Array, unique: number): THREE.BufferAttribute | null {
  if ((attr as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return null
  const src = attr.array as ArrayLike<number>
  const k = attr.itemSize
  // the same typed array as the source, so a normalized Uint8 colour stays a Uint8 colour
  const Ctor = (src as unknown as { constructor: unknown }).constructor as new (n: number) => THREE.TypedArray
  const dst = new Ctor(unique * k)
  const n = Math.min(attr.count, remap.length)
  for (let i = 0; i < n; i++) {
    const j = remap[i]
    if (j >= unique) continue
    for (let c = 0; c < k; c++) dst[j * k + c] = src[i * k + c]
  }
  const out = new THREE.BufferAttribute(dst, k, attr.normalized)
  return out
}

/**
 * `geo` at about `ratio` of its triangles, or null if it cannot be simplified (no positions, a
 * failure in the worker). `error` is meshoptimizer's relative error budget: how far the surface may
 * move, as a fraction of the mesh's size.
 */
export function simplified(geo: THREE.BufferGeometry, ratio: number, error = 0.02): Promise<THREE.BufferGeometry | null> {
  const key = `${geo.uuid}@${ratio}@${error}`
  const hit = cache.get(key)
  if (hit) return hit
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!pos || pos.itemSize !== 3 || (pos as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return Promise.resolve(null)
  const p = new Promise<THREE.BufferGeometry | null>((resolve) => {
    const id = ++seq
    waiting.set(id, (r) => {
      if (!r.indices || !r.remap || r.unique === undefined) { console.warn('simplify:', r.failed); resolve(null); return }
      const out = new THREE.BufferGeometry()
      for (const [name, attr] of Object.entries(geo.attributes)) {
        const c = compact(attr as THREE.BufferAttribute, r.remap, r.unique)
        if (c) out.setAttribute(name, c)
      }
      // a compact mesh almost always fits a 16-bit index: half the bytes, and the fast path in three
      out.setIndex(new THREE.BufferAttribute(r.unique <= 65535 ? Uint16Array.from(r.indices) : r.indices, 1))
      out.boundingBox = geo.boundingBox
      out.boundingSphere = geo.boundingSphere
      out.name = `${geo.name || 'mesh'}:lod`
      resolve(out)
    })
    // copies: the source keeps its own arrays (they are its GPU upload's source)
    const positions = new Float32Array(pos.array as ArrayLike<number>)
    const idx = geo.index ? new Uint32Array(geo.index.array as ArrayLike<number>) : null
    simplifier().postMessage({ id, positions, indices: idx, ratio, error }, idx ? [positions.buffer, idx.buffer] : [positions.buffer])
  })
  cache.set(key, p)
  return p
}

/**
 * Draw every mesh under `root` at `ratio` of its triangles (1 = the original), swapping between the
 * mesh's own geometry and a simplified copy. Swapped back and forth freely; the copy is made once.
 *
 * A mesh wearing a geometry that is neither — a dent's private clone (dents.ts) — is left alone:
 * a dented car keeps the dent. Async: a mesh draws as it is until its copy arrives from the worker.
 */
export function setDetail(root: THREE.Object3D, ratio: number): void {
  const want = ratio >= 0.999 ? 1 : ratio
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.geometry) return
    const ud = m.userData as { lodFull?: THREE.BufferGeometry; lodLow?: THREE.BufferGeometry; lodLowRatio?: number; lodWant?: number }
    ud.lodFull ??= m.geometry
    const full = ud.lodFull
    if (m.geometry !== full && m.geometry !== ud.lodLow) return
    ud.lodWant = want
    if (want === 1) { if (m.geometry !== full) m.geometry = full; return }
    if (ud.lodLow && ud.lodLowRatio === want) { if (m.geometry !== ud.lodLow) m.geometry = ud.lodLow; return }
    void simplified(full, want).then((g) => {
      if (!g || ud.lodWant !== want) return
      // still wearing one of ours (not a dent that arrived meanwhile)
      if (m.geometry !== full && m.geometry !== ud.lodLow) return
      ud.lodLow = g
      ud.lodLowRatio = want
      m.geometry = g
    })
  })
}
