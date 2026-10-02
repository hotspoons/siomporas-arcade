// Zones: a bounded piece of the world with GAMEPLAY attached, as distinct from a correction to it.
//
// Rich, 2026-09-29: *"we need to add our traffic system as something you can place on levels … we
// can use the bounding box we use for things like canopy or rendering overrides to also draw the
// box on the road, then apply a traffic color. Each area should be able to have a swing too, so
// either always jammed up, or a min and a max and random."* And: *"first we need a bounds."*
//
// WHY THIS IS NOT `adjust.ts`. That file already carries drawn polygons and it would be a small
// change to add a density field to `Adjust` — and it would be wrong. An adjustment is a statement
// that THE BAKE GOT IT WRONG: the canopy here is too tall, this surface is gravel not tarmac. It is
// authored once against a place and it is true for every game played there. A traffic zone is the
// opposite: it is a statement about a GAME, it changes between levels on the same roads, and a
// rally stage and a delivery game want different answers in the same field. Merging them means a
// level cannot have its own traffic without editing the world's corrections, and a re-bake that
// fixes the canopy quietly ships somebody's rush hour.
//
// So: the same GEOMETRY, deliberately — a polygon in the site frame, the same point-in-polygon and
// the same bbox-first query, imported from `polygon.ts` rather than written again — and a separate
// document with its own lifetime.
//
// WHAT A DENSITY MEANS. It is not a spawn probability. It is VEHICLES PER KILOMETRE PER LANE, which
// is the quantity traffic engineering actually measures and the one the Intelligent Driver Model in
// `traffic.ts` turns into behaviour. Free flow on a rural road is about six cars per kilometre per
// lane; a jam is bumper to bumper at a jam gap plus a car length, which is about 130. Nobody writes
// a queue: you place that many cars and IDM produces the queue, the shock wave and the discharge on
// green by itself. That is the whole reason to express it this way.

import { areaOf, inside } from '../../world/polygon'

/* ---- the document ------------------------------------------------------------------------------ */

/** What a zone does. One for now; gates and objectives are their own shapes, not another kind here. */
export const ZONE_KINDS = ['traffic'] as const
export type ZoneKind = (typeof ZONE_KINDS)[number]

/**
 * How busy, and how much that varies.
 *
 * `density` is the floor and `densityMax` the ceiling. Left out, the zone is always exactly
 * `density` — Rich's *"always jammed up"*. Set, the level rolls once between them when it loads:
 * the same seed gives the same roll, so a stage is reproducible, and a different seed gives a
 * different rush hour on the same roads.
 */
export interface TrafficZone {
  /** 0…1, where 0 is an empty road and 1 is stationary */
  density: number
  /** 0…1; when present and above `density`, the level rolls between the two */
  densityMax?: number
  /**
   * What the drivers in here are like, 0…1: the share who stop for a light they could run.
   *
   * On the zone rather than global because it is the thing that makes one part of a map feel
   * different from another, and `makeDriver` already takes it per driver.
   */
  obeyRate?: number
  /** multiplier on the posted limit for drivers in here: 0.8 is a crawl, 1.15 is a road nobody obeys */
  speedFactor?: number
}

export interface Zone {
  id: string
  name: string
  kind: ZoneKind
  /** SITE frame, metres: x east, y north. Closed implicitly — the last vertex joins the first. */
  polygon: [number, number][]
  traffic?: TrafficZone
}

/** The file, beside `adjustments.json` and stamped with the same frame for the same reason. */
export interface ZoneDoc {
  version: 1
  frame?: { kind?: string; epsg?: number; anchor?: { lon: number; lat: number; h?: number } }
  zones: Zone[]
}

export const EMPTY_ZONES: ZoneDoc = { version: 1, zones: [] }

/* ---- the colour scale, which IS the interface -------------------------------------------------- */

