/**
 * The map's roads, off the main thread: fetch the bake's `context.json`, project every road into
 * the site frame, and hand back merged segment buckets and label anchors.
 *
 * `context.json` is the bake's compact projection of the OSM extract (tools/corridor/corridor/
 * osm.py `context`): every road in the world with its class already resolved and its name. The
 * game's minimap reads the same file in its own worker (game/move/minimap.worker.ts) — on
 * dc-metro-take-2 it is 47 MB of JSON and 875 k vertices, a parse that has no business on the
 * thread drawing the editor. Nothing new is fetched for the map: this is the file the game
 * already loads.
 *
 * Protocol (maproads.ts):
 *   → { type: 'load', url, frame, cell }
 *   ← { type: 'none', status }                 no context.json for this world
 *   ← { type: 'buckets', names, buckets, ms }  every road, bucketed (buffers transferred)
 *   ← { type: 'error', message }
 */
import { siteProjector } from '../../game/move/siteproj'
import { bucketRoads, type RoadLine } from './maproads.data'

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as { type: string; url: string; frame: Parameters<typeof siteProjector>[0]; cell: number }
  if (msg.type !== 'load') return
  try {
    const t0 = performance.now()
    const r = await fetch(msg.url, { cache: 'force-cache' })
    if (!r.ok) {
      ;(self as unknown as Worker).postMessage({ type: 'none', status: r.status })
      return
    }
    const ctx = (await r.json()) as { roads?: { cls: string; name?: string | null; coords: number[][] }[] }
    const proj = siteProjector(msg.frame)
    const lines: RoadLine[] = []
    for (const rd of ctx.roads ?? []) {
      const n = rd.coords?.length ?? 0
      if (n < 2) continue
      const xy = new Float32Array(n * 2)
      for (let i = 0; i < n; i++) {
        const [x, y] = proj(rd.coords[i][0], rd.coords[i][1])
        xy[i * 2] = x
        xy[i * 2 + 1] = y
      }
      lines.push({ cls: rd.cls, name: rd.name ?? null, xy, z: null })
    }
    const out = bucketRoads(lines, msg.cell)
    const transfer: Transferable[] = []
    for (const b of out.buckets) transfer.push(b.xy.buffer, b.z.buffer, b.segs.buffer, b.style.buffer, b.labels.x.buffer, b.labels.y.buffer, b.labels.ang.buffer, b.labels.name.buffer, b.labels.rank.buffer)
    ;(self as unknown as Worker).postMessage({ type: 'buckets', names: out.names, buckets: out.buckets, ms: performance.now() - t0, roads: lines.length }, transfer)
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ type: 'error', message: (e as Error).message })
  }
}
