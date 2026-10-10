// Building classes and the facades they are drawn from.
//
// Rich, 2026-10-10: "We also need a tab in assets to assign textures to classes of buildings. We
// need to be able to have random textures feed a single building type so we can get variety, e.g.
// brick and siding textures -> single family home, bricks and cinder blocks -> apartments, cinder
// blocks, bricks and pale bricks -> commercial building, glass -> skyscraper. Need to be able to
// assign reflectiveness for cases like skyscrapers."
//
// THE SHAPE. A CLASS is what a footprint is (a house, a tower, a warehouse) — decided here from
// the OSM `building=` value the bake kept, the shop or office a POI lent it, and failing those its
// size and height. Each class has a POOL of library materials with weights, a roof pool, and how
// its walls take the light (metalness as reflectiveness, roughness, and whether a material's glass
// mask makes panes). Every building draws ONE wall and ONE roof from its class's pools, by a hash
// of the building itself, so it is the same building on every load and in every tile.
//
// THREE LAYERS, the last word winning per field:
//   1. the built-in set (`facades.json`, Rich's examples), so a world nobody has touched has them;
//   2. the shared default — the library's `/facades` collection, edited in Assets → Buildings;
//   3. the world's own — `sites/<slug>/surfaces.json` → `buildings.classes`, beside its road and
//      grass textures. A world's older single wall/roof pool (`buildings.walls`, `buildings.roofs`,
//      the World tab's chips) is the world speaking too, so it beats the shared default for every
//      class the world has not given a pool of its own.
//
// NO THREE AND NO DOM: the massing worker classifies and picks with exactly this code, and the
// world editor's MCP tools read the same `facades.json`.

import builtin from './facades.json'

export interface FacadeEntry {
  /** a library material id (assetsvc /materials) */
  material: string
  /** relative share: 2 is picked twice as often as 1 */
  weight: number
}

export interface FacadeClass {
  id: string
  label: string
  note: string
  /** the `building=` values that put a footprint in this class */
  osm: string[]
  /** a footprint at least this tall is this class whatever its tag says */
  min_height_m?: number
  walls: FacadeEntry[]
  roofs: FacadeEntry[]
  /** 0…1 — how much the walls mirror the sky ("reflectiveness"); 0.85 is a glass tower */
  metalness: number
  /** 0…1 — 1 is chalk, 0.05 is a mirror */
  roughness: number
  /** use the material's glass mask: its panes take the material's own glass roughness */
  glass: boolean
}

/** What a shared record or a world may say about a class: any of the drawable fields. */
export type FacadePatch = Partial<Pick<FacadeClass, 'walls' | 'roofs' | 'metalness' | 'roughness' | 'glass'>>

/** The surfaces.json `buildings` block, as far as this module reads it. */
export interface WorldBuildings {
  walls?: string[]
  roofs?: string[]
  seed?: number
  classes?: Record<string, FacadePatch>
}

export const BUILTIN_FACADES: FacadeClass[] = (builtin as { classes: FacadeClass[] }).classes

/** The class ids, in the order the tab lists them. vocab.test.mjs holds the MCP vocabulary to this. */
export const FACADE_CLASS_IDS = ['house', 'townhouse', 'apartments', 'commercial', 'skyscraper', 'industrial', 'civic', 'farm', 'shed']

/** The fields a patch may carry — anything else in a stored record (id, updated…) is ignored. */
const FIELDS = ['walls', 'roofs', 'metalness', 'roughness', 'glass'] as const

function clean(list: unknown): FacadeEntry[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out: FacadeEntry[] = []
  for (const e of list) {
    const m = typeof e === 'string' ? e : (e as FacadeEntry)?.material
    const w = typeof e === 'string' ? 1 : Number((e as FacadeEntry)?.weight ?? 1)
    if (typeof m === 'string' && m && Number.isFinite(w) && w > 0) out.push({ material: m, weight: w })
  }
  return out
}

function lay(into: FacadeClass, patch: FacadePatch | undefined | null): void {
  if (!patch) return
  for (const k of FIELDS) {
    const v = patch[k]
    if (v === undefined || v === null) continue
    if (k === 'walls' || k === 'roofs') {
      const c = clean(v)
      if (c) into[k] = c
    } else if (k === 'glass') {
      into.glass = !!v
    } else {
      const n = Number(v)
      if (Number.isFinite(n)) into[k] = Math.min(1, Math.max(0, n))
    }
  }
}

