// The three authored files, and how they get to and from disk.
//
// All live BESIDE the bake (tools/corridor/data/sites/<slug>/{adjustments,placements,structures}
// .json), not inside web/ — the bake owns web/ and would overwrite them. In dev the Vite
// middleware serves them at /sites/<slug>/*.json and accepts a PUT back to the same path; that is
// the only writable path in the app. `python -m corridor areas` writes adjustments.json too,
// seeding the areas this editor then tunes, so the two must agree on the shape exactly.

import type { Manifest } from '../site'

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
  /** how much paint: none / centre line only / centre + edge + lane lines. null = as inferred */
  markings: string | null
  /** which centre line. OSM has no `overtaking` tag on any baked site, so a passing zone cannot
   *  come from the data — it is authored here or inferred from sight distance by road-and-car. */
  centre_line: string | null
  /** what grows on the ground inside this polygon, where it is not simply verge */
  cover: string | null
  /** with `cover: 'crop'`, which crop */
  crop: string | null
  /** row direction as a compass bearing, and the gap between rows. Only read when cover=crop, so
   *  0 is a safe neutral rather than a sentinel. */
  row_heading_deg: number
  row_spacing_m: number
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

/**
 * Which frame a file's coordinates are in.
 *
 * On 2026-09-22 the corridor moved from UTM-relative metres to true ENU. Every authored polygon
 * stayed where it was written and the world rotated by the grid convergence underneath it — a
 * median of 40 m off the road each band was drawn around, up to 439 m, with nothing erroring,
 * nothing logging, and every polygon still drawing a perfectly plausible shape. A file of
 * coordinates must say which frame it is in.
 */
export interface FrameStamp {
  kind?: string
  epsg?: number
  anchor?: { lon: number; lat: number; h?: number }
}

/** Non-null when a file was authored in a different frame from the one the bake now serves. */
export function frameMismatch(stamp: FrameStamp | undefined, manifest: Manifest): string | null {
  const now = (manifest as unknown as { frame?: FrameStamp }).frame ?? {}
  if (!stamp || (!stamp.kind && !stamp.anchor)) {
    // written before stamping existed: it cannot be shown to match, so say so rather than assume
    return `authored before frames were stamped; the bake is "${now.kind ?? 'utm'}". If these were drawn before 2026-09-22 they are in the old UTM-relative metres and will sit off the road.`
  }
  if (stamp.kind && now.kind && stamp.kind !== now.kind) return `authored in "${stamp.kind}" but the bake is now "${now.kind}"`
  const a = stamp.anchor, b = now.anchor
  if (a && b && (Math.abs(a.lon - b.lon) > 1e-6 || Math.abs(a.lat - b.lat) > 1e-6)) {
    return `authored about a different anchor (${a.lat.toFixed(5)}, ${a.lon.toFixed(5)} vs ${b.lat.toFixed(5)}, ${b.lon.toFixed(5)})`
  }
  return null
}

export interface Adjustments {
  version: 1
  frame?: FrameStamp
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
  /**
   * Set on a generated (`g-`) item the moment a human touches it. Regeneration then leaves it
   * alone. This is the whole override story: you are never editing a file that is about to be
   * rewritten out from under you, and you never have to remember which ones you fixed.
   * Absent on hand-placed items, which are never regenerated anyway.
   */
  locked?: boolean
}

/** What autogen remembers between runs. The viewer ignores it; only `items` is rendered. */
export interface AutogenState {
  params: Record<string, number | boolean>
  /** generated ids the human deleted — regeneration must not bring them back */
  deleted: string[]
  ran?: string
}

export interface Placements {
  version: 1
  frame?: FrameStamp
  items: Placement[]
  autogen?: AutogenState
}

/** A generated item, as opposed to one a human placed by hand. */
export const isGenerated = (p: Placement) => p.id.startsWith('g-')

/**
 * What a human says the road does where the lidar could not tell. Intervals are ALONG-TRACK
 * metres on the site's spine (`manifest.spine`, `site.spineAt(s)`), never x/y: a re-bake that
 * moves the centreline sideways keeps the bridge over the road.
 *
 *   flatten      the grade between the two ends is a straight line (the viewer applies it to the
 *                spline before anything is built, so the strip, car and paint follow)
 *   suppress     detected structures (profile.json) inside the interval are ignored
 *   bridge_over  `asset` centred at mid-interval, long axis ACROSS the road (+ yaw_offset_deg),
 *                scaled so its long axis = span_m, underside at road + clearance_m, abutments on
 *                the ground
 *
 * The four bridge keys are present only on `bridge_over`. The viewer (src/structures.ts, the
 * main agent's) consumes this key set — nothing may be added without telling them.
 */
export type StructureKind = 'bridge_over' | 'flatten' | 'suppress'

