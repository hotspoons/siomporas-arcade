// Serve-time replay of the way-tiling bake fix, for testing it on an ALREADY-BAKED world.
//
// `export.py` now writes a polyline into every tile its vertices fall in (`_WAY_COORDS`), because a
// road keyed by its first vertex vanishes from every tile it bridges: the viewer streams no spline
// there, `decksNear` has no carriageway to make a deck from, and the car falls through the overpass
// (`f7cf98b`, Paul's Whitfield Chapel Road report). A world baked before that fix still has the old
// holes, and re-baking dc-metro is heavy — so this proxy fetches every branch tile the manifest
// names, remembers each branch, and re-injects it into every tile its geometry actually touches.
// The output is what a fixed bake would write; the viewer (`takeBranch`, `addBranchSegments`)
// dedupes by id, so a road in two loaded tiles is built once.
//
// Everything else — the manifest, the raster tiles, `/api` — passes straight through. Point the
// viewer at it with `?data=`:
//
//     node probes/vtproxy.mjs                       # listens on :5190
//     # then load:  http://localhost:5186/#dc-metro-take-2?data=http://127.0.0.1:5190
//
// (Or, to expose it to a browser elsewhere, tunnel this port and pass that URL as `?data=`.)
// It is a stopgap: when the world is next baked, delete it. `probes/.build/bridgefix.mjs` drives
// the overpass across it and against the raw remote to show the difference.
import http from 'node:http'

const REMOTE = process.env.VT_REMOTE ?? 'https://worldeditor.richard-siomporas.basedweights.com'
const PORT = Number(process.env.VT_PORT ?? 5190)
const SLUG = process.env.VT_SLUG ?? 'dc-metro-take-2'
const SIZE = Number(process.env.VT_SIZE ?? 1000)

// id -> { rec, cells:Set<string> }
const branches = new Map()
let prefetch = null

const branchKey = (br) =>
  br.id ?? `${br.coords?.[0]?.[0]},${br.coords?.[0]?.[1]},${br.coords?.length},${br.name ?? ''}`

function cellsOf(coords) {
  const out = new Set()
  for (const p of coords ?? []) if (p && p[0] != null && p[1] != null) out.add(`${Math.floor(p[0] / SIZE)}_${Math.floor(p[1] / SIZE)}`)
  return out
}

function register(obj) {
  for (const br of obj?.branches ?? []) {
    const id = branchKey(br)
    if (!branches.has(id)) branches.set(id, { rec: br, cells: cellsOf(br.coords) })
  }
}

async function fetchTile(x, y) {
  const r = await fetch(`${REMOTE}/sites/${SLUG}/web/vt/0/${x}_${y}.json`)
  return r.ok ? r.json() : null
}

/** Read the manifest's branch index once and scan every tile that holds a road. */
async function doPrefetch() {
  const t0 = Date.now()
  const man = await (await fetch(`${REMOTE}/sites/${SLUG}/web/manifest.json`)).json()
  const work = (man?.vt?.branch ?? []).map((t) => [t.x, t.y])
  let done = 0
  let i = 0
  await Promise.all(Array.from({ length: 24 }, async () => {
    while (i < work.length) {
      const [x, y] = work[i++]
      try { const obj = await fetchTile(x, y); if (obj) register(obj) } catch { /* a tile may 404 */ }
      if (++done % 200 === 0) console.error(`vtproxy: ${done}/${work.length} tiles, ${branches.size} branches, ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
  }))
  console.error(`vtproxy: ready — ${work.length} tiles, ${branches.size} branches, ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://this')
  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
  const tile = url.pathname.match(/^\/sites\/([^/]+)\/web\/vt\/\d+\/(\d+)_(\d+)\.json$/)
  if (!tile) {
    try {
      const r = await fetch(`${REMOTE}${url.pathname}${url.search}`)
      const ct = r.headers.get('content-type')
      res.writeHead(r.status, ct ? { ...cors, 'content-type': ct } : cors)
      res.end(Buffer.from(await r.arrayBuffer()))
    } catch (e) { res.writeHead(502); res.end(String(e)) }
    return
  }
  try {
    if (!prefetch) prefetch = doPrefetch()
    await prefetch
    const cell = `${tile[2]}_${tile[3]}`
    const obj = (await fetchTile(Number(tile[2]), Number(tile[3]))) ?? {}
    register(obj)
    const have = new Set((obj.branches ?? []).map(branchKey))
    const add = []
    for (const [id, { rec, cells }] of branches) if (cells.has(cell) && !have.has(id)) add.push(rec)
    if (add.length) obj.branches = [...(obj.branches ?? []), ...add]
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  } catch (e) { res.writeHead(502, cors); res.end(JSON.stringify({ error: String(e) })) }
})

server.listen(PORT, () => console.error(`vtproxy: listening on ${PORT}, remote ${REMOTE}`))
