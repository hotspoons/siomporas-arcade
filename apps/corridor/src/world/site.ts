// The site manifest as tools/corridor/corridor/export.py writes it. Metres, relative to the site
// origin (the photo fix projected to UTM), z in metres NAVD88. Keep this in step with export.py.

import { reliefHeights } from '../visuals/relief'

/**
 * A geodetic control lattice over a raster: `n*n` lon/lat samples, row-major, rows running SOUTH
 * to NORTH and columns WEST to EAST — the same order as `bbox`.
 *
 * A raster is a regular grid on whatever plane the bake projected it onto (UTM, today). In the
 * ENU frame the viewer renders in, that grid is rotated by the meridian convergence, scaled, and
 * curved over the ellipsoid, so its bbox cannot simply be relabelled. The viewer interpolates
 * lon/lat from this lattice and asks the `Anchor` where each vertex goes; curvature is not a
 * correction applied afterwards, it falls out of the transform.
 *
 * Measured over crofton-triangle's 8.56 x 7.90 km DEM, worst error against the exact projection:
 * 1179 mm at 2x2, 295 at 3x3, 73 at 5x5, **18 at 9x9**, 4.6 at 17x17. The bake writes 9x9 for a
 * whole raster and 3x3 for a 1 km tile.
 *
 * It also means the browser never learns which CRS the bake used, so a future source in some other
 * projection just emits its own lattice. See docs/corridor/FRAME.md.
 */
export interface GeoLattice {
  n: number
  lon: number[]
  lat: number[]
}

export interface Layer {
  file: string
  res: number
  size: [number, number]
  /** ENU metres about the site anchor, and only a CONTAINING box — `geo` is what places the grid */
  bbox: [number, number, number, number]
  /** absent on a manifest baked before the geodetic frame; such a site draws on a flat plane */
  geo?: GeoLattice
  /** GPU-compressed twin of `file`, when the bake wrote one — see textures.ts */
  ktx2?: string
  zmin?: number
  zscale?: number
  scale?: number
}

/**
 * `manifest.layers.tiles`: a network-sized bake cuts its DEM, canopy and imagery into `size_m`
 * tiles instead of one image per layer, and lists only the tiles that have data. Tiles outside the
 * corridor hull are simply absent. Files are `web/tiles/0/<x>_<y>.dem.png | .naip.jpg | .chm.png`,
 * with the same encodings as the single-image layers.
 */
/** What the bake's `pyramid.list` says about one tile. Bounds are NOT here — they are in the id. */
export interface PyrEntry {
  z: number
  x: number
  y: number
  empty?: boolean
  dem?: { zmin: number; zscale: number }
  chm?: boolean
  naip?: boolean
  naip_fill?: number
}

export interface PyrIndex {
  scheme: string
  zmin: number
  zmax: number
  px: number
  dir: string
  format: string
  list: PyrEntry[]
}

export interface TileIndex {
  size_m: number
  /** tile (0,0)'s minimum corner ON THE PROJECTION GRID — not ENU. Tile placement comes from each
   *  tile's own `geo` lattice; this is only useful for naming and for coarse bookkeeping. */
  origin: [number, number]
  res: { dem: number; naip: number | null; chm: number | null }
  /** where the packs live, relative to web/ (default `tiles/0`) */
  dir?: string
  /** `pack-1`: uint32 LE header length, header JSON {rev, files:{name:[offset,len]}}, then blobs */
  format?: string
  /** the per-tile imagery file inside the tile directory (default `naip.jpg`) */
  texture?: string
  /** the GPU-compressed twin beside it, when the bake made one — 8x less resident than the jpg */
  texture_ktx2?: string
  list: {
    x: number
    y: number
    dem: { zmin: number; zscale: number }
    chm?: boolean
    naip?: boolean
    /** pack size in bytes, for a loading estimate */
    pack?: number
    /** the tile's own geodetic control lattice — the only correct way to place or sample it */
    geo?: GeoLattice
  }[]
}

export interface Structure {
  kind: 'bridge' | 'overpass' | 'gantry'
  source?: string
  s_start: number
  s_end: number
  length_m: number
  deck_z_min: number | null
  deck_z_max: number | null
  clearance_m: number | null
  height_above_ground_m: number | null
}