/**
 * The five levels, in the colours every mapping application has used for thirty years.
 *
 * Rich: *"just painting a strip of road like google maps and reversing the yellow/orange/red/maroon
 * back to varying levels of traffic"*. That is exactly right and it is why there is no numeric
 * field in the first draw: green through maroon is a scale people already read fluently, and
 * "0.72" is not. The number exists underneath for code and for the ECS.
 *
 * `density` on each is the midpoint of that level's band, so picking a colour gives a sensible
 * number and `levelOf` gives the colour back.
 */
export interface TrafficLevel {
  id: string
  label: string
  /** the density this colour means */
  density: number
  /** hex, for the map and the legend */
  colour: string
  /** what it is like to drive through */
  note: string
}

export const TRAFFIC_LEVELS: TrafficLevel[] = [
  { id: 'clear', label: 'Clear', density: 0.05, colour: '#2fa84f', note: 'An empty road. A car every few hundred metres.' },
  { id: 'light', label: 'Light', density: 0.3, colour: '#d8c33f', note: 'Traffic you overtake. Nothing stops you.' },
  { id: 'heavy', label: 'Heavy', density: 0.55, colour: '#e0812f', note: 'A queue at every light and no easy overtake.' },
  { id: 'slow', label: 'Slow', density: 0.8, colour: '#cf3b2f', note: 'Walking pace between lights.' },
  { id: 'jammed', label: 'Jammed', density: 1, colour: '#8a1f1a', note: 'Stationary. You are threading the gaps or you are not moving.' },
]

/** The level a density reads as — the nearest band, so any number has a colour. */
export function levelOf(density: number): TrafficLevel {
  const d = clamp01(density)
  let best = TRAFFIC_LEVELS[0]
  for (const l of TRAFFIC_LEVELS) if (Math.abs(l.density - d) < Math.abs(best.density - d)) best = l
  return best
}

/**
 * The colour for a density, interpolated between the levels either side of it.
 *
 * Interpolated rather than stepped because a painted road should show a gradient where one zone
 * meets another — five flat bands make a smooth change of density look like five separate zones.
 */
export function trafficColour(density: number): string {
  const d = clamp01(density)
  let lo = TRAFFIC_LEVELS[0]
  let hi = TRAFFIC_LEVELS[TRAFFIC_LEVELS.length - 1]
  for (let i = 0; i < TRAFFIC_LEVELS.length - 1; i++) {
    if (d >= TRAFFIC_LEVELS[i].density && d <= TRAFFIC_LEVELS[i + 1].density) {
      lo = TRAFFIC_LEVELS[i]
      hi = TRAFFIC_LEVELS[i + 1]
      break
    }
  }
  const span = hi.density - lo.density
  return mixHex(lo.colour, hi.colour, span > 1e-6 ? (d - lo.density) / span : 0)
}

/* ---- what a density is, in cars ---------------------------------------------------------------- */

/** Vehicles per kilometre per lane on an empty road — a car every 160 m. */
export const FREE_FLOW_PER_KM = 6
/**
 * Vehicles per kilometre per lane when stationary.
 *
 * Bumper to bumper is a car length plus the jam gap: about 4.5 m of car and 2.2 m of gap, so
 * 1000 / 6.7 ≈ 149. Rounded down a little because a real jam is never perfectly packed.
 */
export const JAM_PER_KM = 140

/**
 * Cars per kilometre per lane for a density.
 *
 * NOT linear. Density 0.5 is not "half a jam" — the interesting range for a driving game is the
 * bottom half, where the difference between four cars and twenty per kilometre is the difference
 * between an empty road and a busy one, and everything above about 0.8 looks the same from inside
 * the car. A square law puts the resolution where it is felt.
 */
export function vehiclesPerKm(density: number): number {
  const d = clamp01(density)
  return FREE_FLOW_PER_KM + (JAM_PER_KM - FREE_FLOW_PER_KM) * d * d
}

/** How many cars to put on a stretch of road: its length, how many lanes, and how busy. */
export function carsFor(lengthM: number, lanes: number, density: number): number {
  if (!(lengthM > 0) || !(lanes > 0)) return 0
  return Math.round((lengthM / 1000) * lanes * vehiclesPerKm(density))
}

