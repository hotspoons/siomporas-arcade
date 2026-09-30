// A world's own textures: `sites/<slug>/surfaces.json`.
//
// Rich, 2026-09-30: "we need to be able to apply default textures per world for things like roads
// by material, grass, buildings (have a pool to pick from randomly)… per world we can pick the
// textures from the place editor."
//
// The renderer names surfaces by CLASS — a road is `asphalt_aged` or `concrete`, a verge is
// `grass_mown` — and until now the class was also the name of the texture set that drew it. This
// document is the mapping between the two, per world: which library material draws each road
// class, which draws the mown and the rough grass, and which pools a building's walls and roof are
// drawn from. Nothing in it is required; a class it does not mention draws as it always did.

/** where the bake is served from (site.ts DATA_BASE), read lazily so this module loads under node for its tests */
const dataBase = () => (typeof location === 'undefined' ? '' : (new URLSearchParams(location.search).get('data') ?? ''))

export interface SurfacesDoc {
  version: 1
  /** road class (asphalt_aged, concrete, …) → material id */
  road?: Record<string, string>
  /** the verge grasses → material ids */
  ground?: { mown?: string; rough?: string }
  /** pools a building draws its walls and roof from, by a hash of the building and `seed` */
  buildings?: { walls?: string[]; roofs?: string[]; seed?: number }
}

export const EMPTY_SURFACES: SurfacesDoc = { version: 1 }

/** the material categories the road classes may be drawn with, and the ground ones */
export const ROAD_CATEGORIES = ['road', 'paving', 'shoulder']
export const GROUND_CATEGORIES = ['ground_cover', 'verge']
export const WALL_CATEGORY_RE = /^wall/
export const ROOF_CATEGORY_RE = /^roof/

export async function loadSurfacesDoc(slug: string, base = dataBase()): Promise<SurfacesDoc> {
  try {
    const r = await fetch(`${base}/sites/${slug}/surfaces.json`, { cache: 'no-cache' })
    if (!r.ok) return { ...EMPTY_SURFACES }
    const text = (await r.text()).trimStart()
    if (!text.startsWith('{')) return { ...EMPTY_SURFACES }
    const doc = JSON.parse(text) as SurfacesDoc
    return { ...EMPTY_SURFACES, ...doc }
  } catch {
    return { ...EMPTY_SURFACES }
  }
}

export async function saveSurfacesDoc(slug: string, doc: SurfacesDoc): Promise<number> {
  const r = await fetch(`/sites/${slug}/surfaces.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc, null, 1) })
  const j = (await r.json()) as { ok: boolean; bytes?: number; error?: string }
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j.bytes ?? 0
}

/**
 * The texture-set lookup the renderer uses, with the world's choices laid over the defaults:
 * `resolved[cls]` is the set that draws class `cls`. A choice that names a set the library did
 * not deliver falls back to the class's own set, so a missing texture is a default look, not a
 * pink road.
 */
export function resolveSurfaceSets<T>(sets: Record<string, T>, doc: SurfacesDoc | null | undefined): Record<string, T> {
  const out: Record<string, T> = { ...sets }
  for (const [cls, id] of Object.entries(doc?.road ?? {})) if (id && sets[id]) out[cls] = sets[id]
  const g = doc?.ground
  if (g?.mown && sets[g.mown]) out.grass_mown = sets[g.mown]
  if (g?.rough && sets[g.rough]) out.grass_rough = sets[g.rough]
  return out
}

/** Which pool member a building gets: stable per building and per `seed`. */
export function pickFromPool(pool: string[] | undefined, key: number, seed = 1): string | null {
  if (!pool?.length) return null
  let h = (Math.imul(key | 0, 2654435761) ^ Math.imul(seed | 0, 40503)) >>> 0
  h = (h ^ (h >>> 15)) >>> 0
  return pool[h % pool.length]
}
