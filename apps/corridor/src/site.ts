// The site manifest as tools/corridor/corridor/export.py writes it. Metres, relative to the site
// origin (the photo fix projected to UTM), z in metres NAVD88. Keep this in step with export.py.

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
  name: string | null
  ref?: string | null
  highway?: string | null
  lanes?: number | null
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
    masts: { x: number; y: number; z: number; yaw_deg: number; travel_deg: number; arm_m: number; lanes: number; junction: number; tagged: boolean; x_id?: string; phase?: number; arm?: number }[]
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
  /** what grows here: LANDFIRE EVT classes with their corridor share, an FIA species mix,
   *  a ground-cover class per vegetation type and Daymet monthly climate (tools/corridor/corridor/flora.py).
   *  Absent on bakes older than 2026-09-21; flora.ts falls back to the OSM land-use rule. */
  flora?: import('./flora').FloraBlock | null
  /** terrain-and-data agent: cut faces (cuts.py), exposed rock (rock.py), water (water.py); absent on older bakes */
  cuts?: import('./rocks').CutsLayer | null
  rock?: import('./rocks').RockLayer | null
  water?: import('./water').WaterLayer | null
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
  return out
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
