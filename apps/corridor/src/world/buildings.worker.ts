// Building geometry, off the main thread.
//
// The pure geometry lives in `massing.ts` and `dressingdraw.ts` (no THREE, no DOM); this file is
// only the message plumbing. A cell posts its footprint list and gets back merged arrays as
// transferables, so the main thread does no per-vertex work and allocates none of it.
//
// Dressing has one wrinkle the massing does not: a driveway slab's four corners each take their
// own ground height, and the ground sampler lives on the main thread. So a dressing job runs in
// two messages — plan and collect the slab corners, ask the main thread to sample them, then draw
// with the values replayed. The picture is identical; only the number of round trips changed.

import { buildMassing, type MassInput, type MassPool } from './massing'
import { planBuilding, drawSite, slabCorners, DRESS, type DressBuild } from './dressingdraw'
import type { DressingSite, Footprint } from './dressing'

interface MassJob {
  kind: 'mass'
  id: number
  list: MassInput[]
  pool: MassPool | null
}

interface DressJob {
  kind: 'dress'
  id: number
  buildings: { bd: Footprint; base: number; street: [number, number] | null }[]
  windowWalls: number
}

interface GroundJob {
  kind: 'ground'
  id: number
  /** site x, y pairs, one per slab corner, in draw order */
  values: Float32Array
}

type Job = MassJob | DressJob | GroundJob

/** A dressing job parked between its plan and its ground values. */
const plannedDress = new Map<number, { build: DressBuild; sites: DressingSite[] }>()

const emptyBuild = (): DressBuild => ({ pos: [], col: [], pal: [], lay: [], idx: [] })

self.onmessage = async (ev: MessageEvent<Job>) => {
  const job = ev.data
  try {
    if (job.kind === 'mass') {
      const r = await buildMassing(job.list, job.pool)
      const transfer: Transferable[] = [r.pos.buffer, r.col.buffer, r.pal.buffer, r.lay.buffer, r.idx.buffer, r.norm.buffer]
      self.postMessage({ kind: 'mass', id: job.id, pos: r.pos, col: r.col, pal: r.pal, lay: r.lay, idx: r.idx, norm: r.norm, gabled: r.gabled, fromLidar: r.fromLidar }, { transfer })
      return
    }
    if (job.kind === 'dress') {
      const sites: DressingSite[] = []
      const q: number[] = []
      for (const g of job.buildings) {
        for (const s of planBuilding(g.bd, g.base, g.street, job.windowWalls)) {
          sites.push(s)
          // exactly the corners `drawSite` will ask for, in order
          if (DRESS[s.part]?.kind === 'slab') for (const [x, y] of slabCorners(s)) q.push(x, y)
        }
      }
      if (q.length) {
        plannedDress.set(job.id, { build: emptyBuild(), sites })
        const corners = Float64Array.from(q)
        self.postMessage({ kind: 'ground', id: job.id, q: corners }, { transfer: [corners.buffer] })
      } else {
        finishDress(job.id, emptyBuild(), sites, null)
      }
      return
    }
    // kind === 'ground'
    const parked = plannedDress.get(job.id)
    if (!parked) return
    plannedDress.delete(job.id)
    finishDress(job.id, parked.build, parked.sites, job.values)
  } catch (err) {
    self.postMessage({ kind: (job as { kind?: string }).kind ?? 'mass', id: (job as { id?: number }).id, error: String((err as Error)?.message ?? err) })
  }
}

function finishDress(id: number, build: DressBuild, sites: DressingSite[], grounds: Float32Array | null): void {
  let gc = 0
  // `drawSite` calls this once per slab corner, in the order the corners were collected, so a
  // straight cursor replays them. NaN is the main thread's "no ground here" (null). No slabs at
  // all means `grounds` is null and this is never called.
  const ground = grounds ? (_x: number, _y: number) => { const v = grounds[gc++]; return Number.isNaN(v) ? null : v } : () => null
  let dressed = 0
  for (const s of sites) {
    if (!DRESS[s.part]) continue
    dressed++
    drawSite(build, s, ground)
  }
  const pos = Float32Array.from(build.pos)
  const col = Float32Array.from(build.col)
  const idx = Uint32Array.from(build.idx)
  const transfer: Transferable[] = [pos.buffer, col.buffer, idx.buffer]
  self.postMessage({ kind: 'dress', id, pos, col, idx, dressed }, { transfer })
}
