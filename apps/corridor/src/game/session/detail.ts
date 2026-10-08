// Display ▸ Detail: one setting for how much geometry the world draws.
//
// Rich, 2026-10-08: "a main menu option under settings for detail, with low/med/high/ultra, and
// start with ultra putting everything max including props, high doing small props as low detail,
// and … for medium and low … a budget of high detail and low detail models for traffic, and low
// maybe puts everything at low detail. All knobs for LOD that are impacted by graphic detail
// should be reset when the detail level is updated, then you can override in the tuning panel."
//
// So a level is a set of LOD knob values (tuning.ts, the LOD tab's "models" section). Choosing a
// level writes all of them and forgets the panel's overrides of them; at load it writes only the
// ones the panel has not overridden. What a level does to each class:
//
//   ultra   everything at full detail
//   high    traffic and the hero at full; props and rewards simplified
//   medium  the nearest 24 traffic cars within 150 m at full, the rest simplified; props simplified
//   low     everything simplified, the hero car included
export type Detail = 'low' | 'medium' | 'high' | 'ultra'
export const DETAILS: Detail[] = ['low', 'medium', 'high', 'ultra']

export const DETAIL_PRESETS: Record<Detail, Record<string, number>> = {
  ultra: { LOD_TRAFFIC_RATIO: 0.05, LOD_TRAFFIC_FULL_N: 10000, LOD_TRAFFIC_FULL_M: 100000, LOD_HERO_RATIO: 1, LOD_PROP_RATIO: 1 },
  high: { LOD_TRAFFIC_RATIO: 0.05, LOD_TRAFFIC_FULL_N: 10000, LOD_TRAFFIC_FULL_M: 100000, LOD_HERO_RATIO: 1, LOD_PROP_RATIO: 0.05 },
  medium: { LOD_TRAFFIC_RATIO: 0.05, LOD_TRAFFIC_FULL_N: 24, LOD_TRAFFIC_FULL_M: 150, LOD_HERO_RATIO: 1, LOD_PROP_RATIO: 0.05 },
  low: { LOD_TRAFFIC_RATIO: 0.05, LOD_TRAFFIC_FULL_N: 0, LOD_TRAFFIC_FULL_M: 0, LOD_HERO_RATIO: 0.15, LOD_PROP_RATIO: 0.05 },
}

/** What the panel offers a preset: write a knob, and the names this browser has overridden. */
export interface DetailTarget {
  applyPreset: (values: Record<string, number>, force: boolean) => number
}

/**
 * Put a detail level's values into the knobs. `force` (the player chose a level): every knob, and
 * the panel's overrides of them are forgotten. Not forced (a page load): only the knobs the panel
 * has not overridden. Returns how many knobs moved.
 */
export function applyDetail(target: DetailTarget, level: Detail, force: boolean): number {
  return target.applyPreset(DETAIL_PRESETS[level] ?? DETAIL_PRESETS.ultra, force)
}
