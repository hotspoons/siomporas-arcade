// The model adapters: everything that knows how a particular AI server talks.
//
// The rest of assetsvc knows two interfaces and no vendors. Swapping flux.2 for SDXL, or TRELLIS
// for something else, means adding an entry here and changing one environment variable — no route,
// no catalog code and nothing in the editor changes.
//
//   ImageModel   a prompt (and optionally some source images) -> one PNG
//   MeshModel    one or more views -> one GLB
//
// WHY THE INTERFACES LOOK LIKE THIS. An image server answers in one round trip and a
// reconstruction does not — TRELLIS takes tens of seconds to minutes and hands back a job id to
// poll. Rather than push that difference onto every caller, `reconstruct` owns its own polling and
// resolves when the mesh is in hand; the SERVICE is what makes the whole thing asynchronous, once,
// for both kinds (see jobs.mjs). One place that understands waiting.
//
// Every adapter is also honest about not being configured: `available()` answers without throwing
// so `GET /models` can tell the editor which half of the pipeline is reachable, instead of the
// editor discovering it from a failed generation five minutes in.

import { Buffer } from 'node:buffer'

/** A fetch with a deadline, because a hung model server should fail a job and not wedge the queue. */
async function fetchWithTimeout(url, opts = {}, ms = 180_000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------------------------------------------------------------------------------------
 * Image models
 * ------------------------------------------------------------------------------------------- */

/**
 * Anything speaking the OpenAI images API: `/v1/images/generations` and `/v1/images/edits`.
 *
 * That covers flux.2-dev and flux.2-klein as they are served on gh200-1 today, and most local
 * inference servers, which is exactly why this is the shape the adapter is written to rather than
 * to "flux". `model` is a string the server understands and nothing here interprets.
 */
export class OpenAIImagesModel {
  constructor({ id, url, model, field = 'image', timeoutMs = 300_000, headers = {} }) {
    this.id = id
    this.kind = 'image'
    this.url = url?.replace(/\/$/, '')
    this.model = model
    // The attachment field name differs between servers — flux.2-dev takes `image`, klein takes
    // `image[]`. It is configuration, not a branch in the code.
    this.field = field
    this.timeoutMs = timeoutMs
    this.headers = headers
  }

  describe() {
    return { id: this.id, kind: this.kind, model: this.model, url: this.url, configured: !!this.url }
  }

  async available() {
    if (!this.url) return { ok: false, detail: 'no url configured' }
    try {
      // /v1/models is the cheapest thing every one of these servers answers.
      const r = await fetchWithTimeout(`${this.url}/v1/models`, { headers: this.headers }, 8000)
      return r.ok ? { ok: true } : { ok: false, detail: `HTTP ${r.status}` }
    } catch (e) {
      return { ok: false, detail: String(e.message ?? e) }
    }
  }

  /**
   * @param {{prompt: string, negative?: string, size?: string, steps?: number, seed?: number,
   *          trueCfg?: number, sources?: {name: string, buf: Buffer}[]}} req
   * @returns {Promise<{png: Buffer, seconds: number, meta: object}>}
   */
  async generate(req) {
    if (!this.url) throw new Error(`image model ${this.id} has no url configured`)
    const started = Date.now()
    const { prompt, negative, size = '1024x1024', steps = 28, seed, trueCfg, sources = [] } = req
    let res

    if (!sources.length) {
      res = await fetchWithTimeout(
        `${this.url}/v1/images/generations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.headers },
          body: JSON.stringify({
            model: this.model,
            prompt,
            negative_prompt: negative,
            true_cfg_scale: trueCfg,
            size,
            num_inference_steps: steps,
            seed,
            response_format: 'b64_json',
          }),
        },
        this.timeoutMs,
      )
    } else {
      const form = new FormData()
      form.append('model', this.model)
      form.append('prompt', prompt)
      form.append('size', size)
      form.append('num_inference_steps', String(steps))
      form.append('response_format', 'b64_json')
      if (seed !== undefined) form.append('seed', String(seed))
      if (negative) form.append('negative_prompt', negative)
      if (trueCfg) form.append('true_cfg_scale', String(trueCfg))
      for (const s of sources) form.append(this.field, new Blob([s.buf], { type: 'image/png' }), s.name)
      res = await fetchWithTimeout(`${this.url}/v1/images/edits`, { method: 'POST', body: form, headers: this.headers }, this.timeoutMs)
    }

    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`${this.id} ${res.status}: non-JSON reply ${text.slice(0, 300)}`)
    }
    if (!res.ok || json.error) throw new Error(`${this.id} ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 400)}`)
    const b64 = json.data?.[0]?.b64_json
    if (!b64) throw new Error(`${this.id}: no image in reply ${JSON.stringify(json).slice(0, 300)}`)
    return {
      png: Buffer.from(b64, 'base64'),
      seconds: (Date.now() - started) / 1000,
      meta: { model: this.model, prompt, negative, size, steps, seed, sources: sources.map((s) => s.name) },
    }
  }
}

/* ---------------------------------------------------------------------------------------------
 * Mesh models
 * ------------------------------------------------------------------------------------------- */

/**
 * `tools/recon-service`: POST views to /reconstruct, poll /jobs/<id>, GET the asset.
 *
 * Send KEYED cut-outs where you have them. The service keeps an alpha channel when one is
 * present, and our own chroma key is better than the background remover it would otherwise run —
 * flattening to RGB throws that away and makes the model guess again.
 */
export class ReconMeshModel {
  constructor({ id, url, pollMs = 3000, timeoutMs = 1_800_000, headers = {} }) {
    this.id = id
    this.kind = 'mesh'
    this.url = url?.replace(/\/$/, '')
    this.pollMs = pollMs
    this.timeoutMs = timeoutMs
    this.headers = headers
  }

  describe() {
    return { id: this.id, kind: this.kind, url: this.url, configured: !!this.url }
  }

  async available() {
    if (!this.url) return { ok: false, detail: 'no url configured' }
    // /readyz before /healthz: a GPU service answers healthz the moment the process is up, and
    // TRELLIS takes minutes to get 16 GB of weights onto the card. Liveness would tell the editor
    // the pipeline is available while a reconstruction would still fail.
    for (const path of ['/readyz', '/healthz', '/health']) {
      try {
        const r = await fetchWithTimeout(`${this.url}${path}`, { headers: this.headers }, 8000)
        if (r.ok) return { ok: true, detail: `via ${path}` }
      } catch {
        /* try the next one */
      }
    }
    return { ok: false, detail: 'no health endpoint answered' }
  }

  /**
   * @param {{views: {name: string, buf: Buffer}[], seed?: number, onProgress?: (s: object) => void}} req
   * @returns {Promise<{glb: Buffer, seconds: number, meta: object}>}
   */
  async reconstruct({ views, seed = 1, onProgress }) {
    if (!this.url) throw new Error(`mesh model ${this.id} has no url configured`)
    if (!views?.length) throw new Error('reconstruct needs at least one view')
    const started = Date.now()

    const form = new FormData()
    for (const v of views) form.append('images', new Blob([v.buf], { type: 'image/png' }), v.name)
    form.append('seed', String(seed))
    const res = await fetchWithTimeout(`${this.url}/reconstruct`, { method: 'POST', body: form, headers: this.headers }, 120_000)
    const startedJob = await res.json().catch(() => ({}))
    if (!res.ok || !startedJob.job) throw new Error(`${this.id} ${res.status}: ${JSON.stringify(startedJob).slice(0, 300)}`)

    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      if (Date.now() > deadline) throw new Error(`${this.id} job ${startedJob.job} still running after ${Math.round(this.timeoutMs / 1000)}s`)
      await new Promise((r) => setTimeout(r, this.pollMs))
      let s
      try {
        s = await (await fetchWithTimeout(`${this.url}/jobs/${startedJob.job}`, { headers: this.headers }, 30_000)).json()
      } catch (e) {
        // One failed poll is not a failed job — a GPU node under load drops connections.
        onProgress?.({ state: 'polling', detail: String(e.message ?? e) })
        continue
      }
      onProgress?.(s)
      if (s.state === 'failed') throw new Error(`${this.id} job ${startedJob.job} failed: ${s.detail ?? 'no detail'}`)
      if (s.state !== 'done') continue

      const assetPath = s.asset ?? `/jobs/${startedJob.job}/asset`
      const glbRes = await fetchWithTimeout(`${this.url}${assetPath}`, { headers: this.headers }, 300_000)
      if (!glbRes.ok) throw new Error(`${this.id}: asset fetch ${glbRes.status}`)
      const glb = Buffer.from(await glbRes.arrayBuffer())
      return {
        glb,
        seconds: (Date.now() - started) / 1000,
        meta: { job: startedJob.job, views: views.length, seed, vertices: s.vertices, faces: s.faces, textured: s.textured },
      }
    }
  }
}

/* ---------------------------------------------------------------------------------------------
 * The registry
 * ------------------------------------------------------------------------------------------- */

/**
 * Build the models from configuration.
 *
 * `config` is the parsed models.json (see models.example.json) merged with environment overrides,
 * so a Helm chart can ship a whole roster in a ConfigMap and a laptop can point one URL at a
 * port-forward without editing a file.
 */
export function buildRegistry(config = {}, env = process.env) {
  const models = new Map()

  for (const [id, spec] of Object.entries(config.models ?? {})) {
    const url = env[`ASSETSVC_URL_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] ?? spec.url
    const headers = spec.tokenEnv && env[spec.tokenEnv] ? { Authorization: `Bearer ${env[spec.tokenEnv]}` } : {}
    if (spec.kind === 'image') models.set(id, new OpenAIImagesModel({ id, ...spec, url, headers }))
    else if (spec.kind === 'mesh') models.set(id, new ReconMeshModel({ id, ...spec, url, headers }))
    else throw new Error(`models.json: ${id} has unknown kind ${JSON.stringify(spec.kind)}`)
  }

  const imageId = env.ASSETSVC_IMAGE_MODEL ?? config.defaults?.image
  const meshId = env.ASSETSVC_MESH_MODEL ?? config.defaults?.mesh

  return {
    models,
    get image() {
      const m = models.get(imageId)
      if (!m) throw new Error(`no image model ${JSON.stringify(imageId)} — have ${[...models.keys()].join(', ') || 'none'}`)
      return m
    },
    get mesh() {
      const m = models.get(meshId)
      if (!m) throw new Error(`no mesh model ${JSON.stringify(meshId)} — have ${[...models.keys()].join(', ') || 'none'}`)
      return m
    },
    defaults: { image: imageId, mesh: meshId },
    describe: () => ({
      defaults: { image: imageId, mesh: meshId },
      models: [...models.values()].map((m) => m.describe()),
    }),
  }
}
