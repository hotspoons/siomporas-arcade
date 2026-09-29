// Where the image generator and TRELLIS are, settable from the environment AND from the editor.
//
// Rich, 2026-09-29: "we should be able to configure trellis endpoint, image generator endpoint".
//
// THE SAME NAMES THE ENVIRONMENT ALREADY USES. `buildRegistry` (adapters.mjs) reads a model's URL
// from `ASSETSVC_URL_<ID>` and the defaults from `ASSETSVC_IMAGE_MODEL` / `ASSETSVC_MESH_MODEL`.
// A value saved from the UI is stored under exactly that name and laid OVER the real environment
// before the registry is built — so the precedence is:
//
//     a value saved from the UI     kept on this service's volume
//     the environment               what the chart set
//     the roster file               models.json, the shipped defaults
//
// and no adapter learns that the UI exists. Clearing a UI value falls back to the environment,
// never past it.
//
// THE ROSTER DECIDES WHAT CAN BE SET. Every model in models.json gets a URL, and the two defaults
// are a choice among the models of their kind. A model that is not in the roster cannot be
// conjured from the UI — adding one is a roster change, because it needs an adapter `kind`, a
// field name and timeouts that a URL box has no way to supply.
//
// No secrets: `tokenEnv` names an environment variable the chart fills from a Secret, and nothing
// here reads, stores or returns a token.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const envKey = (id) => `ASSETSVC_URL_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

export class AssetSettings {
  constructor(dataDir, env = process.env, config = { models: {}, defaults: {} }) {
    this.file = path.join(dataDir, 'settings.json')
    this.env = env
    this.config = config
    this.saved = {}
  }

  async load() {
    try {
      const doc = JSON.parse(await readFile(this.file, 'utf8'))
      const known = new Set(this.schema().map((s) => s.env))
      this.saved = Object.fromEntries(Object.entries(doc?.values ?? {}).filter(([k]) => known.has(k)))
    } catch {
      this.saved = {}
    }
    return this
  }

  /** What may be set, derived from the roster so it cannot drift from it. */
  schema() {
    const models = Object.entries(this.config.models ?? {})
    const ofKind = (k) => models.filter(([, m]) => m.kind === k).map(([id]) => id)
    return [
      {
        key: 'image.model', env: 'ASSETSVC_IMAGE_MODEL', kind: 'enum', options: ofKind('image'),
        def: this.config.defaults?.image ?? '', group: 'image',
        label: 'Image generator',
        note: 'Which model in the roster draws a view. Its URL is below.',
      },
      {
        key: 'mesh.model', env: 'ASSETSVC_MESH_MODEL', kind: 'enum', options: ofKind('mesh'),
        def: this.config.defaults?.mesh ?? '', group: 'mesh',
        label: 'Mesh reconstructor',
        note: 'Which model in the roster turns a view into a mesh — TRELLIS on gh200-1.',
      },
      ...models.map(([id, m]) => ({
        key: `url.${id}`, env: envKey(id), kind: 'url', def: m.url ?? '', group: m.kind,
        label: `${id} endpoint`,
        note: m.kind === 'mesh'
          ? 'In-cluster DNS. The reconstructor serialises internally — one GPU, one job at a time.'
          : 'In-cluster DNS. The browser never reaches this; the asset service does.',
      })),
    ]
  }

  #spec(key) {
    const s = this.schema().find((x) => x.key === key)
    if (!s) throw Object.assign(new Error(`no setting "${key}"`), { status: 400 })
    return s
  }

  get(key) {
    const s = this.#spec(key)
    if (this.saved[s.env]) return this.saved[s.env]
    if (this.env[s.env]) return this.env[s.env]
    return s.def
  }

  source(key) {
    const s = this.#spec(key)
    if (this.saved[s.env]) return 'ui'
    if (this.env[s.env]) return 'env'
    return 'default'
  }

  /** The environment `buildRegistry` should see: the real one, with the UI's values laid over it. */
  effectiveEnv() {
    return { ...this.env, ...this.saved }
  }

  describe() {
    return this.schema().map((s) => ({
      key: s.key, group: s.group, kind: s.kind, label: s.label, note: s.note ?? null,
      options: s.options ?? null,
      value: this.get(s.key), source: this.source(s.key), env: s.env,
      fallback: this.env[s.env] || s.def,
    }))
  }

  /** All-or-nothing, and `null`/`''` clears a key back to the environment. */
  async set(patch = {}) {
    const errors = []
    const writes = []
    for (const [key, v] of Object.entries(patch)) {
      let s
      try {
        s = this.#spec(key)
      } catch (e) {
        errors.push(e.message)
        continue
      }
      if (v === null || v === undefined || v === '') { writes.push([s.env, null]); continue }
      if (s.kind === 'url') {
        try {
          const u = new URL(String(v))
          if (!/^https?:$/.test(u.protocol)) errors.push(`${s.label} must be http or https`)
        } catch {
          errors.push(`${s.label}: "${v}" is not a URL`)
        }
      }
      if (s.kind === 'enum' && !s.options.includes(String(v))) {
        errors.push(`${s.label} must be one of ${s.options.join(', ') || '(none in the roster)'}`)
      }
      writes.push([s.env, String(v)])
    }
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400, errors })
    for (const [k, v] of writes) {
      if (v === null) delete this.saved[k]
      else this.saved[k] = v
    }
    await mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify({ values: this.saved, updated: new Date().toISOString() }, null, 2))
    await rename(tmp, this.file)
    return this.describe()
  }
}
