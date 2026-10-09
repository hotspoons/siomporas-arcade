// The editor's client for assetsvc. The ONLY origin the browser talks to for asset generation.
//
// There is deliberately no flux or TRELLIS URL anywhere in this file, or anywhere else in the
// browser bundle. Those are ClusterIP services on the cluster's own network and the page has no
// route to them and no credentials for them; assetsvc reaches them and the editor reaches
// assetsvc. If you ever find yourself wanting to add a model URL here, that is the sign the
// backend is missing an endpoint.
//
// WHERE THE SERVICE IS. In order: a `?assetsvc=` query parameter (handy for pointing a dev editor
// at a colleague's instance), then `VITE_ASSETSVC` at build time, then same-origin `/assetsvc`
// (which is how it looks in the cluster, behind one ingress), then localhost:8770 for a laptop.
//
// NOT CONFIGURED IS A NORMAL STATE. Asset generation is off by default and corridor works
// completely without it, so every call here can fail and the UI's job is to say "no service"
// rather than to break.

export interface AssetItem {
  id: string
  subject: string
  /** which sort of thing it is filed as — open vocabulary, decides DEFAULTS */
  kind: string
  /**
   * What it IS: prop, vehicle, actor or weapon. Closed, and it decides CAPABILITY.
   *
   * Absent on almost everything, and that is the normal case rather than a gap: `typeOf` in
   * `classes.ts` reads it off the class, so the mapping lives in one place instead of being
   * stamped onto every record at import time and going stale there. Stored only when somebody
   * overrides it.
   */
  type?: string | null
  prompt: string
  negative: string
  notes: string
  tags: string[]
  chosen: string | null
  created: string
  updated: string
  views: string[]
  mesh: number | null
  finished: number | null
  /** the finished mesh with its glazing split into KHR_materials_transmission — the one with glass */
  glass?: number | null
  state: 'spec' | 'drawn' | 'meshed' | 'finished'
  history: { at: string; step: string; file?: string; model?: string; seconds?: number }[]
  /** `null` is shared with every world; a slug belongs to that world alone */
  world?: string | null
  /** what it was forked from, when it was */
  forkedFrom?: string | null
  /** which bone does what, when somebody has said rather than letting the names be guessed */
  rig?: RigBinding | null
  /**
   * How the model is turned about its up axis wherever it is used, degrees. A reconstruction
   * faces whatever way the exporter felt like; this is the fact about the MODEL that says which
   * way is its front (+X once turned), so no guess is needed. Absent: as exported, and guessed.
   */
  orient?: { yaw_deg: number } | null
  /** metres: how big the thing is, so a unit-cube reconstruction is placed at its real size */
  size_m?: { w?: number; d?: number; h?: number } | null
  /** role → which mesh that role loads. Absent means the class default; see `USED_FOR` */
  use?: Record<string, MeshVariant> | null
  /**
   * How it drives, when it is a vehicle. The schema and the units are in `src/vehicles.ts`.
   *
   * Typed as `unknown` here on purpose: this file is the transport, and giving it the real type
   * would make the service client import the physics engine to describe a field it only forwards.
   * Callers narrow it with `validateVehicle`, which is the thing that actually knows.
   */
  vehicle?: unknown
  /** how it moves and fights, when it is a person, an animal or an enemy. Schema: `src/actorspecs.ts` */
  actor?: unknown
  /** what it does when fired, when it is a weapon. Schema: `src/weapons.ts` */
  weapon?: unknown
}

/**
 * The roles a game drives, bound to the bones that actually do them.
 *
 * The viewer guesses from bone NAMES and is right most of the time; this is what you write when
 * it is not — a rig whose wheels are `Bone.007`, or one whose "arm" is an excavator's stick.
 */
