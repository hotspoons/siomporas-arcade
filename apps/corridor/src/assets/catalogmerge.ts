// The placement catalog, as the editor and the viewer both see it: the shipped models plus the
// asset library.
//
// Rich, 2026-09-30: "the shipped version of the editor has a bunch of hard-coded items from
// development that aren't actually there like gas station, strip mall, etc. — these need to draw
// from the asset library, not from a hard-coded list of items that don't exist."
//
// `/assets/catalog.json` is the shipped kit — the rock kit, a barn, a diner, a water tower, a
// bridge — every entry of which has a model on disk. Everything else that can be placed is a
// LIBRARY item: a catalog asset with a mesh, filed as a prop, a building or a fixture. The two
// are merged here, once, and both `editor/catalog.ts` and `placements.ts` read the merge, so
// the editor never offers what the game cannot draw.
//
// SIZE. A reconstruction is a unit cube; nothing in it says how tall the thing is. The asset
// record may say (`size_m`, from the asset form); otherwise the class does (`heightFor`), and
// the footprint is MEASURED from the model the first time it is loaded (`measured: false` until
// then) rather than typed here.

import { ASSETSVC, MESH_FILE, assetsvc, type AssetItem, type Build } from './assetsvc'
import { heightFor, typeOf, type AssetType } from './classes'

export interface PlaceableEntry {
  id: string
  name: string
  category: string
  glb?: string | null
  footprint_m: [number, number]
  height_m: number
  fit?: 'height' | 'span'
  yaw_offset_deg?: number
  rock_type?: string
  /** from the asset library rather than the shipped kit */
  library?: boolean
  /** the footprint was measured from the model (or typed); false means "a guess until loaded" */
  measured?: boolean
  /** what it IS — prop, vehicle, actor, weapon, fixture — when it came from the library */
  type?: AssetType
  /** a vehicle, actor or weapon BUILD wearing this model: the catalog id it wears */
  wears?: string
}

/** the shipped kit, minus anything that has no model: a box with a name on it is not an asset */
export function shippedEntries(doc: { assets?: PlaceableEntry[] } | null | undefined): PlaceableEntry[] {
  return (doc?.assets ?? []).filter((e) => !!e.glb).map((e) => ({ ...e, measured: true }))
}

/**
 * THE BUILT-INS: what can be placed that is not a library item.
 *
 * Rich, 2026-10-10: "Catalog was supposed to show props like horse bridges and water towers, these
 * show up in the place editor but don't show up in the catalog." The place editor reads the merge
 * of two sources and the Catalog tab listed one of them. This is the other one, said once so both
 * screens agree on it: every entry of the placeable list that has a model (`shippedEntries`) and
 * is not a library item — not one by id, and not one whose model is served by the asset service
 * (a ticked library item lives in the same file, and it is listed as the library row it is).
 */
