// Autogen: the rules from tools/corridor/AUTOGEN.md, over the bake's `buildings`/`landuse`/`pois`.
//
// The bake measures the corridor; it does not know what anything IS. 2887 of the 3413 footprints
// across the nine sites are tagged `building=yes` and nothing else, so the category has to be
// inferred from shape, height and context rather than read. That inference is what lives here.
//
// It runs in the BROWSER, not the pipeline, and deliberately. The loop this has to serve is
// "generate, look at it, fix the six it got wrong, generate again" — and a loop with a shell
// round trip and a re-bake in it is a loop nobody runs twice. Everything it needs is already in
// `web/manifest.json`; the three quantities that genuinely need the GIS stack (the minimum
// rotated rectangle, the lidar height, the corridor position) are precomputed there by
// `tools/corridor/corridor/buildings.py`.
//
// Output is `placements.json` items with a `g-` id derived from the SOURCE BUILDING INDEX, so a
// regeneration lands on the same ids and the human's overrides survive. See `grow.ts` for the
// override bookkeeping.
import type { Manifest } from '../site'
import type { CatalogEntry } from './catalog'
import type { Placement } from './schema'
import { bearingOf, normDeg, yawForLongAxis } from './corridor'
import type { Site } from '../scene'
import * as THREE from 'three'

export interface Building {
  ring: [number, number][]
  area_m2: number
  rect: { w: number; d: number; yaw_deg: number }
  height_m: number
  height_src: string
  s: number
  lat: number
  tags: Record<string, string>
}

export interface Landuse {
  class: string
  ring: [number, number][]
  area_m2: number
}

export interface Poi {
  x: number
  y: number
  s: number
  lat: number
  kind: string
  name: string | null
  building: number | null
}

export type Zone = 'commercial' | 'residential' | 'industrial' | 'farm' | 'civic' | 'open' | 'rural'

export interface Params {
  /** skip footprints this far or further from the centreline; the bake only reaches 300 m */
  max_lat_m: number
  /** never put anything within this of a pavement edge */
  keepout_m: number
  /** below this the footprint is map noise, not a building */
  min_area_m2: number
  /** how far a catalog asset may be stretched to fit a footprint before it is the wrong object */
  scale_min: number
  scale_max: number
  /** invent frontage where the corridor is bare (AUTOGEN.md R5) */
  invent: boolean
  invent_spacing_m: number
  /** every slot is taken within this of an INTERCHANGE; nothing at all past `invent_falloff_m` */
  invent_near_m: number
  invent_falloff_m: number
  /** how often a rural slot is taken at all. Commercial frontage packs out; a farm road does
   *  not, and without this the first version put 56 buildings down a forested mountain
   *  interstate because every slot within 400 m of a farm track scored a certainty. */
  invent_rural_chance: number
  seed: number
}

export const DEFAULTS: Params = {
  max_lat_m: 260,
  keepout_m: 10,
  min_area_m2: 25,
  scale_min: 0.7,
  scale_max: 1.4,
  invent: false,
  invent_spacing_m: 70,
  invent_near_m: 400,
  invent_falloff_m: 1500,
  invent_rural_chance: 0.15,
  seed: 1,
}

/** R1: what an OSM landuse value means to us. */
const LANDUSE_ZONE: Record<string, Zone> = {
  retail: 'commercial', commercial: 'commercial',
  residential: 'residential',
  industrial: 'industrial', construction: 'industrial', quarry: 'industrial',
  farmland: 'farm', farmyard: 'farm', meadow: 'farm', orchard: 'farm', allotments: 'farm',
  forest: 'open', grass: 'open', recreation_ground: 'open', village_green: 'open',
  religious: 'civic', cemetery: 'civic', education: 'civic',
}

/**
 * R2 read directly off a tag, where there is one. This is the half of the classification that is
 * not guesswork, and it is worth checking first: `shop=supermarket` inside a 5000 m² footprint
 * settles the category outright, and no amount of shape reasoning beats it.
 */
