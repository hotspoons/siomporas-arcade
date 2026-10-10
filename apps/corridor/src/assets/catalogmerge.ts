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

import { ASSETSVC, MESH_FILE, assetsvc, type AssetItem } from './assetsvc'
import { heightFor, typeOf } from './classes'

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

/** the library's placeable items: props, buildings and fixtures that have a mesh */
export function libraryEntries(items: AssetItem[]): PlaceableEntry[] {
  const out: PlaceableEntry[] = []
  for (const it of items) {
    const type = typeOf(it)
    if (type !== 'prop' && type !== 'fixture') continue
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
