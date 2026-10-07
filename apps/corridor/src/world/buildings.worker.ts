// Building massing, off the main thread.
//
// The pure geometry lives in `massing.ts` (no THREE, no DOM); this file is only the message
// plumbing. A cell posts its footprint list and gets back the merged massing arrays as
// transferables, so the main thread does no per-vertex work and allocates none of it.

import { buildMassing, type MassInput, type MassPool } from './massing'

interface Job {
  id: number
  list: MassInput[]
  pool: MassPool | null
}

self.onmessage = async (ev: MessageEvent<Job>) => {
  const job = ev.data
  try {
    const r = await buildMassing(job.list, job.pool)
    const transfer: Transferable[] = [r.pos.buffer, r.col.buffer, r.pal.buffer, r.lay.buffer, r.idx.buffer, r.norm.buffer]
    self.postMessage({ id: job.id, pos: r.pos, col: r.col, pal: r.pal, lay: r.lay, idx: r.idx, norm: r.norm, gabled: r.gabled, fromLidar: r.fromLidar }, { transfer })
  } catch (err) {
    self.postMessage({ id: job.id, error: String((err as Error)?.message ?? err) })
  }
}