/* ---- the swing --------------------------------------------------------------------------------- */

/**
 * The density this zone has THIS TIME, given a generator.
 *
 * Rolled once when a level loads, never per frame: traffic that re-rolls while you are driving
 * through it is cars appearing and vanishing in the mirror. The caller owns the generator — the
 * same seeded `rng` from `traffic.ts` — so a stage replays identically.
 */
export function rollDensity(t: TrafficZone | undefined, rand: () => number): number {
  if (!t) return 0
  const lo = clamp01(t.density)
  const hi = t.densityMax === undefined ? lo : clamp01(t.densityMax)
  if (hi <= lo) return lo
  return lo + (hi - lo) * rand()
}

/** A sentence for the editor: what this zone will actually do. */
export function describeTraffic(t: TrafficZone | undefined): string {
  if (!t) return 'no traffic set'
  const lo = clamp01(t.density)
  const hi = t.densityMax === undefined ? lo : clamp01(t.densityMax)
  const cars = (d: number) => `${vehiclesPerKm(d).toFixed(0)} cars/km/lane`
  const base = hi > lo
    ? `${levelOf(lo).label} to ${levelOf(hi).label} — ${cars(lo)} to ${cars(hi)}, rolled when the level loads`
    : `${levelOf(lo).label}, always — ${cars(lo)}`
  const bits = [base]
  if (t.obeyRate !== undefined) bits.push(`${Math.round(clamp01(t.obeyRate) * 100)}% stop for a red`)
  if (t.speedFactor !== undefined) bits.push(`${t.speedFactor.toFixed(2)}× the limit`)
  return bits.join(' · ')
}

/* ---- the lookup -------------------------------------------------------------------------------- */

interface Prepared {
  zone: Zone
  bbox: [number, number, number, number]
  size: number
  /** the density rolled for this run, so every query gives the same answer all session */
  density: number
}

/**
 * The zones of one world, ready to be asked about a point.
 *
 * SMALLEST POLYGON WINS, the same rule as `adjust.ts`, and for the same reason: a small zone drawn
 * inside a big one is somebody saying "except here", and it is also the one the editor selects when
 * you click. Bbox first, because this is asked per spawn and per junction.
 */
export class Zones {
  private zones: Prepared[] = []

  get count(): number {
    return this.zones.length
  }

  /** the zones themselves, for a list or a map overlay */
  get list(): readonly Zone[] {
    return this.zones.map((p) => p.zone)
  }