export interface Crossing {
  s: number
  kind: string | null
  relation: string
  name: string | null
  inferred?: boolean
  /**
   * The crossing way's OSM structure tags, kept since 2026-10-06 (they used to be stripped at
   * export). `tunnel`/`layer` say a road goes UNDER rather than over — the tell for a portal — and
   * `bridge` says the crossing is on a structure at all. Absent on bakes before then.
   */
  bridge?: string | null
  tunnel?: string | null
  layer?: string | null
  /** whether the SPINE itself is on a bridge at this crossing, rather than the crossing way */
  spine_bridge?: boolean
}

/** a road of a network site other than the primary: rendered as a first-class carriageway with its own strip */
/** a road end with nothing beyond it: a turning bulb unless a human says it is a true dead end */
export interface DeadEnd {
  s: number
  kind: 'cul_de_sac' | 'dead_end'
  radius_m?: number
  source?: string
  x?: number
  y?: number
}

export interface Branch {
  /** the bake's road id, `r<osm way id>`; the junction model's approaches name roads by it */
  id?: string
  name: string | null
  ref?: string | null
  highway?: string | null
  /**
   * What OSM said, as the bake left it: a number, a numeric string, or — when the ways along the
   * chain disagreed — a SORTED SET OF STRINGS of every value seen. See `branchLanes` in scene.ts.
   */
  lanes?: number | string | string[] | null
  oneway?: string | null
  length_m: number
  /** site x, y and lidar road grade z, densified ~10 m like the spine */
  coords: [number, number, number][]
  junctions?: { x: number; y: number; z: number; node?: number; with?: string[] }[]
  s_on_primary?: number | null
  profile?: { s: number[]; road_z: number[] } | null
  structures?: Structure[] | null
  dead_ends?: DeadEnd[] | null
}

