// Stunt fixtures on real roads: a loop-the-loop over Route 450.
//
// Rich, 2026-09-29: *"can you also look at pulling in the stuntin' library of props for stunt
// racing games. It would be so dope to be able to stick a loop-de-loop over a section of road. To
// make it work we would need to be able to place the stunts at any orientation. There is already a
// good algorithm for automatically hooking up waypoints to the start and finish of a stunt
// fixture… place the stunt and then connect it to a start and finish waypoints and then don't
// render the openstreet map road underneath the stunt."* And: *"hooking up the waypoints should go
// through a bezier curve and link naturally from the end of the stunt fixture to the continuation
// of road."*
//
// THE VOCABULARY IS NOT COPIED. `@apex/stunt-pieces` is 592 lines of loops, corkscrews, banked
// sixths, drawbridges and jumps, each with a lane path that has been driven and tuned. A port that
// copies it is a port that drifts: the day somebody fixes the corkscrew's exit angle in STUNTIN',
// corridor keeps the old one and nobody notices for a month. So this IMPORTS the piece definitions
// and adds the one thing they do not have — a way to stand them anywhere, at any angle, on ground
// that is not a grid.
//
// IT IS A PACKAGE WITH NO DEPENDENCIES, which is the whole reason this survives the repositories
// being split: corridor depends on a folder, and a folder can be moved and depended on over a git
// URL. Reaching into `apps/stuntin/src/` — which is what this did first — works in a monorepo and
// nowhere else, and it dragged that game's entire car-tuning table in to learn that a cell is 40 m.
//
// TWO FRAMES, AND THE CONVERSION IS THE WHOLE JOB:
//
//   STUNTIN' — x east, z north, y UP. A piece's footprint has its minimum corner at the origin and
//   the grid is `CELL` metres (40). Everything is axis-aligned because the editor is a tile grid.
//
//   CORRIDOR — x east, y north, and height is a third thing entirely, sampled from the terrain. A
//   fixture has a position and a YAW, because a real road does not run along a grid line.
//
// PORTS COME FROM THE LANE, NOT FROM THE PORT TABLE. A piece declares its ports as a cell and a
// compass side, which is exact on a grid and needs a pile of rotation bookkeeping off one. The lane
// path already knows where it starts and ends and which way it is pointing — it is the thing the
// car actually drives — so sampling it at t=0 and t=1 gives the entry and exit poses directly, and
// they cannot disagree with the surface for the same reason the surface is where it is.

import { PIECE_BY_TYPE, type PathPoint, type PieceDef } from '@apex/stunt-pieces/pieces'
import { CELL, LEVEL_H } from '@apex/stunt-pieces/geometry'
import { areaOf, inside } from '../../world/polygon'
import type { FrameStamp } from '../../editor/store/schema'

export { CELL as STUNT_CELL, LEVEL_H as STUNT_LEVEL_H }

/* ---- poses ------------------------------------------------------------------------------------- */

/**
 * A place on the course and the way traffic flows THROUGH it.
 *
 * `d` always points along the direction of travel — not outward from a piece, which is STUNTIN's
 * convention and the right one for a grid where two pieces meet edge to edge. Here the two things
 * being joined are a road and a fixture, neither of which has an edge, so "which way are you going
 * when you are here" is the only question both can answer.
 */
export interface Pose {
  x: number
  y: number
  /** metres above the datum the road is measured in */
  z: number
  /**
   * Unit HORIZONTAL direction of travel — its shadow on the map.
   *
   * Every road pose has this and nothing else, because a road is flat enough that its shadow is its
   * direction. A stunt piece is not: see `t3`.
   */
  dx: number
  dy: number
  /**
   * The FULL direction of travel, unit length, including its vertical part.
   *
   * WITHOUT THIS A LOOP IS A SHEARED RIBBON. The surface across the road is `tangent × normal`, and
   * using the horizontal shadow as the tangent is only right while the road is flat. Measured on a
   * loop: where the lane pitches up 62°, the cross-section came out 32° from the direction of
   * travel instead of 90° — the quad sheared into a diagonal, which reads as a ridge running up the
   * middle of the road and rising to near vertical. Rich, 2026-09-29, with a screenshot: *"The
   * center of the loop de loop's road is raised to near vertical, the car runs into it and gets
   * stuck. We need the road smoothed out so it is as flat as it can be from side to side without
   * this large crown right in the middle."*
   *
   * Optional, because a road pose has no need of it and `dx, dy, 0` is the right answer there.
   */
  t3?: { x: number; y: number; z: number }
  /** surface normal, for a link that arrives on a banked or inverted surface */
  up?: { x: number; y: number; z: number }
  /** roll about the tangent, radians */
  roll?: number
}

/* ---- the document ------------------------------------------------------------------------------ */