  /**
   * Take a document and roll every swing once.
   *
   * The generator is passed in rather than made here so a level can be replayed: same seed, same
   * rush hour. With none, the floor is used — which is the right answer for an editor, where a
   * density that changes every time you press save is not something you can author against.
   */
  set(zones: Zone[], rand?: () => number): void {
    this.zones = zones
      .filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 3)
      .map((z) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const [x, y] of z.polygon) {
          if (x < x0) x0 = x
          if (y < y0) y0 = y
          if (x > x1) x1 = x
          if (y > y1) y1 = y
        }
        return {
          zone: z,
          bbox: [x0, y0, x1, y1] as [number, number, number, number],
          size: areaOf(z.polygon),
          density: rand ? rollDensity(z.traffic, rand) : clamp01(z.traffic?.density ?? 0),
        }
      })
  }

  /** The smallest traffic zone containing this point, or null where none does. */
  at(x: number, y: number): Prepared | null {
    let best: Prepared | null = null
    for (const p of this.zones) {
      if (x < p.bbox[0] || x > p.bbox[2] || y < p.bbox[1] || y > p.bbox[3]) continue
      if (!inside(p.zone.polygon, x, y)) continue
      if (!best || p.size < best.size) best = p
    }
    return best
  }

  /**
   * How busy it is here, 0…1.
   *
   * ZERO OUTSIDE EVERY ZONE, and that is a decision worth stating: a world with no traffic zones has
   * no traffic at all, rather than some default sprinkle. Traffic is now something a level places,
   * so a level that places none gets none, and nobody has to hunt for the global that was putting
   * cars on their rally stage.
   */
  densityAt(x: number, y: number): number {
    return this.at(x, y)?.density ?? 0
  }

  /** The driver population here: what the zone says, or the sensible defaults. */
  driversAt(x: number, y: number): { obeyRate: number; speedFactor: number } {
    const t = this.at(x, y)?.zone.traffic
    return { obeyRate: t?.obeyRate ?? 0.97, speedFactor: t?.speedFactor ?? 1 }
  }

  /** What each zone rolled this run, for a readout that explains why the road is busy. */
  get rolled(): { id: string; density: number }[] {
    return this.zones.map((p) => ({ id: p.zone.id, density: p.density }))
  }

  /**
   * Set one zone's live density by its position in `list`.
   *
   * The seam with `zones-ecs.ts`: the entity holds the number that anybody may change, and this is
   * how it gets back into the lookup that spawning actually asks. By INDEX rather than by id
   * because it runs once per zone per tick and a map lookup per zone per tick is a map lookup per
   * zone per tick for nothing.
   */
  setDensity(index: number, density: number): void {
    const p = this.zones[index]
    if (p) p.density = clamp01(density)
  }
}

/* ---- odds and ends ----------------------------------------------------------------------------- */

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  const u = Math.max(0, Math.min(1, t))
  const ch = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * u)
  return `#${[ch(0), ch(1), ch(2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function parseHex(h: string): [number, number, number] {
  const s = h.replace('#', '')
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Validate a document the way the vehicle and actor documents are validated: every problem, not the first. */
export function validateZones(doc: ZoneDoc | null | undefined): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!doc) return { ok: true, errors, warnings }
  const seen = new Set<string>()
  for (const [i, z] of (doc.zones ?? []).entries()) {
    const where = z.id ? `zone ${JSON.stringify(z.id)}` : `zones[${i}]`
    if (!z.id) errors.push(`${where} has no id`)
    else if (seen.has(z.id)) errors.push(`${where} is used twice`)
    else seen.add(z.id)
    if (!(ZONE_KINDS as readonly string[]).includes(z.kind)) errors.push(`${where} has kind ${JSON.stringify(z.kind)}; it must be one of ${ZONE_KINDS.join(', ')}`)
    if (!Array.isArray(z.polygon) || z.polygon.length < 3) errors.push(`${where} needs at least three points`)
    else if (areaOf(z.polygon) < 1) warnings.push(`${where} encloses less than a square metre, so nothing will ever be inside it`)
    const t = z.traffic
    if (z.kind === 'traffic' && !t) errors.push(`${where} is a traffic zone with no traffic on it`)
    if (t) {
      if (!Number.isFinite(t.density) || t.density < 0 || t.density > 1) errors.push(`${where} density must be between 0 and 1`)
      if (t.densityMax !== undefined) {
        if (!Number.isFinite(t.densityMax) || t.densityMax < 0 || t.densityMax > 1) errors.push(`${where} densityMax must be between 0 and 1`)
        else if (t.densityMax < t.density) errors.push(`${where} densityMax ${t.densityMax} is below density ${t.density} — the swing has no room`)
      }
      if (t.obeyRate !== undefined && (!Number.isFinite(t.obeyRate) || t.obeyRate < 0 || t.obeyRate > 1)) errors.push(`${where} obeyRate must be between 0 and 1`)
      if (t.speedFactor !== undefined && (!Number.isFinite(t.speedFactor) || t.speedFactor <= 0)) errors.push(`${where} speedFactor must be a positive number`)
      else if (t.speedFactor !== undefined && (t.speedFactor < 0.4 || t.speedFactor > 1.6)) warnings.push(`${where} speedFactor ${t.speedFactor} is past anything a population of drivers does`)
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}
