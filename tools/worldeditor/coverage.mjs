// Which Overpass upstream holds which ground — by the extract's REAL boundary, not a box.
//
// THE FAILURE THIS IS FOR, measured 2026-10-10. The editor routed by fences on the URL:
//
//   http://overpass/api/interpreter#37.9/-79.5/39.8/-75.0      "the mid-Atlantic"
//
// That instance holds a Geofabrik MARYLAND extract, and the box takes in Washington, Arlington,
// Alexandria and Fairfax, none of which are in it. Asked for highways over Arlington it answers
// HTTP 200 with 0 ways (College Park, the control: 5,185; overpass-na over the same Arlington box:
// 4,346; over downtown Washington: 0 against 6,418). dc-metro-take-2 sits at 38.91 N, 77.01 W, its
// square is wholly inside that box, so the "tightest fence that covers" rule sent its whole bake to
// `overpass` — and 35.3% of the square is outside maryland.poly. Its context.json came back with
// 109,134 roads, 108,816 of them in Maryland: Washington and Virginia simply were not there, and
// nothing anywhere said so. overpass-na, which holds all of it, was never asked.
//
// So coverage is the extract's own polygon — Geofabrik publishes it, in index-v1.json and as a
// .poly beside every extract, and it is EXACTLY the polygon the extract was cut with (maryland.poly
// against the index geometry: symmetric difference 0.000000 of its area) — and an upstream that
// holds several imported regions has several polygons. Kept on the editor's volume, seeded from the
// deployment (WORLDEDITOR_OVERPASS_REGIONS), and grown by an `osm-import` run when a region is
// added to an instance (runs.mjs).
//
// THE FILE IS ALSO THE BAKE'S. `<data>/overpass/coverage.json` is on the volume every bake Job
// mounts, and `osm.py` reads it (CORRIDOR_OVERPASS_COVERAGE) to refuse — loudly, with a BakeFault
// — to send a query to an upstream that does not hold the whole of the query's area. The editor
// routes; the bake checks the routing. Either one alone has been wrong before.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/* ---- geometry, in lon/lat degrees ------------------------------------------------------------
 *
 * Planar degrees, on purpose. Every question here is "is this box inside that polygon", and
 * containment does not care about the metric — a box is inside a polygon in degrees exactly when
 * it is inside it on the ground, because both are drawn in the same lon/lat. The FRACTION outside
 * is reported in degree-area, which overstates the polar side of a tall box by a cosine; it is a
 * number for a person to read, never a threshold that decides anything but "zero or not".
 */

/** A GeoJSON Polygon or MultiPolygon as a list of polygons, each `[outer, ...holes]`. */
export function polygonsOf(geom) {
  if (!geom) return []
  if (geom.type === 'Polygon') return [geom.coordinates]
  if (geom.type === 'MultiPolygon') return geom.coordinates
  return []
}

/** |area| of a ring by the shoelace formula. Closed or open, either works. */
export function ringArea(ring) {
  let a = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % n]
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}

/**
 * A ring clipped to an axis-aligned box (Sutherland-Hodgman, four half-planes).
 *
 * The clip of a CONCAVE ring can come back with degenerate edges running along the box's sides,
 * which would matter for drawing and does not matter at all for area: those edges enclose nothing.
 * Area is all this is used for.
 */
export function clipRing(ring, box) {
  const edges = [
    (p) => p[0] >= box.west, (p) => p[0] <= box.east, (p) => p[1] >= box.south, (p) => p[1] <= box.north,
  ]
  const cut = [
    (a, b) => at(a, b, 0, box.west), (a, b) => at(a, b, 0, box.east), (a, b) => at(a, b, 1, box.south), (a, b) => at(a, b, 1, box.north),
  ]
  let out = ring
  for (let k = 0; k < 4 && out.length; k++) {
    const inside = edges[k]
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]
      const prev = input[(i + input.length - 1) % input.length]
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut[k](prev, cur))
        out.push(cur)
      } else if (inside(prev)) out.push(cut[k](prev, cur))
    }
  }
  return out
}