/**
 * The three meshes an asset can have, in order of fidelity.
 *
 * `glass` is the finished mesh with its glazing split into KHR_materials_transmission — the only
 * one whose windows are actually windows; `finished` is the same geometry with them painted on;
 * `raw` is what the reconstructor returned, before simplifying: several times the triangles and
 * no compression.
 */
export type MeshVariant = 'glass' | 'finished' | 'raw'

/** The file each variant is stored as. One place, so the viewer and the placeable catalog agree. */
export const MESH_FILE: Record<MeshVariant, string> = {
  glass: 'mesh.glass.glb',
  finished: 'mesh.finished.glb',
  raw: 'mesh.glb',
}

/** The collections that hold a visual plus its configuration. */
export type BuildKind = 'vehicles' | 'actors' | 'weapons' | 'presets' | 'traffic'

/**
 * One crafted thing: a chosen model, a preset it started from, and the document that configures it.
 *
 * `asset` may be null — a build can be given its numbers before anybody has drawn it, which is how
 * an agent writes a dozen of these and a person picks the models later.
 */
export interface Build<Doc> {
  id: string
  name: string
  /** a catalog id, or null while it has no model yet */
  asset: string | null
  /** which preset it started from, for the readout. Not a live link: the doc is the truth */
  preset?: string | null
  notes?: string
  doc: Doc
  created?: string
  updated?: string
  /**
   * Only on a row in the `presets` collection: which of the three it is a starting point for.
   *
   * A preset is a build with no model, so it is the same record and the same routes; this is the
   * one field that says a vehicle preset must not be offered when somebody is making a weapon.
   */
  for?: 'vehicle' | 'actor' | 'weapon'
}

export interface RigBinding {
  /** role → bone names, in the order the game expects them (wheels: FL, FR, RL, RR) */
  roles: Record<string, string[]>
  /** what it is, for anything that treats a car differently from a person */
  convention?: string
  updated?: string
}

export interface AssetJob {
  job: string
  lane: 'image' | 'mesh'
  label: string
  state: 'queued' | 'running' | 'done' | 'failed'
  ahead: number
  progress: { state?: string; model?: string } | null
  result: Record<string, unknown> | null
  detail: string | null
}

export interface ModelRoster {
  defaults: { image?: string; mesh?: string }
  models: { id: string; kind: string; model?: string; url: string; configured: boolean }[]
  reachable: Record<string, { ok: boolean; detail?: string }>
  s3: { configured: boolean; bucket: string | null; endpoint: string; prefix: string }
}

function baseUrl(): string {
  const q = new URLSearchParams(location.search).get('assetsvc')
  if (q) return q.replace(/\/$/, '')
  const built = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ASSETSVC
  if (built) return built.replace(/\/$/, '')
  /*
   * THROUGH THE EDITOR, ALWAYS. In the cluster the editor and the service sit behind one host, so
   * a relative path is right and needs no CORS. In development Vite proxies `/assetsvc` to the
   * world editor (`WORLDEDITOR=…`), which forwards to the service IT is configured for — and that
   * is the one whose builds the editor screens write. This used to fall back to
   * `http://localhost:8770` on a dev port, which is whichever asset service happens to be on 8770
   * and was, measured, an older one with no `/traffic` route and a different data directory: the
   * viewer could not read the traffic set the editor had just saved. One service, reached one way.
   * `?assetsvc=` still overrides for a probe.
   */
  return `${location.origin}/assetsvc`
}