export interface Manifest {
  /**
   * True when this site was baked as a WORLD: imagery, lidar and vegetation cover the whole
   * rectangle the network spans, not a buffer around each road. Where it is false, there is no
   * data past the verge and distance-from-a-road is a fair stand-in for "is there anything here".
   * Where it is true, it is not, and the ground itself decides. See PLAN-OPEN-WORLD.md.
   */
  world?: boolean
  slug: string
  ident: Record<string, string> | null
  /**
   * Where this site is, and what its stored metres mean. `epsg`/`origin` are the UTM the bake
   * writes; `anchor` is the same origin in WGS84 and is the geodetic authority — see
   * docs/corridor/FRAME.md. `kind` is absent on a manifest baked before the geodetic frame
   * existed, which is how the viewer knows it cannot place that site on the ellipsoid.
   */
  frame: {
    epsg: number
    origin: [number, number]
    /**
     * What the COORDINATES in this manifest are. "enu" is true ENU metres about `anchor`; "utm"
     * is UTM easting/northing minus `origin`, on a plane. Both are small metric numbers and
     * nothing else tells them apart, so guessing wrong draws the world rotated by the grid
     * convergence — 55 m out at 3 km, and plausible-looking until measured.
     */
    kind?: 'utm' | 'enu'
    anchor?: { lon: number; lat: number; h: number }
    /** UTM north relative to TRUE north at the anchor, degrees — a rotation, not an error */
    utm_convergence_deg?: number
    utm_scale?: number
  }
  bbox: [number, number, number, number]
  layers: Partial<Record<'dem' | 'chm' | 'naip' | 'horizon' | 'horizon_naip' | 'flora', Layer>> & { tiles?: TileIndex; pyramid?: PyrIndex }
  spine: {
    dead_ends?: DeadEnd[] | null
    coords: [number, number, number][]
    photo_s: number
    length_m: number
    segments: { s_start: number; s_end: number; tags: Record<string, string> }[]
  }
  siblings: [number, number][][]
  /** unnamed asphalt: OSM `highway=service` — driveways, parking aisles, alleys. Unmarked. */
  driveways?: { service: string; width_m: number; surface?: string | null; coords: [number, number, number][] }[]
  /** roads we do not model, stubbed ~60 m from where they meet ours so a junction goes somewhere */
  stubs?: { highway: string; name?: string | null; lanes?: number; oneway?: string | null; coords: [number, number, number][] }[]
  /** street furniture: signal masts and stop/give-way signs (OSM highway=traffic_signals|stop|give_way) */
  signals?: {
    /** `far_side`: the bake put the pole across the junction from the traffic it controls (2026-09-26); absent on older bakes, which placed it at the stop line */
    masts: { x: number; y: number; z: number; yaw_deg: number; travel_deg: number; arm_m: number; lanes: number; junction: number; tagged: boolean; x_id?: string; phase?: number; arm?: number; far_side?: boolean }[]
    signs: { kind: string; x: number; y: number; z: number; yaw_deg: number; travel_deg: number; x_id?: string; arm?: number; source?: string }[]
    /** the painted stop line for each stopping approach, across the lane at the stop position */
    bars?: { x: number; y: number; z: number; travel_deg: number; width_m: number; x_id?: string; arm?: number }[]
  } | null
  /**
   * Where the roads meet, and who has priority there (corridor/intersections.py).
   *
   * DERIVED from the drawn network rather than transcribed from OSM, because an American suburb
   * maps almost none of it: 854 drivable ways inside crofton-triangle carry three `highway=stop`
   * nodes between them. `control` is what the junction is, `approaches` is one arm per direction
   * you can arrive on, and `phases` groups the arms that run together on a signal.
   */
  intersections?: {
    list: {
      id: string
      nodes: number[]
      x: number
      y: number
      control: 'signals' | 'two_way_stop' | 'all_way_stop'
      arms: number
      superior: string
      approaches: {
        road: string; name: string | null; highway: string; rank: number; lanes: number
        bearing_deg: number; s: number; through: boolean; superior: boolean; stop: boolean
        stop_x: number; stop_y: number; width_m: number; phase?: number; stop_source?: string
      }[]
      phases: { arms: number[]; green_s: number; amber_s: number; all_red_s: number; superior: boolean }[]
      cycle_s: number
      /** street name signs, already truncated to the blade's character budget */
      blades: { text: string; full: string; truncated: boolean; yaw_deg: number; rank: number }[]
      /** candidate corners, best first; only the viewer knows which one is clear of the asphalt */
      corners: { x: number; y: number; why: string }[]
    }[]
    counts: Record<string, number>
    /** compact per-arm junction cut, derived at bake from `list` and kept resident so the base road
     *  — built before any tile streams — is painted around junctions; see `junctionPaintCut` */
    paint?: { x: number; y: number; a: [number, number][] }[]
  } | null
  /** polygons inside which every street was given a sidewalk (walkways.py), for the minimap/editor */
  sidewalk_zones?: [number, number][][] | null
  /** `amenity=parking` areas, in site metres; the viewer decides which are real (parking.ts) */
  parking?: { kind: string; surface?: string | null; access?: string | null; name?: string | null; area_m2: number; z: number; ring: [number, number][]; holes: [number, number][][] }[] | null
  /** `barrier=guard_rail|fence|wall|hedge` ways, with a vertex every 2 m and a grade (furniture.ts) */
  barriers?: { kind: string; height_m: number; material?: string | null; coords: [number, number, number][] }[] | null
  /** sidewalks and crossings: explicit `highway=footway` ways plus offsets from `sidewalk=*` roads */
  sidewalks?: { kind: string; width_m: number; marked: boolean; source: string; coords: [number, number, number][] }[] | null
  /** power lines and their supports (OSM power=line|minor_line, tower|pole) */
  power?: { lines: { kind: string; voltage?: string | null; coords: [number, number, number][] }[]; supports: { kind: string; x: number; y: number; z: number; height_m: number }[] } | null
  /** network sites: every road that is not the primary spine */
  branches?: Branch[]
  structures: Structure[]
  crossings: Crossing[]
  surface: {
    step_m: number
    s: number[]
    class: string[]
    lidar_ratio: (number | null)[]
    naip_brightness: (number | null)[]
    segments: { s_start: number; s_end: number; class: string }[]
    summary: Record<string, number>
  } | null
  profile: {
    s: number[]
    road_z: number[]
    ground_rel: Record<string, number[]>
    canopy: Record<string, number[]>
  } | null
  geology: {
    named_formations: string[]
    units: { name: string; strat_name: string; lith: string; descrip: string; b_age: number; t_age: number }[]
  }
  photos: { file: string; heading_deg: number | null; taken: string | null }[]
  lidar: { dataset: string | null; points_in_corridor: number | null; classes: Record<string, number> | null }
  /** OSM land-use polygons in site coordinates; groundcover.ts picks the grass type from them */
  landuse?: { class: string; ring: [number, number][]; area_m2?: number }[]
  /** A tiled world's land-use rings stream per cell, so the class->area summary `grassTypeFor`
   *  needs to pick the verge grass is computed once at bake and kept here (tools/corridor/export.py). */
  landuse_area?: Record<string, number>
  /** OSM footprints with a measured height, in site metres (tools/corridor/corridor/buildings.py) */
  buildings?: {
    ring: [number, number][]
    area_m2?: number
    rect?: { w: number; d: number; yaw_deg: number }
    height_m: number
    height_src?: string
    s?: number
    lat?: number
    tags?: Record<string, string>
  }[]
  /** OSM points of interest (tools/corridor/corridor/buildings.py): an amenity/shop kind and the
   *  index of the building it sits in. Streams per cell like the footprints. */
  pois?: { x: number; y: number; s?: number; lat?: number; kind: string; name?: string | null; building?: number | null }[]
  /** what grows here: LANDFIRE EVT classes with their corridor share, an FIA species mix,
   *  a ground-cover class per vegetation type and Daymet monthly climate (tools/corridor/corridor/flora.py).
   *  Absent on bakes older than 2026-09-21; flora.ts falls back to the OSM land-use rule. */
  flora?: import('./flora').FloraBlock | null
  /** terrain-and-data agent: cut faces (cuts.py), exposed rock (rock.py), water (water.py); absent on older bakes */
  cuts?: import('./rocks').CutsLayer | null
  rock?: import('./rocks').RockLayer | null
  water?: import('./water').WaterLayer | null
  /** Above a threshold the bake moves `buildings` out of the manifest into per-1 km-tile files;
   *  the viewer fetches only the tiles near the eye (see loadVectorTile). Absent on small sites. */
  vt?: VectorTileIndex
}