/** where the segment a→b crosses the line `coord[axis] = v` */
function at(a, b, axis, v) {
  const t = (v - a[axis]) / (b[axis] - a[axis])
  return axis === 0 ? [v, a[1] + t * (b[1] - a[1])] : [a[0] + t * (b[0] - a[0]), v]
}

export const boxArea = (b) => Math.max(0, b.east - b.west) * Math.max(0, b.north - b.south)

/**
 * Degree-area of `geom` inside `box`. Exact for a valid (multi)polygon: parts do not overlap and holes subtract.
 *
 * IN THE BOX'S OWN COORDINATES. Clipped in absolute degrees, the shoelace sums products of
 * coordinates near (−77, 39) to measure a box of 4.5e-4 square degrees, and the rounding is about
 * 1e-9 of it: a 900 m world in Arlington came out "1.4e-9 outside" North America — over
 * INSIDE_TOL, so not held, so the public mirrors (2026-10-10). Shifted to the box's corner, the
 * numbers are the size of the box and the dust is ~1e-16 of it.
 */
export function areaInBox(geom, box) {
  const x0 = box.west
  const y0 = box.south
  const local = { west: 0, south: 0, east: box.east - x0, north: box.north - y0 }
  let a = 0
  for (const poly of polygonsOf(geom)) {
    poly.forEach((ring, i) => {
      const clipped = ringArea(clipRing(ring.map(([x, y]) => [x - x0, y - y0]), local))
      a += i === 0 ? clipped : -clipped
    })
  }
  return Math.max(0, a)
}

export function geomArea(geom) {
  let a = 0
  for (const poly of polygonsOf(geom)) poly.forEach((ring, i) => { a += i === 0 ? ringArea(ring) : -ringArea(ring) })
  return Math.max(0, a)
}

/**
 * A geometry that encloses something. `{"type":"MultiPolygon","coordinates":[]}` does not — and is
 * exactly what Geofabrik's index of 2026-10-10 gave for us/maryland (geofabrik.mjs). A region
 * recorded with it routes nothing, so it is never recorded.
 */
export function hasOutline(geom) {
  try {
    return geomArea(geom) > 0
  } catch {
    return false
  }
}

/** Even-odd point in polygon, holes included. */
export function pointIn(geom, lon, lat) {
  for (const poly of polygonsOf(geom)) {
    let inside = false
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
      }
    }
    if (inside) return true
  }
  return false
}

export function bboxOfGeom(geom) {
  let s = 90, w = 180, n = -90, e = -180
  for (const poly of polygonsOf(geom)) for (const [x, y] of poly[0]) {
    if (x < w) w = x
    if (x > e) e = x
    if (y < s) s = y
    if (y > n) n = y
  }
  return { south: s, west: w, north: n, east: e }
}

/** Below this the box is inside: floating-point dust from clipping a box that is wholly within. */
export const INSIDE_TOL = 1e-9

/**
 * How much of `box` lies outside every one of `geoms`, as a fraction of the box.
 *
 * EXACT when one geometry holds the box on its own (or there is only one geometry), which is
 * every case that has ever existed on gh200-1: one region per instance. For SEVERAL regions on one
 * instance, the union is the coverage and two regions' polygons overlap at their shared border
 * (Geofabrik cuts every extract with a buffer), so their areas cannot simply be summed. That case
 * is SAMPLED on a grid, and the answer says so (`exact: false`). A gap narrower than one grid
 * cell could hide between samples — a 40 km box at 64 samples is 600 m — and two Geofabrik
 * neighbours overlap by kilometres, so that gap exists only between regions that are not
 * neighbours, where it is the whole box wide. The bake's own check (osm.py) is an exact union in
 * shapely, so a miss here still cannot reach a bake silently.
 */