export interface StuntFixture {
  id: string
  name: string
  /** a `type` from the STUNTIN' vocabulary: loop, corkscrew, bank6, jump, … */
  piece: string
  /** where the fixture's footprint centre sits, site frame metres */
  at: [number, number]
  /** rotation about up, degrees anticlockwise from east — the same sense as a road bearing's negation */
  yaw_deg: number
  /** how far the fixture's base floats above the ground under `at`. 0 sits it on the road */
  lift_m?: number
  /** how tightly the approach curves bend, 0.25 (direct) … 2 (a long sweep) */
  tightness?: number
  /**
   * How it is surfaced.
   *
   * `road` wears the site's own tarmac, so a loop is made of the same asphalt as the road it
   * replaces — which is the honest default, since it IS that road. `stuntin` adds the red-and-white
   * kerbs the arcade games all use; on a loop or a corkscrew they are not decoration, they are the
   * only thing telling you where the surface ends while you are upside down.
   */
  style?: StuntStyle
  /**
   * What each end joins to: a road, another fixture, or nothing at all.
   *
   * Rich, 2026-09-29: *"the original ask was to be able to drop a stunt piece and place it
   * anywhere, not just on the existing roads, then connect it on both ends to the roads with
   * waypoints … or not have them link to roads at all. That way I can build complete stunt tracks
   * in a field."*
   *
   * So an end is a CHOICE of three rather than a distance that may be missing. `{ kind: 'none' }`
   * is a real, saveable, valid state — a piece standing on its own while you build the rest of a
   * track around it — and it is not the same as "you forgot to connect this", which is what an
   * absent `entry_s` used to mean and why the editor nagged about it.
   */
  entry?: StuntEnd
  exit?: StuntEnd
  /**
   * The old shape: a distance along `chain`.
   *
   * Still read, never written. Every stunts.json authored before ends existed says `entry_s: 420`,
   * and a document format that cannot read its own past is a document format that loses somebody's
   * afternoon. `endsOf` migrates on the way in.
   */
  entry_s?: number
  exit_s?: number
  /** which chain those legacy distances are on, and the default chain for a road end; 0 is the spine */
  chain?: number
}

/**
 * One end of a fixture, and what it is joined to.
 *
 * THREE KINDS, AND THE THIRD IS THE POINT. A road end is the original behaviour — a station on a
 * chain, picked by clicking a waypoint on the tarmac. A fixture end joins this piece to another
 * one, which is how a track gets built out of pieces in a field with no road anywhere near it. And
 * `none` is a deliberate open end.
 */
export type StuntEnd =
  | { kind: 'none' }
  | { kind: 'road'; s: number; chain?: number }
  | { kind: 'fixture'; id: string; port?: StuntPort }

export type StuntPort = 'entry' | 'exit'

export const NO_END: StuntEnd = { kind: 'none' }

/**
 * Both ends of a fixture, with the legacy fields migrated.
 *
 * The one place that knows `entry_s` ever existed. Everything downstream asks for this and gets
 * three kinds it has to handle, which is the shape that makes "unlinked" impossible to forget.
 */
export function endsOf(f: StuntFixture): { entry: StuntEnd; exit: StuntEnd } {
  const legacy = (s: number | undefined): StuntEnd =>
    s === undefined || !Number.isFinite(s) ? NO_END : { kind: 'road', s, chain: f.chain ?? 0 }
  return {
    entry: f.entry ?? legacy(f.entry_s),
    exit: f.exit ?? legacy(f.exit_s),
  }
}

/**
 * Set one end, and retire the legacy field it replaces.
 *
 * Clearing `entry_s` as well is not tidiness: `endsOf` prefers `entry`, so a document carrying both
 * would show one thing in the editor and another to anybody reading the JSON, and the stale number
 * would come back the moment somebody wrote a migration that trusted it.
 */
export function setEnd(f: StuntFixture, which: StuntPort, end: StuntEnd): void {
  if (which === 'entry') {
    f.entry = end
    delete f.entry_s
  } else {
    f.exit = end
    delete f.exit_s
  }
}

/** Which port of another fixture this end naturally joins to, if it does not say. */
export function defaultPort(which: StuntPort): StuntPort {
  // you arrive at my ENTRY from somebody's EXIT, and leave my EXIT into somebody's ENTRY
  return which === 'entry' ? 'exit' : 'entry'
}

/** Does this fixture name that one at either end? For rebuilding what a move invalidated. */
export function linksTo(f: StuntFixture, id: string): boolean {
  const e = endsOf(f)
  return (e.entry.kind === 'fixture' && e.entry.id === id) || (e.exit.kind === 'fixture' && e.exit.id === id)
}

export const STUNT_STYLES = ['road', 'stuntin'] as const
export type StuntStyle = (typeof STUNT_STYLES)[number]

export interface StuntDoc {
  version: 1
  frame?: FrameStamp
  fixtures: StuntFixture[]
}

export const EMPTY_STUNTS: StuntDoc = { version: 1, fixtures: [] }
export const DEFAULT_TIGHTNESS = 0.8

/** Every piece that is a stunt rather than a straight or a bit of scenery. */
export function stuntPieces(): PieceDef[] {
  return Object.values(PIECE_BY_TYPE).filter((p) => p.group === 'stunts' || p.group === 'curves' || p.group === 'flow')
}

export function pieceOf(type: string): PieceDef | null {
  return PIECE_BY_TYPE[type] ?? null
}

/* ---- standing a piece up anywhere -------------------------------------------------------------- */

/** The footprint, metres: how big the fixture is before it is turned. */
export function fixtureSize(f: StuntFixture): { w: number; h: number } {
  const def = pieceOf(f.piece)
  return def ? { w: def.w * CELL, h: def.h * CELL } : { w: 0, h: 0 }
}

/**
 * Local (STUNTIN') to site, for a fixture at a position and a yaw.
 *
 * The local origin is the footprint's minimum corner, and `at` is where the CENTRE goes — a person
 * placing a loop on a road is pointing at the middle of it, not at a corner they cannot see.
 */
