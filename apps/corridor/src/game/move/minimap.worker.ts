/**
 * The minimap's linework, off the main thread.
 *
 * Rich, 2026-10-08: "Anything that can be moved off the main thread should be moved to a web worker."
 * A sampled profile of his tab put `MiniMap.draw` at 23.6% of all main-thread wall time — more than
 * half of the busy time — nearly all of it canvas `stroke` / `lineTo`: every other frame it stroked
 * EVERY road in the world (dc-metro's context.json) and every carriageway streamed so far, with no
 * culling to the few hundred metres the map shows.
 *
 * The roads do not change, so they are drawn ONCE per map tile, here, into an OffscreenCanvas, and
 * handed back as ImageBitmaps; the main thread only composites the handful of tiles in view. This
 * worker also does the fetch, the 47 MB JSON.parse and the projection of every coordinate, so none
 * of that — nor the arrays — touches the main thread.
 *
 * Protocol (minimap.ts):
 *   → { type: 'load', url, fallback, frame }        fetch + project the roads
 *   → { type: 'lines', layer: 'spine'|'siblings', lines: Float32Array[] }   our carriageways
 *   → { type: 'tile', id, k, tx, ty, px, levelPxPerM, dpr }
 *   ← { type: 'ready', roads }  |  { type: 'tile', id, bitmap }  |  { type: 'error', message }
 */
import { siteProjector } from './siteproj'

/** the classes the map draws, their stroke (CSS px) and colour, and how far in they appear */
const CLASS_STYLE: Record<string, { w: number; c: string; minPxPerM: number }> = {
  motorway: { w: 4, c: '#ffb648', minPxPerM: 0 },
  trunk: { w: 3.5, c: '#ffd07a', minPxPerM: 0 },
  primary: { w: 3, c: '#ffe8a8', minPxPerM: 0 },
  secondary: { w: 2.5, c: '#ffffff', minPxPerM: 0.02 },
  tertiary: { w: 2, c: '#e6e6e6', minPxPerM: 0.05 },
  motorway_link: { w: 2, c: '#ffb648', minPxPerM: 0.05 },
  residential: { w: 1.5, c: '#c9c9c9', minPxPerM: 0.12 },
  unclassified: { w: 1.5, c: '#c9c9c9', minPxPerM: 0.12 },
  service: { w: 1, c: '#9a9a9a', minPxPerM: 0.3 },
  track: { w: 1, c: '#8a7a5a', minPxPerM: 0.3 },
  railway: { w: 2, c: '#7a5aa0', minPxPerM: 0.02 },
  waterway: { w: 1.5, c: '#5a8ad0', minPxPerM: 0.05 },
}
/** draw order, background first; our own carriageways go on top of all of it */
const ORDER = ['waterway', 'railway', 'track', 'service', 'unclassified', 'residential', 'tertiary', 'secondary', 'motorway_link', 'primary', 'trunk', 'motorway', 'siblings', 'spine']
const OWN: Record<string, { w: number; c: string; minPxPerM: number }> = {
  siblings: { w: 2, c: '#ff8c00', minPxPerM: 0 },
  spine: { w: 3, c: '#ffdc00', minPxPerM: 0 },
}
const styleOf = (s: string) => CLASS_STYLE[s] ?? OWN[s]

/** A polyline cut into chunks of at most CHUNK points, each with its own box, so a tile asks only for what crosses it. */
interface Chunk { style: number; pts: Float32Array; x0: number; y0: number; x1: number; y1: number }
const CHUNK = 32
/** the spatial index's cell, metres */
const CELL = 500
const chunks: Chunk[] = []
const grid = new Map<string, number[]>()

function add(style: string, pts: Float32Array): void {
  const si = ORDER.indexOf(style)
  if (si < 0 || pts.length < 4) return
  for (let i = 0; i < pts.length - 2; i += (CHUNK - 1) * 2) {
    const end = Math.min(pts.length, i + CHUNK * 2)
    const sub = pts.slice(i, end)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let j = 0; j < sub.length; j += 2) {
      const x = sub[j], y = sub[j + 1]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    const id = chunks.push({ style: si, pts: sub, x0, y0, x1, y1 }) - 1
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const k = `${cx},${cy}`
        const list = grid.get(k)
        if (list) list.push(id)
        else grid.set(k, [id])
      }
    }
  }
}

