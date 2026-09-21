// Adjustment areas: the human's corrections to what the data inferred, authored in the editor
// (apps/corridor/src/editor, the editor agent's) and consumed here.
//
// Composition where areas overlap: scales multiply, offsets add, and for the two categorical
// keys the SMALLEST polygon wins — which is also the one the editor selects on a click.
// Point-in-polygon is even-odd (winding not guaranteed). Areas are few and long, so every query
// goes through a bbox test first; callers that ask per tree or per grass blade should still cache.
import { DATA_BASE } from './site'

export interface Adjust {
  canopy_scale: number
  canopy_offset_m: number
  tree_density: number
  grass_height: number
  grass_density: number
  ground_offset_m: number
  surface_class: string | null
  species: string | null
  // --- authored by the editor (editor-knobs, 900), consumed here ------------------------------
  /** how much paint this stretch carries (road-and-car) */
  markings: string | null
  /** the centre line's kind over this stretch (road-and-car) */
  centre_line: string | null
  /** what covers this ground when the bake's guess is wrong (world-look) */
  cover: string | null
  /** which crop, when `cover` is 'crop' */
  crop: string | null
  /** compass bearing the crop rows run along; only read when cover === 'crop', so 0 is neutral */
  row_heading_deg: number
  /** metres between crop rows; 0 = the crop's own default */
  row_spacing_m: number
}

export interface Area {
  id: string
  name: string
  source?: string
  polygon: [number, number][]
  adjust: Partial<Adjust>
}

export const NEUTRAL: Adjust = { canopy_scale: 1, canopy_offset_m: 0, tree_density: 1, grass_height: 1, grass_density: 1, ground_offset_m: 0, surface_class: null, species: null, markings: null, centre_line: null, cover: null, crop: null, row_heading_deg: 0, row_spacing_m: 0 }

interface Prepared {
  area: Area
  bbox: [number, number, number, number]
  size: number
}

export class Adjustments {
  private areas: Prepared[] = []
  get count() {
    return this.areas.length
  }

  static async load(slug: string): Promise<Adjustments> {
    const a = new Adjustments()
    try {
      const r = await fetch(`${DATA_BASE}/sites/${slug}/adjustments.json`, { cache: 'no-cache' })
      if (r.ok) a.set((await r.json()).areas ?? [])
    } catch {
      /* no adjustments is the normal case */
    }
    return a
  }

  set(areas: Area[]) {
    this.areas = areas
      .filter((ar) => Array.isArray(ar.polygon) && ar.polygon.length >= 3)
      .map((ar) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const [x, y] of ar.polygon) {
          if (x < x0) x0 = x
          if (y < y0) y0 = y
          if (x > x1) x1 = x
          if (y > y1) y1 = y
        }
        return { area: ar, bbox: [x0, y0, x1, y1] as [number, number, number, number], size: areaOf(ar.polygon) }
      })
  }

  /** the authored areas themselves: crops and covers are read per POLYGON, not per point */
  get list(): readonly Area[] {
    return this.areas.map((p) => p.area)
  }

  /** True when any area with a non-neutral adjustment exists — callers can skip work otherwise. */
  get active(): boolean {
    return this.areas.some((p) => Object.entries(p.area.adjust ?? {}).some(([k, v]) => v !== null && v !== (NEUTRAL as unknown as Record<string, unknown>)[k]))
  }

  /** Composite adjustment at a site-frame point (x east, y north). */
  at(x: number, y: number, out: Adjust = { ...NEUTRAL }): Adjust {
    Object.assign(out, NEUTRAL)
    // every categorical key is smallest-polygon-wins, and so are the crop row FIELD ATTRIBUTES:
    // a heading and a row spacing describe a field, they are not corrections, so overlapping
    // areas must not multiply or sum them (editor-knobs, 900)
    let bestSurface = Infinity, bestSpecies = Infinity, bestMark = Infinity, bestLine = Infinity
    let bestCover = Infinity, bestCrop = Infinity, bestHeading = Infinity, bestSpacing = Infinity
    for (const p of this.areas) {
      const b = p.bbox
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue
      if (!inside(p.area.polygon, x, y)) continue
      const a = p.area.adjust ?? {}
      out.canopy_scale *= a.canopy_scale ?? 1
      out.canopy_offset_m += a.canopy_offset_m ?? 0
      out.tree_density *= a.tree_density ?? 1
      out.grass_height *= a.grass_height ?? 1
      out.grass_density *= a.grass_density ?? 1
      out.ground_offset_m += a.ground_offset_m ?? 0
      if (a.surface_class && p.size < bestSurface) { bestSurface = p.size; out.surface_class = a.surface_class }
      if (a.species && p.size < bestSpecies) { bestSpecies = p.size; out.species = a.species }
      if (a.markings && p.size < bestMark) { bestMark = p.size; out.markings = a.markings }
      if (a.centre_line && p.size < bestLine) { bestLine = p.size; out.centre_line = a.centre_line }
      if (a.cover && p.size < bestCover) { bestCover = p.size; out.cover = a.cover }
      if (a.crop && p.size < bestCrop) { bestCrop = p.size; out.crop = a.crop }
      if (a.row_heading_deg != null && p.size < bestHeading) { bestHeading = p.size; out.row_heading_deg = a.row_heading_deg }
      if (a.row_spacing_m != null && p.size < bestSpacing) { bestSpacing = p.size; out.row_spacing_m = a.row_spacing_m }
    }
    return out
  }
}

/** Even-odd point in polygon. */
export function inside(poly: [number, number][], x: number, y: number): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

export function areaOf(poly: [number, number][]): number {
  let s = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
  return Math.abs(s) / 2
}