export function toSite(f: StuntFixture, local: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const { w, h } = fixtureSize(f)
  // centre the footprint, then turn it
  const lx = local.x - w / 2
  const lz = local.z - h / 2
  const a = (f.yaw_deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return {
    x: f.at[0] + lx * c - lz * s,
    y: f.at[1] + lx * s + lz * c,
    z: (f.lift_m ?? 0) + local.y,
  }
}

/** A direction in the local frame, turned into the site frame. Lengths are preserved. */
export function dirToSite(f: StuntFixture, local: { x: number; z: number }): { x: number; y: number } {
  const a = (f.yaw_deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: local.x * c - local.z * s, y: local.x * s + local.z * c }
}

/** The four corners of the footprint, in order, for suppressing the road under it. */
export function fixtureFootprint(f: StuntFixture): [number, number][] {
  const { w, h } = fixtureSize(f)
  const corners: { x: number; y: number; z: number }[] = [
    { x: 0, y: 0, z: 0 }, { x: w, y: 0, z: 0 }, { x: w, y: 0, z: h }, { x: 0, y: 0, z: h },
  ]
  return corners.map((c) => {
    const p = toSite(f, c)
    return [p.x, p.y] as [number, number]
  })
}

const SCRATCH: PathPoint = { x: 0, y: 0, z: 0, ux: 0, uy: 1, uz: 0, roll: 0, surface: true }

/** The lane a car drives through this piece, sampled in the LOCAL frame. */
function localAt(def: PieceDef, t: number): PathPoint {
  const lane = def.lanes[0]
  const o: PathPoint = { ...SCRATCH }
  lane.path(Math.max(0, Math.min(1, t)), o)
  return o
}

/**
 * The drivable line through a fixture, in the site frame.
 *
 * `n` is how many samples; the default is one every few metres for a typical piece, which is what
 * a road mesh wants. Every point carries its surface normal and roll, because the point of a loop
 * is that the surface is upside down in the middle of it and nothing downstream can work that out
 * from a position alone.
 *
 * `baseZ` IS THE HEIGHT OF THE GROUND THE FIXTURE STANDS ON, and passing it here rather than
 * letting the renderer add it later is not a preference. A `Pose`'s z is metres above the datum the
 * road is measured in — the road anchors this is linked to are absolute — so a path that is
 * relative to its own base is a path that cannot be compared with, or joined to, anything. The
 * first version left the renderer to add the offset, which lifted the fixture AND its approach
 * curves by the terrain height a second time: thirty metres of Maryland, applied consistently
 * enough that it looked right until you saw the ribbon floating over a field.
 */
export function fixturePath(f: StuntFixture, n = 96, baseZ = 0): Pose[] {
  const def = pieceOf(f.piece)
  if (!def) return []
  const out: Pose[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const p = localAt(def, t)
    const here = toSite(f, p)
    here.z += baseZ
    // the tangent by difference, which works for every piece including the ones with a discontinuity
    const eps = 1 / (n * 4)
    const a = localAt(def, Math.max(0, t - eps))
    const b = localAt(def, Math.min(1, t + eps))
    const d = dirToSite(f, { x: b.x - a.x, z: b.z - a.z })
    const len = Math.hypot(d.x, d.y) || 1
    // the vertical part of the same difference. STUNTIN's local y is up, and so is the site's z.
    const rise = b.y - a.y
    const len3 = Math.hypot(d.x, d.y, rise) || 1
    const up = dirToSite(f, { x: p.ux, z: p.uz })
    out.push({
      x: here.x, y: here.y, z: here.z,
      dx: d.x / len, dy: d.y / len,
      t3: { x: d.x / len3, y: d.y / len3, z: rise / len3 },
      up: { x: up.x, y: up.y, z: p.uy },
      roll: p.roll,
    })
  }
  return out
}

/** Where you enter it and where you leave it, pointing the way you are going. */
export function fixturePorts(f: StuntFixture, baseZ = 0): { entry: Pose; exit: Pose } | null {
  const path = fixturePath(f, 32, baseZ)
  if (path.length < 2) return null
  return { entry: path[0], exit: path[path.length - 1] }
}

/** How long the lane through the fixture is, metres — for a lap distance and for sampling density. */
export function fixtureLength(f: StuntFixture): number {
  const path = fixturePath(f, 128)
  let len = 0
  for (let i = 1; i < path.length; i++) {
    len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z)
  }
  return len
}

/* ---- the link ---------------------------------------------------------------------------------- */

/**
 * A cubic Hermite between two poses, matching the direction of travel at both ends.
 *
 * This is `linkPoint` from `apps/stuntin/src/sim/links.ts` with one change: STUNTIN's port facings
 * point OUT of their piece, so it negates the far tangent. A `Pose` here points along travel at
 * both ends, so both tangents are positive — which is why a road anchor and a fixture port can be
 * joined without either of them knowing what the other is.
 *
 * `tightness` scales the tangents by the straight-line distance: small is a tight, direct curve and
 * large is a wide sweep. 0.8 is STUNTIN's default and it reads as "natural" because a tangent about
 * four fifths of the gap is roughly what a road designer's transition spiral does.
 *
 * Height eases with a smoothstep rather than linearly: a linear ramp has a corner in it at both
 * ends, and a corner in height is a jump you did not author.
 */
