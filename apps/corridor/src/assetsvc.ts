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
  kind: string
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
  state: 'spec' | 'drawn' | 'meshed' | 'finished'
  history: { at: string; step: string; file?: string; model?: string; seconds?: number }[]
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
  // In the cluster the editor and the service sit behind one host, so a relative path is right and
  // needs no CORS. On a laptop Vite is on another port and the service is on 8770.
  if (location.port === '' || location.port === '443' || location.port === '80') return `${location.origin}/assetsvc`
  return 'http://localhost:8770'
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

  image: (id: string, opts: { prompt?: string; negative?: string; size?: string; steps?: number; seed?: number } = {}) =>
    call<AssetJob>(`/catalog/${encodeURIComponent(id)}/image`, { method: 'POST', body: JSON.stringify(opts) }),

  mesh: (id: string, opts: { views?: string[]; seed?: number; finish?: boolean } = {}) =>
    call<AssetJob>(`/catalog/${encodeURIComponent(id)}/mesh`, { method: 'POST', body: JSON.stringify(opts) }),

  job: (job: string) => call<AssetJob>(`/jobs/${job}`),
  jobs: () => call<{ jobs: AssetJob[] }>('/jobs').then((r) => r.jobs),

  push: () => call<{ pushed: string[]; skipped: string[] }>('/sync/push', { method: 'POST' }),
  pull: () => call<{ pulled: string[]; skipped: string[] }>('/sync/pull', { method: 'POST' }),

  /** A URL the browser can put in an <img> or hand to GLTFLoader. */
  fileUrl: (id: string, rel: string) => `${ASSETSVC}/catalog/${encodeURIComponent(id)}/file/${rel.split('/').map(encodeURIComponent).join('/')}`,

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