const TAG_CATEGORY: Record<string, string> = {
  'amenity=restaurant': 'restaurant', 'amenity=fast_food': 'restaurant', 'amenity=cafe': 'restaurant',
  'amenity=fuel': 'gas_station', 'shop=fuel': 'gas_station',
  'amenity=place_of_worship': 'church', 'building=church': 'church', 'building=chapel': 'church',
  'amenity=school': 'school', 'building=school': 'school', 'amenity=college': 'school', 'amenity=kindergarten': 'school',
  'tourism=motel': 'hotel', 'tourism=hotel': 'hotel', 'building=hotel': 'hotel',
  'shop=supermarket': 'big_box', 'shop=department_store': 'big_box', 'shop=doityourself': 'big_box', 'shop=wholesale': 'big_box',
  'shop=storage_rental': 'warehouse', 'building=warehouse': 'warehouse', 'building=industrial': 'warehouse',
  'office=yes': 'office', 'building=office': 'office', 'building=commercial': 'office',
  'building=apartments': 'apartments', 'building=residential': 'apartments',
  'building=terrace': 'townhouse',
  'building=house': 'house', 'building=detached': 'house', 'building=bungalow': 'house',
  'building=barn': 'barn', 'building=farm_auxiliary': 'barn', 'building=stable': 'barn',
  'building=shed': 'shed', 'building=garage': 'shed', 'building=garages': 'shed', 'building=carport': 'shed',
  'man_made=water_tower': 'utility', 'building=water_tower': 'utility',
  'building=retail': 'retail_unit', 'shop=car': 'retail_unit', 'shop=car_repair': 'retail_unit',
}

/** The largest footprint a tag-derived category may sit on before shape takes over, m². */
const PLAUSIBLE_MAX: Record<string, number> = {
  shed: 150, house: 600, house_large: 1200, townhouse: 2500, apartments: 6000,
  restaurant: 1600, gas_station: 1500, retail_unit: 3000, strip_mall: 20000,
  church: 3500, school: 25000, hotel: 8000, office: 20000,
  barn: 3000, warehouse: 40000, big_box: 40000, utility: 800,
}

const centroid = (ring: [number, number][]): [number, number] => {
  let x = 0, y = 0
  for (const [px, py] of ring) { x += px; y += py }
  return [x / ring.length, y / ring.length]
}

