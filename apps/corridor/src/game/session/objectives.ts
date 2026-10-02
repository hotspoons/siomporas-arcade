// Find the things and pick them up: the bones of a hunt, without a game around them.
//
// Rich, 2026-09-29: *"We should remove squishy hunt and parkour, they predate the game engine. Just
// make sure some primitives for object hunting objectives with capture survive."*
//
// Quite right about the games: both were written before there was a program API, so each carried
// its own scoring, its own HUD, its own keys and its own idea of what a level is — three ways to
// say the same thing, none of which a level could use. What was worth keeping is underneath:
//
//   THE SPREAD. Picking twelve places out of two hundred so the hunt crosses the whole town rather
//   than one strip mall. Farthest-point selection, seeded, so the same world gives the same hunt.
//
//   THE CAPTURE. Standing near enough, on foot or in a car, counts — with a height tolerance,
//   because a target on the ground and a player on a flyover are not in the same place.
//
//   THE HINT. "a corner store, north-east, a couple of blocks away" — a direction and a distance
//   band in words, which is the whole game when you are nine.
//
// NO DOM, NO THREE, NO ECS. A program drives this and draws whatever it likes; a test drives it
// from a list of coordinates. That is the difference between a primitive and a game.

/** Something to find. `z` is optional: most hunts are laid out on the map. */
export interface HuntTarget {
  id: string
  x: number
  y: number
  z?: number
  /** what it is, in words — "a corner store" */
  what?: string
  /** where it is, in words — the road it stands on */
  where?: string
}

export interface HuntOpts {
  /** how near you have to be, metres. 6 is arm's length from a car */
  radius?: number
  /** how much height difference still counts — a flyover overhead is not a capture */
  height?: number
  /**
   * Whether targets must be taken in order.
   *
   * `any` is the honest default: stumbling on one early should count, which is what made the old
   * hunt feel like exploring rather than like following a line.
   */
  order?: 'any' | 'in-turn'
}

export const DEFAULT_RADIUS_M = 6
export const DEFAULT_HEIGHT_M = 12

export type HuntEvent =
  | { at: 'captured'; target: HuntTarget; captured: number; total: number }
  | { at: 'finished'; captured: number; total: number }

/**
 * One hunt: targets, what has been taken, and what a move does about it.
 *
 * Fed positions rather than reading any; `move` is the whole interface, so a program can drive it
 * from the player, from an actor, or from a list in a test.
 */
export class Hunt {
  private items: HuntTarget[]
  private taken = new Set<string>()
  private opts: Required<HuntOpts>
  private ended = false

  constructor(targets: readonly HuntTarget[], opts: HuntOpts = {}) {
    this.items = targets.filter((t) => t && t.id && Number.isFinite(t.x) && Number.isFinite(t.y))
    this.opts = {
      radius: opts.radius ?? DEFAULT_RADIUS_M,
      height: opts.height ?? DEFAULT_HEIGHT_M,
      order: opts.order ?? 'any',
    }
  }

  get targets(): readonly HuntTarget[] {
    return this.items
  }

  get total(): number {
    return this.items.length
  }

  get captured(): number {
    return this.taken.size
  }

  get remaining(): HuntTarget[] {
    return this.items.filter((t) => !this.taken.has(t.id))
  }

  /** Has this one been taken? For hiding its model. */
  has(id: string): boolean {
    return this.taken.has(id)
  }

  /** The one to point an arrow at: the first still out there, in placement order. */
  get next(): HuntTarget | null {
    return this.remaining[0] ?? null
  }

  get done(): boolean {
    return this.items.length > 0 && this.taken.size === this.items.length
  }

  /**
   * The player is here. Returns what that changed.
   *
   * EVENTS RATHER THAN CALLBACKS, like every other rule in this project: a caller that wants a
   * sound, a toast and a score does three things with one list, and a test asserts the list.
   */
  move(at: { x: number; y: number; z?: number }): HuntEvent[] {
    const out: HuntEvent[] = []
    if (this.ended) return out
    for (const t of this.items) {
      if (this.taken.has(t.id)) continue
      if (this.opts.order === 'in-turn' && this.next?.id !== t.id) continue
      if (!this.within(t, at)) continue
      this.taken.add(t.id)
      out.push({ at: 'captured', target: t, captured: this.taken.size, total: this.items.length })
    }
    if (out.length && this.done) {
      this.ended = true
      out.push({ at: 'finished', captured: this.taken.size, total: this.items.length })
    }
    return out
  }

  /** Take one without being near it — for a program that has its own rule. */
  capture(id: string): boolean {
    const t = this.items.find((x) => x.id === id)
    if (!t || this.taken.has(id)) return false
    this.taken.add(id)
    return true
  }

  reset(): void {
    this.taken.clear()
    this.ended = false
  }

  private within(t: HuntTarget, at: { x: number; y: number; z?: number }): boolean {
    if (Math.hypot(t.x - at.x, t.y - at.y) > this.opts.radius) return false
    if (t.z === undefined || at.z === undefined) return true
    return Math.abs(t.z - at.z) <= this.opts.height
  }
}

/* ---- laying one out ---------------------------------------------------------------------------- */

