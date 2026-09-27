// Where the models are, today, from inside this pod.
//
// The editor needs three kinds of inference: an IMAGE model to draw an asset, a MESH model to
// reconstruct it, and a TEXT model for the in-app agent. Nothing above this file should know that
// those are flux.2-dev, TRELLIS.2 and qwen3.8-27b, or that two of them arrive through a Patapsco
// AI CRD and the third is a plain Deployment somebody wrote by hand.
//
// RESOLUTION ORDER, and the reason for each step:
//
//   1. an explicit URL in the environment            a port-forward on a laptop beats discovery
//   2. the CRD's own LWS API Service                 in-cluster, no gateway (see the note below)
//   3. the CRD's internal gateway                    what the CRD tells you to use
//   4. a plain Service by name                       how `recon` is deployed: no CRD at all
//   5. the CRD's external hostname                   for humans, and for outside the cluster
//   6. nothing                                       said plainly, with what was looked for
//
// WHY THE LWS API SERVICE COMES BEFORE THE GATEWAY, against the handoff's own ordering. The
// gateway routes on `X-Gateway-Model-Name`, which its endpoint-picker derives from a JSON body's
// `model` field -- and a multipart form has no JSON body, so `POST /v1/images/edits` returns 404
// through it. Sending the header by hand does not help. That is measured and written down in the
// asset-library agent's handoff, three paragraphs after the ordering that would walk into it.
// Editing an image is most of what the asset pipeline does, so the direct Service wins and the
// gateway is the fallback rather than the other way round.
//
// NOTHING HERE HARD-CODES A PUBLIC HOSTNAME. The external endpoint is read from the CRD's status
// when it is needed, so a renamed deployment does not leave a stale `basedweights.com` in a file.

/** the operator's API group. The CRD NAMES are `<plural>.<group>`; this is just the group. */
export const PAI_GROUP = 'richard-siomporas.patapsco.ai'