export function outsideFraction(geoms, box, { samples = 64 } = {}) {
  const area = boxArea(box)
  if (!(area > 0)) {
    // a degenerate box — a point or a line — is inside when its corner is
    const c = geoms.some((g) => pointIn(g, box.west, box.south))
    return { outside: c ? 0 : 1, exact: true, by: c ? geoms.findIndex((g) => pointIn(g, box.west, box.south)) : null }
  }
  let best = 1
  let by = null
  geoms.forEach((g, i) => {
    const f = Math.max(0, 1 - areaInBox(g, box) / area)
    if (f < best) { best = f; by = i }
  })
  if (best <= INSIDE_TOL) return { outside: 0, exact: true, by }
  if (geoms.length <= 1) return { outside: best, exact: true, by: null }
  let miss = 0
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const lon = box.west + ((i + 0.5) / samples) * (box.east - box.west)
      const lat = box.south + ((j + 0.5) / samples) * (box.north - box.south)
      if (!geoms.some((g) => pointIn(g, lon, lat))) miss++
    }
  }
  return { outside: Math.min(best, miss / (samples * samples)), exact: false, by: null }
}

/** A box as a GeoJSON Polygon — how a legacy `#south/west/north/east` fence becomes a coverage. */
export const boxPolygon = (b) => ({
  type: 'Polygon',
  coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]],
})

/* ---- routing ------------------------------------------------------------------------------ */

/**
 * The upstreams that hold ALL of `box`, in the order to ask them, with each one's verdict.
 *
 * @param upstreams [{ name, url, geoms: Geometry[] | null }] — `null` geoms is an upstream that
 *                  claims everywhere (a public mirror, or one nobody has described); an EMPTY list
 *                  is an upstream that holds nothing we know of, and is never asked.
 *
 * THE TIGHTEST COVERAGE THAT HOLDS THE BOX GOES FIRST, then the rest that hold it, then the
 * unfenced ones. Two upstreams can both hold a box in Crofton — a Maryland extract and North
 * America — and the regional one certainly has the data and is the smaller database to search;
 * an unfenced one is somebody else's rate limit. Configuration order breaks a tie.
 *
 * An upstream that holds MOST of the box is not on the list at all. That is the point: the silent
 * empty is precisely an upstream answering for ground it partly holds, and a confident partial
 * answer is the worst failure this system has.
 */
export function route(upstreams, box) {
  const verdicts = upstreams.map((u, order) => {
    if (u.geoms == null) return { name: u.name, url: u.url, covered: true, outside: 0, exact: true, claims: 'everywhere', order, size: Infinity }
    if (!u.geoms.length) return { name: u.name, url: u.url, covered: false, outside: 1, exact: true, claims: 'nothing', order, size: 0 }
    const f = box ? outsideFraction(u.geoms, box) : { outside: 0, exact: true }
    return {
      name: u.name,
      url: u.url,
      covered: f.outside <= INSIDE_TOL,
      outside: f.outside,
      exact: f.exact,
      claims: 'regions',
      order,
      size: u.geoms.reduce((s, g) => s + geomArea(g), 0),
    }
  })
  const urls = verdicts
    .filter((v) => v.covered)
    .sort((a, b) => a.size - b.size || a.order - b.order)
    .map((v) => v.url)
  return { urls, verdicts }
}

/**
 * The area a bake of this world will actually ask Overpass about, as a lon/lat box.
 *
 * NOT the box the editor draws. `network.roads` queries the geodetic bbox of a UTM square of side
 * 2·radius about the centre (or of the drawn ring's bounds, padded 40 m), and that square is
 * rotated by the grid convergence — measured in overpass.mjs at +1.9% of the radius on every side
 * at Crofton. Convergence grows with distance from the zone's central meridian and with latitude
 * (3° off-meridian at 60° N is 2.6°, which is +4.4%), so the box is grown by 5% of its half-size
 * plus 100 m: a little too much is a slightly stricter routing decision, too little is a query the
 * bake's own check refuses at run time.
 */
