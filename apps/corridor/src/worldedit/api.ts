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

/** The surface roles a world can override. Mirrors SURFACE_ROLES in tools/worldeditor/worlds.mjs. */
export const SURFACE_ROLES = ['road', 'shoulder', 'sidewalk', 'paving', 'ground_cover', 'verge'] as const
export type SurfaceRole = (typeof SURFACE_ROLES)[number]

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
  look?: { style?: string; season?: string; water_level_m?: number; relief?: number }
  /** role -> material id. An absent role uses the viewer's default. */
  surfaces?: Partial<Record<SurfaceRole, string>>
  baked?: { slug: string; fetched: string | null; frame: { kind?: string; epsg?: number; anchor?: { lon: number; lat: number } } | null; seconds: number | null; web: boolean } | null
}

export interface Selection {
  square: { ways: number; metres: number }
  boundary: { ways: number; metres: number } | null
  idents: { ident: string; ways: number; metres: number; highway: string }[]
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

/* ---- what the new services return ------------------------------------------------------------ */

export interface Level {
  id: string
  world: string
  defaults?: { time?: string; weather?: string; season?: string }
  mode?: string
  placements?: { asset: string; at: number[]; yaw?: number }[]
  splats?: { run?: string; id?: string }[]
  simulations?: { kind: string; [k: string]: unknown }[]
  scenario?: {
    goal?: { type: string; target?: number; time_s?: number }
    events?: { when: string; do: string; [k: string]: unknown }[]
    scoring?: { event: string; points: number; per?: number }[]
  } | null
}

export interface Capture {
  id: string
  world: string | null
  rig: string | null
  note: string
  created: string
  state: string
  chapters: { camera: string; name: string; bytes: number; upload: string; offset: number; complete: boolean }[]
}

export interface CaptureManifest {
  id: string
  world: string | null
  cameras: Record<string, { order: number; name: string; bytes: number; path: string }[]>
  ordering: string
  chapters: number
  pending: number
  bytes: number
}

/** where an inference model is, and how the resolver found it (tools/worldeditor/models.mjs) */
export interface ModelTarget {
  url: string | null
  via: 'env' | 'crd' | 'crd-gateway' | 'service' | 'public' | 'none'
  model: string
  detail?: string
  why?: string
  live?: boolean
  serving?: string[]
  matches?: boolean
}

export interface SpecSummary {
  id: string
  subject: string | null
  paint: string | null
  era: string | null
  roster: string
}

export interface Recipe extends SpecSummary {
  class: string | null
  chroma: string
  glassKey: string
  prompt: string
  negative: string
  chars: number
  over: boolean
  why: Record<string, string>
}

export interface AssetJob {
  job: string
  lane: string
  label: string
  state: string
  progress?: Record<string, unknown>
  result?: { id?: string; drawn?: { file: string; seed: number; seconds: number }[]; recipe?: Record<string, unknown> }
  detail?: string
}

export interface CatalogItem {
  id: string
  chosen: string | null
  seed: number | null
  views?: string[]
  spec?: { id: string; roster: string; chroma: string; glassKey: string }
}

export interface TrainingRun {
  name: string
  kind?: string
  via?: string
  capture?: string | null
  world?: string | null
  workers?: number
  createdAt?: string
  state?: string
  phase?: string | null
  message?: string | null
  steps?: { step: string; ok: boolean; why: string | null }[]
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
    // `variant` is the QUESTION the layer asks at this zoom — part of a tile's identity, not just
    // a server-side cache detail. See `tileKey` in main.ts.
    call<{ zoom: number; plan: { layer: string; kind: 'points' | 'lines'; variant?: string; tiles: TileId[]; total: number }[] }>(
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

  /* ---- moving worlds between machines -------------------------------------------------------
   *
   * Two different sizes of thing, deliberately kept apart. A DEFINITION is a few hundred bytes of
   * JSON — where, how big, which road is the spine, and the levels set there — and it is how you
   * hand somebody a place to bake. A BAKED world is hundreds of megabytes of raster and is how
   * you hand them the result without the eight hours.
   *
   * These go through the browser rather than `call()` because one is a download and the other is
   * a file the person picked: neither is JSON in and JSON out. */

  /** The URL of a world bundle — definitions plus the levels set in them. Empty slugs = all. */
  exportWorldsUrl: (slugs: string[] = [], levels = true) => {
    const q = new URLSearchParams()
    for (const s of slugs) q.append('slug', s)
    if (!levels) q.set('levels', '0')
    const query = q.toString()
    return `/api/worlds/export${query ? `?${query}` : ''}`
  },
  importWorlds: (bundle: unknown, replace = false) =>
    call<{ imported: string[]; levels: string[]; skipped: { slug?: string; level?: string; why: string }[] }>(
      `/api/worlds/import${replace ? '?replace=1' : ''}`,
      { method: 'POST', body: JSON.stringify(bundle) },
    ),

  /** A baked world as one zip. `web` is the viewer's half — most of the value, a fraction of the bytes. */
  archiveUrl: (slug: string, web = true) => `/api/sites/${slug}/archive${web ? '?web=1' : ''}`,
  /**
   * Upload a baked world. Raw bytes, not multipart: the service reads the body as the zip, and
   * wrapping it in a form boundary would mean parsing multipart in a dependency-free server for
   * no gain. Progress is reported because these are big enough that silence reads as a hang.
   */
  importSite: (file: File, replace: boolean, onProgress?: (sent: number, total: number) => void) =>
    new Promise<{ site: string; files: number; bytes: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/sites/import${replace ? '?replace=1' : ''}`)
      xhr.setRequestHeader('Content-Type', 'application/zip')
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.total || file.size)
      xhr.onload = () => {
        let body: { error?: string } = {}
        try { body = JSON.parse(xhr.responseText) } catch { /* a proxy's HTML error page */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as { site: string; files: number; bytes: number })
        // An ingress that refuses the body answers before the service ever sees it, and its page
        // is HTML — so say which limit was hit rather than printing a fragment of nginx.
        else if (xhr.status === 413) reject(new Error(body.error ?? 'too large for the proxy in front of the service (nginx proxy-body-size)'))
        else reject(new Error(body.error ?? `HTTP ${xhr.status}`))
      }
      xhr.onerror = () => reject(new Error('the upload failed before it reached the service'))
      xhr.send(file)
    }),

  runs: () => call<{ runs: Run[]; runner: string }>('/api/runs'),
  run: (id: string) => call<{ run: Run }>(`/api/runs/${id}`),
  bake: (slug: string, opts: { skip?: string } = {}) => call<{ run: Run }>('/api/runs/bake', { method: 'POST', body: JSON.stringify({ slug, ...opts }) }),
  publish: (slug: string, opts: { dryRun?: boolean } = {}) => call<{ run: Run }>('/api/runs/publish', { method: 'POST', body: JSON.stringify({ slug, ...opts }) }),
  cancel: (id: string) => call<{ run: Run }>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  /** Bytes from `offset`. The whole streaming protocol — see tools/worldeditor/runs.mjs. */
  log: (id: string, offset: number) => call<{ text: string; offset: number; size: number; truncated: boolean }>(`/api/runs/${id}/log?offset=${offset}`),

  /* ---- levels: a world dressed and given something to do (tools/worldeditor/levels.mjs) ---- */
  levels: () => call<{ levels: Level[]; facts: Record<string, string>; actions: Record<string, string>; modes: string[] }>('/api/levels'),
  level: (id: string) => call<{ level: Level; ok: boolean; errors: string[]; warnings: string[] }>(`/api/levels/${id}`),
  createLevel: (body: Partial<Level>) => call<{ level: Level; warnings: string[] }>('/api/levels', { method: 'POST', body: JSON.stringify(body) }),
  saveLevel: (id: string, body: Partial<Level>) => call<{ level: Level; warnings: string[] }>(`/api/levels/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteLevel: (id: string) => call<{ deleted: string }>(`/api/levels/${id}`, { method: 'DELETE' }),
  /** check without saving — what the in-app agent calls before it writes anything */
  validateLevel: (body: Partial<Level>) => call<{ ok: boolean; errors: string[]; warnings: string[] }>('/api/levels/validate', { method: 'POST', body: JSON.stringify(body) }),

  /* ---- captures: footage in, splat world out ---- */
  captures: () => call<{ captures: Capture[] }>('/api/captures'),
  capture: (id: string) => call<{ capture: Capture; manifest: CaptureManifest }>(`/api/captures/${id}`),
  createCapture: (body: { id: string; world?: string | null; rig?: string | null; note?: string }) =>
    call<{ capture: Capture }>('/api/captures', { method: 'POST', body: JSON.stringify(body) }),
  patchCapture: (id: string, body: Partial<Capture>) => call<{ capture: Capture }>(`/api/captures/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  beginChapter: (id: string, body: { camera: string; name: string; bytes: number }) =>
    call<{ upload: string; offset: number; bytes: number }>(`/api/captures/${id}/chapters`, { method: 'POST', body: JSON.stringify(body) }),
  uploadState: (upload: string) => call<{ upload: string; offset: number; exists: boolean }>(`/api/uploads/${upload}`),
  finishChapter: (upload: string, capture: string) =>
    call<{ chapter: unknown }>(`/api/uploads/${upload}/done`, { method: 'POST', body: JSON.stringify({ capture }) }),
  /** how big a chunk may be — only the server knows what ingress is in front of it */
  uploadLimits: () => call<{ chunkBytes: number; why: string }>('/api/uploads/limits'),

  /**
   * Send one slice of a chapter.
   *
   * RAW, not through `call`: the body is a Blob of video and `call` is for JSON. The range header
   * is what the server appends at, and it refuses anything that does not start where the file
   * currently ends — so a 409 here is not a failure, it is the server telling us where to resume,
   * and it carries the offset to do it with.
   */
  putChunk: async (upload: string, offset: number, blob: Blob, total: number, signal?: AbortSignal): Promise<{ resumeAt: number } | { offset: number }> => {
    const r = await fetch(`/api/uploads/${encodeURIComponent(upload)}`, {
      method: 'PUT',
      headers: { 'content-range': `bytes ${offset}-${offset + blob.size - 1}/${total}` },
      body: blob,
      signal,
    })
    const body = (await r.json().catch(() => null)) as { offset?: number; error?: string } | null
    if (r.status === 409 && typeof body?.offset === 'number') return { resumeAt: body.offset } as const
    if (!r.ok) throw new Error(body?.error ?? `upload: HTTP ${r.status}`)
    return { offset: body?.offset ?? offset + blob.size } as const
  },

  /* ---- training: the featured TrainingDeployment, or a plain JobSet ---- */
  trainingPlan: () => call<{ via: string; kind: string | null; available: boolean; featured?: boolean; why?: string }>('/api/training/plan'),
  trainingPreview: (body: Record<string, unknown>, as?: string) =>
    call<{ via: string; kind: string; manifest: unknown }>(`/api/training/preview${as ? `?as=${as}` : ''}`, { method: 'POST', body: JSON.stringify(body) }),
  /** Free GPUs, asked of the scheduler. The worker count is a function of this, not of the footage. */
  trainingGpus: () => call<{ free: number; total: number; used?: number; why?: string }>('/api/training/gpus'),
  startTraining: (body: Record<string, unknown>) =>
    call<{ run: TrainingRun }>('/api/training/runs', { method: 'POST', body: JSON.stringify(body) }),
  trainingRuns: () => call<{ runs: TrainingRun[] }>('/api/training/runs'),
  stopTraining: (name: string) =>
    call<{ deleted: string }>(`/api/training/runs/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  /* ---- which inference this pod can reach, and how it found it ---- */
  models: (live = false) => call<{ models: Record<string, ModelTarget> }>(`/api/models${live ? '?live=1' : ''}`),

  /* ---- the asset pipeline, through the assetsvc proxy ---- */
  specs: () => call<{ rosters: string[]; count: number; classes: Record<string, SpecSummary[]> }>('/assetsvc/specs'),
  recipe: (id: string) => call<Recipe>(`/assetsvc/specs/${id}`),
  candidates: (id: string, body: { count?: number; steps?: number; seed?: number }) =>
    call<{ job: { job: string }; recipe: Recipe }>(`/assetsvc/specs/${id}/candidates`, { method: 'POST', body: JSON.stringify(body) }),
  assetJobs: () => call<{ jobs: AssetJob[] }>('/assetsvc/jobs'),
  chooseView: (id: string, view: string) => call<{ item: CatalogItem }>(`/assetsvc/catalog/${id}/choose`, { method: 'POST', body: JSON.stringify({ view }) }),
  /** the expensive half: one GPU, serialised, thirty to forty seconds. Only after a human picked. */
  reconstruct: (id: string, body: { finish?: boolean } = {}) => call<AssetJob>(`/assetsvc/catalog/${id}/mesh`, { method: 'POST', body: JSON.stringify(body) }),

  catalog: () => call<{ assets: { id: string; name: string; category: string; glb?: string; footprint_m: [number, number]; height_m: number }[] }>('/api/catalog'),
  mergeCatalog: (assets: Record<string, unknown>[]) =>
    call<{ total: number; added: string[]; updated: string[] }>('/api/catalog', { method: 'POST', body: JSON.stringify({ assets }) }),
}