export function hermite(a: Pose, b: Pose, tightness: number, t: number): Pose {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  /*
   * The tangent length: `tightness` of the gap, with a floor so a short link is still a curve
   * rather than a kink — BUT THE FLOOR NEVER EXCEEDS THE GAP. A 20 m tangent across a 20 cm join,
   * which is what two pieces butted against each other produce, sends the curve twenty metres
   * forward and twenty metres back: a loop where there should be a joint. That is exactly the
   * case a track built out of touching pieces is made of.
   */
  const L = Math.max(dist * tightness, Math.min(dist, CELL * 0.5))
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  const tax = a.dx * L
  const tay = a.dy * L
  const tbx = b.dx * L
  const tby = b.dy * L
  const x = h00 * a.x + h10 * tax + h01 * b.x + h11 * tbx
  const y = h00 * a.y + h10 * tay + h01 * b.y + h11 * tby
  const d00 = 6 * t2 - 6 * t
  const d10 = 3 * t2 - 4 * t + 1
  const d01 = -6 * t2 + 6 * t
  const d11 = 3 * t2 - 2 * t
  const tx = d00 * a.x + d10 * tax + d01 * b.x + d11 * tbx
  const ty = d00 * a.y + d10 * tay + d01 * b.y + d11 * tby
  const len = Math.hypot(tx, ty) || 1
  const s = smoothstep(t)
  /*
   * THE SURFACE NORMAL ALONG A LINK, interpolated between the two ends.
   *
   * It used not to have one at all, and an absent `up` is read as flat by everything downstream —
   * the ribbon builder, and the assist that decides which way is up for a car on a fixture. A link
   * that arrives at a banked mouth was therefore flat right up to the join, and a car following it
   * was held flat into a surface that had already begun to turn.
   */
  const ua = a.up ?? FLAT
  const ub = b.up ?? FLAT
  const ux = ua.x + (ub.x - ua.x) * s
  const uy = ua.y + (ub.y - ua.y) * s
  const uz = ua.z + (ub.z - ua.z) * s
  const ul = Math.hypot(ux, uy, uz) || 1
  // and the true direction of travel, including the climb: dz/dt of the smoothstepped height
  const dz = (b.z - a.z) * 6 * t * (1 - t)
  const l3 = Math.hypot(tx, ty, dz) || 1
  return {
    x, y,
    z: a.z + (b.z - a.z) * s,
    dx: tx / len, dy: ty / len,
    t3: { x: tx / l3, y: ty / l3, z: dz / l3 },
    up: { x: ux / ul, y: uy / ul, z: uz / ul },
    roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * s,
  }
}

/** The normal of flat ground, for a pose that does not carry one. */
const FLAT = { x: 0, y: 0, z: 1 }

function smoothstep(t: number): number {
  const u = Math.max(0, Math.min(1, t))
  return u * u * (3 - 2 * u)
}

/**
 * How far above the ground a connector is held when it would otherwise be under it.
 *
 * Small, because the connector IS road: it should lie on the field, not hover over it.
 */
export const LINK_CLEARANCE_M = 0.05

/**
 * How long one facet of a fixture's surface may be, metres.
 *
 * The drivable surface is a polyline swept into a ribbon, so every sample is a flat facet and every
 * joint between two is a small ramp: a car crossing one at speed takes a vertical kick of
 * `v · sin(θ)`. At the old fixed 96 samples a 250 m loop was 2.6 m a facet, whose worst joint turns
 * 6.2° — 5.0 m/s straight up at 46 m/s, which is a jump rather than a bump. Half a metre puts the
 * same joint under 1.5°, and it costs about a thousand triangles for a loop.
 *
 * WHAT THIS DID NOT FIX, so that nobody re-runs the experiment: a car driven into a loop still stops
 * where the lane starts to climb, at the same point to the centimetre, with 96 samples or with 842.
 * That ruled the facets out as the cause of THAT — the vertical velocity at the stop was 4.3 m/s
 * before and 4.2 m/s after. It is kept because the arithmetic above is true of every fast crossing,
 * not because it solved the loop.
 */
export const FACET_M = 0.5

/**
 * How many samples a run of `metres` needs.
 *
 * Bounded at both ends: a short link still gets enough points to read as a curve, and a pathological
 * length cannot ask for a million triangles.
 */
export function samplesFor(metres: number, facet = FACET_M): number {
  if (!(metres > 0)) return 48
  return Math.max(48, Math.min(2048, Math.ceil(metres / facet)))
}

/**
 * The link as a polyline — and, given a terrain sampler, one that stays on top of the terrain.
 *
 * WHY THE GROUND MATTERS HERE. The Hermite eases from the road's height to the fixture's mouth, and
 * eases through whatever is in between — so a link across a rise goes THROUGH the rise. Rich,
 * 2026-09-29: *"stunts still not drivable"*; the measurement that found it was a mouth sitting 3 m
 * under a hillside, with the car hitting the hill at 44 m/s and stopping dead. Every screenshot
 * looked right, because the buried part is the part you cannot see.
 *
 * MAXIMUM, THEN SMOOTHED. Taking the greater of the curve and the ground puts a corner wherever the
 * two cross, and a corner in height is a jump you did not author; two averaging passes over the
 * interior take it out. The ends are never moved — they are the road and the fixture, and a link
 * that does not meet them is not a link.
 */