export interface StructureItem {
  id: string
  name: string
  kind: StructureKind
  s_start: number
  s_end: number
  clearance_m?: number
  asset?: string
  span_m?: number
  yaw_offset_deg?: number
}

export interface Structures {
  version: 1
  items: StructureItem[]
}

export const STRUCTURE_KINDS: { kind: StructureKind; label: string; note: string }[] = [
  { kind: 'bridge_over', label: 'bridge over', note: 'a catalog bridge spans the road at the middle of the interval; the interval length is the bridge depth along the road' },
  { kind: 'flatten', label: 'flatten', note: 'the road grade between the two ends becomes a straight line — for lidar noise under a bridge or a junk-classified flight' },
  { kind: 'suppress', label: 'suppress', note: 'structures the profile detected inside the interval are ignored — for a canopy or a gantry that read as a bridge' },
]

export const NEUTRAL: Adjust = {
  canopy_scale: 1,
  canopy_offset_m: 0,
  tree_density: 1,
  grass_height: 1,
  grass_density: 1,
  ground_offset_m: 0,
  surface_class: null,
  species: null,
  markings: null,
  centre_line: null,
  cover: null,
  crop: null,
  row_heading_deg: 0,
  row_spacing_m: 0.76,
}

/** The texture sets tools/surfaces/gen.py bakes; `null` means "whatever the classifier said". */
export const SURFACE_CLASSES = ['asphalt_new', 'asphalt_aged', 'asphalt_patched', 'chipseal', 'concrete', 'shoulder_gravel']

/** What trees.ts can actually grow; `null` means "pick by height as usual". */
export const SPECIES = ['oak', 'ash', 'aspen', 'pine']

/**
 * The dropdown vocabularies, and who consumes each one. A `null` selection always means "as the
 * bake inferred it", which is why every one of these is optional rather than defaulted.
 */
export const PICKERS: { key: keyof Adjust; label: string; options: string[]; note: string }[] = [
  { key: 'surface_class', label: 'surface', options: SURFACE_CLASSES, note: 'overrides the measured pavement class — freshly paved is asphalt_new' },
  { key: 'markings', label: 'markings', options: ['none', 'class', 'full'], note: 'how much paint: none, the centre line only, or centre + edge + lane lines. Site default is the ROAD_MARKINGS knob' },
  { key: 'centre_line', label: 'centre line', options: ['dashed', 'solid', 'solid_left', 'solid_right'], note: 'where overtaking is allowed. No baked site has an OSM `overtaking` tag, so this cannot come from the data' },
  { key: 'species', label: 'species', options: SPECIES, note: 'which tree the near field grows here' },
  { key: 'cover', label: 'ground cover', options: ['crop', 'pasture', 'orchard', 'scrub', 'bare'], note: 'what grows inside the polygon where it is not roadside verge' },
  { key: 'crop', label: 'crop', options: ['corn', 'soy', 'wheat', 'hay', 'fallow'], note: 'only read when ground cover is crop' },
]

/** Shown only when `cover === 'crop'`: the rows themselves. */
export const CROP_FIELDS: { key: keyof Adjust; label: string; step: number; note: string }[] = [
  { key: 'row_heading_deg', label: 'row heading°', step: 1, note: 'compass bearing the rows run along; defaults to the road at this polygon when you pick a crop' },
  { key: 'row_spacing_m', label: 'row spacing m', step: 0.02, note: 'gap between rows; 0.76 m is a US corn row' },
]

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

/**
 * Areas written before a key existed do not have it, and `undefined` is not `NEUTRAL[key]`: the
 * crop-row default is "set it from the road when it is still 0", and an absent key is never 0, so
 * it silently never fired and the two row fields never reached the file. Fill every area's
 * `adjust` from NEUTRAL on the way in and the rest of the editor can assume a complete object.
 * The viewer reads `adjust` as a Partial and does not care either way.
 */
export async function loadAdjustments(slug: string): Promise<Adjustments> {
  const doc = await load<Adjustments>(`/sites/${slug}/adjustments.json`, { version: 1, areas: [] })
  for (const a of doc.areas) a.adjust = { ...NEUTRAL, ...a.adjust }
  return doc
}
export const saveAdjustments = (slug: string, doc: Adjustments) => save(`/sites/${slug}/adjustments.json`, doc)
export const loadPlacements = (slug: string) => load<Placements>(`/sites/${slug}/placements.json`, { version: 1, items: [] })
export const savePlacements = (slug: string, doc: Placements) => save(`/sites/${slug}/placements.json`, doc)
export const loadStructures = (slug: string) => load<Structures>(`/sites/${slug}/structures.json`, { version: 1, items: [] })
export const saveStructures = (slug: string, doc: Structures) => save(`/sites/${slug}/structures.json`, doc)

/** Lowest free `a-NN` / `p-NN` / `st-NN`, so hand-drawn ids never collide with the generated ones. */
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