/** `manifest.vt`: the bake's per-tile vector index. Tiles are keyed on SITE metres: a footprint at
 *  (x, y) lives in tile `(floor(x / size_m), floor(y / size_m))`, exactly where the viewer buckets. */
export interface VectorTileIndex {
  size_m: number
  /** `vt/0`; tiles are `<dir>/<ix>_<iy>.json` under `web/` */
  dir: string
  /** the building tiles, with their footprint counts */
  buildings?: { x: number; y: number; n: number }[]
  /** the tiles that hold branches, so a tiled world knows which to fetch for the road network */
  branch?: { x: number; y: number; n: number }[]
  /** total footprints across the tiles, so a caller can report a count without loading them */
  count?: number
  /** every tile that holds any streamed vector, so a furniture-only tile is still reached */
  cells?: { x: number; y: number }[]
  /** per-array feature counts across the tiles, for the boot log and attribution without loading */
  counts?: Record<string, number>
}

export interface IndexEntry {
  slug: string
  ident: Record<string, string> | null
  length_m: number
  structures: number
  formations: string[]
  layers: string[]
  photos: string[]
}

/** Where the bake is served from. Dev: the Vite middleware. Later: an R2 public URL via ?data= */
export const DATA_BASE = new URLSearchParams(location.search).get('data') ?? ''

