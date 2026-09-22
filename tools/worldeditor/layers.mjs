// What the map asks OSM for, and it depends entirely on how far out you are.
//
// THE MISTAKE THIS REPLACES. The first cut had one question — "every drivable way in this box" —
// and one lever for making it affordable: refuse to zoom out. That is a site definer, not a world
// editor. It assumes you already know where you are going, and it makes finding somewhere new
// impossible: zoom out to look for a pass in the Alps and the map goes blank by design.
//
// A map answers a different question at every scale, and so does this:
//
//   zoom      layer     what you are looking at            source
//   0 – 6     borders   which country is that              Natural Earth, fetched once, cached
//   2 – 11    places    cities, then towns, then villages  Overpass `node[place]`, rank by zoom
//   5 – 10    major     the motorway skeleton              Overpass motorway/trunk (+primary at 9)
//   11 +      roads     every street a car can drive       Overpass, the all_streets query
//
// Measured on 2026-09-22, which is what makes these bands defensible rather than a guess:
//
//   every city+town in ALL of Italy (11.7 x 12 deg)   2 016 nodes    946 kB raw   34 s
//   motorway+trunk over NW Italy (1.5 x 2.5 deg)      5 000 ways     5.2 MB raw   15 s  (capped)
//   every drivable way, 0.25 x 0.35 deg               17 173 ways   15.0 MB raw   11 s
//   every drivable way, 0.34 x 0.44 deg               31 053 ways   26.5 MB raw  >300 s
//
// The bottom row is why the old cap was wrong and the top row is why the new design works: asking
// a cheaper QUESTION over a bigger box beats asking the expensive question over a smaller one.
//
// TILES, NOT VIEWPORTS. Every layer is fetched on a fixed grid — the same geographic quadtree as
// `packages/engine/src/geo/wgs84.ts` and trailworks, so we address the world the way the rest of
// the project does. Panning re-uses whole tiles instead of asking for a box that has never been
// asked for before, which is what the viewport-shaped cache did: every pan was a cache miss.
//
// TRIMMED AND SIMPLIFIED BEFORE CACHING. Overpass returns every tag and every vertex. At the
// overview scales neither is wanted — a motorway across Lombardy does not need 10 m vertex spacing
// to read as a line — so what lands in the cache is what the map will actually draw.

import { simplify } from './simplify.mjs'

/** Level z has 2^(z+1) columns of longitude and 2^z rows of latitude — wgs84.ts `tileBounds`. */
export function tileBounds(z, x, y) {
  const cols = 2 ** (z + 1)
  const rows = 2 ** z
  return {
    west: -180 + (x * 360) / cols,
    east: -180 + ((x + 1) * 360) / cols,
    north: 90 - (y * 180) / rows,
    south: 90 - ((y + 1) * 180) / rows,
  }
}

/** Every tile of level `z` that a bbox touches. Clamped, so a world-wide view is finite. */
export function tilesFor(z, bbox) {
  const cols = 2 ** (z + 1)
  const rows = 2 ** z
  const x0 = Math.max(0, Math.floor(((bbox.west + 180) / 360) * cols))
  const x1 = Math.min(cols - 1, Math.floor(((bbox.east + 180) / 360) * cols))
  const y0 = Math.max(0, Math.floor(((90 - bbox.north) / 180) * rows))
  const y1 = Math.min(rows - 1, Math.floor(((90 - bbox.south) / 180) * rows))
  const out = []
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ z, x, y })
  return out
}

/**
 * The stack, coarsest first.
 *
 * `minZoom`/`maxZoom` are the map zooms at which a layer is worth drawing; `tile` is the quadtree
 * level it is fetched on, chosen so one tile is a sensible unit of work at those zooms — a places
 * tile is a fifth of Europe, a roads tile is a town.
 */