export function inside(ring: [number, number][], x: number, y: number): boolean {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** A stable, seedable hash: the same building gets the same coin flip across runs. */
function hash(seed: number, i: number): number {
  let h = (seed * 374761393 + i * 668265263) >>> 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// --- R1 zone ----------------------------------------------------------------------------------

export function zoneOf(b: Building, ctx: Ctx): Zone {
  const [cx, cy] = centroid(b.ring)
  for (const lu of ctx.landuse) {
    const z = LANDUSE_ZONE[lu.class]
    if (z && inside(lu.ring, cx, cy)) return z
  }
  // R1b: no zoning here, so derive one from what the neighbours look like
  const near: Building[] = []
  for (const o of ctx.buildings) {
    const [ox, oy] = o.centre
    if ((ox - cx) ** 2 + (oy - cy) ** 2 < 150 * 150) near.push(o.b)
  }
  if (!near.length) return 'open'
  const areas = near.map((n) => n.area_m2).sort((p, q) => p - q)
  const med = areas[areas.length >> 1]
  if (med > 1500) return 'commercial'
  if (near.length >= 6 && med >= 80 && med <= 400) return 'residential'
  if (Math.max(...areas) > 400) return 'commercial'
  return 'rural'
}

// --- R2 category ------------------------------------------------------------------------------

/**
 * Shape, height and zone, in that order of evidence — but only after the tags have had their say.
 * Thresholds are cut against the measured footprint deciles over the nine baked sites
 * (13 / 50 / 99 / 149 / 171 / 186 / 207 / 238 / 405 m²), not guessed.
 */
export function categoryOf(b: Building, zone: Zone, poiKind: string | null): string {
  for (const k of [poiKind, ...Object.entries(b.tags ?? {}).map(([a, v]) => `${a}=${v}`)]) {
    const t = k ? TAG_CATEGORY[k] : undefined
    // A POI is a point, and OSM hangs it on whatever polygon contains it — so "Big Papi's Tacos"
    // is tagged on the 5324 m² shopping centre it is a unit inside, and the tag would make the
    // whole centre a taco stand. A tag only wins while the footprint is a plausible size for it.
    if (t && b.area_m2 <= (PLAUSIBLE_MAX[t] ?? Infinity)) return t
  }
  const A = b.area_m2
  const H = b.height_m
  const E = b.rect.d > 0.01 ? b.rect.w / b.rect.d : 1
  if (A < 40) return 'shed'
  if (A < 300) return H >= 11 && E < 2.5 ? 'apartments' : E >= 3.2 ? 'townhouse' : 'house'
  if (A < 800) {
    if (zone === 'residential') return E >= 3.2 ? 'townhouse' : 'house_large'
    if (zone === 'farm' || zone === 'rural') return 'barn'
    if (zone === 'commercial') return A < 450 ? 'restaurant' : 'retail_unit'
    return H >= 11 ? 'apartments' : 'house_large'
  }
  if (A < 4000) {
    if (E >= 3) return 'strip_mall'
    if (zone === 'farm') return 'barn'
    if (H >= 11) return zone === 'residential' ? 'apartments' : 'office'
    return zone === 'industrial' ? 'warehouse' : 'retail_unit'
  }
  // Ties break toward the LARGER thing: a misplaced big box reads as a plausible mistake, a house
  // on a six-thousand-square-metre pad does not.
  return zone === 'industrial' ? 'warehouse' : 'big_box'
}

// --- R3 asset ---------------------------------------------------------------------------------

export interface Fit {
  entry: CatalogEntry
  scale: number
  score: number
  /** how far the catalog entry had to be stretched past the clamp to cover the footprint */
  stretch: number
}

/**
 * What a category may be rendered as when the catalog has NOTHING of its own kind. Only reached
 * when the category is absent from the catalog entirely — not when it merely fits badly.
 */
const SUBSTITUTES: Record<string, string[]> = {
  shed: ['house'],
  house: ['house_large'],
  house_large: ['house'],
  townhouse: ['house_large', 'apartments'],
  apartments: ['office', 'hotel'],
  restaurant: ['retail_unit'],
  retail_unit: ['strip_mall', 'restaurant'],
  strip_mall: ['retail_unit', 'big_box'],
  big_box: ['strip_mall', 'warehouse'],
  warehouse: ['big_box', 'strip_mall'],
  office: ['apartments', 'retail_unit'],
  school: ['office', 'big_box'],
  church: ['office'],
  hotel: ['apartments', 'strip_mall'],
  gas_station: ['retail_unit'],
  barn: ['warehouse', 'shed'],
  utility: [],
  sign: [],
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/**
 * Pick the catalog entry to stand on this footprint.
 *
 * IDENTITY BEATS SIZE, and that is a correction to the first version of this function, which
 * scored every entry on shape with a small penalty for the wrong category. Scored that way, a
 * well-proportioned wrong thing beats a badly-proportioned right thing, and the measured result
 * was a water tower on a 156 m² apartment block, a gas station on Dutch's Daughter Restaurant,
 * and a concrete bridge span on a Public Storage unit. A restaurant rendered twenty per cent
 * small is a far smaller lie than a gas station rendered exactly right.
 *
 * So: candidates are the entries of the category itself; substitutes are consulted only when the
 * catalog has none at all. Within the category, shape decides, and `scale` is CLAMPED rather than
 * used to reject — `stretch` records what the clamp cost so the panel can say the catalog needs
 * another size rather than silently shrugging.
 *
 * Entries marked `fit: "span"` — the bridge assets, which structures mode stretches between two
 * abutments — are excluded outright. They are fitted to a gap, not to a footprint, and one did
 * get picked for a Public Storage unit before this filter existed.
 */
export function fitAsset(b: Building, category: string, catalog: CatalogEntry[], p: Params): Fit | null {
  const A = b.area_m2
  const E = b.rect.d > 0.01 ? b.rect.w / b.rect.d : 1
  const usable = catalog.filter((e) => e.fit !== 'span')
  const pick = (cats: string[]): Fit | null => {
    let best: Fit | null = null
    for (const e of usable) {
      if (!cats.includes(e.category)) continue
      const ea = e.footprint_m[0] * e.footprint_m[1]
      const ee = e.footprint_m[1] > 0.01 ? e.footprint_m[0] / e.footprint_m[1] : 1
      const raw = Math.sqrt(A / ea)
      const scale = clamp(raw, p.scale_min, p.scale_max)
      const stretch = Math.abs(Math.log(raw / scale))
      const score = Math.abs(Math.log(ee / E)) + 0.5 * Math.abs(Math.log(Math.max(1, e.height_m) / Math.max(1, b.height_m))) + 3 * stretch
      if (!best || score < best.score) best = { entry: e, scale: Math.round(scale * 100) / 100, score, stretch }
    }
    return best
  }
  return pick([category]) ?? pick(SUBSTITUTES[category] ?? []) ?? null
}

// --- context ----------------------------------------------------------------------------------

export interface Ctx {
  buildings: { b: Building; centre: [number, number] }[]
  landuse: Landuse[]
  poiFor: Map<number, string>
  site: Site
}

export function contextOf(manifest: Manifest, site: Site): Ctx {
  const buildings = ((manifest as unknown as { buildings?: Building[] }).buildings ?? []).map((b) => ({ b, centre: centroid(b.ring) }))
  const landuse = (manifest as unknown as { landuse?: Landuse[] }).landuse ?? []
  const poiFor = new Map<number, string>()
  for (const p of (manifest as unknown as { pois?: Poi[] }).pois ?? []) {
    if (p.building != null && !poiFor.has(p.building)) poiFor.set(p.building, p.kind)
  }
  return { buildings, landuse, poiFor, site }
}

export interface Result {
  items: Placement[]
  /** why each building was not placed, for the panel's honesty column */
  skipped: Record<string, number>
  byCategory: Record<string, number>
}

// --- the pass ---------------------------------------------------------------------------------

export function generate(manifest: Manifest, site: Site, catalog: CatalogEntry[], params: Params): Result {
  const ctx = contextOf(manifest, site)
  const p = params
  const skipped: Record<string, number> = {}
  const byCategory: Record<string, number> = {}
  const drop = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1 }
  const items: Placement[] = []
  // R7: biggest first, and nothing may overlap something already standing
  const taken: { x: number; y: number; r: number }[] = []
  const free = (x: number, y: number, r: number) => {
    for (const t of taken) if ((t.x - x) ** 2 + (t.y - y) ** 2 < (t.r + r) ** 2) return false
    return true
  }

  const order = ctx.buildings.map((_, i) => i).sort((a, c) => ctx.buildings[c].b.area_m2 - ctx.buildings[a].b.area_m2)
  for (const i of order) {
    const { b, centre } = ctx.buildings[i]
    const [cx, cy] = centre
    if (b.area_m2 < p.min_area_m2) { drop('too small'); continue }
    if (Math.abs(b.lat) > p.max_lat_m) { drop('outside the corridor'); continue }
    // Never on the road. `edgeDistance` is signed and in the WORLD frame (x, z).
    if (site.edgeDistance(cx, -cy) < p.keepout_m) { drop('on or beside the pavement'); continue }
    const zone = zoneOf(b, ctx)
    const category = categoryOf(b, zone, ctx.poiFor.get(i) ?? null)
    const fit = fitAsset(b, category, catalog, p)
    if (!fit) { drop('no catalog asset fits'); continue }
    const r = (Math.max(...fit.entry.footprint_m) * fit.scale) / 2
    if (!free(cx, cy, r * 0.6)) { drop('overlaps something bigger'); continue }
    taken.push({ x: cx, y: cy, r: r * 0.6 })
    items.push({
      id: `g-${i}`,
      asset: fit.entry.id,
      x: Math.round(cx * 10) / 10,
      y: Math.round(cy * 10) / 10,
      z: null,
      // R4: the footprint's own long axis, not the road normal — it is right on a corner lot and
      // right on a cul-de-sac, and the bake measured it. See `yawForLongAxis` for why the sign
      // flips: rect.yaw_deg is a math angle from east, a placement's yaw is a compass bearing.
      yaw_deg: Math.round(yawForLongAxis(b.rect.yaw_deg)),
      scale: fit.scale,
      snap: 'ground',
      tags: [
        category,
        zone,
        `src:${b.height_src}`,
        ...(fit.entry.category !== category ? [`as:${fit.entry.category}`] : []),
        // the catalog had nothing near this size and the scale hit the clamp — a note about the
        // catalog, not about the site
        ...(fit.stretch > 0.05 ? ['stretched'] : []),
      ],
    })
    byCategory[category] = (byCategory[category] ?? 0) + 1
  }

  if (p.invent) inventFrontage(manifest, site, catalog, p, items, taken, free, byCategory)
  items.sort((a, c) => a.id.localeCompare(c.id, 'en', { numeric: true }))
  return { items, skipped, byCategory }
}

// --- R5 invented frontage ----------------------------------------------------------------------

/** The mixes a bare stretch of frontage gets, by what kind of junction is near it. */
const STRIP_MIX = ['gas_station', 'restaurant', 'restaurant', 'retail_unit', 'retail_unit', 'retail_unit', 'retail_unit', 'strip_mall', 'hotel']
const RURAL_MIX = ['house', 'house', 'house', 'house_large', 'barn', 'barn', 'church', 'shed']

/**
 * Which crossings are somewhere people can actually stop.
 *
 * MEASURED, and it is the difference between an invented town and an invented mess. R5 counted
 * every entry in `crossings`, and on the two sites that need invention most that is wrong:
 * sideling-i68's nine "junctions" are four farm tracks, four service roads and one tertiary, and
 * south-mountain-i70's six include TWO STREAMS AND A POWER LINE. Seeding a gas station at a
 * culvert is a good way to make an invented town look invented. So an interchange earns commerce,
 * a minor road earns a farmhouse, and a waterway or a power line earns nothing.
 */
const INTERCHANGE = /^(motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$/
const MINOR = /^(tertiary|tertiary_link|unclassified|residential|service|track|living_street)$/

/**
 * Walk both verges and fill the gaps. Commercial only within reach of an interchange; a farmhouse
 * within reach of any road junction; nothing at all beyond the falloff — which on a forested
 * mountain interstate means nothing at all, and that is the right answer for Sideling Hill.
 */
function inventFrontage(
  manifest: Manifest,
  site: Site,
  catalog: CatalogEntry[],
  p: Params,
  items: Placement[],
  taken: { x: number; y: number; r: number }[],
  free: (x: number, y: number, r: number) => boolean,
  byCategory: Record<string, number>,
) {
  const interchanges: number[] = []
  const minors: number[] = []
  for (const c of manifest.crossings) {
    if (c.relation === 'grade') continue
    const k = c.kind ?? ''
    if (INTERCHANGE.test(k)) interchanges.push(c.s)
    else if (MINOR.test(k)) minors.push(c.s)
  }
  const nearest = (list: number[], s: number) => list.reduce((m, j) => Math.min(m, Math.abs(j - s)), Infinity)
  const len = manifest.spine.length_m
  const left = new THREE.Vector3()
  let n = 0
  for (const sideSign of [1, -1]) {
    let s = p.invent_spacing_m
    while (s < len - p.invent_spacing_m) {
      const dI = nearest(interchanges, s)
      const dM = Math.min(dI, nearest(minors, s))
      const commercial = dI <= p.invent_near_m
      // rural frontage is sparser than a commercial strip, and thins with distance from anything
      // A commercial slot near an interchange is taken every time — that is what a strip IS.
      // A rural slot is taken `invent_rural_chance` of the time, thinning to nothing at the
      // falloff. Without the separate rate, a site whose junctions are 500 m apart has every
      // slot inside `invent_near_m` and builds a continuous ribbon of farmhouses.
      const fade = dM >= p.invent_falloff_m ? 0 : dM <= p.invent_near_m ? 1 : 1 - (dM - p.invent_near_m) / (p.invent_falloff_m - p.invent_near_m)
      const chance = commercial ? 1 : p.invent_rural_chance * fade
      const rnd = hash(p.seed, n * 7919 + (sideSign > 0 ? 0 : 1))
      s += p.invent_spacing_m * (commercial ? 1 : 2.2) * (0.6 + hash(p.seed + 5, n) * 0.8)
      n++
      if (chance <= 0 || rnd > chance) continue
      const mix = commercial ? STRIP_MIX : RURAL_MIX
      const category = mix[Math.floor(hash(p.seed + 11, n) * mix.length)]
      const entry = catalog.filter((e) => e.category === category && e.fit !== 'span')[0]
      if (!entry) continue
      // setback from the PAVEMENT EDGE, deeper for commerce because the parking goes in front
      const setback = (commercial ? 30 : 18) + hash(p.seed + 17, n) * 25
      const at = site.spineAt(s)
      left.set(at.dir.z, 0, -at.dir.x).normalize()
      const half = Math.max(8, -site.edgeDistance(at.pos.x, at.pos.z) + 4)
      const lat = sideSign * (half + setback + Math.max(...entry.footprint_m) / 2)
      const x = at.pos.x + left.x * lat
      const wz = at.pos.z + left.z * lat
      const y = -wz
      if (Math.abs(lat) > p.max_lat_m) continue
      if (site.edgeDistance(x, wz) < p.keepout_m) continue
      const r = Math.max(...entry.footprint_m) / 2
      if (!free(x, y, r * 0.8)) continue
      taken.push({ x, y, r: r * 0.8 })
      // face the road: the inward normal, as a compass bearing
      const face = left.clone().multiplyScalar(-sideSign)
      items.push({
        id: `g-inv-${sideSign > 0 ? 'l' : 'r'}-${Math.round(s)}`,
        asset: entry.id,
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        z: null,
        yaw_deg: Math.round(normDeg(bearingOf(face))),
        scale: 1,
        snap: 'ground',
        tags: [category, commercial ? 'strip' : 'hamlet', 'invented'],
      })
      byCategory[category] = (byCategory[category] ?? 0) + 1
    }
  }
}
