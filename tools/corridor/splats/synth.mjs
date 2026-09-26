// A SYNTHETIC SPLAT WORLD, laid along a site's own road.
//
// The viewer half of the splat work (docs/corridor/PLAN-SPLAT-CORRIDORS.md, Track B) must not wait
// for a capture to be trained: the frame composition, the fit, the streaming, the crossfade and
// the depth interaction are all testable against gaussians we make ourselves — and unlike a
// photoreal capture, a made-up world is deterministic, so a probe can assert pixels against it for
// ever.
//
// What it writes is exactly what gaussworks' `merge` writes, so the viewer cannot tell the
// difference:
//
//     <out>/world.json     frame "enu", origin {lat, lon}, cell_m, tiles[]
//     <out>/corridor.json  radius_m, height_band_m, passes[{points}]
//     <out>/tiles/*.ply    3DGS PLY (x y z, f_dc_*, opacity, scale_*, rot_*)
//
// THE ORIGIN IS DELIBERATELY NOT THE SITE'S ANCHOR. A real capture anchors wherever it started,
// which is the whole reason §2.1 of the plan exists: two ENU frames a kilometre apart are not
// related by a translation. This lays the ribbon down the road in the SITE's frame, converts every
// point into a frame anchored `--origin-km` away through ECEF, and declares that origin. A viewer
// that composes the frames correctly puts the ribbon back on the road; one that treats the
// difference as a translation misses by a measurable half-metre.
//
//   npx tsx tools/corridor/splats/synth.mjs crofton-triangle --out tools/corridor/data/splats/synth-crofton
//   ... --length 600 --origin-km 1.5 --depth-test
//
// `--depth-test` adds three sheets whose visibility is unambiguous — one 30 m ahead of the photo
// stance, one 30 m behind it, one buried 20 m under the ground — which is what
// probes/corridor-splatdepth.mjs looks for.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { geodeticToEcef, ecefToGeodetic, enuBasis } from '../../../packages/engine/src/geo/wgs84.ts'

const args = process.argv.slice(2)
const slug = args[0] ?? 'crofton-triangle'
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const flag = (name) => args.includes(`--${name}`)
const out = opt('out', `tools/corridor/data/splats/synth-${slug}`)
const LENGTH = Number(opt('length', 600))        // metres of road either side of the photo station
const ORIGIN_KM = Number(opt('origin-km', 1.5))  // how far the capture's own anchor sits from the site's
const CELL_M = Number(opt('cell-m', 200))
const STEP = Number(opt('step', 0.6))            // along-road spacing of the ribbon's gaussians
const DEPTH_TEST = flag('depth-test')

const site = JSON.parse(readFileSync(`tools/corridor/data/sites/${slug}/web/manifest.json`, 'utf8'))
const anchor = site.frame?.anchor
if (!anchor) throw new Error(`${slug} has no frame.anchor — it was baked before the geodetic frame`)

// ---- frames -----------------------------------------------------------------------------------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const enuToEcef = (a, e) => {
  const B = enuBasis(a.lon, a.lat), o = geodeticToEcef(a.lon, a.lat, a.h ?? 0)
  return [0, 1, 2].map((i) => o[i] + B.east[i] * e[0] + B.north[i] * e[1] + B.up[i] * e[2])
}
const ecefToEnu = (a, p) => {
  const B = enuBasis(a.lon, a.lat), o = geodeticToEcef(a.lon, a.lat, a.h ?? 0)
  const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]
  return [dot(d, B.east), dot(d, B.north), dot(d, B.up)]
}
// the capture's own anchor: ORIGIN_KM north-east of the site's, as a real capture's would be
const capEcef = enuToEcef(anchor, [ORIGIN_KM * 707, ORIGIN_KM * 707, 0])
const cap = ecefToGeodetic(capEcef[0], capEcef[1], capEcef[2])
const capAnchor = { lon: cap.lon, lat: cap.lat, h: cap.h }
/** site ENU (east, north, up) -> capture ENU */
const toCapture = (e, n, u) => ecefToEnu(capAnchor, enuToEcef(anchor, [e, n, u]))

// ---- the road the ribbon follows ---------------------------------------------------------------
const coords = site.spine.coords // [[x (east), y (north), z (up)], ...] in site ENU
const cum = [0]
for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]))
const total = cum[cum.length - 1]
const photoS = Math.min(total, Math.max(0, site.spine.photo_s ?? total / 2))
const at = (s) => {
  s = Math.min(total, Math.max(0, s))
  let i = 1
  while (i < cum.length - 1 && cum[i] < s) i++
  const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1])
  const p = [0, 1, 2].map((k) => coords[i - 1][k] * (1 - t) + coords[i][k] * t)
  const dx = coords[i][0] - coords[i - 1][0], dy = coords[i][1] - coords[i - 1][1]
  const L = Math.hypot(dx, dy) || 1
  return { p, dir: [dx / L, dy / L], normal: [-dy / L, dx / L] }
}

// ---- the gaussians ------------------------------------------------------------------------------
/** one splat: site ENU position, colour 0..1, radius in metres, opacity 0..1 */
const splats = []
const push = (e, n, u, col, r, a = 0.95) => splats.push({ e, n, u, col, r, a })
const s0 = Math.max(0, photoS - LENGTH / 2), s1 = Math.min(total, photoS + LENGTH / 2)
for (let s = s0; s <= s1; s += STEP) {
  const { p, normal } = at(s)
  const [nx, ny] = normal
  // a painted ribbon just over the road: the eye can see at a glance whether the world landed right
  for (const off of [-2.6, -1.3, 0, 1.3, 2.6]) {
    const shade = 0.55 + 0.45 * Math.sin(s * 0.08)
    push(p[0] + nx * off, p[1] + ny * off, p[2] + 0.45, [0.95 * shade, 0.25, 0.75 * shade], 0.35)
  }
  // two hedges, eight metres out, two metres tall: something with height, so the depth test and the
  // crossfade have a surface that is not flat on the ground
  for (const side of [-1, 1]) {
    for (let h = 0.3; h <= 2.1; h += 0.6) {
      const g = 0.35 + 0.3 * Math.sin(s * 0.21 + h)
      push(p[0] + nx * 8 * side, p[1] + ny * 8 * side, p[2] + h + 0.4, [0.15, g, 0.18], 0.5)
    }
  }
}

