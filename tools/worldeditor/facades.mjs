// The building classes' facade pools, for the MCP tools: the same three layers the game resolves.
//
// The app's `src/world/facades.ts` is the source; this is the part the tools need — the built-in
// set (read from the app's own `facades.json`, so there is ONE copy of the classes and their
// default pools) and the layering: built-in, then the library's shared `/facades` record, then the
// world's `surfaces.json` → `buildings.classes`. facades.test.mjs holds the layering to the same
// cases the app's test does; vocab.test.mjs holds the class ids to the app's list.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const BUILTIN_FILE = path.resolve(HERE, '../../apps/corridor/src/world/facades.json')
export const FIELDS = ['walls', 'roofs', 'metalness', 'roughness', 'glass']

/** the app's built-in classes, as it ships them */
export async function builtinFacades() {
  return JSON.parse(await readFile(BUILTIN_FILE, 'utf8')).classes
}

function clean(list) {
  if (!Array.isArray(list)) return undefined
  const out = []
  for (const e of list) {
    const m = typeof e === 'string' ? e : e?.material
    const w = typeof e === 'string' ? 1 : Number(e?.weight ?? 1)
    if (typeof m === 'string' && m && Number.isFinite(w) && w > 0) out.push({ material: m, weight: w })
  }
  return out
}

function lay(into, patch) {
  if (!patch) return
  for (const k of FIELDS) {
    const v = patch[k]
    if (v === undefined || v === null) continue
    if (k === 'walls' || k === 'roofs') {
      const c = clean(v)
      if (c) into[k] = c
    } else if (k === 'glass') into.glass = !!v
    else {
      const n = Number(v)
      if (Number.isFinite(n)) into[k] = Math.min(1, Math.max(0, n))
    }
  }
}

/** facades.ts `resolveFacades`, line for line */
export function resolveFacades(builtin, shared, world) {
  const byId = new Map((shared ?? []).map((r) => [r.id, r]))
  const legacyWalls = clean(world?.walls ?? [])
  const legacyRoofs = clean(world?.roofs ?? [])
  return builtin.map((b) => {
    const c = structuredClone(b)
    lay(c, byId.get(b.id))
    if (legacyWalls?.length) c.walls = legacyWalls
    if (legacyRoofs?.length) c.roofs = legacyRoofs
    lay(c, world?.classes?.[b.id])
    return c
  })
}

/** facades.ts `facadeSources`: where each field of a class came from */
export function facadeSources(id, shared, world) {
  const out = {}
  const s = (shared ?? []).find((r) => r.id === id)
  const w = world?.classes?.[id]
  for (const k of FIELDS) {
    const legacy = (k === 'walls' && world?.walls?.length) || (k === 'roofs' && world?.roofs?.length)
    out[k] = w?.[k] !== undefined ? 'world' : legacy ? 'world' : s?.[k] !== undefined ? 'shared' : 'built-in'
  }
  return out
}

/**
 * A patch as a tool caller wrote it, checked: known fields only, pools of `{ material, weight }`
 * naming materials the library has, numbers in 0…1. Throws with what to do instead.
 */
export function checkPatch(a, materialIds) {
  const patch = {}
  for (const k of ['walls', 'roofs']) {
    if (a[k] === undefined) continue
    if (!Array.isArray(a[k])) throw new Error(`${k} is a list of { material, weight }`)
    const list = clean(a[k])
    if (list.length !== a[k].length) throw new Error(`every ${k} entry needs a material id and a weight above 0`)
    const missing = list.map((e) => e.material).filter((m) => materialIds && !materialIds.has(m))
    if (missing.length) throw new Error(`not in the library: ${missing.join(', ')} — material_list has the ids`)
    patch[k] = list
  }
  for (const k of ['metalness', 'roughness']) {
    if (a[k] === undefined) continue
    const n = Number(a[k])
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${k} is a number from 0 to 1`)
    patch[k] = n
  }
  if (a.glass !== undefined) patch.glass = !!a.glass
  return patch
}