/**
 * Pick `count` of these so they are spread across the whole place.
 *
 * FARTHEST-POINT, from a seeded start: take the one furthest from everything already taken, every
 * time. It is the reason a hunt is a tour of a town rather than four targets in one car park, and
 * it costs nothing at these sizes.
 *
 * Seeded so that the same world gives the same hunt — which is what lets two people play the same
 * one without sending the layout between them.
 */
export function spread<T extends { x: number; y: number }>(items: readonly T[], count: number, seed = 1): T[] {
  if (!items.length || count <= 0) return []
  const chosen: T[] = []
  const left = new Set(items)
  let cur = items[Math.floor(hash(seed) * items.length) % items.length]
  chosen.push(cur)
  left.delete(cur)
  while (chosen.length < Math.min(count, items.length) && left.size) {
    let best: T | null = null
    let bd = -1
    for (const p of left) {
      let d = Infinity
      for (const c of chosen) d = Math.min(d, Math.hypot(p.x - c.x, p.y - c.y))
      if (d > bd) { bd = d; best = p }
    }
    if (!best) break
    chosen.push(best)
    left.delete(best)
    cur = best
  }
  return chosen
}

/** A stable 0…1 from an integer seed. */
export function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

/* ---- saying where it is ------------------------------------------------------------------------ */

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']

/**
 * Which way that is, in words. Site frame: x east, y north.
 *
 * Eight points rather than sixteen, because "north-north-east" is not a direction anybody walks in.
 */
export function bearing(dx: number, dy: number): string {
  const ang = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
  return COMPASS[Math.round(ang / 45) % 8]
}

/**
 * How far that is, in words.
 *
 * Bands rather than metres: "340 m" is a number you have to convert into a feeling, and the feeling
 * is the only part that helps you decide whether to walk.
 */
export function distanceBand(m: number): string {
  if (m < 25) return 'right here'
  if (m < 120) return 'really close'
  if (m < 400) return 'a couple of blocks away'
  if (m < 1200) return 'a good walk away'
  return 'across town'
}

/** The whole hint: what, which way, how far, and what road it is on. */
export function hintFor(t: HuntTarget, from: { x: number; y: number }): string {
  const dx = t.x - from.x
  const dy = t.y - from.y
  const d = Math.hypot(dx, dy)
  const bits = [t.what ?? 'something', bearing(dx, dy), distanceBand(d)]
  if (t.where) bits.push(`on ${t.where}`)
  return bits.join(', ')
}

/** One line for a HUD: "3 of 12". */
export function scoreLine(h: Hunt): string {
  return `${h.captured} of ${h.total}`
}

/* ---- laying one out on a real world ------------------------------------------------------------ */

/** A place in the bake's own point-of-interest list. */
export interface Poi {
  x: number
  y: number
  kind: string
  name?: string | null
}

/**
 * Which kinds are worth hiding something at.
 *
 * Shops and the places a child would name. Kept because it is the one piece of the old hunt that
 * encodes taste rather than mechanism, and taste is the expensive part.
 */
export const HUNTABLE = /^(shop=|amenity=(fuel|fast_food|restaurant|cafe|ice_cream|pharmacy|post_office)|leisure=(playground|park))/

const WHAT: [RegExp, string][] = [
  [/^amenity=fuel/, 'a gas station'],
  [/^amenity=fast_food/, 'a burger place'],
  [/^amenity=restaurant/, 'a restaurant'],
  [/^amenity=cafe/, 'a coffee shop'],
  [/^amenity=ice_cream/, 'an ice cream shop'],
  [/^amenity=pharmacy/, 'a pharmacy'],
  [/^amenity=post_office/, 'the post office'],
  [/^leisure=playground/, 'a playground'],
  [/^leisure=park/, 'a park'],
  [/^shop=supermarket/, 'a supermarket'],
  [/^shop=convenience/, 'a corner store'],
  [/^shop=beauty|^shop=hairdresser/, 'a hair salon'],
  [/^shop=clothes/, 'a clothes shop'],
  [/^shop=car_repair/, 'a garage'],
  [/^shop=(.+)/, 'a $1 shop'],
]

/** What a point of interest is, in words a person uses. */
export function whatIs(kind: string): string {
  for (const [re, w] of WHAT) {
    const m = kind.match(re)
    if (m) return w.replace('$1', (m[1] ?? '').replace(/_/g, ' '))
  }
  return 'a place'
}

/**
 * Turn a world's points of interest into a hunt's targets.
 *
 * The bake carries every OSM point of interest with its kind and name, so a target has a real
 * address and a hint can be written from the record — no authoring required, which is what made the
 * old hunt work on any site the moment it was baked.
 */
export function targetsFromPois(pois: readonly Poi[], opts: { count?: number; seed?: number } = {}): HuntTarget[] {
  const usable = pois.filter((p) => p && p.name && HUNTABLE.test(p.kind))
  return spread(usable, opts.count ?? 12, opts.seed ?? 7).map((p, i) => ({
    id: `poi-${i}-${Math.round(p.x)}-${Math.round(p.y)}`,
    x: p.x,
    y: p.y,
    what: whatIs(p.kind),
    where: p.name ?? undefined,
  }))
}
