// The world editor's client. ONE origin, and it is this page's own.
//
// Every path here is relative. In the pod `tools/worldeditor` serves the built app, `/api`,
// `/sites` and `/assetsvc` from the same host; in development Vite serves the app and proxies
// those three prefixes to the same service (`WORLDEDITOR=http://localhost:8780 npm run dev`). So
// there is no base URL to configure, no CORS, and — the part that matters — no Overpass URL, no
// Kubernetes API URL and no GPU service URL anywhere in the bundle. If you find yourself wanting
// to add one, the backend is missing an endpoint.

export interface Way {
  id: number
  ident: string
  name: string | null
  ref: string | null
  highway: string
  lanes: string | null
  oneway: string | null
  /** WGS84 [lon, lat]. Nothing in this app is ever site metres — see tools/worldeditor/geo.mjs. */
  line: [number, number][]
}

export interface Box {
  south: number
  west: number
  north: number
  east: number
}

export interface TileId {
  z: number
  x: number
  y: number
}

export interface TileDoc {
  layer: string
  z: number
  x: number
  y: number
  kind: 'points' | 'lines'
  bounds: Box
  items: unknown[]
  raw: number
  cache: 'hit' | 'miss'
  upstream: string | null
  seconds: number
  provisional?: boolean
  note?: string
}

export interface BorderFeature {
  properties: { name: string | null; iso: string | null }
  geometry: { type: string; coordinates: number[][][] | number[][][][] }
}

export interface WorldCity {
  name: string
  country: string | null
  region: string | null
  pop: number
  rank: number
  lat: number
  lon: number
}

/** A geocoder result. `bbox` is why this exists: you frame a country, you do not pin it. */
export interface Place {
  name: string
  short: string
  kind: string
  category: string
  lat: number
  lon: number
  bbox: Box | null
  importance: number
}

/** A place somebody kept. Upstream of a world: cheap to add, promoted when it earns it. */
export interface IndexedPlace {
  id: string
  name: string
  note?: string
  lat: number
  lon: number
  bbox?: Box | null
  kind?: string
  country?: string | null
  source?: string
  added?: string
  /** set once this place has become a world */
  world?: string | null
}

export interface World {
  slug: string
  kind?: string
  lat: number
  lon: number
  radius_m: number
  primary?: string | null
  roads?: string[]
  all_streets?: boolean
  region?: string
  note?: string
  boundary?: [number, number][]
  source?: string
  created?: string
  /** the look a published world opens with */
  look?: { style?: string; season?: string; water_level_m?: number }
  baked?: { slug: string; fetched: string | null; frame: { kind?: string; epsg?: number; anchor?: { lon: number; lat: number } } | null; seconds: number | null; web: boolean } | null
}

export interface Selection {
  square: { ways: number; metres: number }
  boundary: { ways: number; metres: number } | null
  idents: { ident: string; ways: number; metres: number; highway: string }[]
  reference: { slug: string; radius_m: number; ways: number; note: string }
}

export interface Preview {
  circle: { lon: number; lat: number; radius_m: number }
  bbox: { south: number; west: number; north: number; east: number }
  selection: Selection
  primary: string | null
  warnings: string[]
  cache: 'hit' | 'miss'
}

export interface Run {
  id: string
  kind: 'bake' | 'publish'
  slug: string
  label: string
  runner: 'kubernetes' | 'local'
  state: 'starting' | 'queued' | 'running' | 'done' | 'failed'
  started: string
  finished: string | null
  detail: string | null
  job: string | null
  pod: string | null
  exit: number | null
}

export interface Config {
  data: string
  overpass: { urls: string[]; cache: string }
  runs: { runner: string; image: string; claim: string; namespace: string }
  assetsvc: string | null
  bucket: { bucket: string; endpoint: string; prefix: string } | null
  authored: string[]
  limits: { min_radius_m: number; warn_radius_m: number; max_radius_m: number; max_span_lat: number; max_span_lon: number }
  layers: { id: string; label: string; minZoom: number; maxZoom: number; tile: number; kind: 'points' | 'lines' }[]
  adoptedRuns: string[]
}

export interface Ready {
  overpass: { ok: boolean; status?: number; ms?: number; detail?: string }
  kubernetes: { ok: boolean; namespace?: string; detail?: string }
  runner: string
  assetsvc: string | null
}

