// Where the world editor's external services are, settable from the environment AND from the UI.
//
// Rich, 2026-09-29: "We need to make sure all services are configurable both from env vars and
// from within the editor's UI, so we should be able to configure trellis endpoint, image generator
// endpoint, and the splat pipeline."
//
// THE ORDER, and it is the whole design:
//
//     a value saved from the UI     wins, and is kept on the volume
//     the environment               the deployment's own answer
//     a built-in default            said plainly as one
//
// The UI wins because it is the later, more specific decision: the chart says "assetsvc is at
// http://assetsvc", and somebody at the editor who knows it has moved says so here without a
// redeploy. But the environment is never OVERWRITTEN — clearing a UI value falls straight back to
// it, so "what did the deployment say" is always one click away and never lost.
//
// EVERY VALUE SAYS WHERE IT CAME FROM. A setting that is simply "the URL" is a setting nobody can
// debug: when the image generator is unreachable, the first question is whether the URL was typed
// by a person last Tuesday or rendered by the chart this morning. `describe()` answers that.
//
// NO SECRETS HERE. Endpoints, images, runner choices. A credential belongs in a Kubernetes Secret
// the chart mounts, never in a JSON file the UI can read back — the git credential already works
// that way (gitrepo.mjs), and this follows it.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Every setting, with the variable that feeds it and what it is for.
 *
 * `kind` decides the validation and the control: `url` must parse, `enum` must be one of
 * `options`, `json` must parse, `bool` is "true"/"false". Nothing here is free-form except where
 * the thing really is free-form.
 */
export const SCHEMA = [
  /* ---- the services this editor reaches ---- */
  {
    key: 'assetsvc.url', group: 'services', kind: 'url', env: 'WORLDEDITOR_ASSETSVC', def: '',
    label: 'Asset service',
    note: 'Where the catalog, the generators and the materials live. The browser reaches it through this editor at /assetsvc, never directly.',
  },
  {
    key: 'overpass.url', group: 'services', kind: 'string', env: 'WORLDEDITOR_OVERPASS_URL', def: '',
    label: 'Overpass',
    note: 'Comma-separated, first is preferred; the public mirrors follow. A REGIONAL extract must carry its box as #south/west/north/east — out of area it answers HTTP 200 with nothing, which reads exactly like "no roads here".',
  },
  {
    key: 'nominatim.url', group: 'services', kind: 'url', env: 'WORLDEDITOR_NOMINATIM', def: 'https://nominatim.openstreetmap.org',
    label: 'Place search (Nominatim)',
  },

  /* ---- the bake ---- */
  {
    key: 'bake.image', group: 'bake', kind: 'string', env: 'WORLDEDITOR_BAKE_IMAGE', def: 'ghcr.io/hotspoons/corridor:latest',
    label: 'Bake image',
    note: 'The container a bake runs in, as a Kubernetes Job.',
  },

  /* ---- splat training ----
   * THE RUNNER ORDER is the one Rich gave: a Patapsco AI TrainingDeployment where the CRD is
   * installed, a JobSet where that is, and plain Jobs — a leader and its workers — everywhere
   * else. `auto` asks the cluster each time; the others pin one, which is what you want when the
   * featured path is misbehaving and you need to know whether it is the operator or the workload.
   */
  {
    key: 'splat.runner', group: 'splat', kind: 'enum', env: 'WORLDEDITOR_SPLAT_RUNNER', def: 'auto',
    options: ['auto', 'training', 'jobset', 'batch'],
    label: 'Runner',
    note: 'auto: TrainingDeployment if the CRD is installed, else JobSet, else plain Jobs.',
  },
  {
    key: 'splat.image', group: 'splat', kind: 'string', env: 'WORLDEDITOR_SPLAT_IMAGE', def: 'ghcr.io/hotspoons/gaussworks:latest',
    label: 'Training image',
  },
  {
    key: 'splat.command', group: 'splat', kind: 'json', env: 'WORLDEDITOR_SPLAT_COMMAND', def: '["splatpipe"]',
    label: 'Command',
    note: 'A JSON array. The entrypoint the splats lane published is `splatpipe run --capture … --out … --role leader|worker`.',
  },
  {
    key: 'splat.args', group: 'splat', kind: 'json', env: 'WORLDEDITOR_SPLAT_ARGS', def: '',
    label: 'Extra arguments',
    note: 'A JSON array, appended to what each role is given. Empty is normal.',
  },
  {
    key: 'splat.storageClass', group: 'splat', kind: 'string', env: 'WORLDEDITOR_SPLAT_STORAGE_CLASS', def: '',
    label: 'Output storage class',
    note: 'The RWX class the workers share. Only a JobSet or plain Jobs need it; a TrainingDeployment provisions its own.',
  },
  {
    key: 'splat.gpuResource', group: 'splat', kind: 'string', env: 'WORLDEDITOR_GPU_RESOURCE', def: '',
    label: 'GPU resource name',
    note: 'Empty means discovered from the nodes (nvidia.com/gpu on gh200-1).',
  },

  /* ---- blender, for the rigging pipeline ---- */
  {
    key: 'blender.bin', group: 'blender', kind: 'string', env: 'BLENDER_BIN', def: 'blender',
    label: 'Blender binary',
  },
  {
    key: 'blender.autostart', group: 'blender', kind: 'bool', env: 'WORLDEDITOR_BLENDER_AUTOSTART', def: 'false',
    label: 'Keep a live Blender running',
    note: 'The headless session MCP clients and the Blender tab drive. It holds a scene in memory between calls, which is the point and also why it is off unless asked for.',
  },
]

