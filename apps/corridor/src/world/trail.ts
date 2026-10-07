import * as THREE from 'three'

/**
 * Trails and railways: what a path is MADE of, and the shape a rail is drawn with.
 *
 * A path is not a carriageway. It has no kerb, no lane, no edge line and often no asphalt — and the
 * one thing that says which it is is `trailblazed` (OpenStreetMap's own "is this a designated
 * trail?" marker) and `surface`. Rich, 2026-10-06: *"render trails and railways (use trailblazed to
 * decide 'paving', e.g. dirt)"*. This module owns that decision, the rail's dimensions, and the
 * ribbon `buildTrailsAndRail` sweeps from them.
 *
 * The ways ride the `sidewalks` stream, under their own `kind`, not the branch stream: `sidewalks`
 * is already tiled and bucketed per cell, so a path streams with its own kilometre and no viewer
 * wiring is needed. `buildSidewalks` routes those kinds here instead of sweeping concrete.
 */

/** What a trail's ribbon is surfaced with. Not OSM's vocabulary — the three the renderer has. */
export type TrailPaving = 'dirt' | 'gravel' | 'paved'

const PAVED = new Set(['asphalt', 'concrete', 'paved', 'paving_stones', 'concrete:plates', 'metal', 'wood', 'chipseal', 'sealed'])
const GRAVEL = new Set(['gravel', 'fine_gravel', 'pebblestone', 'compacted', 'unpaved', 'cobblestone', 'sett'])
const DIRT = new Set(['dirt', 'earth', 'ground', 'mud', 'grass', 'sand', 'soil', 'clay', 'grass_paver'])

/**
 * Which ribbon draws this trail.
 *
 * `surface` is explicit and wins; `trailblazed` is the fallback the ask names — `paved` there is a
 * paved greenway, `unpaved`/`yes`/anything else is the dirt path a trail usually is. A way with
 * neither is DIRT, not asphalt: an untagged path is almost always the wild one, and defaulting it
 * to asphalt is exactly the mistake the ask is about.
 */
export function trailPaving(tags: Record<string, string | null | undefined>): TrailPaving {
  const surface = (tags.surface ?? '').split(';')[0]!.trim().toLowerCase()
  if (surface) {
    if (PAVED.has(surface)) return 'paved'
    if (GRAVEL.has(surface)) return 'gravel'
    if (DIRT.has(surface)) return 'dirt'
    if (surface.includes('asphalt') || surface.includes('concrete') || surface.includes('pav')) return 'paved'
    if (surface.includes('gravel') || surface.includes('compact')) return 'gravel'
    return 'dirt'
  }
  const blaze = (tags.trailblazed ?? tags.trail_visibility ?? '').trim().toLowerCase()
  if (blaze === 'paved' || blaze === 'sealed') return 'paved'
  return 'dirt'
}

/** standard gauge (m), and the ballast ribbon a rail is drawn on */
export const RAIL_GAUGE_M = 1.435
export const RAIL_BALLAST_W = 3.4
/** how far from the eye a railway is worth drawing in full (rails + sleepers) before it drops to a
 *  ballast ribbon alone; a rail is thin and distant rail is indistinguishable from its bed */
export const RAIL_VIEW_M = 220

/** how wide a walk of each OSM kind is drawn when it carries no `width` tag (m) */
export const TRAIL_DEFAULT_W: Record<string, number> = {
  path: 1.4, footway: 1.4, cycleway: 2.0, bridleway: 1.6, steps: 1.4, pedestrian: 3.0,
}
/** a trail is laid a little proud of the ground so it is not z-fighting the terrain under it (m) */
export const TRAIL_LIFT_M = 0.06
/** rail steel sits on top of its ballast (m), and is drawn this narrow (m) */
export const RAIL_STEEL_LIFT_M = 0.16
export const RAIL_STEEL_W = 0.09

/** The ribbon colours, one material each. Not textures: these are metres across and seen at speed. */
const TRAIL_HEX: Record<TrailPaving, number> = { dirt: 0x8a6b4a, gravel: 0xa39d92, paved: 0x8d8d86 }
const RAIL_BALLAST_HEX = 0x6f6a63
const RAIL_STEEL_HEX = 0x9aa0a6

/** One baked path or rail way, as it arrives on `manifest.sidewalks`. */
export interface TrailRun {
  kind: string
  width_m: number
  coords: number[][]
  surface?: string | null
  trailblazed?: string | null
  id?: string
}

/**
 * Returns the trail/rail runs a bake kind maps to, or null when the kind is a real walk (a sidewalk
 * or crossing) that `buildSidewalks` should sweep as concrete. Kept here so the routing and the
 * material are decided in one place.
 */