export const LAYERS = [
  {
    id: 'places',
    label: 'Towns and villages',
    // Starts at 6, not 2. Below that the basemap's world cities are the right answer: one fetch,
    // cached for ever, 1 251 places with population and country. An Overpass place query over a
    // z4 tile (11.25 deg) is 946 kB and 34 s, and at world zoom there are 448 of those tiles.
    minZoom: 6,
    maxZoom: 12,
    tile: 4, // 11.25 deg cells — all of Italy is two of them
    kind: 'points',
    /**
     * Which places, by zoom. A world view wants twenty capitals, not two thousand villages; and
     * the same query at every zoom either floods the world view or leaves the regional one empty.
     */
    variant(zoom) {
      const kinds = zoom < 5 ? ['city'] : zoom < 7 ? ['city', 'town'] : ['city', 'town', 'village']
      return { key: kinds.map((k) => k[0]).join(''), kinds, cap: zoom < 5 ? 400 : 3000 }
    },
    query(bounds, v) {
      const { south, west, north, east } = bounds
      // `out body`, NOT `out tags`. On a node `out tags` returns the id and the tags and NO
      // COORDINATES — Milan comes back as a name with nowhere to put it — so the trim below,
      // which quite reasonably requires a position, silently dropped all 3 751 elements of a
      // perfectly good response and cached an empty tile. It looked exactly like "there are no
      // cities in the Alps". Verified against Overpass directly: `out tags` on a place node has
      // no `lat` field, `out body` does.
      return `[out:json][timeout:180];node(${f(south)},${f(west)},${f(north)},${f(east)})[place~"^(${v.kinds.join('|')})$"];out body 6000;`
    },
    /** name, rank and position. Nothing else — the raw tags are 90% of the bytes and 0% of the map. */
    trim(elements, v) {
      const rank = { city: 0, town: 1, village: 2 }
      return elements
        .filter((e) => e.lat != null && e.tags?.name)
        .map((e) => ({
          id: e.id,
          name: e.tags.name,
          kind: e.tags.place,
          pop: Number(e.tags.population) || 0,
          lat: round5(e.lat),
          lon: round5(e.lon),
        }))
        // Biggest first, so a viewer drawing the first N draws the ones that matter.
        .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || b.pop - a.pop)
        .slice(0, v.cap)
    },
  },
  {
    id: 'major',
    label: 'Motorways and trunk roads',
    // Starts at 7. Measured: motorway+trunk over 1.5 x 2.5 deg is 5 MB and 15 s and hits the
    // element cap, so a 2.8 deg tile is the most that is sensible and a country-sized view wants
    // twenty-five of them — minutes, and a hundred megabytes off somebody else's mirror. At zoom 7
    // the viewport is two or three tiles. Between 5 and 7 the map is borders and cities, which is
    // enough to find a region, and the motorways arrive as you close in.
    minZoom: 7,
    maxZoom: 11,
    tile: 6, // 2.8 deg cells
    kind: 'lines',
    /**
     * ONE BREAKPOINT, NOT TWO.
     *
     * The road classes and the simplification tolerance both change with zoom, and they used to
     * change at different zooms — classes at 9, tolerance at 8. That gives zoom 8 and zoom 7 the
     * SAME Overpass query under two different cache keys, so the expensive half of the work (the
     * fetch) is done twice and stored twice to produce two renderings of identical data. The probe
     * caught it by asserting that one question maps to one key and back. Both move at 9 now:
     * 300 m tolerance is a fraction of a pixel below that zoom anyway.
     */
    variant(zoom) {
      const coarse = zoom < 9
      const kinds = coarse ? ['motorway', 'trunk'] : ['motorway', 'trunk', 'primary']
      return { key: coarse ? 'mt' : 'mtp', kinds, tol: coarse ? 0.003 : 0.0008 }
    },
    query(bounds, v) {
      const { south, west, north, east } = bounds
      return `[out:json][timeout:300];way(${f(south)},${f(west)},${f(north)},${f(east)})[highway~"^(${v.kinds.join('|')}|${v.kinds.map((k) => `${k}_link`).join('|')})$"];out geom 12000;`
    },
    trim(elements, v) {
      return elements
        .filter((e) => e.geometry?.length)
        .map((e) => ({
          id: e.id,
          name: e.tags?.name ?? null,
          ref: e.tags?.ref ?? null,
          highway: e.tags?.highway,
          line: simplify(
            e.geometry.map((p) => [round5(p.lon), round5(p.lat)]),
            v.tol,
          ),
        }))
        .filter((w) => w.line.length > 1)
    },
  },
  {
    id: 'roads',
    label: 'Every drivable street',
    minZoom: 11,
    maxZoom: 22,
    tile: 9, // 0.35 deg cells — a town and its surroundings
    kind: 'lines',
    /** One question at every zoom, so one cache entry. */
    variant() {
      return { key: 'all' }
    },
    query(bounds) {
      const { south, west, north, east } = bounds
      return `[out:json][timeout:300];(way(${f(south)},${f(west)},${f(north)},${f(east)})[highway~"^(${DRIVABLE.join('|')})$"];);out geom;`
    },
    trim(elements) {
      // The detail layer is what a world is DEFINED from — `ident` here has to be the string the
      // bake will chain on — so it keeps full geometry and is only trimmed of tags.
      return elements
        .filter((e) => e.geometry && e.nodes)
        .filter((e) => !DROPPED.includes(e.tags?.highway))
        .map((e) => ({
          id: e.id,
          ident: e.tags?.name || (e.tags?.ref ? String(e.tags.ref).split(';')[0].trim() : null) || UNNAMED,
          name: e.tags?.name ?? null,
          ref: e.tags?.ref ?? null,
          highway: e.tags?.highway,
          lanes: e.tags?.lanes ?? null,
          oneway: e.tags?.oneway ?? null,
          line: e.geometry.map((p) => [round7(p.lon), round7(p.lat)]),
        }))
    },
  },
]

/** Every highway kind a car can drive on. Copied from `network.py` DRIVABLE — keep them equal. */
export const DRIVABLE = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]
/** And what `network.roads` drops after the query. Same list, same order, for the same reason. */
export const DROPPED = ['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'bridleway', 'service', 'track', 'proposed', 'construction']
export const UNNAMED = '«unnamed»'

export const layerById = (id) => LAYERS.find((l) => l.id === id) ?? null

/**
 * THE CACHE KEY AND THE QUESTION COME FROM ONE PLACE.
 *
 * `places` asks for cities below zoom 5 and cities+towns above it; `major` changes both its road
 * classes and its simplification tolerance with zoom. If the cache key did not carry that, panning
 * at z4 and then zooming to z8 would read back the city-only tile and the towns would never
 * appear — a cache HIT that is silently the wrong answer, which is the worst kind. So `variant()`
 * returns both the parameters and the key derived from them, `query` and `trim` take the variant
 * rather than the zoom, and the two cannot drift apart.
 */
export const variantOf = (layer, zoom) => layer.variant(zoom)

/** Which layers are worth drawing at this zoom, coarsest first. */
export const layersAt = (zoom) => LAYERS.filter((l) => zoom >= l.minZoom && zoom < l.maxZoom)

const f = (v) => Number(v).toFixed(6)
const round5 = (v) => Math.round(v * 1e5) / 1e5
const round7 = (v) => Math.round(v * 1e7) / 1e7
