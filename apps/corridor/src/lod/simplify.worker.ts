/**
 * Mesh simplification, off the main thread (meshoptimizer's simplifier, wasm).
 *
 * The reconstructions the game draws are far heavier than anything that small on screen needs: the
 * cash wad is 116,680 triangles, every traffic car ~118k — the finisher keeps 5% of what TRELLIS
 * returns, and TRELLIS now returns millions. Rich, 2026-10-08: lower the GPU cost of the flying money,
 * and move what can go off the main thread. Five faded wads cost 1.1 ms of GPU, and it is vertex work
 * (a depth pre-pass that halved the blending made it WORSE), so the cure is fewer triangles.
 *
 * Measured on the cash GLB: 116,680 → 5,704 triangles (ratio 0.05, Permissive), error 0.6%.
 *
 * In:  { id, positions: Float32Array (xyz), indices: Uint32Array | null, ratio, error }
 * Out: { id, indices: Uint32Array, remap: Uint32Array, unique: number, error } — the new index list,
 *      already renumbered onto a COMPACT vertex set, and the table that maps each old vertex to its
 *      new slot (a value >= unique means the vertex is not used). The caller rebuilds the attributes
 *      from the table. Without this the 5% copy of a car still carried every one of its 101,532
 *      vertices for 4,052 triangles, and everything per-vertex downstream — a dent's clone, its
 *      normals, its upload — paid for all of them (2026-10-08).
 */
import { MeshoptSimplifier } from 'meshoptimizer'

self.onmessage = async (e: MessageEvent) => {
  const { id, positions, indices, ratio, error } = e.data as { id: number; positions: Float32Array; indices: Uint32Array | null; ratio: number; error: number }
  try {
    await MeshoptSimplifier.ready
    const src = indices ?? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i)
    const target = Math.max(3, Math.floor((src.length * ratio) / 3) * 3)
    // PERMISSIVE, because a reconstruction is cut into texture islands: 62% of the cash wad's
    // vertices are duplicates along UV seams, and a plain simplify will not collapse across a seam —
    // it stalled at 55,494 of 116,680 triangles whatever the error budget. Permissive may cross them:
    // 5,704 triangles at 0.6% error. At the size these are drawn, a seam that smears is invisible.
    const [out, err] = MeshoptSimplifier.simplify(src, positions, 3, target, error, ['Permissive'])
    // compactMesh RENUMBERS `out` IN PLACE and hands back the old→new table for the attributes.
    // Applying the table to `out` a second time mapped most of it to the unused marker (0xffffffff):
    // 774 NaN normals per car and a normal recompute six times slower than it should be (2026-10-08).
    const [remap, unique] = MeshoptSimplifier.compactMesh(out)
    ;(self as unknown as Worker).postMessage({ id, indices: out, remap, unique, error: err }, [out.buffer, remap.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, failed: String((err as Error)?.message ?? err) })
  }
}
