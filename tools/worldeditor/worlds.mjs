// A drawn boundary → a site definition the bake already accepts.
//
// There is no new format here and that is the point. `tools/corridor/sites.json` is a JSON array
// of dicts; `cmd_fetch` picks by `slug` and hands the whole dict to `network.fetch_site`, which
// reads `lat`, `lon`, `radius_m`, `primary`, and either `all_streets` or `roads`. A world drawn in
// the editor is one of those dicts with three extra keys the bake ignores — `boundary`, `created`
// and `source` — so the thing the editor writes is the thing a person could have typed.
//
// WHAT A BOUNDARY IS, EXACTLY. The bake has no concept of an arbitrary extent: `network.roads`
// queries a bbox derived from a UTM square of side 2·radius_m, and there is no circular or
// polygonal clip on roads anywhere in it. So a drawn polygon is reduced to the SMALLEST CIRCLE
// THAT CONTAINS IT (geo.circleFor), and the editor draws the resulting square back on the map.
// The polygon is kept for provenance and for re-editing, never as a clip, and the UI says so
// rather than letting someone believe they cut a shape.

import { circleFor, haversineM, lengthM, pointInRing, slugify } from './geo.mjs'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,47}$/

/**
 * A radius the bake will survive.
 *
 * Every source scales with the area: Overpass, the DEM tiles, NAIP, and worst of all the lidar
 * octree. crofton-crownsville at 9 km is the largest thing baked so far and it is hours. Above
 * `WARN_M` the editor says how much bigger than Crofton this is instead of silently accepting it,
 * and `MAX_M` is a refusal rather than a warning because the failure mode is a Job that fills the
 * volume and then dies.
 */
export const MIN_M = 150
export const WARN_M = 4000
export const MAX_M = 20000

/** The reference, so a warning can be a comparison rather than an adjective. */
const REFERENCE = { slug: 'crofton-triangle', radius_m: 2600, ways: 854, note: 'every drivable street in the Crofton triangle' }

