// The site manifest as tools/corridor/corridor/export.py writes it. Metres, relative to the site
// origin (the photo fix projected to UTM), z in metres NAVD88. Keep this in step with export.py.

export interface Layer {
  file: string
  res: number
  size: [number, number]
  bbox: [number, number, number, number] // xmin, ymin, xmax, ymax relative to origin
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
export interface TileIndex {
  size_m: number
  /** site-frame position of tile (0, 0)'s minimum corner */
  origin: [number, number]
  res: { dem: number; naip: number | null; chm: number | null }
  list: { x: number; y: number; dem: { zmin: number; zscale: number }; chm?: boolean; naip?: boolean }[]
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
}

export interface Manifest {
  slug: string
  ident: Record<string, string> | null
  frame: { epsg: number; origin: [number, number] }
  bbox: [number, number, number, number]
  layers: Partial<Record<'dem' | 'chm' | 'naip' | 'horizon' | 'horizon_naip', Layer>> & { tiles?: TileIndex }
  spine: {
    coords: [number, number, number][]
    photo_s: number
    length_m: number
    segments: { s_start: number; s_end: number; tags: Record<string, string> }[]
  }
  siblings: [number, number][][]
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