export function bakeArea(world) {
  const ring = Array.isArray(world?.boundary) && world.boundary.length >= 3 ? world.boundary : null
  let s, w, n, e
  if (ring) {
    s = Math.min(...ring.map((p) => p[1]))
    n = Math.max(...ring.map((p) => p[1]))
    w = Math.min(...ring.map((p) => p[0]))
    e = Math.max(...ring.map((p) => p[0]))
  } else {
    if (!Number.isFinite(world?.lat) || !Number.isFinite(world?.lon)) return null
    const r = Number.isFinite(world.radius_m) ? world.radius_m : 1000
    const dLat = r / 111132
    const dLon = r / (111412.84 * Math.max(0.05, Math.cos((world.lat * Math.PI) / 180)))
    s = world.lat - dLat; n = world.lat + dLat; w = world.lon - dLon; e = world.lon + dLon
  }
  const midLat = (s + n) / 2
  const halfM = Math.max(((n - s) / 2) * 111132, ((e - w) / 2) * 111412.84 * Math.cos((midLat * Math.PI) / 180))
  const padM = 0.05 * halfM + 100
  const pLat = padM / 111132
  const pLon = padM / (111412.84 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)))
  return { south: s - pLat, west: w - pLon, north: n + pLat, east: e + pLon }
}

/* ---- the upstream list ----------------------------------------------------------------------- */

/**
 * `https://host/api/interpreter` or `...#south/west/north/east` (the old fence, still read).
 * The fragment is never sent on the wire; see overpass.mjs for why it is slashes and not commas.
 */
export function parseUpstream(raw) {
  let s = String(raw).trim()
  // `name=url` names an instance explicitly — for a laptop reaching the cluster's instances through
  // port-forwards, where every host is `localhost` and only the name says which one it is
  const named = /^([A-Za-z0-9_.-]+)=(https?:\/\/.*)$/.exec(s)
  if (named) s = named[2]
  const i = s.indexOf('#')
  const url = i < 0 ? s : s.slice(0, i)
  let fence = null
  if (i >= 0) {
    const n = s.slice(i + 1).split('/').map(Number)
    if (n.length === 4 && n.every(Number.isFinite)) fence = { south: n[0], west: n[1], north: n[2], east: n[3] }
  }
  // the HOST, port included: in the cluster that is the Service name (`overpass-na`), and on a
  // laptop with three port-forwards it keeps `localhost:18081` and `localhost:18082` apart
  let name = named ? named[1] : url
  if (!named) {
    try {
      name = new URL(url).host
    } catch {
      /* not a URL; overpass.mjs refuses it by name */
    }
  }
  return { url, name, fence }
}

/**
 * `overpass=us/maryland, overpass-eu=europe, overpass-na=north-america` → Map(name → [region ids]).
 * Several regions on one upstream are joined with `+`: `overpass=us/maryland+us/virginia`.
 */
export function parseRegions(raw) {
  const out = new Map()
  for (const part of String(raw ?? '').split(/[,;\n]/)) {
    const [name, ids] = part.split('=').map((x) => x?.trim())
    if (!name || !ids) continue
    out.set(name, ids.split('+').map((x) => x.trim()).filter(Boolean))
  }
  return out
}

/* ---- the file on the volume ----------------------------------------------------------------- */

/**
 * The coverage of every configured upstream, on the volume.
 *
 *   { version: 1, upstreams: [{ name, url, regions: [{ id, name, source, geometry, pbf, updates,
 *     added, run }] }] }
 *
 * `source` says where a region came from, and decides what may remove it:
 *   deploy  WORLDEDITOR_OVERPASS_REGIONS / the Settings value. Re-read at every load, so changing
 *           the setting changes these — and only these.
 *   import  an `osm-import` run that succeeded. Kept until somebody removes it; a setting never does.
 *   fence   a `#s/w/n/e` box on the URL, for an upstream nobody has described any other way.
 *
 * An upstream that has regions is routed by them and its fence is ignored. One with neither claims
 * everywhere — which is what a public mirror is, and why every regional instance must be described.
 */