export function validate(world) {
  const errors = []
  const warnings = []
  if (!SLUG_RE.test(world.slug ?? '')) errors.push('slug must be lower-case letters, digits and hyphens, 2–48 characters')
  if (!Number.isFinite(world.lat) || Math.abs(world.lat) > 85) errors.push('lat must be a number within ±85')
  if (!Number.isFinite(world.lon) || Math.abs(world.lon) > 180) errors.push('lon must be a number within ±180')
  const r = Number(world.radius_m)
  if (!Number.isFinite(r) || r < MIN_M) errors.push(`radius_m must be at least ${MIN_M} m`)
  else if (r > MAX_M) errors.push(`radius_m ${Math.round(r)} m is over the ${MAX_M} m ceiling — bake it in pieces`)
  else if (r > WARN_M) warnings.push(`${Math.round(r)} m radius is ${(r / REFERENCE.radius_m).toFixed(1)}× ${REFERENCE.slug} on a side, so roughly ${((r / REFERENCE.radius_m) ** 2).toFixed(1)}× the area and the sources scale with area`)

  if (world.kind === 'network') {
    const roads = world.roads ?? []
    if (!world.all_streets && !roads.length) errors.push('a network site needs `all_streets: true` or a non-empty `roads` list — network.roads raises otherwise')
    if (!world.primary) errors.push('a network site needs a `primary` road: it becomes the spine, and the profile and structures are measured along it')
    if (!world.all_streets && world.primary && !roads.includes(world.primary)) errors.push(`primary "${world.primary}" is not in the roads list`)
  } else if (world.kind) {
    errors.push(`unknown kind "${world.kind}" — this editor makes network sites`)
  }
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Build a definition from what the editor drew.
 *
 * `roads` (the names picked on the map) and `all_streets` are alternatives, and picking names is
 * worth doing only when a person wants a few specific roads: crofton-crownsville named 18 roads
 * over a 9 km radius and drew 18 of the 10 593 drivable ways in that extract, which is why most
 * of the street furniture built from OSM had nothing to attach to. The editor defaults to
 * `all_streets` and says that.
 */
export function fromDraw({ slug, name, boundary, centre, radius_m, primary, roads, all_streets = true, region, note }) {
  const ring = (boundary ?? []).map(toPoint)
  const circle = ring.length >= 3 ? circleFor(ring) : null
  const lat = centre?.lat ?? circle?.lat
  const lon = centre?.lon ?? circle?.lon
  const r = radius_m ?? circle?.radius_m
  const world = {
    slug: slugify(slug ?? name ?? ''),
    kind: 'network',
    lat: round6(lat),
    lon: round6(lon),
    radius_m: Math.round(r ?? 0),
    primary: primary ?? null,
    photos: [],
    heading_deg: null,
  }
  if (all_streets) world.all_streets = true
  else world.roads = [...new Set(roads ?? [])]
  if (region) world.region = region
  if (note) world.note = note
  if (ring.length >= 3) world.boundary = ring.map((p) => [round6(p.lon), round6(p.lat)])
  world.source = 'world-editor'
  world.created = new Date().toISOString()
  return world
}

/**
 * Which of the ways on screen the bake would take for this world, and how much road that is.
 *
 * Two filters, and they are different questions:
 *   * `inSquare` — what the bake's own query box would return. This is the honest answer and the
 *     number the editor shows, because the bake does not clip to a circle or to a polygon.
 *   * `inBoundary` — what fell inside the drawn shape. Shown beside it so a person can see how
 *     much extra the square drags in, which is the whole argument for redrawing tighter.
 * A way counts if ANY of its vertices is inside, which is how a chain that crosses the edge is
 * counted by the bake too (it queries by bbox, keeps the geometry it is given, then drops chains
 * under MIN_CHAIN_M).
 */
export function selectWays(ways, { centre, radius_m, boundary }) {
  const ring = (boundary ?? []).map(toPoint)
  const halfLat = radius_m / 111132.0
  const halfLon = radius_m / (111412.84 * Math.max(0.05, Math.cos((centre.lat * Math.PI) / 180)))
  const inSquare = []
  const inBoundary = []
  for (const w of ways) {
    let sq = false
    let bd = false
    for (const [lon, lat] of w.line) {
      if (!sq && Math.abs(lat - centre.lat) <= halfLat && Math.abs(lon - centre.lon) <= halfLon) sq = true
      if (!bd && ring.length >= 3 && pointInRing(ring, { lon, lat })) bd = true
      if (sq && (bd || ring.length < 3)) break
    }
    if (sq) inSquare.push(w)
    if (bd) inBoundary.push(w)
  }
  const idents = new Map()
  for (const w of inSquare) {
    const e = idents.get(w.ident) ?? { ident: w.ident, ways: 0, metres: 0, highway: w.highway }
    e.ways++
    e.metres += lengthM([w.line.map(([lon, lat]) => ({ lon, lat }))])
    idents.set(w.ident, e)
  }
  return {
    square: { ways: inSquare.length, metres: Math.round(lengthM(inSquare.map((w) => w.line.map(([lon, lat]) => ({ lon, lat }))))) },
    boundary: ring.length >= 3 ? { ways: inBoundary.length, metres: Math.round(lengthM(inBoundary.map((w) => w.line.map(([lon, lat]) => ({ lon, lat }))))) } : null,
    idents: [...idents.values()].map((e) => ({ ...e, metres: Math.round(e.metres) })).sort((a, b) => b.metres - a.metres),
    reference: REFERENCE,
  }
}

/** The longest named road in the selection — the default primary, and a sane one. */
export function suggestPrimary(selection) {
  const named = selection.idents.filter((i) => i.ident && i.ident !== '«unnamed»')
  return named.length ? named[0].ident : null
}

/** How far a world's centre moved, for the UI to warn that a re-bake is a different place. */
export function centreMoveM(a, b) {
  return Math.round(haversineM({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }))
}

const toPoint = (p) => (Array.isArray(p) ? { lon: p[0], lat: p[1] } : p)
const round6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v)
