// The catalog: what the world is made of, and how far along each piece is.
//
// One directory per item on a volume — a PVC in the cluster, a folder on a laptop — because these
// are tens of megabytes of PNG and GLB and they must survive a pod restart without a re-generation
// costing another GPU-hour. `item.json` beside the files is the record; the directory IS the
// database, which is the right size of database for a few hundred props.
//
//   <root>/<id>/item.json        the spec, the state, and the provenance of every step
//   <root>/<id>/views/*.png      generated 2D views, newest last; `chosen` names the one to mesh
//   <root>/<id>/mesh.glb         what the mesh model returned, raw
//   <root>/<id>/mesh.finished.glb  after tools/assetgen/finish.mjs — the one a game loads
//
// PROVENANCE IS NOT OPTIONAL. Every generated file records which model made it, from which prompt,
// with which seed, at which time. An asset whose origin nobody can reconstruct is one you cannot
// regenerate when the style changes, and this pipeline exists to be re-run.

import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export class Catalog {
  constructor(root) {
    this.root = root
  }

  dir(id) {
    if (!SAFE_ID.test(id)) throw Object.assign(new Error(`bad item id ${JSON.stringify(id)}`), { status: 400 })
    return path.join(this.root, id)
  }

  async init() {
    await mkdir(this.root, { recursive: true })
  }

  async list() {
    await this.init()
    const names = await readdir(this.root, { withFileTypes: true })
    const out = []
    for (const d of names) {
      if (!d.isDirectory() || !SAFE_ID.test(d.name)) continue
      const item = await this.get(d.name).catch(() => null)
      if (item) out.push(item)
    }
    out.sort((a, b) => (a.id < b.id ? -1 : 1))
    return out
  }

  async get(id) {
    const file = path.join(this.dir(id), 'item.json')
    const raw = await readFile(file, 'utf8')
    const item = JSON.parse(raw)
    return this.#withFiles(item)
  }

  async #withFiles(item) {
    const dir = this.dir(item.id)
    const views = existsSync(path.join(dir, 'views')) ? (await readdir(path.join(dir, 'views'))).filter((f) => f.endsWith('.png')).sort() : []
    const has = async (f) => {
      try {
        return (await stat(path.join(dir, f))).size
      } catch {
        return 0
      }
    }
    return {
      ...item,
      views,
      mesh: (await has('mesh.glb')) || null,
      finished: (await has('mesh.finished.glb')) || null,
      // What the editor shows as a status chip, derived rather than stored, so it cannot go stale.
      state: (await has('mesh.finished.glb')) ? 'finished' : (await has('mesh.glb')) ? 'meshed' : views.length ? 'drawn' : 'spec',
    }
  }

  /**
   * Create or replace an item's SPEC. Generated files are untouched: editing the prompt of a thing
   * you have already meshed should not silently throw the mesh away.
   */
  async put(id, spec) {
    const dir = this.dir(id)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'item.json')
    const before = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { created: new Date().toISOString(), history: [] }
    const item = {
      ...before,
      id,
      subject: spec.subject ?? before.subject ?? id,
      kind: spec.kind ?? before.kind ?? 'prop',
      prompt: spec.prompt ?? before.prompt ?? '',
      negative: spec.negative ?? before.negative ?? '',
      notes: spec.notes ?? before.notes ?? '',
      tags: spec.tags ?? before.tags ?? [],
      chosen: spec.chosen ?? before.chosen ?? null,
      updated: new Date().toISOString(),
      history: before.history ?? [],
    }
    await writeFile(file, JSON.stringify(item, null, 2))
    return this.#withFiles(item)
  }

  /** Append a provenance record — one per generation step, never rewritten. */
  async record(id, entry) {
    const file = path.join(this.dir(id), 'item.json')
    const item = JSON.parse(await readFile(file, 'utf8'))
    item.history = [...(item.history ?? []), { at: new Date().toISOString(), ...entry }]
    item.updated = new Date().toISOString()
    await writeFile(file, JSON.stringify(item, null, 2))
    return item
  }

  async addView(id, buf, meta) {
    const dir = path.join(this.dir(id), 'views')
    await mkdir(dir, { recursive: true })
    const name = `${String(Date.now()).slice(-10)}.png`
    await writeFile(path.join(dir, name), buf)
    const item = JSON.parse(await readFile(path.join(this.dir(id), 'item.json'), 'utf8'))
    // The newest view becomes the chosen one unless somebody has deliberately chosen another.
    if (!item.chosen) await this.put(id, { chosen: name })
    await this.record(id, { step: 'image', file: `views/${name}`, ...meta })
    return name
  }

  async writeFileFor(id, name, buf, meta) {
    await mkdir(this.dir(id), { recursive: true })
    await writeFile(path.join(this.dir(id), name), buf)
    if (meta) await this.record(id, { step: meta.step ?? 'file', file: name, ...meta })
  }

  async read(id, rel) {
    // `rel` comes off a URL, so it is checked against the item's own directory and not merely
    // inspected for "..": a symlink or an absolute path would pass that test and fail this one.
    const dir = this.dir(id)
    const full = path.resolve(dir, rel)
    if (full !== dir && !full.startsWith(dir + path.sep)) throw Object.assign(new Error('path escapes the item'), { status: 400 })
    return readFile(full)
  }

  async remove(id) {
    await rm(this.dir(id), { recursive: true, force: true })
  }
}