const BY_KEY = new Map(SCHEMA.map((s) => [s.key, s]))

/** Is this a value the setting accepts? Returns an error sentence, or null. */
export function invalid(spec, value) {
  if (value === null || value === undefined || value === '') return null // clearing is always allowed
  const v = String(value)
  if (spec.kind === 'url') {
    try {
      const u = new URL(v)
      if (!/^https?:$/.test(u.protocol)) return `${spec.label} must be http or https, not ${u.protocol}`
    } catch {
      return `${spec.label}: "${v}" is not a URL`
    }
  }
  if (spec.kind === 'enum' && !spec.options.includes(v)) return `${spec.label} must be one of ${spec.options.join(', ')}`
  if (spec.kind === 'bool' && !/^(true|false)$/.test(v)) return `${spec.label} is true or false`
  if (spec.kind === 'json') {
    try {
      const parsed = JSON.parse(v)
      if (!Array.isArray(parsed)) return `${spec.label} must be a JSON array`
    } catch {
      return `${spec.label} is not valid JSON`
    }
  }
  return null
}

export class Settings {
  /**
   * @param dataDir  the volume; the file is `<dataDir>/settings.json`
   * @param env      process.env, or a stand-in for a test
   */
  constructor(dataDir, env = process.env) {
    this.file = path.join(dataDir, 'settings.json')
    this.env = env
    this.saved = {}
    this.listeners = new Set()
  }

  async load() {
    try {
      const doc = JSON.parse(await readFile(this.file, 'utf8'))
      // only keys the schema knows: a file edited by hand, or written by a newer build, must not
      // smuggle an unknown key into something that reads it
      this.saved = Object.fromEntries(Object.entries(doc?.values ?? {}).filter(([k]) => BY_KEY.has(k)))
    } catch {
      this.saved = {}
    }
    return this
  }

  /** The effective value, as a string — the same shape an environment variable has. */
  get(key) {
    const spec = BY_KEY.get(key)
    if (!spec) throw new Error(`no setting "${key}"`)
    if (this.saved[key] !== undefined && this.saved[key] !== '') return String(this.saved[key])
    const e = spec.env ? this.env[spec.env] : undefined
    if (e !== undefined && e !== '') return e
    return spec.def
  }

  /** `get`, parsed for the kinds that are not strings. */
  value(key) {
    const spec = BY_KEY.get(key)
    const raw = this.get(key)
    if (spec.kind === 'bool') return raw === 'true'
    if (spec.kind === 'json') return raw ? JSON.parse(raw) : null
    return raw
  }

  source(key) {
    const spec = BY_KEY.get(key)
    if (this.saved[key] !== undefined && this.saved[key] !== '') return 'ui'
    if (spec.env && this.env[spec.env] !== undefined && this.env[spec.env] !== '') return 'env'
    return 'default'
  }

  /** What the Settings panel draws: every setting, its value, and where the value came from. */
  describe() {
    return SCHEMA.map((s) => ({
      key: s.key, group: s.group, kind: s.kind, label: s.label, note: s.note ?? null,
      options: s.options ?? null,
      value: this.get(s.key),
      source: this.source(s.key),
      env: s.env ?? null,
      // what the setting would fall back to if the UI value were cleared — shown so "reset" is a
      // decision somebody can make knowing what they get
      fallback: (s.env && this.env[s.env]) || s.def,
    }))
  }

  /**
   * Save from the UI. `null` or `''` for a key CLEARS it, falling back to the environment.
   *
   * All-or-nothing: one invalid value refuses the whole patch, because half a configuration change
   * — the new image generator URL saved and its timeout refused — is harder to reason about than
   * none.
   */
  async set(patch = {}) {
    const errors = []
    for (const [k, v] of Object.entries(patch)) {
      const spec = BY_KEY.get(k)
      if (!spec) { errors.push(`no setting "${k}"`); continue }
      const e = invalid(spec, v)
      if (e) errors.push(e)
    }
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400, errors })

    const before = Object.fromEntries(SCHEMA.map((s) => [s.key, this.get(s.key)]))
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') delete this.saved[k]
      else this.saved[k] = String(v)
    }
    await mkdir(path.dirname(this.file), { recursive: true })
    // written then renamed, so a crash mid-write leaves the old file rather than half a new one
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify({ values: this.saved, updated: new Date().toISOString() }, null, 2))
    await rename(tmp, this.file)

    const changed = SCHEMA.map((s) => s.key).filter((k) => this.get(k) !== before[k])
    for (const fn of this.listeners) {
      try {
        await fn(changed)
      } catch (e) {
        console.warn('settings: a listener failed', e)
      }
    }
    return { changed, settings: this.describe() }
  }

  /** Be told which keys changed, so a consumer built at startup can rebuild itself. */
  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}