export function builtinEntries(doc: { assets?: PlaceableEntry[] } | null | undefined, libraryIds: Set<string>): PlaceableEntry[] {
  return shippedEntries(doc).filter((e) => !libraryIds.has(e.id) && !/^\/?assetsvc\//.test(e.glb ?? ''))
}

/** The placeable list as this origin serves it: the shipped kit, or a world editor's volume copy. */
export async function loadPlaceableDoc(): Promise<{ assets?: PlaceableEntry[] } | null> {
  try {
    const r = await fetch('/assets/catalog.json', { cache: 'no-cache' })
    return r.ok ? ((await r.json()) as { assets?: PlaceableEntry[] }) : null
  } catch {
    return null
  }
}

/**
 * The library's items that have a mesh: by default the PLACEABLE ones — props, buildings and
 * fixtures. `types` widens it; a program may spawn a car or a person as scenery too.
 */
export function libraryEntries(items: AssetItem[], types: readonly AssetType[] = ['prop', 'fixture']): PlaceableEntry[] {
  const out: PlaceableEntry[] = []
  for (const it of items) {
    const type = typeOf(it)
    if (!types.includes(type)) continue
    const variant = it.finished ? 'finished' : it.mesh ? 'raw' : null
    if (!variant) continue
    const kind = it.kind || type
    const h = it.size_m?.h ?? heightFor(kind, type)
    const w = it.size_m?.w
    const d = it.size_m?.d
    const measured = typeof w === 'number' && typeof d === 'number'
    // relative to the origin, so a deployed copy (which serves /assetsvc/… out of its bucket) and
    // the editor (which proxies it) both resolve it
    const glb = assetsvc.fileUrl(it.id, MESH_FILE[variant]).replace(ASSETSVC, '/assetsvc')
    out.push({
      id: it.id,
      name: it.subject || it.id,
      category: kind,
      glb,
      footprint_m: measured ? [Math.max(w, d), Math.min(w, d)] : [Math.round(h * 0.8 * 10) / 10, Math.round(h * 0.8 * 10) / 10],
      height_m: h,
      fit: 'height',
      library: true,
      measured,
      type,
    })
  }
  return out
}

/** The merge: the shipped kit and the library, the library winning an id clash. */
export function mergeCatalog(shipped: PlaceableEntry[], library: PlaceableEntry[]): PlaceableEntry[] {
  const byId = new Map<string, PlaceableEntry>()
  for (const e of shipped) byId.set(e.id, e)
  for (const e of library) byId.set(e.id, e)
  return [...byId.values()]
}

/** Both sources, fetched. No library (no service, or a deployed copy without one) is the kit alone. */
export async function loadMergedCatalog(): Promise<{ assets: PlaceableEntry[] }> {
  const shipped = shippedEntries(await loadPlaceableDoc())
  let library: PlaceableEntry[] = []
  try {
    library = libraryEntries(await assetsvc.list())
  } catch {
    /* no library */
  }
  return { assets: mergeCatalog(shipped, library) }
}

/*
 * WHAT A PROGRAM MAY SPAWN — `api.models.spawn(id, pose)`.
 *
 * Rich, 2026-10-10: *"nor no assets we can reference from the library in case we want to spawn
 * something at a point for a given condition."* The placement catalog answers "what can the editor
 * place", which is props and fixtures; a program wants the whole library: the kit, every asset with
 * a model whatever it is, and every vehicle, actor and weapon BUILD by its own id (a build wears its
 * model, so `spawn('beltway-nightmare', …)` puts the RX-7 down as a thing, not as a car to drive).
 *
 * ONE LIST, TWO READERS. The viewer's ModelHost resolves a spawn through it and the editor's Program
 * pane lists it beside the code, so what the list offers is what a spawn finds.
 */
const BUILD_KINDS = [['vehicles', 'vehicle'], ['actors', 'actor'], ['weapons', 'weapon']] as const

/** The builds, each as an entry wearing its model's. Pure, so a test hands it literals. */
export function buildEntries(models: Map<string, PlaceableEntry>, builds: { kind: AssetType; build: Pick<Build<unknown>, 'id' | 'name' | 'asset'> }[]): PlaceableEntry[] {
  const out: PlaceableEntry[] = []
  for (const { kind, build } of builds) {
    const wears = build.asset ? models.get(build.asset) : undefined
    // a build with no model yet is a set of numbers: nothing to draw, so nothing to spawn
    if (!wears || !build.id) continue
    out.push({ ...wears, id: build.id, name: build.name || build.id, type: kind, wears: wears.id })
  }
  return out
}

/** The kit, every library asset with a model, and every build that has one. A missing service is the kit alone. */
export async function loadSpawnCatalog(): Promise<PlaceableEntry[]> {
  let shipped: PlaceableEntry[] = []
  try {
    const r = await fetch('/assets/catalog.json', { cache: 'no-cache' })
    if (r.ok) shipped = shippedEntries((await r.json()) as { assets?: PlaceableEntry[] })
  } catch {
    /* no kit */
  }
  let library: PlaceableEntry[] = []
  const builds: { kind: AssetType; build: Build<unknown> }[] = []
  try {
    library = libraryEntries(await assetsvc.list(), ['prop', 'fixture', 'vehicle', 'actor', 'weapon'])
    await Promise.all(BUILD_KINDS.map(async ([coll, kind]) => {
      for (const build of await assetsvc.builds<Build<unknown>>(coll).catch(() => [])) builds.push({ kind, build })
    }))
  } catch {
    /* no library */
  }
  const models = mergeCatalog(shipped, library)
  const byId = new Map(models.map((e) => [e.id, e]))
  // a build id that clashes with a model id loses: the model is what was asked for by that name
  return [...models, ...buildEntries(byId, builds).filter((b) => !byId.has(b.id))]
}
