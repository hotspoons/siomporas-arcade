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
//
// AND `radius_m` IS A HALF-WIDTH. The name is wrong at the source — network.py's docstring says
// "every drivable way in the radius" and its error says "within {R} m", and a square of side 2R is
// 4/π = 1.27× the area both of those imply. Confirmed with the orchestrator on 2026-09-22, who
// owns network.py and is fixing the documentation rather than the behaviour: clipping to the
// circle to make the name honest would silently shrink every site already baked, and
// crofton-crownsville's eighteen hand-chosen roads were picked against the square's reach.

import { circleFor, haversineM, lengthM, pointInRing, slugify } from './geo.mjs'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,47}$/

/**
 * A half-width the bake will survive.
 *
 * Every source scales with AREA — Overpass, the DEM tiles, NAIP, and worst of all the lidar
 * octree — and the bake takes a square of side 2r, so doubling this quadruples the work. Above
 * `WARN_M` the editor states the area rather than silently accepting it. `MAX_M` is a refusal
 * rather than a warning because the failure mode is a Job that fills the volume and then dies.
 *
 * The warning used to compare against a named world that shipped in the image. It no longer does,
 * on both counts: the image ships empty, so the comparison was to something the reader had never
 * seen, and an area in km² is a fact about their own bake instead of trivia about someone else's.
 */
export const MIN_M = 150
export const WARN_M = 4000
export const MAX_M = 20000

export function validate(world) {
  const errors = []
  const warnings = []
  if (!SLUG_RE.test(world.slug ?? '')) errors.push('slug must be lower-case letters, digits and hyphens, 2–48 characters')
  if (!Number.isFinite(world.lat) || Math.abs(world.lat) > 85) errors.push('lat must be a number within ±85')
  if (!Number.isFinite(world.lon) || Math.abs(world.lon) > 180) errors.push('lon must be a number within ±180')
  const r = Number(world.radius_m)
  if (!Number.isFinite(r) || r < MIN_M) errors.push(`radius_m must be at least ${MIN_M} m`)
  else if (r > MAX_M) errors.push(`radius_m ${Math.round(r)} m is over the ${MAX_M} m ceiling — bake it in pieces`)
  else if (r > WARN_M) warnings.push(`${((r * 2 / 1000) ** 2).toFixed(0)} km² to bake — every source scales with area, so expect hours`)

  if (world.kind === 'network') {
    const roads = world.roads ?? []
    if (!world.all_streets && !roads.length) errors.push('pick at least one road, or choose Every street')
    if (!world.primary) errors.push('a spine road is required')
    if (!world.all_streets && world.primary && !roads.includes(world.primary)) errors.push(`spine "${world.primary}" is not in the roads list`)
  } else if (world.kind) {
    errors.push(`unknown kind "${world.kind}" — this editor makes network sites`)
  }
  /*
   * WHICH TEXTURES THIS WORLD USES, by role.
   *
   * Rich, 2026-09-28: the texture library should be "configurable per world with defaults". So a
   * world names a material id for each surface role it cares about, and says nothing about the
   * rest — an absent role means the viewer's default, which is what makes this additive rather
   * than a thing every world must now fill in.
   *
   * Ids are NOT validated against the library here. The library lives on the asset service, which
   * a world definition must be writable without: a definition is a few hundred bytes of JSON that
   * moves between machines, and refusing to save one because a texture service is down would make
   * the two hard-coupled for no gain. The viewer falls back per role when an id is missing, and
   * the editor's picker only offers ids that exist.
   */
  if (world.surfaces != null) {
    const S = world.surfaces
    if (typeof S !== 'object' || Array.isArray(S)) errors.push('surfaces must be an object of role -> material id')
    else {
      for (const [role, id] of Object.entries(S)) {
        if (!SURFACE_ROLES.includes(role)) errors.push(`surfaces.${role} is not a surface role — one of ${SURFACE_ROLES.join(', ')}`)
        else if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) errors.push(`surfaces.${role} must be a material id`)
      }
    }
  }

  // the look a published world opens with: a style palette, a season, and the water level (the
  // waterworld knob). Optional, every field; anything else is left to the viewer's defaults.
  if (world.look != null) {
    const L = world.look
    if (typeof L !== 'object') errors.push('look must be an object')
    else {
      if (L.style != null && !STYLES.includes(L.style)) errors.push(`look.style must be one of ${STYLES.join(', ')}`)
      if (L.season != null && !SEASONS.includes(L.season)) errors.push(`look.season must be one of ${SEASONS.join(', ')}`)
      if (L.relief != null && !(Number.isFinite(L.relief) && L.relief >= 0.25 && L.relief <= 10)) errors.push('look.relief must be a number between 0.25 and 10 (terrain exaggeration, 1 = as measured)')
      if (L.water_level_m != null && !(Number.isFinite(L.water_level_m) && L.water_level_m >= -100 && L.water_level_m <= 1000)) errors.push('look.water_level_m must be a number between -100 and 1000 (metres NAVD88 / above the ellipsoid)')
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}
/**
 * The surfaces a world draws, by role.
 *
 * These are the things the bake produces geometry for and the viewer has to texture. A world may
 * override any of them and need not mention any: the list is the vocabulary, not a requirement.
 */
export const SURFACE_ROLES = ['road', 'shoulder', 'sidewalk', 'paving', 'ground_cover', 'verge']

/** the palettes the viewer has (apps/corridor/src/style.ts) and the four seasons */
export const STYLES = ['realistic', 'fantasy']
export const SEASONS = ['winter', 'spring', 'summer', 'autumn']

/**
 * Build a definition from what the editor drew.
 *
 * `roads` (names picked on the map) and `all_streets` are alternatives. Naming roads is worth
 * doing only for a handful of specific ones: measured on a 9 km site, a list of 18 named roads
 * drew 18 of the 10 593 drivable ways in that extract, so nearly all the street furniture built
 * from OSM had nothing to attach to. `all_streets` is the default.
 */
export function fromDraw({ slug, name, boundary, centre, radius_m, primary, roads, all_streets = true, region, note, look, surfaces }) {
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
  if (look && typeof look === 'object') {
    const L = {}
    if (look.style) L.style = look.style
    if (look.season) L.season = look.season
    if (Number.isFinite(look.water_level_m)) L.water_level_m = Number(look.water_level_m)
    if (Number.isFinite(look.relief) && Number(look.relief) !== 1) L.relief = Number(look.relief)
    if (Object.keys(L).length) world.look = L
  }
  // only the roles that were actually chosen: an empty object would say "this world overrides
  // nothing" in a way that reads like "this world was configured", and they are not the same
  if (surfaces && typeof surfaces === 'object') {
    const S = {}
    for (const role of SURFACE_ROLES) if (surfaces[role]) S[role] = surfaces[role]
    if (Object.keys(S).length) world.surfaces = S
  }
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