const READY = (o) => (o?.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')

/** ASSETSVC_URL_FLUX2_DEV, MODEL_URL_IMAGE — upper case, non-alphanumerics to underscores. */
const envKey = (prefix, id) => `${prefix}_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

/**
 * What each kind looks like in this cluster.
 *
 * `match` picks a CRD by the Services it brought up, because the model name is not in the CRD's
 * spec or its labels -- it is in the name of the LeaderWorkerSet API Service that the operator
 * creates (`high-brine-high-brine-flux2-dev-lws-api`). That is a discovery detail and it belongs
 * here rather than in anything that calls a model.
 */
export const KINDS = {
  image: { model: 'flux.2-dev', match: /flux/i, service: null, port: 80 },
  // `match: null` means this kind does NOT come from a CRD at all. TRELLIS is a plain Deployment
  // and a null pattern used to mean "any CRD will do", which handed mesh work to the image model.
  mesh: { model: 'TRELLIS.2', match: null, service: 'recon', port: 80 },
  text: { model: 'qwen3.8-27b', match: /qwen/i, service: null, port: 80 },
}

export class ModelResolver {
  /**
   * @param k8s   a K8s client (k8s.mjs); may be unusable, in which case discovery is skipped
   * @param env   process.env, or a stand-in for a test
   * @param opts  { namespace, ttlMs }
   */
  constructor(k8s, env = process.env, { namespace = 'default', ttlMs = 60000 } = {}) {
    this.k8s = k8s
    this.env = env
    this.namespace = env.WORLDEDITOR_NAMESPACE ?? namespace
    this.ttlMs = ttlMs
    this.cache = new Map()
  }

  /**
   * Every InferenceDeployment in the namespace, or [] when the CRD is not installed.
   *
   * THE GROUP IS DISCOVERED, NOT PINNED. `inferencedeployments.richard-siomporas.patapsco.ai` is
   * the CRD's NAME; its API group is `richard-siomporas.patapsco.ai` and the served version today
   * is v1alpha1. I had the name where the group goes and `v1` where v1alpha1 goes, which made the
   * whole CRD rung silently unreachable from a pod -- it would have fallen all the way to "no
   * image model" while `kubectl get inferencedeployments` worked perfectly beside it. Asking the
   * discovery document is one request and it survives the day v1alpha1 becomes v1.
   */
  async #deployments() {
    if (!this.k8s?.usable?.()) return []
    try {
      const gv = await this.groupVersion()
      if (!gv) return []
      const r = await this.k8s.raw('GET', `/apis/${gv}/namespaces/${this.namespace}/inferencedeployments`)
      return r?.items ?? []
    } catch {
      return []
    }
  }

  /** `richard-siomporas.patapsco.ai/v1alpha1` today, whatever it is tomorrow. */
  async groupVersion() {
    if (this._gv !== undefined) return this._gv
    try {
      const groups = await this.k8s.raw('GET', '/apis')
      const g = (groups?.groups ?? []).find((x) => x.name === PAI_GROUP)
      this._gv = g?.preferredVersion?.groupVersion ?? null
    } catch {
      this._gv = null
    }
    return this._gv
  }

  async #services() {
    if (!this.k8s?.usable?.()) return []
    try {
      const r = await this.k8s.raw('GET', `/api/v1/namespaces/${this.namespace}/services`)
      return r?.items ?? []
    } catch {
      return []
    }
  }

  /**
   * Resolve one kind. Returns `{ url, via, model, detail }`, or `{ url: null, why }` when there is
   * nothing to use — which is an answer, not an exception: the editor shows "model unavailable"
   * and stays up.
   */
  async resolve(kind) {
    const cfg = KINDS[kind]
    if (!cfg) throw new Error(`unknown model kind ${JSON.stringify(kind)}`)
    const hit = this.cache.get(kind)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value
    const value = await this.#resolve(kind, cfg)
    this.cache.set(kind, { at: Date.now(), value })
    return value
  }

  async #resolve(kind, cfg) {
    const looked = []

    // 1. the environment wins, always: this is how a laptop points at a port-forward
    for (const prefix of ['MODEL_URL', 'ASSETSVC_URL', 'WORLDEDITOR_MODEL_URL']) {
      const v = this.env[envKey(prefix, kind)]
      if (v) return { url: v.replace(/\/+$/, ''), via: 'env', model: cfg.model, detail: envKey(prefix, kind) }
    }
    looked.push(`$${envKey('MODEL_URL', kind)}`)

    const deployments = await this.#deployments()
    const services = await this.#services()
    const svcNames = services.map((s) => s.metadata.name)

    /*
     * 2 and 3: a Ready CRD -- its LWS API Service first, its gateway second.
     *
     * A CRD IS IDENTIFIED BY THE SERVICES IT OWNS, not by its own name. `high-brine` serves
     * flux.2-dev and says so nowhere in its spec, its labels or its status; the only place the
     * model appears is in the operator's Service names
     * (`high-brine-high-brine-flux2-dev-lws-api`). Matching on `metadata.name` looks right and
     * finds nothing, which is how the gateway fallback silently never fired.
     */
    const owned = (d) => svcNames.filter((n) => n.startsWith(`${d.metadata?.name}-`))
    const mine = cfg.match ? deployments.filter((d) => owned(d).some((n) => cfg.match.test(n))) : []
    for (const d of mine) {
      const name = d.metadata.name
      if (!READY(d)) { looked.push(`${name} (not Ready)`); continue }
      const api = owned(d).find((n) => n.endsWith('-lws-api') && cfg.match.test(n))
      if (!api) continue
      return {
        url: `http://${api}.${this.namespace}.svc:${cfg.port}`,
        via: 'crd',
        model: cfg.model,
        detail: `${name} -> ${api}`,
        external: d.status?.endpoints?.external ?? null,
        gateway: d.status?.endpoints?.internal ?? null,
      }
    }
    for (const d of mine) {
      if (!READY(d)) continue
      const gw = d.status?.endpoints?.internal
      if (!gw) continue
      return { url: `http://${gw}`, via: 'crd-gateway', model: cfg.model, detail: d.metadata.name, external: d.status?.endpoints?.external ?? null }
    }
    if (!cfg.match) looked.push('this kind does not come from a CRD')
    else if (deployments.length) looked.push(`${deployments.length} InferenceDeployment(s), none serving ${cfg.match}`)
    else looked.push('no InferenceDeployment CRD')

    // 4. a plain Service, which is how recon is deployed and how anything hand-rolled will be
    const want = this.env[envKey('MODEL_SERVICE', kind)] ?? cfg.service
    if (want && svcNames.includes(want)) {
      return { url: `http://${want}.${this.namespace}.svc:${cfg.port}`, via: 'service', model: cfg.model, detail: want }
    }
    if (want) looked.push(`no Service "${want}"`)

    // 5. the public hostname, from the CRD's status rather than from a constant
    for (const d of mine) {
      const ext = d.status?.endpoints?.external
      if (ext && READY(d)) {
        return { url: `https://${ext}`, via: 'public', model: cfg.model, detail: d.metadata.name, note: 'attachments 404 through the gateway; this is for JSON only' }
      }
    }

    return { url: null, via: 'none', model: cfg.model, why: `no ${kind} model: looked for ${looked.join('; ')}` }
  }

  /**
   * Ask the endpoint what it is, rather than trusting that a URL means a model.
   *
   * Every one of these speaks the OpenAI model list except `recon`, which is a FastAPI service
   * and answers its own health path. A URL that resolves and does not answer is exactly the
   * failure this resolver exists to make visible, so the check is cheap and the answer is carried
   * next to the URL rather than discovered by whatever calls it first.
   */
  async probe(kind, { timeoutMs = 4000 } = {}) {
    const r = await this.resolve(kind)
    if (!r.url) return { ...r, live: false }
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      if (kind === 'mesh') {
        // no model list: alive is alive. A 404 from FastAPI's router is a running FastAPI.
        const res = await fetch(`${r.url}/`, { signal: ac.signal })
        return { ...r, live: res.status > 0, serving: null, status: res.status }
      }
      const res = await fetch(`${r.url}/v1/models`, { signal: ac.signal })
      if (!res.ok) return { ...r, live: false, status: res.status }
      const body = await res.json()
      const serving = (body?.data ?? []).map((m) => m.id)
      return { ...r, live: true, serving, matches: serving.includes(r.model) }
    } catch (e) {
      return { ...r, live: false, error: String(e?.message ?? e).slice(0, 120) }
    } finally {
      clearTimeout(t)
    }
  }

  /** Everything at once, for the editor's config endpoint and for a probe. */
  async describe({ live = false } = {}) {
    const out = {}
    for (const k of Object.keys(KINDS)) out[k] = live ? await this.probe(k) : await this.resolve(k)
    return out
  }
}