export function linkPath(
  a: Pose,
  b: Pose,
  tightness = DEFAULT_TIGHTNESS,
  n = samplesFor(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)),
  ground?: (x: number, y: number) => number,
): Pose[] {
  const out: Pose[] = []
  for (let i = 0; i <= n; i++) out.push(hermite(a, b, tightness, i / n))
  if (!ground || out.length < 3) return out
  for (let i = 1; i < out.length - 1; i++) {
    out[i].z = Math.max(out[i].z, ground(out[i].x, out[i].y) + LINK_CLEARANCE_M)
  }
  for (let pass = 0; pass < 2; pass++) {
    const was = out.map((p) => p.z)
    for (let i = 1; i < out.length - 1; i++) out[i].z = (was[i - 1] + was[i] * 2 + was[i + 1]) / 4
  }
  /*
   * AND THE TANGENT IS NOW A LIE. Holding the curve above the ground changed its heights, so the
   * `t3` the Hermite computed describes a path this no longer is — and `t3` is what decides which
   * way the road faces across itself. Recomputed from the points that are actually here.
   */
  for (let i = 1; i < out.length - 1; i++) {
    const p = out[i - 1]
    const q = out[i + 1]
    const l = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) || 1
    out[i].t3 = { x: (q.x - p.x) / l, y: (q.y - p.y) / l, z: (q.z - p.z) / l }
  }
  return out
}

/** Its length, by sampling — the number a lap distance and a road mesh both need. */
export function linkLength(a: Pose, b: Pose, tightness = DEFAULT_TIGHTNESS): number {
  const pts = linkPath(a, b, tightness, 64)
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z)
  return len
}

/**
 * The whole thing: road in, through the fixture, road out.
 *
 * `road(s)` is the corridor's own centreline sampler — give it a distance along the chain and it
 * gives back a pose. Everything else is arithmetic, so a level can place a loop by naming two
 * distances and a piece, and an editor can do the same by dragging.
 *
 * WHY THE APPROACH IS A CURVE AND NOT A STRAIGHT. Rich: *"link naturally from the end of the stunt
 * fixture to the continuation of road"*. A straight from the road to the loop's mouth meets the
 * road at an angle, and a car crossing that joint at 40 m/s is a car that has just been steered for
 * it. The Hermite leaves along the road's own tangent and arrives along the fixture's, so there is
 * no angle anywhere — the transition is exactly as invisible as it should be.
 */
export interface StuntLinkOpts {
  /** the terrain under a site point, so a fixture stands on the ground rather than at datum zero */
  groundAt?: (x: number, y: number) => number
  /**
   * The other fixtures of the same document, by id.
   *
   * Without it a fixture end that names another piece cannot be resolved and is reported as a
   * problem rather than silently ignored — a link that quietly does nothing is a link somebody
   * spends an evening re-drawing.
   */
  fixture?: (id: string) => StuntFixture | null
}

/**
 * Where one end of a fixture actually is, in the world.
 *
 * Returns a pose and, separately, a complaint: a `none` end has neither, which is the difference
 * between "not joined to anything" and "joined to something that is not there".
 */
export function resolveEnd(
  end: StuntEnd,
  which: StuntPort,
  road: (s: number, chain: number) => Pose | null,
  opts: StuntLinkOpts = {},
): { pose: Pose | null; problem: string | null } {
  if (end.kind === 'none') return { pose: null, problem: null }
  if (end.kind === 'road') {
    const pose = road(end.s, end.chain ?? 0)
    return pose
      ? { pose, problem: null }
      : { pose: null, problem: `no road at ${end.s.toFixed(0)} m to ${which === 'entry' ? 'enter from' : 'leave to'}` }
  }
  const other = opts.fixture?.(end.id) ?? null
  if (!other) return { pose: null, problem: `${which === 'entry' ? 'comes from' : 'goes to'} ${end.id}, which is not in this document` }
  const base = opts.groundAt ? opts.groundAt(other.at[0], other.at[1]) : 0
  const ports = fixturePorts(other, base)
  if (!ports) return { pose: null, problem: `${end.id} is a ${other.piece}, which this build cannot stand up` }
  return { pose: ports[end.port ?? defaultPort(which)], problem: null }
}

/**
 * The whole thing: in, through the fixture, out.
 *
 * `road(s, chain)` is the corridor's own centreline sampler — a distance along a chain gives back a
 * pose. Everything else is arithmetic, so a level can place a loop by naming two distances and a
 * piece, and an editor can do the same by dragging.
 *
 * EITHER END MAY BE NOTHING, and that is the normal case for a track built in a field: the piece is
 * drawn and driveable on its own, and the approach or departure ribbon simply is not there. It used
 * to be the case that a fixture with no `entry_s` was a fixture the editor complained about, which
 * made "put a loop in a field and join it up later" a thing you could do only by ignoring a
 * warning.
 *
 * WHY THE APPROACH IS A CURVE AND NOT A STRAIGHT. Rich: *"link naturally from the end of the stunt
 * fixture to the continuation of road"*. A straight from the road to the loop's mouth meets the
 * road at an angle, and a car crossing that joint at 40 m/s is a car that has just been steered for
 * it. The Hermite leaves along the road's own tangent and arrives along the fixture's, so there is
 * no angle anywhere — the transition is exactly as invisible as it should be. The same curve joins
 * two fixtures to each other, for the same reason and with no extra code: both ends of it are poses
 * and neither has to know what the other is attached to.
 */
