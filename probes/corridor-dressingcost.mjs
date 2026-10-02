// How much geometry the building dressing costs on the biggest site we have, and whether it still
// fits in the budget.
//
// The first version of the renderer drew every part as a six-face box with three fresh vertices a
// triangle. On crofton-triangle's 7506 footprints that is 2,062,980 triangles and 223 MB of vertex
// data for windows, gutters and mailboxes — which is not a thing you notice by looking at one
// house, and is why this probe exists rather than a rule of thumb. What brought it down to 693k
// and 50 MB: indexed quads, a gutter drawn as a line rather than a solid, box faces that are
// against a wall or the ground dropped, the window frame spent only on the street elevation, and
// a budget on how many elevations get glass at all.
//
// It runs on the MANIFEST, not in a browser: the numbers are a property of the plan, and asking a
// SwiftShader tab to build 7506 buildings takes two minutes and then crashes.
//
//   node probes/corridor-dressingcost.mjs          # the default 3-elevation budget
//   WALLS=4 node probes/corridor-dressingcost.mjs  # all four, the worst case
import { readFileSync } from 'node:fs'
const m = JSON.parse(readFileSync('tools/corridor/data/sites/crofton-triangle/web/manifest.json', 'utf8'))
const { planDressing, RoadIndex } = await import('../apps/corridor/src/world/dressing.ts').catch(async () => {
  // no TS loader: compile on the fly with esbuild, which the repo already has
  const { build } = await import('esbuild')
  const r = await build({ entryPoints: ['apps/corridor/src/world/dressing.ts'], bundle: true, format: 'esm', write: false, platform: 'node' })
  const { pathToFileURL } = await import('node:url')
  const { writeFileSync } = await import('node:fs')
  writeFileSync('/tmp/_dress.mjs', r.outputFiles[0].text)
  return import(pathToFileURL('/tmp/_dress.mjs').href)
})
const KIT = JSON.parse(readFileSync('tools/assetlib/specs/buildings-dressing.json', 'utf8')).assets
const lines = []
if (m.spine?.coords) lines.push(m.spine.coords.map(([x, y]) => [x, y]))
for (const s of m.siblings ?? []) lines.push(s)
for (const d of m.driveways ?? []) lines.push(d.coords.map(([x, y]) => [x, y]))
const idx = new RoadIndex(lines)
let parts = 0, dressed = 0, far = 0
const byPart = {}
const frontByPart = {}
for (const b of m.buildings ?? []) {
  const ring = b.ring ?? []
  if (ring.length < 3) continue
  const cx = ring.reduce((t, p) => t + p[0], 0) / ring.length
  const cy = ring.reduce((t, p) => t + p[1], 0) / ring.length
  const st = idx.nearest(cx, cy, 80)
  if (!st) far += 1
  const s = planDressing(b, KIT, { street: st, windowWalls: Number(process.env.WALLS ?? 3) })
  if (s.length) dressed += 1
  parts += s.length
  for (const x of s) {
    byPart[x.part] = (byPart[x.part] ?? 0) + 1
    if (x.front) frontByPart[x.part] = (frontByPart[x.part] ?? 0) + 1
  }
}
// the same accounting buildings.ts does: a quad is 2 tris and 4 verts
const TRIM = new Set(['window-double-hung-white', 'window-picture-large', 'window-commercial-storefront', 'door-front-panelled', 'door-garage-sectional'])
const FLAT = new Set(['driveway-concrete-apron', 'gutter-half-round-run', 'roof-vent-ridge', 'meter-box-utility', 'mailbox-wall-mounted'])
let quads = 0
const FLUSH = new Set(['downpipe-round', 'porch-step-concrete', 'awning-fabric-shop', 'fire-escape-landing'])
for (const [k, n] of Object.entries(byPart)) quads += n * (FLAT.has(k) ? 1 : TRIM.has(k) ? 1 : FLUSH.has(k) ? 4 : 5)
for (const [k, n] of Object.entries(frontByPart)) if (TRIM.has(k)) quads += n  // the frame, street side only
const tris = quads * 2
console.log('buildings', (m.buildings ?? []).length, 'dressed', dressed, 'no road within 80 m', far)
console.log('parts', parts, 'quads', quads, 'tris', tris, 'verts', quads * 4, 'MB', ((quads * 4 * 36) / 1e6).toFixed(1))
console.log(Object.entries(byPart).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('\n'))

// the budget. One extra draw call is free; a million triangles and a hundred megabytes is not,
// and the way that regresses is somebody making one part a solid because it looked better on one
// house. Generous enough not to fire on a change of a few per cent.
const MAX_TRIS = 1_000_000
const MAX_MB = 80
const mb = (quads * 4 * 36) / 1e6
const bad = []
if (tris > MAX_TRIS) bad.push(`${tris} triangles over the ${MAX_TRIS} budget`)
if (mb > MAX_MB) bad.push(`${mb.toFixed(1)} MB of vertex data over the ${MAX_MB} MB budget`)
if (!parts) bad.push('nothing was planned at all — the kit or the manifest did not load')
if (bad.length) { console.log('FAIL: ' + bad.join('; ')); process.exit(1) }
console.log(`PASS: ${tris} triangles, ${mb.toFixed(1)} MB — inside the ${MAX_TRIS}/${MAX_MB} MB budget`)