/**
 * The classes as a world draws them: built-in, then the shared default, then the world.
 *
 * `shared` is the library's records (`{ id, …patch }`), `world` the surfaces.json block. A record
 * for a class this file does not know is ignored — a class is a classification rule as well as a
 * pool, and the rule lives here.
 */
export function resolveFacades(shared: (FacadePatch & { id: string })[] | null | undefined, world: WorldBuildings | null | undefined): FacadeClass[] {
  const byId = new Map((shared ?? []).map((r) => [r.id, r]))
  const legacyWalls = clean(world?.walls ?? [])
  const legacyRoofs = clean(world?.roofs ?? [])
  return BUILTIN_FACADES.map((b) => {
    const c: FacadeClass = structuredClone(b)
    lay(c, byId.get(b.id))
    // the world's one pool for every class: the World tab's chips, which predate classes
    if (legacyWalls?.length) c.walls = legacyWalls
    if (legacyRoofs?.length) c.roofs = legacyRoofs
    lay(c, world?.classes?.[b.id])
    return c
  })
}

/** Where each field of a class came from, for the tab to say so. */
export function facadeSources(id: string, shared: (FacadePatch & { id: string })[] | null | undefined, world: WorldBuildings | null | undefined): Record<(typeof FIELDS)[number], 'built-in' | 'shared' | 'world'> {
  const out = {} as Record<(typeof FIELDS)[number], 'built-in' | 'shared' | 'world'>
  const s = (shared ?? []).find((r) => r.id === id)
  const w = world?.classes?.[id]
  for (const k of FIELDS) {
    const legacy = (k === 'walls' && world?.walls?.length) || (k === 'roofs' && world?.roofs?.length)
    out[k] = w?.[k] !== undefined ? 'world' : legacy ? 'world' : s?.[k] !== undefined ? 'shared' : 'built-in'
  }
  return out
}

/* ---- classification -------------------------------------------------------------------------- */

/** What the classifier reads off a footprint — the bake's `manifest.buildings` entries carry it all. */
export interface FootprintFacts {
  tags?: Record<string, string> | null
  area_m2?: number
  height_m?: number
  rect?: { w: number; d: number } | null
}

/** A shop, an office, a school lent to the footprint by a POI inside it (buildings.py). */
const POI_CLASS: Record<string, string> = {
  'amenity=school': 'civic', 'amenity=college': 'civic', 'amenity=university': 'civic', 'amenity=kindergarten': 'civic',
  'amenity=place_of_worship': 'civic', 'amenity=hospital': 'civic', 'amenity=townhall': 'civic', 'amenity=library': 'civic',
  'amenity=fire_station': 'civic', 'amenity=police': 'civic', 'amenity=courthouse': 'civic', 'amenity=post_office': 'civic',
  'amenity=restaurant': 'commercial', 'amenity=fast_food': 'commercial', 'amenity=cafe': 'commercial', 'amenity=bank': 'commercial',
  'amenity=fuel': 'commercial', 'amenity=pharmacy': 'commercial', 'amenity=bar': 'commercial', 'amenity=pub': 'commercial',
  'tourism=hotel': 'commercial', 'tourism=motel': 'commercial',
}
/** a POI is a point, and OSM hangs it on whatever contains it: past this size it is a unit in something bigger */
const POI_PLAUSIBLE_M2 = 20000

/**
 * Which class a footprint is. Height first (a 40 m building is a tower whatever it is tagged), then
 * its own `building=` value, then what a POI inside it says, then its shape — the same evidence, in
 * the same order, as the editor's autogen (editor/author/autogen.ts `categoryOf`), coarsened to the
 * classes a facade differs by.
 */
