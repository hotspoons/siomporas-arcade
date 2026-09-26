// Terrain exaggeration: Rich's "have fun with areas — exaggerate terrain".
//
// One affine transform on every absolute height, applied ONCE at load:
//
//     z' = z0 + k · (z − z0)
//
// with z0 the median grade of the primary road, so the spine stays where it was and the hills
// around it rise. Because it is the same affine map for the rasters (DEM tiles, the overview,
// the horizon — all through `decodeHeights`) and for every height the manifest carries (road
// profiles, bridge decks, water, power, signs…), everything that lay on the ground still lies on
// it, only steeper: the car gets real hills, the strip stays drivable, the buildings and trees
// read `heightAt` and follow for free. Relative offsets across the road (`profile.ground_rel`)
// scale by k for the same reason; heights of things (buildings, trees, poles) do not — a house is
// not terrain.
//
// It is a load-time transform, not a live knob: the geometry is built from these numbers. The
// viewer reads `?relief=` from the URL, else the stance, else the world's `look.relief` in the
// site's tuning.json (the world editor writes it), and a change reloads the site.

import type { Manifest } from './site'

let K = 1
let Z0 = 0

/** Set the exaggeration before anything decodes. k = 1 is the world as measured. */
export function setRelief(k: number, z0: number): void {
  K = Number.isFinite(k) && k > 0 ? k : 1
  Z0 = Number.isFinite(z0) ? z0 : 0
}

export function relief(): { k: number; z0: number } {
  return { k: K, z0: Z0 }
}

export const reliefZ = (z: number): number => (K === 1 ? z : Z0 + K * (z - Z0))

/** In place, on a decoded height raster. A no-op at k = 1, which is every ordinary load. */
export function reliefHeights(arr: Float32Array): Float32Array {
  if (K === 1) return arr
  for (let i = 0; i < arr.length; i++) arr[i] = Z0 + K * (arr[i] - Z0)
  return arr
}

/** Clamp what a URL or a world record may ask for. */
export function clampRelief(k: number): number {
  return Number.isFinite(k) ? Math.min(10, Math.max(0.25, k)) : 1
}

/** The median z of the spine: the datum the exaggeration turns about. */
export function spineDatum(m: Manifest): number {
  const zs = (m.spine?.coords ?? []).map((c) => c[2]).filter((z) => Number.isFinite(z)).sort((a, b) => a - b)
  return zs.length ? zs[zs.length >> 1] : 0
}

type XYZ = [number, number, number]
const coords3 = (cs: XYZ[] | null | undefined) => {
  if (!cs) return
  for (const c of cs) if (Number.isFinite(c[2])) c[2] = reliefZ(c[2])
}
const nums = (a: number[] | null | undefined, f: (z: number) => number) => {
  if (!a) return
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) a[i] = f(a[i])
}
const zOf = (o: { z?: number | null } | null | undefined) => {
  if (o && typeof o.z === 'number' && Number.isFinite(o.z)) o.z = reliefZ(o.z)
}

/**
 * Every absolute height the manifest carries, in place. Enumerated, not guessed: a field named
 * `height_m` is a thing's height (unchanged) except where it is a cut's, and `toe_m`/`top_m` on
 * a cut face are LATERAL offsets from the road, not heights.
 */
export function reliefManifest(m: Manifest): void {
  if (K === 1) return
  const scale = (v: number) => v * K
  coords3(m.spine?.coords as XYZ[])
  if (m.profile) {
    nums(m.profile.road_z, reliefZ)
    for (const a of Object.values(m.profile.ground_rel ?? {})) nums(a, scale)
  }
  for (const s of m.structures ?? []) {
    if (typeof s.deck_z_min === 'number') s.deck_z_min = reliefZ(s.deck_z_min)
    if (typeof s.deck_z_max === 'number') s.deck_z_max = reliefZ(s.deck_z_max)
  }
  for (const b of m.branches ?? []) {
    coords3(b.coords)
    for (const j of b.junctions ?? []) zOf(j)
    if (b.profile) nums(b.profile.road_z, reliefZ)
    for (const s of b.structures ?? []) {
      if (typeof s.deck_z_min === 'number') s.deck_z_min = reliefZ(s.deck_z_min)
      if (typeof s.deck_z_max === 'number') s.deck_z_max = reliefZ(s.deck_z_max)
    }
  }
  for (const d of m.driveways ?? []) coords3(d.coords)
  for (const s of m.stubs ?? []) coords3(s.coords)
  for (const b of m.barriers ?? []) coords3(b.coords)
  for (const s of m.sidewalks ?? []) coords3(s.coords)
  for (const p of m.parking ?? []) zOf(p)
  if (m.power) {
    for (const l of m.power.lines) coords3(l.coords)
    for (const s of m.power.supports) zOf(s)
  }
  if (m.signals) {
    for (const x of m.signals.masts) zOf(x)
    for (const x of m.signals.signs) zOf(x)
    for (const x of m.signals.bars ?? []) zOf(x)
  }
  if (m.water) {
    for (const l of m.water.lines ?? []) coords3(l.pts as XYZ[])
    for (const a of m.water.areas ?? []) zOf(a)
  }
  for (const f of m.cuts?.faces ?? []) {
    f.height_m = scale(f.height_m)
    if (typeof f.height_max_m === 'number') f.height_max_m = scale(f.height_max_m)
  }
}