// three unambiguous sheets for probes/corridor-splatdepth.mjs
const sheets = []
if (DEPTH_TEST) {
  const mk = (name, s, up, col) => {
    const { p, normal } = at(s)
    const [nx, ny] = normal
    const first = splats.length
    for (let a = -6; a <= 6; a += 0.4) for (let h = 0; h <= 6; h += 0.4) {
      push(p[0] + nx * a, p[1] + ny * a, p[2] + up + h, col, 0.3, 1)
    }
    sheets.push({ name, s, up, colour: col, splats: splats.length - first, centre: [p[0], p[1], p[2] + up + 3] })
  }
  mk('ahead', photoS + 30, 1.0, [1, 0.1, 0.1])     // in front of the camera: must be visible
  mk('behind', photoS - 30, 1.0, [0.1, 0.1, 1])    // behind it: must not be
  mk('buried', photoS + 60, -26, [0.1, 1, 0.1])    // under the ground: must be occluded by the terrain
}

// ---- tiles ---------------------------------------------------------------------------------------
const cells = new Map()
for (const sp of splats) {
  const c = toCapture(sp.e, sp.n, sp.u)
  const key = `${Math.floor(c[0] / CELL_M)}_${Math.floor(c[1] / CELL_M)}`
  const arr = cells.get(key) ?? []
  arr.push({ ...sp, c })
  cells.set(key, arr)
}

/** 3DGS PLY: the fields every reader expects, little-endian binary */
function writePly(path, rows) {
  const FIELDS = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${FIELDS.map((f) => `property float ${f}`).join('\n')}\nend_header\n`
  const body = Buffer.alloc(rows.length * FIELDS.length * 4)
  const SH_C0 = 0.28209479177387814
  const logit = (p) => Math.log(p / (1 - p))
  let o = 0
  for (const r of rows) {
    // gaussworks ENU is (east, north, up) and so is the viewer's site frame — the y-up swap is the
    // viewer's business (toWorld), not the file's
    const v = [
      r.c[0], r.c[1], r.c[2], 0, 0, 1,
      (r.col[0] - 0.5) / SH_C0, (r.col[1] - 0.5) / SH_C0, (r.col[2] - 0.5) / SH_C0,
      logit(Math.min(0.999, Math.max(0.001, r.a))),
      Math.log(r.r), Math.log(r.r), Math.log(r.r),
      1, 0, 0, 0,
    ]
    for (const x of v) { body.writeFloatLE(x, o); o += 4 }
  }
  writeFileSync(path, Buffer.concat([Buffer.from(header, 'ascii'), body]))
  return body.length + header.length
}

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'tiles'), { recursive: true })
const tiles = []
let bytes = 0
for (const [key, rows] of [...cells].sort()) {
  const [cx, cy] = key.split('_').map(Number)
  const name = `chunk_x${cx}_y${cy}.ply`
  bytes += writePly(join(out, 'tiles', name), rows)
  const xs = rows.map((r) => r.c[0]), ys = rows.map((r) => r.c[1])
  tiles.push({
    tile: name,
    chunk: `chunk_x${cx}_y${cy}`,
    bounds_enu_m: [cx * CELL_M, cy * CELL_M, (cx + 1) * CELL_M, (cy + 1) * CELL_M],
    centre: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2],
    gaussians: rows.length,
    owned: rows.length,
    source: rows.length,
  })
}

// the capture corridor: the road itself, which is where the camera would have driven
const pass = []
for (let s = s0; s <= s1; s += 5) {
  const { p } = at(s)
  const c = toCapture(p[0], p[1], p[2] + 1.9) // a camera on the roof, not on the tarmac
  pass.push(c.map((v) => +v.toFixed(3)))
}
const us = pass.map((p) => p[2])
writeFileSync(join(out, 'corridor.json'), JSON.stringify({
  frame: 'enu',
  origin: { lat: capAnchor.lat, lon: capAnchor.lon },
  radius_m: 25,
  height_band_m: [Math.min(...us) - 8, Math.max(...us) + 8],
  passes: [{ video: 'synthetic', seq_range: [0, pass.length - 1], points: pass }],
}, null, 1))
writeFileSync(join(out, 'world.json'), JSON.stringify({
  frame: 'enu',
  origin: { lat: capAnchor.lat, lon: capAnchor.lon },
  cell_m: CELL_M,
  gaussians: splats.length,
  source_gaussians: splats.length,
  corridor_pruned: false,
  corridor: 'corridor.json',
  corridor_passes: 1,
  synthetic: { site: slug, length_m: LENGTH, origin_km: ORIGIN_KM, depth_test: DEPTH_TEST, sheets, camera_height_m: 1.9 },
  tiles,
}, null, 1))
console.log(JSON.stringify({
  out, site: slug, splats: splats.length, tiles: tiles.length, MB: +(bytes / 1e6).toFixed(1),
  siteAnchor: anchor, captureOrigin: { lat: +capAnchor.lat.toFixed(7), lon: +capAnchor.lon.toFixed(7) },
  originOffsetKm: ORIGIN_KM, sheets: sheets.map((s) => s.name),
}, null, 1))