export function classifyFootprint(b: FootprintFacts, classes: FacadeClass[] = BUILTIN_FACADES): string {
  const H = b.height_m ?? 6
  const A = b.area_m2 ?? 0
  for (const c of classes) if (c.min_height_m !== undefined && H >= c.min_height_m) return c.id
  const tags = b.tags ?? {}
  const v = tags.building
  if (v && v !== 'yes') for (const c of classes) if (c.osm.includes(v)) return c.id
  if (A <= POI_PLAUSIBLE_M2) {
    for (const [k, val] of Object.entries(tags)) {
      const hit = POI_CLASS[`${k}=${val}`]
      if (hit) return hit
      if (k === 'shop' || k === 'office') return 'commercial'
    }
  }
  const E = b.rect && b.rect.d > 0.01 ? b.rect.w / b.rect.d : 1
  if (A < 40) return 'shed'
  if (A < 300) return H >= 11 && E < 2.5 ? 'apartments' : E >= 3.2 ? 'townhouse' : 'house'
  if (A < 800) return H >= 9 ? 'apartments' : A < 450 ? 'house' : 'commercial'
  if (A < 4000) return H >= 14 ? 'commercial' : H >= 9 ? 'apartments' : 'commercial'
  return H < 12 ? 'industrial' : 'commercial'
}

/* ---- the pick ------------------------------------------------------------------------------- */

/**
 * A building's identity, as an integer. The bake carries no OSM id, so this is the footprint's
 * centroid in site metres rounded to 10 cm — the same in every tile that holds it, every load and
 * either winding, which a ring's first vertex is not.
 */
export function buildingKey(ring: [number, number][]): number {
  let x = 0, y = 0
  for (const p of ring) { x += p[0]; y += p[1] }
  const n = ring.length || 1
  const qx = Math.round((x / n) * 10) | 0
  const qy = Math.round((y / n) * 10) | 0
  let h = Math.imul(qx, 374761393) ^ Math.imul(qy, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/** Which entry a building gets, by weight: stable for a key, and `salt` makes the roof its own draw. */
export function pickWeighted(weights: number[], key: number, salt = 0): number {
  if (!weights.length) return -1
  let total = 0
  for (const w of weights) total += w > 0 ? w : 0
  if (total <= 0) return -1
  let h = Math.imul((key ^ salt) >>> 0, 2654435761) >>> 0
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  let u = (h / 4294967296) * total
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] > 0 ? weights[i] : 0
    if (u < w) return i
    u -= w
  }
  return weights.length - 1
}

/* ---- the plan the massing reads ------------------------------------------------------------- */

/** One class as the massing needs it: which texture layer each pool entry is, and its weight. */
export interface PlanClass {
  id: string
  walls: { layer: number; weight: number }[]
  roofs: { layer: number; weight: number }[]
  /** glazed: the dressing (windows, doors) is not drawn over a curtain wall */
  glass: boolean
}

/**
 * The resolved classes, reduced to texture layers. `available` is the library's material ids — a
 * pool entry naming a material the library does not have is dropped (a missing texture is the
 * palette colour, not a hole), and a class whose pool empties draws from the palette.
 *
 * `layers` is every material used, once: ONE texture array for the whole world, whatever the
 * number of classes and buildings.
 */
export function facadePlan(classes: FacadeClass[], available: Set<string> | null): { layers: string[]; classes: PlanClass[] } {
  const layers: string[] = []
  const layerOf = (m: string) => {
    let i = layers.indexOf(m)
    if (i < 0) { i = layers.length; layers.push(m) }
    return i
  }
  const pool = (list: FacadeEntry[]) => {
    const out: { layer: number; weight: number }[] = []
    for (const e of list) {
      if (available && !available.has(e.material)) continue
      if (!layers.includes(e.material) && layers.length >= MAX_LAYERS) continue
      out.push({ layer: layerOf(e.material), weight: e.weight })
    }
    return out
  }
  const out = classes.slice(0, MAX_CLASSES).map((c) => ({ id: c.id, walls: pool(c.walls), roofs: pool(c.roofs), glass: c.glass }))
  return { layers, classes: out }
}

/**
 * The massing packs a vertex's texture as `class × 64 + layer` in the one float it already carried,
 * so the class's surface rides with it for no extra attribute — dc-metro's massing is millions of
 * vertices, and a second float on each is megabytes for nothing.
 */
export const LAYER_STRIDE = 64
export const MAX_LAYERS = 63
export const MAX_CLASSES = 16
export const packLayer = (slot: number, layer: number) => slot * LAYER_STRIDE + layer
