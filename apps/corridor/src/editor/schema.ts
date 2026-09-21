// The two authored files, and how they get to and from disk.
//
// Both live BESIDE the bake (tools/corridor/data/sites/<slug>/{adjustments,placements}.json), not
// inside web/ — the bake owns web/ and would overwrite them. In dev the Vite middleware serves
// them at /sites/<slug>/*.json and accepts a PUT back to the same path; that is the only writable
// path in the app. `python -m corridor areas` writes adjustments.json too, seeding the areas this
// editor then tunes, so the two must agree on the shape exactly.

/** Every knob an area can turn. NOTHING may be added here without telling the main agent: the
 *  viewer (scene.ts) consumes this key set to decide what a polygon does to trees, grass, the
 *  ground and the pavement. Neutral means "leave what the data inferred alone". */
export interface Adjust {
  canopy_scale: number
  canopy_offset_m: number
  tree_density: number
  grass_height: number
  grass_density: number
  ground_offset_m: number
  surface_class: string | null
  species: string | null
}

export interface Area {
  id: string
  name: string
  /** where the proposal came from: canopy | structure | surface, absent for hand-drawn */
  source?: string
  /** SITE frame, metres: x east, y north. Closed implicitly — the last vertex joins the first. */
  polygon: [number, number][]
  adjust: Adjust
}

export interface Adjustments {
  version: 1
  areas: Area[]
}

export interface Placement {
  id: string
  asset: string
  x: number
  y: number
  /** null = sit on the ground; the viewer resolves it from site.groundAt */
  z: number | null
  yaw_deg: number
  scale: number
  snap: 'ground' | 'free'
  tags: string[]
}

export interface Placements {
  version: 1
  items: Placement[]
}

export const NEUTRAL: Adjust = {
  canopy_scale: 1,
  canopy_offset_m: 0,
  tree_density: 1,
  grass_height: 1,
  grass_density: 1,
  ground_offset_m: 0,
  surface_class: null,
  species: null,
}

/** The texture sets tools/surfaces/gen.py bakes; `null` means "whatever the classifier said". */
export const SURFACE_CLASSES = ['asphalt_new', 'asphalt_aged', 'asphalt_patched', 'chipseal', 'concrete', 'shoulder_gravel']

/** What trees.ts can actually grow; `null` means "pick by height as usual". */
export const SPECIES = ['oak', 'ash', 'aspen', 'pine']

export interface SliderDef {
  key: keyof Adjust
  label: string
  min: number
  max: number
  step: number
  /** What the viewer actually does with it — shown on hover, because two of these have limits. */
  note: string
}

/** One slider each, in panel order. */
export const SLIDERS: SliderDef[] = [
  { key: 'canopy_scale', label: 'canopy ×', min: 0.2, max: 3, step: 0.05, note: 'multiplies the measured canopy height; the tree list is rebuilt from it' },
  { key: 'canopy_offset_m', label: 'canopy +m', min: -10, max: 20, step: 0.5, note: 'added to the measured canopy height, after the scale' },
  // Thinning only. The viewer picks trees out of canopy cells, so there is nothing to add trees
  // from above 1 — a density of 2 would need cells the lidar never measured.
  { key: 'tree_density', label: 'trees ×', min: 0, max: 1, step: 0.05, note: 'thins the trees by a stable position hash. Thinning only: above 1 there are no canopy cells to grow from' },
  { key: 'grass_height', label: 'grass height ×', min: 0, max: 3, step: 0.05, note: 'scales the blade height in the grass ring' },
  { key: 'grass_density', label: 'grass density ×', min: 0, max: 3, step: 0.05, note: 'scales how many blades the grass ring puts down' },
  { key: 'ground_offset_m', label: 'ground +m', min: -10, max: 10, step: 0.25, note: 'raises or lowers the corridor strip off the pavement; it fades in from the pavement edge so the road itself never moves' },
]

const base = new URLSearchParams(location.search).get('data') ?? ''
/** Saving writes through the dev middleware; a remote ?data= bucket is read-only. */
export const CAN_SAVE = base === ''

async function load<T>(path: string, empty: T): Promise<T> {
  const r = await fetch(`${base}${path}`, { cache: 'no-cache' })
  if (r.status === 404) return empty // never authored yet — that is not an error
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  // A file that does not exist yet does NOT come back as a 404 in dev: the bake middleware calls
  // next(), Vite's SPA fallback answers with index.html, and `r.json()` dies on a tag. Sniff the
  // body. A body that opens with `{` and still fails to parse is a real file we have corrupted,
  // and that must throw — returning `empty` there would silently overwrite the human's edits on
  // the next save.
  const text = (await r.text()).trimStart()
  if (!text.startsWith('{')) return empty
  return JSON.parse(text) as T
}

async function save(path: string, body: unknown): Promise<number> {
  if (!CAN_SAVE) throw new Error('read-only: this viewer is pointed at a published bucket')
  const r = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, null, 1) })
  const j = (await r.json()) as { ok: boolean; bytes?: number; error?: string }
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j.bytes ?? 0
}

export const loadAdjustments = (slug: string) => load<Adjustments>(`/sites/${slug}/adjustments.json`, { version: 1, areas: [] })
export const saveAdjustments = (slug: string, doc: Adjustments) => save(`/sites/${slug}/adjustments.json`, doc)
export const loadPlacements = (slug: string) => load<Placements>(`/sites/${slug}/placements.json`, { version: 1, items: [] })
export const savePlacements = (slug: string, doc: Placements) => save(`/sites/${slug}/placements.json`, doc)

/** Lowest free `a-NN` / `p-NN`, so hand-drawn ids never collide with the generated ones. */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let i = 1; i < 1000; i++) {
    const id = `${prefix}-${String(i).padStart(2, '0')}`
    if (!used.has(id)) return id
  }
  return `${prefix}-${Date.now()}`
}

/** Even-odd point-in-polygon in the site frame; picking an area under the cursor. */
export function inside(poly: [number, number][], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** Shoelace area, m² — the panel shows it so a stray click is obvious. */
export function areaOf(poly: [number, number][]): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
  return Math.abs(a) / 2
}