export async function fetchJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${DATA_BASE}${path}`, { cache: 'no-cache' })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return (await r.json()) as T
}

/**
 * How many parsed vector tiles may stay cached. They are big — a dc-metro tile is up to ~860 KB
 * of text, and parsed into JS objects it is several times that — and nothing downstream keeps the
 * arrays: a cell's meshes are built once and retained, but the tile's own `signals`, `parking`,
 * `barriers`, `intersections`, `cuts` and `water` are consumed and dropped. So the cache is only a
 * builder scratch pad and can be a small LRU rather than "for the life of the page". The pump
 * builds one cell at a time, so a few dozen covers the eye and its hysteresis with room to spare.
 *
 * Re-fetching an evicted tile is cheap (a conditional request) and correct: `hydrated` and
 * `builtStreet` already make a revisit a no-op, so the refetch is the only cost.
 */
const _vtiles = new Map<string, Promise<Record<string, unknown>>>()
let _vtileMax = 48
/** the cap, for a tuning readout; a value below 1 means unbounded (the old behaviour) */
export function setVectorTileCacheMax(n: number) { _vtileMax = n }
export function vectorTileCacheSize(): number { return _vtiles.size }

/** One vector tile, fetched once and cached. A missing tile is `{}`.
 *  A tile is a partial manifest: arrays (`buildings`, `sidewalks`) and nested objects
 *  (`power`, `signals`) keyed exactly as the manifest field they replace.
 *
 *  `cache: 'no-cache'`, NOT `force-cache`. A re-export (a re-bake, the ENU migration) rewrites
 *  the tile bodies at the SAME URL; `force-cache` served the browser's pre-export copy for the
 *  life of the cache without ever asking the server, so streamed roads stayed on the old flat
 *  vertical while the manifest spine and every raster (both fetched fresh) curved onto the
 *  ellipsoid — "some streets on flat earth, some on round". The server sends `Cache-Control:
 *  no-cache`; honour it. The map still dedupes while a tile is being built, so the network cost is
 *  one conditional request per tile as it streams, not one per builder that asks for it. */
export function loadVectorTile(slug: string, dir: string, x: number, y: number): Promise<Record<string, unknown>> {
  const url = `${DATA_BASE}/sites/${slug}/web/${dir}/${x}_${y}.json`
  let p = _vtiles.get(url)
  if (p) {
    // LRU: touch on use, so the tiles the eye is working stay and the ones behind it age out
    _vtiles.delete(url)
    _vtiles.set(url, p)
    return p
  }
  p = fetch(url, { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : {}))
    .catch(() => ({}))
  _vtiles.set(url, p)
  if (_vtileMax >= 1) {
    // evict oldest-first, never the tile we just asked for
    for (const k of _vtiles.keys()) {
      if (_vtiles.size <= _vtileMax) break
      if (k !== url) _vtiles.delete(k)
    }
  }
  return p
}

export function loadImage(path: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => ok(img)
    img.onerror = () => fail(new Error(`image ${path}`))
    img.src = `${DATA_BASE}${path}`
  })
}

/** Decode an RGB-encoded height PNG (R high byte, G low byte) into metres. */
export function decodeHeights(img: HTMLImageElement, layer: Layer): Float32Array {
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, c.width, c.height).data
  const out = new Float32Array(c.width * c.height)
  const zmin = layer.zmin ?? 0
  const zs = layer.zscale ?? 0.01
  for (let i = 0; i < out.length; i++) out[i] = zmin + ((px[i * 4] << 8) | px[i * 4 + 1]) * zs
  return reliefHeights(out)
}

/** Decode an 8-bit PNG of CLASS INDICES (the flora grid). No scaling: these are not measurements. */
export function decodeIndex(img: HTMLImageElement): Uint8Array {
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, c.width, c.height).data
  const out = new Uint8Array(c.width * c.height)
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4]
  return out
}

/** Decode an 8-bit scalar PNG (canopy) into metres. */
export function decodeScalar(img: HTMLImageElement, scale: number): Float32Array {
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, c.width, c.height).data
  const out = new Float32Array(c.width * c.height)
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * scale
  return out
}

/**
 * Bilinear, never nearest-cell. The car samples the ground at its four wheels and the DEM is a
 * 2 m (or 8 m) lattice: a nearest-cell lookup made the car step from cell to cell across a field,
 * "snapping to a grid" (Rich, 2026-09-26). Cell centres are at (c + 0.5, r + 0.5).
 */
export function bilinear(data: Float32Array, w: number, h: number, u: number, v: number): number {
  const gx = Math.min(w - 1, Math.max(0, u * w - 0.5)), gy = Math.min(h - 1, Math.max(0, v * h - 0.5))
  const c0 = Math.floor(gx), r0 = Math.floor(gy)
  const c1 = Math.min(w - 1, c0 + 1), r1 = Math.min(h - 1, r0 + 1)
  const fx = gx - c0, fy = gy - r0
  const a = data[r0 * w + c0], b = data[r0 * w + c1], c = data[r1 * w + c0], d = data[r1 * w + c1]
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
}