export function connectFixture(
  f: StuntFixture,
  road: (s: number, chain: number) => Pose | null,
  opts: StuntLinkOpts = {},
): { approach: Pose[]; through: Pose[]; departure: Pose[]; problems: string[]; baseZ: number } | null {
  const problems: string[] = []
  const tight = f.tightness ?? DEFAULT_TIGHTNESS
  const ends = endsOf(f)

  const from = resolveEnd(ends.entry, 'entry', road, opts)
  const to = resolveEnd(ends.exit, 'exit', road, opts)
  if (from.problem) problems.push(from.problem)
  if (to.problem) problems.push(to.problem)

  /*
   * WHERE THE BOTTOM OF IT SITS.
   *
   * THE HIGHEST GROUND IT TOUCHES, not the ground under its middle. A fixture's base is a flat
   * plane — the piece was authored on a grid — and a loop is eighty metres across, so on any real
   * slope the height of the centre buries one end of it. Measured on Race Track Road: the mouth of
   * a loop stood on its centre sat 3.0 m under the hillside, the approach ran into the hill, and a
   * car doing 44 m/s stopped dead against it. Rich: *"stunts still not drivable"*.
   *
   * The two PORTS are what matter, because they are where a car arrives and leaves; the centre is
   * in there so a piece on a crest is not left hanging. Standing it on the highest of the three
   * means the worst case is a small step UP at one end, which a car drives over, rather than a
   * wall it hits.
   */
  const baseZ = opts.groundAt ? standOn(f, opts.groundAt) : (from.pose?.z ?? 0)

  const ports = fixturePorts(f, baseZ)
  if (!ports) return null

  /*
   * A MUTUAL JOIN IS ONE CURVE, NOT TWO. When A's exit names B's entry and B's entry names A's
   * exit — which is what joining two pieces in the editor writes, so that both panels tell the
   * truth about what they are attached to — the same Hermite is described twice. Drawn twice it is
   * two coincident ribbons, which z-fight in the render and hand the physics a doubled surface.
   * The ARRIVING side owns it: B draws the approach, A draws nothing.
   */
  const approach = from.pose ? linkPath(from.pose, ports.entry, tight, undefined, opts.groundAt) : []
  const departure = to.pose && !ownedByTheOtherEnd(f, ends.exit, opts)
    ? linkPath(ports.exit, to.pose, tight, undefined, opts.groundAt)
    : []

  /*
   * A LINK THAT DOUBLES BACK IS NOT A LINK. Two poses pointing at each other produce a Hermite
   * that leaves along one tangent, turns round and comes back — geometrically valid and
   * undriveable. It happens whenever the fixture is placed facing the wrong way, which is the
   * single easiest mistake to make and the one that looks fine from above.
   */
  if (approach.length && reverses(approach)) problems.push('the approach doubles back — turn the fixture round, or move its entry to the other side of it')
  if (departure.length && reverses(departure)) problems.push('the exit doubles back — turn the fixture round, or move its exit to the other side of it')

  // SAMPLED BY LENGTH, not by a fixed count — see `FACET_M`. A loop and a speedbump are not the
  // same number of facets, and the one that matters is the metres between them.
  return { approach, through: fixturePath(f, samplesFor(fixtureLength(f)), baseZ), departure, problems, baseZ }
}

/**
 * The height to stand a fixture at: the highest ground under its centre or either of its ports.
 *
 * The ports' plan positions are taken with the base at zero, which is exact — a fixture's yaw and
 * placement decide where its mouth is in plan, and the base only moves it up and down.
 */
export function standOn(f: StuntFixture, ground: (x: number, y: number) => number): number {
  /*
   * THE WHOLE LANE, not just the two ends. The ends were not enough: measured on Race Track Road,
   * a loop standing on the higher of its two mouths still had the middle of its lane a metre under
   * the hillside, and a car entering it at 37 m/s hit the point where the tarmac came out of the
   * ground and stopped dead. Every point a car touches has to be above the field.
   *
   * The lane is sampled coarsely — two dozen points across eighty metres — because this answers
   * "how high is the hill under this piece", and terrain that changes faster than that between
   * samples is terrain nobody should be standing a loop on anyway.
   */
  let hi = ground(f.at[0], f.at[1])
  for (const p of fixturePath(f, 24, 0)) hi = Math.max(hi, ground(p.x, p.y))
  return hi
}

/** Is the curve leaving this fixture's exit already being drawn as somebody else's approach? */
function ownedByTheOtherEnd(f: StuntFixture, exit: StuntEnd, opts: StuntLinkOpts): boolean {
  if (exit.kind !== 'fixture') return false
  if ((exit.port ?? defaultPort('exit')) !== 'entry') return false
  const other = opts.fixture?.(exit.id)
  if (!other) return false
  const theirs = endsOf(other).entry
  return theirs.kind === 'fixture' && theirs.id === f.id && (theirs.port ?? defaultPort('entry')) === 'exit'
}

/** Does this polyline turn through more than a right angle against itself anywhere? */
function reverses(path: Pose[]): boolean {
  for (let i = 1; i < path.length; i++) {
    if (path[i].dx * path[0].dx + path[i].dy * path[0].dy < -0.2) return true
  }
  return false
}

