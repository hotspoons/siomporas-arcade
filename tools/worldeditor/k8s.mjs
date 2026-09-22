// The Kubernetes API, by hand, for the two things this service does with it: start a Job and read
// its logs.
//
// WHY NOT SHELL OUT TO HELM OR KUBECTL. The bake already has a chart, and `helm upgrade` is how a
// person starts a bake from a terminal. A pod is not a person: it would need helm, kubectl, a
// kubeconfig and a checkout of the chart in its image, and every one of those is a thing that can
// be the wrong version. The API is right there on the pod network with a token already mounted,
// the Job spec is forty lines of JSON, and log streaming is one GET. So the chart stays the way a
// HUMAN bakes and this is how the EDITOR bakes, and the two agree because the Job this builds is
// the chart's Job with the same image, the same volume, the same env and the same command.
//
// WHY node:https AND NOT fetch. The API server's certificate is signed by the cluster CA mounted
// in the pod, and global `fetch` has no per-request way to trust one extra CA without pulling in
// undici's Agent. `https.request` takes `ca` directly and gives a stream, which is what following
// a log wants anyway.

import https from 'node:https'
import { readFileSync } from 'node:fs'

const SA = '/var/run/secrets/kubernetes.io/serviceaccount'

export class K8s {
  constructor(env = process.env) {
    this.host = env.KUBERNETES_SERVICE_HOST ?? ''
    this.port = env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT ?? '443'
    this.token = read(`${SA}/token`)
    this.ca = read(`${SA}/ca.crt`)
    this.namespace = env.WORLDEDITOR_NAMESPACE || read(`${SA}/namespace`) || 'default'
  }

  /** In-cluster and holding a token. Off-cluster this is false and the local runner takes over. */
  get available() {
    return !!(this.host && this.token && this.ca)
  }

  describe() {
    return { available: this.available, namespace: this.namespace, api: this.available ? `https://${this.host}:${this.port}` : null }
  }

  #request(method, apiPath, { body, stream } = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const opts = {
      host: this.host,
      port: this.port,
      path: apiPath,
      method,
      ca: this.ca,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }
    return new Promise((resolve, reject) => {
      const req = https.request(opts, (res) => {
        if (stream) return resolve(res)
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode >= 400) {
            return reject(Object.assign(new Error(`k8s ${method} ${apiPath}: ${res.statusCode} ${text.slice(0, 300)}`), { status: res.statusCode }))
          }
          try {
            resolve(text ? JSON.parse(text) : {})
          } catch {
            resolve(text)
          }
        })
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  /** Can this service actually do what it claims? Reported by /ready, so a failure is visible. */
  async permitted() {
    if (!this.available) return { ok: false, detail: 'not running in a cluster' }
    try {
      await this.#request('GET', `/apis/batch/v1/namespaces/${this.namespace}/jobs?limit=1`)
      return { ok: true, namespace: this.namespace }
    } catch (e) {
      return { ok: false, detail: String(e.message ?? e) }
    }
  }

  createJob(spec) {
    return this.#request('POST', `/apis/batch/v1/namespaces/${this.namespace}/jobs`, { body: spec })
  }

  getJob(name) {
    return this.#request('GET', `/apis/batch/v1/namespaces/${this.namespace}/jobs/${name}`)
  }

  /** Background propagation, so the pods go too — an orphaned pod keeps the volume mounted. */
  deleteJob(name) {
    return this.#request('DELETE', `/apis/batch/v1/namespaces/${this.namespace}/jobs/${name}?propagationPolicy=Background`)
  }

  async podsFor(jobName) {
    const r = await this.#request('GET', `/api/v1/namespaces/${this.namespace}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`)
    return r.items ?? []
  }

  /**
   * A pod's log as a stream. `timestamps` is on because it is the only way to resume a follow that
   * dropped without either losing lines or printing them twice — `sinceTime` is exclusive of
   * nothing, so the caller drops what it has already seen by comparing the stamp.
   */
  logStream(pod, { follow = true, sinceTime = null, container = null } = {}) {
    const q = new URLSearchParams({ follow: String(follow), timestamps: 'true' })
    if (sinceTime) q.set('sinceTime', sinceTime)
    if (container) q.set('container', container)
    return this.#request('GET', `/api/v1/namespaces/${this.namespace}/pods/${pod}/log?${q}`, { stream: true })
  }
}

function read(file) {
  try {
    return readFileSync(file, file.endsWith('ca.crt') ? undefined : 'utf8')
  } catch {
    return null
  }
}
