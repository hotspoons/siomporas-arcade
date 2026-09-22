// What grows here, read off the bake.
//
// `tools/corridor/corridor/flora.py` writes three things into the manifest and one image beside it:
//
//   evt       LANDFIRE Existing Vegetation Type, 30 m — the site's vegetation classes with their
//             AREA SHARE inside the corridor, each carrying its lifeform, physiognomy, the
//             evergreen/deciduous subclass, a derived ground-cover class, and a species mix
//   canopy    the site-wide species mix, and `ref`, the botany of every species named: genus,
//             scientific name, and FIA's softwood/hardwood flag
//   climate   Daymet monthly rain and temperature at 1 km
//   flora_30m.png   the EVT class INDEX per 30 m pixel (255 = outside the corridor), so a tree on
//             a canyon floor and a tree on the ridge above it can be different species
//
// Everything in here is a read of that. No region, state or species is named in this file: a
// corridor anywhere in the United States comes out of the same code, and the only thing that
// changes is the numbers LANDFIRE and FIA return for it.
import { decodeIndex, loadImage, type Layer, type Manifest } from './site'

export interface FloraSpecies {
  common: string
  scientific: string
  genus: string
  softwood: boolean
  spcd: number | null
  /** mean lidar canopy height over the pixels where this species carries basal area, metres.
   *  Measured in THIS corridor; null where the species came from the EVT class name instead. */
  canopy_h_m: number | null
}

export interface FloraClass {
  value: number
  name: string
  lifeform: string // Tree | Shrub | Herb | Sparse | Agriculture | Developed | Water
  physiognomy: string // Conifer | Hardwood | Shrubland | Grassland | ...
  canopy: string // Closed / Open / Sparse tree canopy, Herbaceous - grassland, ...
  subclass: string // "Evergreen closed tree canopy", "Annual Graminoid/Forb", ...
  leaf_cycle: 'evergreen' | 'deciduous' | 'mixed' | 'none'
  ground: GroundClass
  share: number
  rgb: [number, number, number]
  species?: { key: string; weight: number }[]
  species_from?: 'fhp' | 'evt_name' | 'none'
}

/** The ground-cover vocabulary flora.py derives from LANDFIRE's own lifeform/subclass fields. */
export type GroundClass =
  | 'mown'
  | 'perennial_grass'
  | 'annual_grass'
  | 'forb'
  | 'crop'
  | 'marsh'
  | 'evergreen_scrub'
  | 'deciduous_scrub'
  | 'mixed_scrub'
  | 'dwarf_heath'
  | 'conifer_duff'
  | 'hardwood_litter'
  | 'broadleaf_evergreen_litter'
  | 'mixed_litter'
  | 'dune'
  | 'ledge'
  | 'barren'
  | 'water'

export interface FloraBlock {
  evt: { source: string; service: string; credit: string; classes: FloraClass[] }
  canopy: {
    source: string
    coverage: number
    rasters_here: number
    rasters_with_data: number
    species: { key: string; weight: number }[]
    ref: Record<string, FloraSpecies>
  }
  ground: { classes: { key: GroundClass; weight: number }[]; vocabulary: GroundClass[] }
  climate: {
    source: string
    ppt_mm: number[]
    tmax_c: number[]
    tmin_c: number[]
    annual_mm: number
    summer_dry: number | null
    driest_month_mm: number
  }
  fetched: string
}

export interface SpeciesWeight {
  key: string
  weight: number
  species: FloraSpecies
}

/**
 * The site's flora with a spatial index over it.
 *
 * `at(x, y)` takes SITE metres (x east, y north — the same frame the CHM and the spine are in, NOT
 * world z) and returns the EVT class of that 30 m pixel. Everything spatial hangs off that: a
 * redwood is a redwood because the pixel it stands on is "California Coastal Redwood Forest", and
 * the chaparral fifty metres up the slope is a different class in the same corridor.
 */
export class Flora {
  readonly block: FloraBlock
  private grid: Uint8Array | null
  private layer: Layer | null
  /** class index -> class, plus the species mix resolved against `ref` once */
  readonly classes: FloraClass[]
  private mixes: SpeciesWeight[][]
  readonly siteMix: SpeciesWeight[]

  constructor(block: FloraBlock, grid: Uint8Array | null, layer: Layer | null) {
    this.block = block
    this.grid = grid
    this.layer = layer
    this.classes = block.evt.classes
    const ref = block.canopy.ref
    const resolve = (m: { key: string; weight: number }[] | undefined): SpeciesWeight[] =>
      (m ?? []).filter((s) => ref[s.key]).map((s) => ({ key: s.key, weight: s.weight, species: ref[s.key] }))
    this.mixes = this.classes.map((c) => resolve(c.species))
    this.siteMix = resolve(block.canopy.species)
  }