export function trailKind(kind: string): boolean {
  return kind !== 'sidewalk' && kind !== 'crossing'
}

/** accumulate one ribbon into a shared position/index buffer, one mesh per colour at the end */
function ribbon(
  pts: { x: number; z: number; y: number }[],
  w: number,
  lift: number,
  lateral: number,
  pos: number[],
  idx: number[],
): number {
  const n = pts.length
  if (n < 2) return 0
  const base = pos.length / 3
  let metres = 0
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    let tx = b.x - a.x
    let tz = b.z - a.z
    const l = Math.hypot(tx, tz) || 1
    tx /= l
    tz /= l
    const nx = -tz
    const nz = tx
    const cx = pts[i].x + nx * lateral
    const cz = pts[i].z + nz * lateral
    const y = pts[i].y + lift
    pos.push(cx + (nx * w) / 2, y, cz + (nz * w) / 2)
    pos.push(cx - (nx * w) / 2, y, cz - (nz * w) / 2)
    if (i > 0) {
      const p = base + (i - 1) * 2
      idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2)
      metres += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
    }
  }
  return metres
}

// A long way is written into every tile it crosses (export.py `_WAY_COORDS`), so the same path can
// arrive from two cells. `takeBranch` dedupes roads by id; trails ride `sidewalks`, which has no
// such dedupe, so this does it. Page-lifetime, like the `_vtiles` cache: it resets on a reload and
// clears when the slug changes, which is the same scope every other viewer cache here uses.
let drawnSlug = ''
const drawnTrailIds = new Set<string>()

/**
 * Sweep every baked trail and railway into a few meshes: one per paving (dirt/gravel/paved), one
 * ballast and one steel for the rails. No kerb, no clip, no corner join — a path has none of those,
 * which is the whole point.
 */
export function buildTrailsAndRail(
  runs: TrailRun[],
  groundAt: (x: number, z: number) => number | null,
  slug: string,
): { group: THREE.Group; counts: { trails: number; rail: number; metres: number } } {
  const group = new THREE.Group()
  group.name = 'trails'
  const counts = { trails: 0, rail: 0, metres: 0 }
  if (slug !== drawnSlug) {
    drawnSlug = slug
    drawnTrailIds.clear()
  }
  const sweeps = new Map<number, { pos: number[]; idx: number[]; sees: boolean }>()
  const sweep = (hex: number) => {
    let s = sweeps.get(hex)
    if (!s) {
      s = { pos: [], idx: [], sees: false }
      sweeps.set(hex, s)
    }
    return s
  }

  for (const r of runs) {
    if (!trailKind(r.kind)) continue
    const id = r.id
    if (id) {
      const key = slug + '|' + id
      if (drawnTrailIds.has(key)) continue
      drawnTrailIds.add(key)
    }
    const raw = r.coords
    if (!raw || raw.length < 2) continue
    const pts = raw.map((p) => {
      const x = p[0]
      const z = -p[1]
      return { x, z, y: groundAt(x, z) ?? p[2] }
    })
    if (r.kind === 'rail') {
      const ballast = sweep(RAIL_BALLAST_HEX)
      counts.metres += ribbon(pts, RAIL_BALLAST_W, TRAIL_LIFT_M, 0, ballast.pos, ballast.idx)
      const steel = sweep(RAIL_STEEL_HEX)
      const half = RAIL_GAUGE_M / 2
      ribbon(pts, RAIL_STEEL_W, TRAIL_LIFT_M + RAIL_STEEL_LIFT_M, half, steel.pos, steel.idx)
      ribbon(pts, RAIL_STEEL_W, TRAIL_LIFT_M + RAIL_STEEL_LIFT_M, -half, steel.pos, steel.idx)
      counts.rail++
    } else {
      const paving = trailPaving({ surface: r.surface, trailblazed: r.trailblazed })
      const s = sweep(TRAIL_HEX[paving])
      const w = Math.max(0.6, Math.min(6, r.width_m || TRAIL_DEFAULT_W[r.kind] || 1.4))
      counts.metres += ribbon(pts, w, TRAIL_LIFT_M, 0, s.pos, s.idx)
      counts.trails++
    }
  }

  for (const [hex, s] of sweeps) {
    if (!s.idx.length) continue
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3))
    g.setIndex(s.idx)
    g.computeVertexNormals()
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }))
    mesh.name = `trail:${hex.toString(16)}`
    mesh.frustumCulled = false
    group.add(mesh)
  }
  counts.metres = Math.round(counts.metres)
  return { group, counts }
}