/**
 * Every failure carries the server's own words.
 *
 * The backend answers a refusal with `{error}` and a real status, and the useful half of the
 * message is always the second half ("radius_m 31000 m is over the 20000 m ceiling — bake it in
 * pieces"). A client that throws `HTTP 400` loses exactly the part a person needed.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } : init?.headers,
  })
  const text = await r.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${path}: ${r.status} ${text.slice(0, 200)}`)
  }
  if (!r.ok) throw new Error((body as { error?: string })?.error ?? `${path}: HTTP ${r.status}`)
  return body as T
}

export const api = {
  config: () => call<Config>('/api/config'),
  ready: () => call<Ready>('/api/ready'),

  roads: (b: { south: number; west: number; north: number; east: number }, signal?: AbortSignal) =>
    call<{ ways: Way[]; cache: 'hit' | 'miss'; upstream: string | null; fellBack: boolean | null; key: string }>(
      `/api/osm/roads?south=${b.south.toFixed(6)}&west=${b.west.toFixed(6)}&north=${b.north.toFixed(6)}&east=${b.east.toFixed(6)}`,
      { signal },
    ),
  search: (q: string) => call<{ places: Place[]; cache: string }>(`/api/osm/search?q=${encodeURIComponent(q)}`),

  /* ---- the layer stack ---- */
  plan: (b: Box, zoom: number, signal?: AbortSignal) =>
    call<{ zoom: number; plan: { layer: string; kind: 'points' | 'lines'; tiles: TileId[]; total: number }[] }>(
      `/api/osm/plan?south=${b.south.toFixed(5)}&west=${b.west.toFixed(5)}&north=${b.north.toFixed(5)}&east=${b.east.toFixed(5)}&zoom=${zoom.toFixed(2)}`,
      { signal },
    ),
  tile: (layer: string, t: TileId, zoom: number, signal?: AbortSignal) =>
    call<TileDoc>(`/api/osm/tile/${layer}/${t.z}/${t.x}/${t.y}?zoom=${zoom.toFixed(2)}`, { signal }),
  borders: () => call<{ features: BorderFeature[]; source: string | null; note?: string }>('/api/osm/borders'),
  cities: () => call<{ cities: WorldCity[]; source: string | null; note?: string }>('/api/osm/cities'),
  purgeEmpty: () => call<{ responses: unknown[]; tiles: unknown[] }>('/api/osm/cache/purge-empty', { method: 'POST' }),

  /* ---- the place index ---- */
  places: () => call<{ places: IndexedPlace[] }>('/api/places'),
  addPlace: (p: Partial<IndexedPlace>) => call<{ place: IndexedPlace }>('/api/places', { method: 'POST', body: JSON.stringify(p) }),
  updatePlace: (id: string, p: Partial<IndexedPlace>) => call<{ place: IndexedPlace }>(`/api/places/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deletePlace: (id: string) => call<{ deleted: string }>(`/api/places/${id}`, { method: 'DELETE' }),
  /** Every upstream in the order they are tried, and what each just answered. */
  overpassStatus: () =>
    call<{ ours: string | null; using: string | null; cache: string; upstreams: { url: string; host: string; ok: boolean; status?: number; ms: number; detail?: string }[] }>(
      '/api/osm/status',
    ),

  worlds: () => call<{ worlds: World[] }>('/api/worlds'),
  world: (slug: string) => call<{ world: World }>(`/api/worlds/${slug}`),
  preview: (body: { boundary?: [number, number][]; centre?: { lat: number; lon: number }; radius_m?: number }) =>
    call<Preview>('/api/worlds/preview', { method: 'POST', body: JSON.stringify(body) }),
  createWorld: (body: Record<string, unknown>) => call<{ world: World; warnings: string[] }>('/api/worlds', { method: 'POST', body: JSON.stringify(body) }),
  saveWorld: (slug: string, body: Record<string, unknown>) =>
    call<{ world: World; warnings: string[]; movedM: number }>(`/api/worlds/${slug}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteWorld: (slug: string) => call<{ deleted: string }>(`/api/worlds/${slug}`, { method: 'DELETE' }),

  runs: () => call<{ runs: Run[]; runner: string }>('/api/runs'),
  run: (id: string) => call<{ run: Run }>(`/api/runs/${id}`),
  bake: (slug: string, opts: { skip?: string } = {}) => call<{ run: Run }>('/api/runs/bake', { method: 'POST', body: JSON.stringify({ slug, ...opts }) }),
  publish: (slug: string, opts: { dryRun?: boolean } = {}) => call<{ run: Run }>('/api/runs/publish', { method: 'POST', body: JSON.stringify({ slug, ...opts }) }),
  cancel: (id: string) => call<{ run: Run }>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  /** Bytes from `offset`. The whole streaming protocol — see tools/worldeditor/runs.mjs. */
  log: (id: string, offset: number) => call<{ text: string; offset: number; size: number; truncated: boolean }>(`/api/runs/${id}/log?offset=${offset}`),

  catalog: () => call<{ assets: { id: string; name: string; category: string; glb?: string; footprint_m: [number, number]; height_m: number }[] }>('/api/catalog'),
  mergeCatalog: (assets: Record<string, unknown>[]) =>
    call<{ total: number; added: string[]; updated: string[] }>('/api/catalog', { method: 'POST', body: JSON.stringify({ assets }) }),
}