export class Coverage {
  /**
   * @param dataDir   the volume
   * @param o.urls    () => the configured upstream list (the `overpass.url` setting), in order
   * @param o.regions () => the `overpass.regions` setting
   * @param o.lookup  async (id) => a Geofabrik feature for a region id, or null (geofabrik.mjs)
   */
  constructor(dataDir, { urls, regions, lookup }) {
    this.file = path.join(dataDir, 'overpass', 'coverage.json')
    this.urls = urls
    this.regions = regions
    this.lookup = lookup
    this.doc = { version: 1, upstreams: [] }
    this.problems = []
  }

  /**
   * Read the file and fold the deployment's regions into it. Safe to call again after a settings
   * change or an index refresh; calls are run one after another, never interleaved.
   */
  load() {
    this.loading = (this.loading ?? Promise.resolve()).catch(() => {}).then(() => this.#load())
    return this.loading
  }

  async #load() {
    try {
      const doc = JSON.parse(await readFile(this.file, 'utf8'))
      if (Array.isArray(doc?.upstreams)) this.doc = doc
    } catch {
      /* a new volume: everything comes from the deployment */
    }
    this.problems = []
    const want = parseRegions(this.regions())
    for (const up of this.configured()) {
      const rec = this.#record(up.name, up.url)
      rec.url = up.url
      const ids = want.get(up.name) ?? []
      // the deployment's regions are exactly the setting's: drop the ones it no longer names
      rec.regions = rec.regions.filter((r) => r.source !== 'deploy' || ids.includes(r.id))
      for (const id of ids) {
        // an outline already on the volume stands; an EMPTY one (written before outlines were
        // checked) is looked up again, which is how a volume that took a bad index heals
        if (rec.regions.some((r) => r.id === id && r.source === 'deploy' && hasOutline(r.geometry))) continue
        const f = await this.lookup(id).catch(() => null)
        if (!hasOutline(f?.geometry)) {
          // NOT "covers everywhere", which is what an upstream with no regions would mean. A region
          // we cannot outline is a region we cannot route to; say so and leave it out.
          rec.regions = rec.regions.filter((r) => r.id !== id || r.source !== 'deploy')
          this.problems.push(f
            ? `${up.name}: region "${id}" has no outline in the Geofabrik index this editor can read — it is not routed to until it has`
            : `${up.name}: region "${id}" is not in the Geofabrik index this editor can read — it is not routed to until it is`)
          continue
        }
        rec.regions = rec.regions.filter((r) => r.id !== id)
        rec.regions.push(regionRecord(f, 'deploy'))
      }
      // an imported region whose outline was lost the same way: look it up again, or say so
      for (const r of rec.regions) {
        if (r.source === 'fence' || hasOutline(r.geometry)) continue
        const f = await this.lookup(r.id).catch(() => null)
        if (hasOutline(f?.geometry)) r.geometry = f.geometry
        // kept, not dropped: dropping the last one would turn the instance into one that claims
        // everywhere. An empty outline routes nothing, here and in osm.py alike.
        else this.problems.push(`${up.name}: region "${r.id}" has no outline — it is not routed to until it has`)
      }
      // a fence only stands in for an upstream with no regions at all
      rec.regions = rec.regions.filter((r) => r.source !== 'fence')
      if (!rec.regions.length && up.fence) rec.regions.push({ id: 'fence', name: `box ${fmtBox(up.fence)}`, source: 'fence', geometry: boxPolygon(up.fence) })
      if (!rec.regions.length && want.has(up.name)) rec.holdsNothingKnown = true
      else delete rec.holdsNothingKnown
    }
    await this.save()
    return this
  }

  /** The configured upstreams, in order, parsed. */
  configured() {
    return (this.urls() ?? []).map(parseUpstream).filter((u) => u.url)
  }

