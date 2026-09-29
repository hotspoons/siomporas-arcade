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

import { cp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
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
    /*
     * THE CLASS THE IMPORT ALREADY KNEW.
     *
     * Measured 2026-09-29: 125 items, and `kind` set on SIX of them. `origin.class` was set on
     * 120 — 77 `hero-car`, 43 `traffic` — because `assetlib` writes the class it generated from
     * into the provenance and the importer never promoted it to the field the editor filters on.
     *
     * So the whole library read as props. Every car in it showed no vehicle form, the fleet
     * roster was empty beside a library full of cars, and there was no error anywhere — the two
     * fields simply never met (Rich, 2026-09-29: "the other guy added 3 tabs for physics but
     * nothing works. I have no idea how to take a car model and attach a physics model to it").
     *
     * Derived on READ rather than migrated on disk, deliberately: a migration can half-run and
     * leaves nothing to say which half, and a new import would arrive un-promoted the next day.
     * Writing a `kind` explicitly still wins — `put` stores it, and this only fills a hole.
     */
    const kind = item.kind ?? item.origin?.class ?? 'prop'
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
      kind,
      views,
      mesh: (await has('mesh.glb')) || null,
      finished: (await has('mesh.finished.glb')) || null,
      /*
       * THE ONE WITH REAL GLASS.
       *
       * `finish.mjs` emits a third file whose glazing is split into KHR_materials_transmission
       * with a per-texel mask — the raw reconstruction and the plain finished one both have the
       * windows PAINTED ON, opaque. Nothing reported this file, so nothing ever loaded it and
       * every car in the editor had solid windows (Rich, 2026-09-28: "I notice the window
       * transparency isn't working on either the original or decimated models").
       */
      glass: (await has('mesh.glass.glb')) || null,
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
      /*
       * WHAT IT IS, as opposed to what it is filed under.
       *
       * Rich, 2026-09-29: "I don't like how they used classes to link catalog types — things from
       * the catalog should be either a prop/furniture/building type of thing, a vehicle, an actor,
       * or a weapon."
       *
       * `kind` answers "which sort of vehicle"; `type` answers "is this a vehicle at all", and
       * only the second decides which documents an asset can have. Stored only when somebody sets
       * it: the client derives it from `kind` otherwise, so the mapping lives in exactly one place
       * (`apps/corridor/src/classes.ts`) rather than in a copy here that drifts.
       */
      type: spec.type ?? before.type ?? null,
      prompt: spec.prompt ?? before.prompt ?? '',
      negative: spec.negative ?? before.negative ?? '',
      notes: spec.notes ?? before.notes ?? '',
      tags: spec.tags ?? before.tags ?? [],
      chosen: spec.chosen ?? before.chosen ?? null,
      /*
       * THE SEED IS PART OF THE ASSET, not a detail of the run that made it.
       *
       * Two generations from one prompt are two different cars. So the seed that produced the
       * view a human accepted is the only thing that makes the asset reproducible — regenerate
       * without it and you get a different car with the same name, which is worse than no asset
       * because nothing says so. Pinned here when a view is chosen.
       */
      seed: spec.seed ?? before.seed ?? null,
      /** the roster entry this came from, when it came from one */
      spec: spec.spec ?? before.spec ?? null,
      /*
       * WHICH MESH IS USED WHERE.
       *
       * Rich, 2026-09-28: "I would want the original models for the hero car of any game plus
       * direct opponents, while traffic would use lower quality models."
       *
       * Role → variant. Absent means the class default (see `USED_FOR` in ui/assets.ts), so a
       * library nobody has filled in still resolves — and an asset that genuinely differs can say
       * so without every asset having to.
       */
      use: spec.use === undefined ? (before.use ?? null) : spec.use,
      /*
       * SHARED, OR THIS WORLD'S.
       *
       * Rich, 2026-09-28: "we should have a shared vs world concept for assets where you can take
       * a shared asset and customize it for your world, or create a world-specific asset."
       *
       * `null` means shared: every world may place it, and editing it changes it everywhere,
       * which is right for a fire hydrant and wrong for the diner on the corner of THIS road. A
       * slug means it belongs to that world and is only offered there. Forking a shared one (see
       * `fork`) is how the second becomes true of a thing that used to be the first.
       */
      world: spec.world === undefined ? (before.world ?? null) : spec.world,
      /*
       * WHAT THE BONES ARE FOR, when somebody has said.
       *
       * The viewer guesses roles from bone NAMES, which works until it does not: a rig calls its
       * front wheels `Bone.007`, or calls an excavator's stick an arm. This is the override, and
       * it is stored with the asset because it is a fact about the model rather than about a level.
       */
      rig: spec.rig === undefined ? (before.rig ?? null) : spec.rig,
      /*
       * HOW IT DRIVES, when it is a vehicle.
       *
       * Beside the asset rather than inside a level, for the same reason `rig` is: a car's mass,
       * grip, gearing and engine note are facts about the CAR, and a level that carried them would
       * mean the same car handled differently in two games by accident rather than on purpose. A
       * level may still override — the document holds a profile REFERENCE plus overrides, never a
       * copy, so improving `street` improves every car that names it.
       *
       * The schema and every unit are in `apps/corridor/src/vehicles.ts`; this only stores it. The
       * service deliberately does not validate it: the editor reports every problem at once while
       * somebody is typing, which is better than a 400 from here naming the first one.
       */
      vehicle: spec.vehicle === undefined ? (before.vehicle ?? null) : spec.vehicle,
      /** how it moves and fights, for a person, an animal or an enemy (`src/actorspecs.ts`) */
      actor: spec.actor === undefined ? (before.actor ?? null) : spec.actor,
      /** what it does when fired (`src/weapons.ts`) */
      weapon: spec.weapon === undefined ? (before.weapon ?? null) : spec.weapon,
      updated: new Date().toISOString(),
      history: before.history ?? [],
    }
    await writeFile(file, JSON.stringify(item, null, 2))
    return this.#withFiles(item)
  }

  /**
   * Copy an item, files and all, under a new id.
   *
   * FOR CUSTOMISING A SHARED ASSET FOR ONE WORLD. The alternative — a world-specific override
   * layer pointing at a shared item — means an edit to the shared one silently changes the
   * customised one underneath, which is exactly what somebody forking it was trying to avoid. A
   * copy is bytes on a volume and no surprises.
   */
  async fork(id, to, world = null) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(to ?? '')) throw Object.assign(new Error(`${JSON.stringify(to)} is not a usable id`), { status: 400 })
    const from = this.dir(id)
    const dest = this.dir(to)
    if (!existsSync(from)) throw Object.assign(new Error(`no asset ${id}`), { status: 404 })
    if (existsSync(dest)) throw Object.assign(new Error(`${to} already exists`), { status: 409 })
    await cp(from, dest, { recursive: true })
    const item = JSON.parse(await readFile(path.join(dest, 'item.json'), 'utf8'))
    item.id = to
    item.world = world
    item.forkedFrom = id
    item.updated = new Date().toISOString()
    // the provenance says where it came from; a copy with the original's history and none of this
    // is an asset nobody can explain later
    item.history = [...(item.history ?? []), { at: item.updated, step: 'fork', from: id, world }]
    await writeFile(path.join(dest, 'item.json'), JSON.stringify(item, null, 2))
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