/* ---- suppressing the road underneath ----------------------------------------------------------- */

/**
 * The fixtures of one world, ready to be asked whether the road should be drawn at a point.
 *
 * Rich: *"don't render the openstreet map road underneath the stunt"*. The fixture IS the road
 * there, so drawing both gives you a loop with a strip of tarmac through the middle of it. The same
 * bbox-first query as `Zones`, for the same reason: this is asked per road quad.
 */
export class Stunts {
  private items: { f: StuntFixture; poly: [number, number][]; bbox: [number, number, number, number]; size: number }[] = []

  get count(): number {
    return this.items.length
  }

  get list(): readonly StuntFixture[] {
    return this.items.map((i) => i.f)
  }

  set(fixtures: StuntFixture[]): void {
    this.items = fixtures
      .filter((f) => pieceOf(f.piece))
      .map((f) => {
        const poly = fixtureFootprint(f)
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const [x, y] of poly) {
          if (x < x0) x0 = x
          if (y < y0) y0 = y
          if (x > x1) x1 = x
          if (y > y1) y1 = y
        }
        return { f, poly, bbox: [x0, y0, x1, y1] as [number, number, number, number], size: areaOf(poly) }
      })
  }

  /** Is this point under a fixture? If so the baked road must not be drawn there. */
  coversRoad(x: number, y: number): boolean {
    for (const it of this.items) {
      if (x < it.bbox[0] || x > it.bbox[2] || y < it.bbox[1] || y > it.bbox[3]) continue
      if (inside(it.poly, x, y)) return true
    }
    return false
  }

  /** Which fixture is here, for a click or a readout. */
  at(x: number, y: number): StuntFixture | null {
    let best: { f: StuntFixture; size: number } | null = null
    for (const it of this.items) {
      if (x < it.bbox[0] || x > it.bbox[2] || y < it.bbox[1] || y > it.bbox[3]) continue
      if (!inside(it.poly, x, y)) continue
      if (!best || it.size < best.size) best = { f: it.f, size: it.size }
    }
    return best?.f ?? null
  }
}

/* ---- validation -------------------------------------------------------------------------------- */