export const ASSETSVC = baseUrl()

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ASSETSVC}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`assetsvc ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `assetsvc ${res.status}`)
  return body as T
}

/** One tileable surface: three maps, and the number that makes them the right size. */
export interface Material {
  id: string
  category: string
  name: string
  /** how many metres one tile of these maps covers. The whole game. */
  metres_per_tile: number
  albedo: string
  normal?: string
  roughness?: string
  /** the seed and the prompt that drew it — what makes a texture improvable rather than final */
  seed?: number
  prompt?: string
}

export const assetsvc = {
  url: ASSETSVC,

  /** Is there a service there at all? Resolves false rather than throwing — see the file header. */
  async health(): Promise<boolean> {
    try {
      await call('/health')
      return true
    } catch {
      return false
    }
  },

  models: () => call<ModelRoster>('/models'),
  list: () => call<{ items: AssetItem[] }>('/catalog').then((r) => r.items),
  get: (id: string) => call<AssetItem>(`/catalog/${encodeURIComponent(id)}`),
  put: (spec: Partial<AssetItem> & { id: string }) => call<AssetItem>('/catalog', { method: 'POST', body: JSON.stringify(spec) }),
  remove: (id: string) => call<{ deleted: string }>(`/catalog/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** copy it, files and all, usually to make a world's own version of a shared thing */
  fork: (id: string, to: string, world: string | null) =>
    call<AssetItem>(`/catalog/${encodeURIComponent(id)}/fork`, { method: 'POST', body: JSON.stringify({ to, world }) }),

  /**
   * IMPORT A MODEL SOMEBODY ALREADY HAS, over whatever is there.
   *
   * Rich, 2026-09-28: "You should also be able to import 3d models, not just generate them."
   * `.glb` becomes the mesh directly; the other formats are stored and reported as needing
   * converting, because a catalog entry that looks meshed and fails at load is worse than one
   * that says what it needs.
   */
  importModel: async (id: string, file: File): Promise<{ stored: string; format: string; bytes: number; loadable: boolean }> => {
    const r = await fetch(`${ASSETSVC}/catalog/${encodeURIComponent(id)}/model/${encodeURIComponent(file.name)}`, { method: 'PUT', body: file })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
    return body
  },

  /**
   * A sound of the build's own, stored under its asset as sounds/<name>. The answer's `entry` is
   * what goes into a document's `sounds` slot (`asset:<id>/<name>`); `soundbank.ts` resolves it
   * back to `fileUrl(id, 'sounds/<name>')`.
   */
  uploadSound: async (id: string, file: File): Promise<{ stored: string; entry: string; bytes: number }> => {
    const r = await fetch(`${ASSETSVC}/catalog/${encodeURIComponent(id)}/sound/${encodeURIComponent(file.name)}`, { method: 'PUT', body: file })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
    return body
  },

  image: (id: string, opts: { prompt?: string; negative?: string; size?: string; steps?: number; seed?: number } = {}) =>
    call<AssetJob>(`/catalog/${encodeURIComponent(id)}/image`, { method: 'POST', body: JSON.stringify(opts) }),

  /** pick the drawing TRELLIS meshes; a person's pick sticks through later draws */
  choose: (id: string, view: string) =>
    call<{ item: AssetItem }>(`/catalog/${encodeURIComponent(id)}/choose`, { method: 'POST', body: JSON.stringify({ view }) }),
  /** delete one drawing; if it was the chosen one, the newest left takes over */
  removeView: (id: string, view: string) =>
    call<{ item: AssetItem }>(`/catalog/${encodeURIComponent(id)}/views/${encodeURIComponent(view)}`, { method: 'DELETE' }),

  mesh: (id: string, opts: { views?: string[]; seed?: number; finish?: boolean } = {}) =>
    call<AssetJob>(`/catalog/${encodeURIComponent(id)}/mesh`, { method: 'POST', body: JSON.stringify(opts) }),

  job: (job: string) => call<AssetJob>(`/jobs/${job}`),
  jobs: () => call<{ jobs: AssetJob[] }>('/jobs').then((r) => r.jobs),

  push: () => call<{ pushed: string[]; skipped: string[] }>('/sync/push', { method: 'POST' }),
  pull: () => call<{ pulled: string[]; skipped: string[] }>('/sync/pull', { method: 'POST' }),

  /** A URL the browser can put in an <img> or hand to GLTFLoader. */
  /*
   * BUILDS: a visual PLUS its configuration.
   *
   * Rich, 2026-09-29: the catalog is visuals; a vehicle is a visual plus dynamics, layout and
   * configuration. So a build is its own record naming a catalog asset, which is what lets two
   * builds share one model and lets a build outlive the model it started from.
   */
  builds: <T>(kind: BuildKind) => call<Record<string, T[]>>(`/${kind}`).then((r) => (r[kind] ?? []) as T[]),
  saveBuild: <T>(kind: BuildKind, id: string, patch: Record<string, unknown>) =>
    call<Record<string, T>>(`/${kind}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) })
      .then((r) => Object.values(r)[0] as T),
  deleteBuild: (kind: BuildKind, id: string) =>
    call<{ ok: boolean }>(`/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  fileUrl: (id: string, rel: string) => `${ASSETSVC}/catalog/${encodeURIComponent(id)}/file/${rel.split('/').map(encodeURIComponent).join('/')}`,

  /* ---- materials: the tileable surfaces half of the library ---------------------------------
   *
   * A different shape from a prop, and the difference is one number. A prop is a mesh with a size;
   * a material is three maps and `metres_per_tile`, which is what turns a photograph of bricks
   * into a wall of the right size — and is the field a generated texture gets wrong. */
  materials: () => call<{ materials: Material[] }>('/materials'),
  /** Upload one map. One file per request, so a failed upload loses a map rather than a material. */
  putMaterialFile: async (id: string, name: string, file: Blob): Promise<{ bytes: number }> => {
    const r = await fetch(`${ASSETSVC}/materials/${encodeURIComponent(id)}/file/${encodeURIComponent(name)}`, {
      method: 'PUT', body: file,
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
    return body
  },
  putMaterial: (id: string, patch: Partial<Material>) =>
    call<{ material: Material }>(`/materials/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteMaterial: (id: string) =>
    call<{ deleted: string }>(`/materials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /*
   * DRAWING A TEXTURE, AND NOT LOSING THE OLD ONE.
   *
   * Rich, 2026-09-28: "don't blow away old copies until an explicit save operation happens!" So
   * generation writes into the material's `draft/` and these three are the whole lifecycle:
   * draw it, look at it, then either keep it or throw it away. `save` even keeps what it replaced.
   */
  generateMaterial: (id: string, body: { prompt: string; metres_per_tile?: number; seed?: number; size?: string }) =>
    call<AssetJob>(`/materials/${encodeURIComponent(id)}/generate`, { method: 'POST', body: JSON.stringify(body) }),
  materialDraft: (id: string) =>
    call<{ draft: { prompt: string; seed: number | null; at: string } | null }>(`/materials/${encodeURIComponent(id)}/draft`),
  saveMaterialDraft: (id: string) =>
    call<{ material: Material }>(`/materials/${encodeURIComponent(id)}/save`, { method: 'POST', body: '{}' }),
  discardMaterialDraft: (id: string) =>
    call<{ discarded: boolean }>(`/materials/${encodeURIComponent(id)}/draft`, { method: 'DELETE' }),
  materialUrl: (id: string, rel: string) =>
    `${ASSETSVC}/materials/${encodeURIComponent(id)}/file/${rel.split('/').pop()!.split('/').map(encodeURIComponent).join('/')}`,

  /**
   * Poll a job to completion.
   *
   * Every slow thing here is a job precisely so the editor does not hold a connection open, so the
   * polling lives on this side. 1.5 s is frequent enough that a 10 s image feels responsive and
   * slow enough that a 3 minute reconstruction is 120 requests, not 18,000.
   */
  async wait(job: string, onProgress?: (j: AssetJob) => void, everyMs = 1500): Promise<AssetJob> {
    for (;;) {
      const j = await assetsvc.job(job)
      onProgress?.(j)
      if (j.state === 'done' || j.state === 'failed') return j
      await new Promise((r) => setTimeout(r, everyMs))
    }
  },
}
