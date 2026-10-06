/**
 * Trails and railways: what a path is MADE of, and the shape a rail is drawn with.
 *
 * A path is not a carriageway. It has no kerb, no lane, no edge line and often no asphalt — and the
 * one thing that says which it is is `trailblazed` (OpenStreetMap's own "is this a designated
 * trail?" marker) and `surface`. Rich, 2026-10-06: *"render trails and railways (use trailblazed to
 * decide 'paving', e.g. dirt)"*. This module owns only that decision and the rail's dimensions, kept
 * pure so a wrong material is a one-line test and not a screenshot.
 *
 * The bake does not carry these ways into the branch stream yet (network.py drops footway/path/
 * cycleway/track, and rail is not a road at all) — see `PLAN-STREET-FURNITURE.md` §6. When it does,
 * `trailMesh` belongs beside this and reads `trailPaving` to pick the ribbon's material.
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