async function load(url: string, fallback: string, frame: Parameters<typeof siteProjector>[0]): Promise<number> {
  const proj = siteProjector(frame)
  const project = (coords: number[][]) => {
    const pts = new Float32Array(coords.length * 2)
    for (let i = 0; i < coords.length; i++) {
      const [x, y] = proj(coords[i][0], coords[i][1])
      pts[i * 2] = x
      pts[i * 2 + 1] = y
    }
    return pts
  }
  let n = 0
  const r = await fetch(url, { cache: 'force-cache' })
  if (r.ok) {
    const ctx = (await r.json()) as { roads?: { cls: string; coords: number[][] }[] }
    for (const rd of ctx.roads ?? []) {
      if (!(rd.cls in CLASS_STYLE)) continue
      add(rd.cls, project(rd.coords))
      n++
    }
    return n
  }
  // a site baked before context.json: the raw extract, as the minimap always fell back to
  const f = await fetch(fallback, { cache: 'force-cache' })
  if (!f.ok) return 0
  const gj = (await f.json()) as { features: { geometry: { type: string; coordinates: number[][] }; properties: Record<string, string> }[] }
  for (const ft of gj.features) {
    if (ft.geometry.type !== 'LineString') continue
    const p = ft.properties
    const cls = p.highway ?? (p.railway ? 'railway' : p.waterway ? 'waterway' : null)
    if (!cls || !(cls in CLASS_STYLE)) continue
    add(cls, project(ft.geometry.coordinates))
    n++
  }
  return n
}

/** Draw one tile: the chunks crossing it, batched by style (one stroke per style), in draw order. */
function tile(k: number, tx: number, ty: number, px: number, levelPxPerM: number, dpr: number): ImageBitmap {
  const size = Math.max(1, Math.round(px * dpr))
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')!
  const S = px / levelPxPerM // tile side, metres
  const X0 = tx * S, Y1 = (ty + 1) * S
  // a margin of the widest stroke, so a line just outside still paints its edge into this tile
  const m = 4 / levelPxPerM
  const bx0 = X0 - m, bx1 = X0 + S + m, by0 = Y1 - S - m, by1 = Y1 + m
  const want = new Set<number>()
  for (let cx = Math.floor(bx0 / CELL); cx <= Math.floor(bx1 / CELL); cx++) {
    for (let cy = Math.floor(by0 / CELL); cy <= Math.floor(by1 / CELL); cy++) {
      for (const id of grid.get(`${cx},${cy}`) ?? []) {
        const c = chunks[id]
        if (c.x1 < bx0 || c.x0 > bx1 || c.y1 < by0 || c.y0 > by1) continue
        want.add(id)
      }
    }
  }
  const byStyle: number[][] = ORDER.map(() => [])
  for (const id of want) byStyle[chunks[id].style].push(id)
  const sc = levelPxPerM * dpr
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (let si = 0; si < ORDER.length; si++) {
    const ids = byStyle[si]
    if (!ids.length) continue
    const st = styleOf(ORDER[si])
    // detail fades with zoom, as it always did, judged at this tile's own scale
    if (levelPxPerM < st.minPxPerM) continue
    ctx.strokeStyle = st.c
    ctx.lineWidth = st.w * dpr
    ctx.beginPath()
    for (const id of ids) {
      const p = chunks[id].pts
      ctx.moveTo((p[0] - X0) * sc, (Y1 - p[1]) * sc)
      for (let j = 2; j < p.length; j += 2) ctx.lineTo((p[j] - X0) * sc, (Y1 - p[j + 1]) * sc)
    }
    ctx.stroke()
  }
  void k
  return canvas.transferToImageBitmap()
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: string; [k: string]: unknown }
  try {
    if (msg.type === 'load') {
      const roads = await load(msg.url as string, msg.fallback as string, msg.frame as Parameters<typeof siteProjector>[0])
      ;(self as unknown as Worker).postMessage({ type: 'ready', roads })
    } else if (msg.type === 'lines') {
      for (const pts of msg.lines as Float32Array[]) add(msg.layer as string, pts)
    } else if (msg.type === 'tile') {
      const bitmap = tile(msg.k as number, msg.tx as number, msg.ty as number, msg.px as number, msg.levelPxPerM as number, msg.dpr as number)
      ;(self as unknown as Worker).postMessage({ type: 'tile', id: msg.id, bitmap }, [bitmap])
    }
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ type: 'error', message: String((err as Error)?.message ?? err), id: msg.id })
  }
}