  /** The EVT class at a point in site metres, or null outside the corridor / with no grid. */
  at(x: number, y: number): FloraClass | null {
    if (!this.grid || !this.layer) return null
    const [xmin, ymin, xmax, ymax] = this.layer.bbox
    if (x < xmin || x >= xmax || y < ymin || y >= ymax) return null
    const [w, h] = this.layer.size
    const c = Math.floor(((x - xmin) / (xmax - xmin)) * w)
    const r = Math.floor(((ymax - y) / (ymax - ymin)) * h)
    const i = this.grid[r * w + c]
    return i === 255 || i >= this.classes.length ? null : this.classes[i]
  }

  /** The species mix at a point: the pixel's class where there is one, the whole site otherwise. */
  mixAt(x: number, y: number): SpeciesWeight[] {
    const c = this.at(x, y)
    if (c) {
      const m = this.mixes[this.classes.indexOf(c)]
      if (m && m.length) return m
    }
    return this.siteMix
  }

  /** Whether the stand at a point keeps its leaves: straight off LANDFIRE's EVT_SBCLS. */
  leafCycleAt(x: number, y: number): 'evergreen' | 'deciduous' | 'mixed' | 'none' {
    return this.at(x, y)?.leaf_cycle ?? 'mixed'
  }

  /**
   * Is the BROADLEAF component of the stand at a point evergreen?
   *
   * An evergreen stand is not the same thing as an evergreen broadleaf. "California Coastal Live
   * Oak Woodland" is Hardwood + Evergreen and its oaks hold their leaves; "Acadian Low-Elevation
   * Spruce-Fir Forest" is Conifer + Evergreen and its paper birch does not. Both halves of the test
   * are needed, and LANDFIRE files both halves.
   */
  broadleafEvergreenAt(x: number, y: number): boolean {
    const c = this.at(x, y)
    return !!c && c.leaf_cycle === 'evergreen' && c.physiognomy === 'Hardwood'
  }

  static isBroadleafEvergreen(c: FloraClass): boolean {
    return c.leaf_cycle === 'evergreen' && c.physiognomy === 'Hardwood'
  }

  groundAt(x: number, y: number): GroundClass | null {
    return this.at(x, y)?.ground ?? null
  }

  /** The commonest ground-cover class over the corridor, ignoring water and pavement. */
  get dominantGround(): GroundClass | null {
    const g = this.block.ground.classes.filter((c) => c.key !== 'water')
    return g.length ? g[0].key : null
  }

  /**
   * How cured the herbaceous cover is in a given month, 0 (green) … 1 (straw).
   *
   * THIS is the answer to "why is California brown". It is not soil and it is not a palette: it is
   * that the grass has had no water since April. The index is the rain the plant has had over the
   * preceding ~90 days measured against what a growing sward needs, so it falls out of Daymet
   * with nothing typed per region:
   *
   *   Bixby Bridge   Jun–Aug rain   2 mm  (0.2 % of the year) -> cured by May, green in February
   *   Chesterfield   Jun–Aug rain 419 mm  (32 % of the year)  -> never cures; olive all summer
   *   Acadia         Jun–Aug rain 299 mm  (22 % of the year)  -> never cures
   *
   * Cold cures it too — a January verge in Maine is straw because the grass is dormant, not dry —
   * so the index is the worse of the two.
   */
  curing(month: number): number {
    const p = this.block.climate?.ppt_mm
    const t = this.block.climate?.tmax_c
    if (!p || p.length !== 12) return 0
    // 90 days of rain ending this month; ~40 mm a month is roughly what keeps a cool-season sward
    // growing, and 10 mm is bare survival. Linear between the two.
    let rain = 0
    for (let k = 0; k < 3; k++) rain += p[(month - k + 12) % 12]
    const drought = Math.min(1, Math.max(0, (120 - rain) / 90))
    // dormancy: below ~8 °C daily maximum nothing is growing, above ~14 °C everything is
    const cold = t && t.length === 12 ? Math.min(1, Math.max(0, (14 - t[month]) / 6)) : 0
    return Math.max(drought, cold)
  }

  /** The month the viewer's four seasons stand for, for `curing`. */
  static SEASON_MONTH: Record<string, number> = { winter: 1, spring: 3, summer: 8, autumn: 10 }
}

/** Load the flora block and its class grid from a site manifest. Null when the bake has neither. */
export async function loadFlora(manifest: Manifest): Promise<Flora | null> {
  const block = manifest.flora
  if (!block) return null
  const layer = manifest.layers.flora ?? null
  let grid: Uint8Array | null = null
  if (layer) {
    try {
      grid = decodeIndex(await loadImage(`/sites/${manifest.slug}/web/${layer.file}`))
    } catch {
      grid = null // the class table alone still gives a site-wide mix
    }
  }
  return new Flora(block, grid, layer)
}
