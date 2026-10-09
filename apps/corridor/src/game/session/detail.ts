// Display ▸ Detail: one setting for how much geometry the world draws.
//
// Rich, 2026-10-08: "a main menu option under settings for detail, with low/med/high/ultra, and
// start with ultra putting everything max including props, high doing small props as low detail,
// and … for medium and low … a budget of high detail and low detail models for traffic, and low
// maybe puts everything at low detail. All knobs for LOD that are impacted by graphic detail
// should be reset when the detail level is updated, then you can override in the tuning panel."
//
// So a level is a set of knob values: the model LODs (tuning.ts, the LOD tab's "models" section) and
// the existing knobs that cost the most GPU, measured on the DC Beltway 2026-10-08 — sun shadows
// (~5 ms), the hero's four real spot lights (~9.7 ms at night; mode 2 is the cheap analytic flood),
// the reflections (car probe live / snapshot / sky; the water mirror), the near-tree radius, grass,
// and the render resolution. Choosing a
// level writes all of them and forgets the panel's overrides of them; at load it writes only the
// ones the panel has not overridden. What a level does to each class:
//
//   ultra   everything at full detail, live reflections, real lamps
//   high    props simplified; the car's reflection a snapshot; fake tail lamps
//   medium  24 nearest traffic cars full; shorter shadows, no card shadows; sky-only water; fake
//           lamps; fewer near trees and less grass; 85% resolution
//   low     everything simplified, the hero too; no shadows; sky-only reflections; 70% resolution
//           (blob shadows for low are a later job)
export type Detail = 'low' | 'medium' | 'high' | 'ultra'
export const DETAILS: Detail[] = ['low', 'medium', 'high', 'ultra']

export const DETAIL_PRESETS: Record<Detail, Record<string, number>> = {
  // FULL-DETAIL TRAFFIC WITHIN 220 M, not everywhere: a 118k-triangle car 400 m away is forty
  // pixels tall, and at Ultra the jam in view was 8-13 M triangles a frame (2026-10-08). Within
  // 220 m the copy and the original cannot be told apart from the driver's seat.
  ultra: {
    LOD_TRAFFIC_RATIO: 0.05, LOD_TRAFFIC_FULL_N: 80, LOD_TRAFFIC_FULL_M: 220, LOD_HERO_RATIO: 1, LOD_PROP_RATIO: 1,
    SHADOW: 1, SHADOW_REACH: 95, SHADOW_CARDS: 1,
    CAR_PROBES: 1, WATER_REFLECT: 0.9, WATER_PROBES: 1,
    HERO_HEADLIGHTS_MODE: 1, HERO_TAILLIGHTS_MODE: 1,
    TREE_NEAR_RADIUS: 220, GRASS_DENSITY: 3.1, RENDER_SCALE: 1,
  },
  high: {
    LOD_TRAFFIC_RATIO: 0.05, LOD_TRAFFIC_FULL_N: 80, LOD_TRAFFIC_FULL_M: 220, LOD_HERO_RATIO: 1, LOD_PROP_RATIO: 0.05,
    SHADOW: 1, SHADOW_REACH: 95, SHADOW_CARDS: 1,
    CAR_PROBES: 2, WATER_REFLECT: 0.9, WATER_PROBES: 1,
    HERO_HEADLIGHTS_MODE: 1, HERO_TAILLIGHTS_MODE: 2,
    TREE_NEAR_RADIUS: 220, GRASS_DENSITY: 3.1, RENDER_SCALE: 1,
  },
  medium: {
    LOD_TRAFFIC_RATIO: 0.05, LOD_TRAFFIC_FULL_N: 24, LOD_TRAFFIC_FULL_M: 150, LOD_HERO_RATIO: 1, LOD_PROP_RATIO: 0.05,
    SHADOW: 1, SHADOW_REACH: 70, SHADOW_CARDS: 0,
    CAR_PROBES: 2, WATER_REFLECT: 0, WATER_PROBES: 0,
    HERO_HEADLIGHTS_MODE: 2, HERO_TAILLIGHTS_MODE: 2,
    TREE_NEAR_RADIUS: 150, GRASS_DENSITY: 2, RENDER_SCALE: 0.85,
  },
  low: {
    LOD_TRAFFIC_RATIO: 0.05, LOD_TRAFFIC_FULL_N: 0, LOD_TRAFFIC_FULL_M: 0, LOD_HERO_RATIO: 0.15, LOD_PROP_RATIO: 0.05,
    SHADOW: 0, SHADOW_REACH: 70, SHADOW_CARDS: 0,
    CAR_PROBES: 0, WATER_REFLECT: 0, WATER_PROBES: 0,
    HERO_HEADLIGHTS_MODE: 2, HERO_TAILLIGHTS_MODE: 2,
    TREE_NEAR_RADIUS: 80, GRASS_DENSITY: 1.2, RENDER_SCALE: 0.7,
  },
}

/** What the panel offers a preset: write a knob, and the names this browser has overridden. */
export interface DetailTarget {
  applyPreset: (values: Record<string, number>, force: boolean, notify?: boolean) => number
}

/**
 * Put a detail level's values into the knobs. `force` (the player chose a level): every knob, and
 * the panel's overrides of them are forgotten. Not forced (a page load): only the knobs the panel
 * has not overridden. Returns how many knobs moved.
 */
export function applyDetail(target: DetailTarget, level: Detail, force: boolean, notify = force): number {
  return target.applyPreset(DETAIL_PRESETS[level] ?? DETAIL_PRESETS.ultra, force, notify)
}