export function validateStunts(
  doc: StuntDoc | null | undefined,
  road?: (s: number, chain: number) => Pose | null,
  opts: StuntLinkOpts = {},
): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!doc) return { ok: true, errors, warnings }
  const seen = new Set<string>()
  const byId = new Map((doc.fixtures ?? []).map((f) => [f.id, f]))
  const resolve = opts.fixture ?? ((id: string) => byId.get(id) ?? null)
  for (const [i, f] of (doc.fixtures ?? []).entries()) {
    const where = f.id ? `fixture ${JSON.stringify(f.id)}` : `fixtures[${i}]`
    if (!f.id) errors.push(`${where} has no id`)
    else if (seen.has(f.id)) errors.push(`${where} is used twice`)
    else seen.add(f.id)
    if (!pieceOf(f.piece)) {
      errors.push(`${where} is a ${JSON.stringify(f.piece)}, which is not a piece this build has`)
      continue
    }
    if (!Number.isFinite(f.yaw_deg)) errors.push(`${where} has no yaw`)
    if (f.tightness !== undefined && (f.tightness < 0.25 || f.tightness > 2)) {
      warnings.push(`${where} tightness ${f.tightness} is outside 0.25…2 and will either kink or loop`)
    }
    /*
     * A FIXTURE JOINED TO ITSELF is the one link that cannot be drawn at all — the Hermite's two
     * ends would be two ports of the same piece, so the "curve" is a ribbon laid back over the
     * thing it came from. An error rather than a warning because there is no reading of it that
     * works.
     */
    const ends = endsOf(f)
    for (const which of ['entry', 'exit'] as const) {
      const e = ends[which]
      if (e.kind === 'fixture' && e.id === f.id) errors.push(`${where} joins its ${which} to itself`)
    }
    if (road) {
      /*
       * A WARNING, NOT AN ERROR, and the difference is not pedantic.
       *
       * These are statements about DRIVABILITY — the approach doubles back, the road does not reach
       * that far — and the document is perfectly well formed either way. Reported as errors they
       * refused the save; the editor's preview saves every file first; so one fixture somebody was
       * halfway through turning blocked the preview of the whole site, and blocked saving the
       * areas and placements beside it. Rich, 2026-09-29: *"Always get this when I try to
       * preview"*. Work in progress has to be saveable, or it cannot be put down and come back to.
       *
       * The things that are still ERRORS are the ones that make the file meaningless: no id, a
       * duplicate id, a piece this build does not have, a fixture joined to itself.
       *
       * AND AN UNJOINED END IS NOT REPORTED AT ALL. It was, until Rich asked for pieces standing in
       * a field; an open end is now a thing you chose, and a tool that complains about the state
       * you asked for is a tool you learn to ignore.
       */
      const c = connectFixture(f, road, { ...opts, fixture: resolve })
      for (const p of c?.problems ?? []) warnings.push(`${where}: ${p}`)
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** How an end reads in a panel or a list. */
export function describeEnd(end: StuntEnd, which: StuntPort): string {
  if (end.kind === 'none') return which === 'entry' ? 'open — nothing joins it' : 'open — it stops there'
  if (end.kind === 'road') return `road at ${end.s.toFixed(0)} m${end.chain ? ` on chain ${end.chain}` : ''}`
  return `${end.id}’s ${end.port ?? defaultPort(which)}`
}

/** One line for a list. */
export function describeFixture(f: StuntFixture): string {
  const def = pieceOf(f.piece)
  if (!def) return `${f.piece} — not a piece this build has`
  const { w, h } = fixtureSize(f)
  const bits = [def.label, `${w.toFixed(0)}×${h.toFixed(0)} m`, `${fixtureLength(f).toFixed(0)} m of track`]
  if (f.yaw_deg) bits.push(`${f.yaw_deg.toFixed(0)}°`)
  if (f.lift_m) bits.push(`${f.lift_m.toFixed(1)} m up`)
  return bits.join(' · ')
}


/* ---- the ribbon as plain numbers --------------------------------------------------------------- */

/**
 * The drivable surface of a run of poses, as positions and triangle indices.
 *
 * PLAIN ARRAYS, NO THREE. Two things need this geometry and only one of them is a renderer: the
 * other is the physics, which builds a triangle-mesh collider out of it so a loop can be driven
 * rather than looked at. Generating it twice from two copies of the same cross-product is how the
 * thing you see stops being the thing you hit.
 *
 * THE SITE FRAME, x east, y north, z up — `stuntmesh.ts` converts to three's on its way in. A
 * collider is built in the physics world's own frame and the physics world uses this one.
 *
 * ACROSS = TANGENT × NORMAL, never tangent × world-up: on a loop the tangent IS world-up twice, and
 * the cross product collapses there, pinching the road to nothing at the top and the bottom.
 */
/**
 * The direction of travel at a pose: the full one if it has it, its horizontal shadow otherwise.
 *
 * One function, because the renderer and the physics must agree about which way the road faces, and
 * two copies of "is `t3` there" is how they stop agreeing.
 */
export function tangentOf(p: Pose): { x: number; y: number; z: number } {
  const t = p.t3
  if (t) {
    const l = Math.hypot(t.x, t.y, t.z)
    if (l > 1e-6) return { x: t.x / l, y: t.y / l, z: t.z / l }
  }
  const l = Math.hypot(p.dx, p.dy) || 1
  return { x: p.dx / l, y: p.dy / l, z: 0 }
}

export function ribbonGeometry(path: Pose[], halfWidth: number): { positions: Float32Array; indices: Uint32Array } {
  const n = path.length
  if (n < 2) return { positions: new Float32Array(0), indices: new Uint32Array(0) }
  const positions = new Float32Array(n * 6)
  const indices = new Uint32Array((n - 1) * 6)
  for (let i = 0; i < n; i++) {
    const p = path[i]
    const up = p.up ?? { x: 0, y: 0, z: 1 }
    /*
     * THE TANGENT IS THE FULL ONE WHERE THERE IS ONE. `dx, dy` is the direction's shadow on the
     * map, which is the tangent only while the road is flat; on a loop's climb the two are sixty
     * degrees apart and the ribbon comes out sheared into a diagonal ridge.
     */
    const t = tangentOf(p)
    // re-square the normal against the tangent, so the width does not wobble through a corkscrew
    const d = up.x * t.x + up.y * t.y + up.z * t.z
    let ux = up.x - t.x * d
    let uy = up.y - t.y * d
    let uz = up.z - t.z * d
    const ul = Math.hypot(ux, uy, uz) || 1
    ux /= ul; uy /= ul; uz /= ul
    // across = tangent × normal: perpendicular to BOTH, so the road is flat from side to side
    const ax = t.y * uz - t.z * uy
    const ay = t.z * ux - t.x * uz
    const az = t.x * uy - t.y * ux
    const al = Math.hypot(ax, ay, az) || 1
    const hx = (ax / al) * halfWidth
    const hy = (ay / al) * halfWidth
    const hz = (az / al) * halfWidth
    const k = i * 6
    positions[k] = p.x - hx; positions[k + 1] = p.y - hy; positions[k + 2] = p.z - hz
    positions[k + 3] = p.x + hx; positions[k + 4] = p.y + hy; positions[k + 5] = p.z + hz
    if (i) {
      const a = (i - 1) * 2
      const j = (i - 1) * 6
      indices[j] = a; indices[j + 1] = a + 1; indices[j + 2] = a + 2
      indices[j + 3] = a + 1; indices[j + 4] = a + 3; indices[j + 5] = a + 2
    }
  }
  return { positions, indices }
}

/** Every drivable surface of a connected fixture: the approach, the stunt and the way out. */
export function fixtureGeometry(
  parts: { approach: Pose[]; through: Pose[]; departure: Pose[] },
  halfWidth: number,
): { positions: Float32Array; indices: Uint32Array } {
  const runs = [parts.approach, parts.through, parts.departure].filter((p) => p.length >= 2).map((p) => ribbonGeometry(p, halfWidth))
  const nPos = runs.reduce((a, r) => a + r.positions.length, 0)
  const nIdx = runs.reduce((a, r) => a + r.indices.length, 0)
  const positions = new Float32Array(nPos)
  const indices = new Uint32Array(nIdx)
  let po = 0
  let io = 0
  let base = 0
  for (const r of runs) {
    positions.set(r.positions, po)
    for (let i = 0; i < r.indices.length; i++) indices[io + i] = r.indices[i] + base
    base += r.positions.length / 3
    po += r.positions.length
    io += r.indices.length
  }
  return { positions, indices }
}
