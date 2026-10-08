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
 * Out: { id, indices: Uint32Array, error }  — an index list over the SAME vertices, so the caller can
 *      share the original's vertex buffers and only the index buffer is new.
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
    ;(self as unknown as Worker).postMessage({ id, indices: out, error: err }, [out.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, failed: String((err as Error)?.message ?? err) })
  }
}