  #record(name, url) {
    let rec = this.doc.upstreams.find((u) => u.name === name)
    if (!rec) {
      rec = { name, url, regions: [] }
      this.doc.upstreams.push(rec)
    }
    rec.regions ??= []
    return rec
  }

  /**
   * What routing reads: each configured upstream, with its geometries — or `null` when it carries
   * no description at all (claims everywhere), or `[]` when it was described and none of its
   * regions could be outlined (holds nothing we can vouch for, never asked).
   */
  upstreams() {
    return this.configured().map((u) => {
      const rec = this.doc.upstreams.find((r) => r.name === u.name)
      const regions = rec?.regions ?? []
      const geoms = regions.length ? regions.map((r) => r.geometry) : rec?.holdsNothingKnown ? [] : null
      return { name: u.name, url: u.url, regions, geoms }
    })
  }

  route(box) {
    return route(this.upstreams(), box)
  }

  /** Add an imported region to an upstream's coverage. Idempotent by region id. */
  async addRegion(name, feature, meta = {}) {
    if (!hasOutline(feature?.geometry)) throw new Error(`${feature?.properties?.id ?? 'region'} has no outline in the Geofabrik index; it cannot be routed to`)
    const rec = this.#record(name, this.configured().find((u) => u.name === name)?.url ?? null)
    rec.regions = rec.regions.filter((r) => r.id !== feature.properties.id && r.source !== 'fence')
    rec.regions.push({ ...regionRecord(feature, 'import'), ...meta })
    delete rec.holdsNothingKnown
    await this.save()
    return rec
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true })
    // unique per write, as store.mjs's writeAtomic: two saves in one tick must not share a tmp file
    const tmp = `${this.file}.tmp-${process.pid}-${++tmpSeq}`
    await writeFile(tmp, JSON.stringify(this.doc))
    await rename(tmp, this.file)
  }

  describe() {
    return { file: this.file, upstreams: this.upstreams().map(({ geoms, ...u }) => ({ ...u, claims: geoms == null ? 'everywhere' : geoms.length ? 'regions' : 'nothing' })), problems: this.problems }
  }
}

/**
 * A region's name for a person. Geofabrik's index names the US states by their id
 * (`"name": "us/virginia"`) — and files them under north-america, beside `us` rather than in it —
 * so a name with a slash in it is the id, and its last part is the name.
 */
export function regionLabel(p) {
  const n = String(p?.name ?? p?.id ?? '')
  if (!n.includes('/')) return n
  return n.split('/').pop().split('-').map((w) => (w.length > 2 || w === 'of' ? w : w.toUpperCase())).map((w) => (w === 'of' ? w : w[0].toUpperCase() + w.slice(1))).join(' ')
}

/** A Geofabrik index feature as the record kept on the volume. */
export function regionRecord(f, source) {
  const p = f.properties ?? {}
  return {
    id: p.id,
    name: regionLabel(p),
    source,
    geometry: f.geometry,
    pbf: p.urls?.pbf ?? null,
    updates: p.urls?.updates ?? null,
    added: new Date().toISOString(),
  }
}

let tmpSeq = 0

/**
 * The coverage the editor routes by, opened the way the server opens it — the tests open it the
 * same way, so what they prove is what a fresh deployment does.
 *
 * Start-up never waits on the network: the coverage is loaded from the volume's copy of the
 * Geofabrik index, or the vendored seed on a fresh volume, so the deployment's own instances are
 * routed from the first request. `refresh()` then reads the live index (Geofabrik only fetches it
 * when the copy is a week old, or the seed, or `force`) and loads the coverage again; the server
 * runs it once at start-up and on a timer. A failure is logged and is in `geofabrik.status()`.
 *
 * @param geofabrik a Geofabrik (geofabrik.mjs)
 */
export async function openCoverage(dataDir, { urls, regions, geofabrik, log = console }) {
  const report = (c) => {
    for (const p of c.problems) log.warn?.(`overpass coverage: ${p}`)
    return c
  }
  const coverage = new Coverage(dataDir, { urls, regions, lookup: (id) => geofabrik.region(id, { offline: true }) })
  report(await coverage.load())
  const refresh = async ({ force = false } = {}) => {
    await geofabrik.index({ refresh: force })
    coverage.lookup = (id) => geofabrik.region(id)
    return report(await coverage.load())
  }
  return { coverage, refresh }
}

const fmtBox = (b) => `${b.south}/${b.west}/${b.north}/${b.east}`
