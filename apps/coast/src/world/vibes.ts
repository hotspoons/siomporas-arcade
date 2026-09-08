// Vibes: the time of day and the weather, as a thing you place on a track
// rather than a property of the scenery. Rad Mobile's stages slid from dusk
// into night and out the other side into rain; a track here can do the same by
// dropping two or three vibe stops along it.
//
// A vibe owns the sky (its colours, the sun's place and size, the clouds, the
// fog) and a grade — a multiply-and-tint that pulls the scene's own ground,
// tarmac and rail colours toward the light of that hour. The scene keeps its
// identity (grass is green in the forest, sand is sand in the desert); the vibe
// decides what hour it is. `night` and `rain` are continuous, so a crossfade
// between two vibes really does bring the dark and the weather in gradually.

import type { Palette } from '../render/RenderTuning'
import type { VibeStop } from './types'

export interface VibeDef {
  id: string
  name: string
  /** 0 = broad daylight, 1 = full night: drives the ambient, the headlight nag and the stars. */
  night: number
  /** 0..1 rain: streaks on the screen and drops on the glass. */
  rain: number
  /** 1 = everything roadside is a black cut-out against the sky (the OutRun sunset). */
  silhouette: number
  skyTop: number
  skyBottom: number
  sun: number
  sunPos: [number, number]
  sunSize: number
  fog: number
  clouds: number
  /** Ground grade: multiply the scene's colours by `mul`, then pull `tint` in by `tintAmount`. */
  mul: number
  tint: number
  tintAmount: number
  /** Multiplier on the fog density (weather closes the view in). */
  fogK: number
}

const V = (d: VibeDef): VibeDef => d

/** Ordered as the day runs, so the editor's list reads like a clock. */
export const VIBES: Record<string, VibeDef> = {
  dawn: V({ id: 'dawn', name: 'Dawn', night: 0.18, rain: 0, silhouette: 0, skyTop: 0x2a3a7a, skyBottom: 0xffc0a0, sun: 0xffe8c0, sunPos: [0.32, 0.44], sunSize: 2.2, fog: 0xffc8a8, clouds: 0xffb090, mul: 0.82, tint: 0xff9a70, tintAmount: 0.24, fogK: 1.15 }),
  day: V({ id: 'day', name: 'Day', night: 0, rain: 0, silhouette: 0, skyTop: 0x1a4a9a, skyBottom: 0x8fd0ff, sun: 0xfff1b0, sunPos: [0.7, 0.62], sunSize: 1, fog: 0x9fd8ff, clouds: 0xffffff, mul: 1, tint: 0xffffff, tintAmount: 0, fogK: 1 }),
  overcast: V({ id: 'overcast', name: 'Overcast', night: 0, rain: 0, silhouette: 0, skyTop: 0x6a7a8a, skyBottom: 0xc0c8d0, sun: 0xd8dce0, sunPos: [0.7, 0.75], sunSize: 0.8, fog: 0xc0c8d0, clouds: 0x9aa4ae, mul: 0.84, tint: 0x8090a0, tintAmount: 0.22, fogK: 1.25 }),
  fogbank: V({ id: 'fogbank', name: 'Sea fog', night: 0.05, rain: 0, silhouette: 0, skyTop: 0xb0b8bc, skyBottom: 0xd8dce0, sun: 0xf0f0f0, sunPos: [0.6, 0.8], sunSize: 1.4, fog: 0xd0d4d8, clouds: 0xc8ccd0, mul: 0.92, tint: 0xc0c8cc, tintAmount: 0.4, fogK: 3.1 }),
  rain: V({ id: 'rain', name: 'Rain', night: 0.12, rain: 1, silhouette: 0, skyTop: 0x3a4a5a, skyBottom: 0x8a98a4, sun: 0xb8c0c8, sunPos: [0.7, 0.8], sunSize: 0.6, fog: 0x8a98a4, clouds: 0x6a7480, mul: 0.68, tint: 0x50606a, tintAmount: 0.32, fogK: 1.5 }),
  sunset: V({ id: 'sunset', name: 'Sunset', night: 0.2, rain: 0, silhouette: 1, skyTop: 0x5a0a2a, skyBottom: 0xffc020, sun: 0xffe070, sunPos: [0.5, 0.36], sunSize: 3.4, fog: 0xffa040, clouds: 0xff8040, mul: 0.46, tint: 0x1a060c, tintAmount: 0.5, fogK: 1.1 }),
  twilight: V({ id: 'twilight', name: 'Twilight', night: 0.5, rain: 0, silhouette: 0.35, skyTop: 0x120a3a, skyBottom: 0x6a4a8a, sun: 0xffd0a0, sunPos: [0.5, 0.3], sunSize: 2, fog: 0x4a3a6a, clouds: 0x3a2a5a, mul: 0.54, tint: 0x2a2050, tintAmount: 0.38, fogK: 1.2 }),
  night: V({ id: 'night', name: 'Night', night: 1, rain: 0, silhouette: 0, skyTop: 0x050515, skyBottom: 0x2a1a5a, sun: 0xf0f4ff, sunPos: [0.78, 0.8], sunSize: 0.7, fog: 0x1a1030, clouds: 0x201838, mul: 0.36, tint: 0x101830, tintAmount: 0.5, fogK: 1.1 }),
  neon: V({ id: 'neon', name: 'Neon night', night: 1, rain: 0, silhouette: 0, skyTop: 0x080418, skyBottom: 0x46184a, sun: 0xffb0e0, sunPos: [0.2, 0.82], sunSize: 0.9, fog: 0x2a1038, clouds: 0x2a1030, mul: 0.42, tint: 0x2a1038, tintAmount: 0.42, fogK: 1.05 }),
  rainNight: V({ id: 'rainNight', name: 'Rain · night', night: 1, rain: 1, silhouette: 0, skyTop: 0x04060e, skyBottom: 0x1a2438, sun: 0xc8d4e0, sunPos: [0.8, 0.86], sunSize: 0.5, fog: 0x121a26, clouds: 0x141c28, mul: 0.31, tint: 0x0e1620, tintAmount: 0.5, fogK: 1.55 }),
  storm: V({ id: 'storm', name: 'Storm', night: 0.8, rain: 1, silhouette: 0, skyTop: 0x080a14, skyBottom: 0x26303e, sun: 0xffffff, sunPos: [0.7, 0.9], sunSize: 0.4, fog: 0x1a2028, clouds: 0x1a2028, mul: 0.34, tint: 0x101820, tintAmount: 0.48, fogK: 1.7 }),
}

export const VIBE_IDS: string[] = Object.keys(VIBES)
/** Default crossfade between two vibe stops, as a fraction of the track. */
export const VIBE_FADE = 0.14

export function vibeDef(id: string): VibeDef {
  return VIBES[id] ?? VIBES.day
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Linear blend of two packed RGB colours. */
export function mixRgb(a: number, b: number, t: number): number {
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, t))
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, t))
  const bl = Math.round(lerp(a & 255, b & 255, t))
  return (r << 16) | (g << 8) | bl
}

export function blendVibe(a: VibeDef, b: VibeDef, t: number): VibeDef {
  if (t <= 0) return a
  if (t >= 1) return b
  return {
    id: `${a.id}~${b.id}`,
    name: `${a.name} → ${b.name}`,
    night: lerp(a.night, b.night, t),
    rain: lerp(a.rain, b.rain, t),
    silhouette: lerp(a.silhouette, b.silhouette, t),
    skyTop: mixRgb(a.skyTop, b.skyTop, t),
    skyBottom: mixRgb(a.skyBottom, b.skyBottom, t),
    sun: mixRgb(a.sun, b.sun, t),
    sunPos: [lerp(a.sunPos[0], b.sunPos[0], t), lerp(a.sunPos[1], b.sunPos[1], t)],
    sunSize: lerp(a.sunSize, b.sunSize, t),
    fog: mixRgb(a.fog, b.fog, t),
    clouds: mixRgb(a.clouds, b.clouds, t),
    mul: lerp(a.mul, b.mul, t),
    tint: mixRgb(a.tint, b.tint, t),
    tintAmount: lerp(a.tintAmount, b.tintAmount, t),
    fogK: lerp(a.fogK, b.fogK, t),
  }
}

/**
 * The vibe in force at `at` (0..1 of the track). Stops are sorted; each one
 * crossfades in over its own `fade` window, centred on its position, so a stop
 * placed at 0.5 has fully arrived by 0.5 + fade/2 and the change reads as the
 * hour turning rather than a cut.
 */
function ordered(stops: readonly VibeStop[]): readonly VibeStop[] {
  for (let i = 1; i < stops.length; i++) if (stops[i].at < stops[i - 1].at) return [...stops].sort((p, q) => p.at - q.at)
  return stops
}

/**
 * How dark and how wet it is at `at`, without building a whole vibe — the sim asks
 * this every tick (it decides whether the headlights and wipers are wanted).
 */
export function weatherAt(stops: readonly VibeStop[], at: number, out: { night: number; rain: number }): void {
  const s = ordered(stops)
  if (!s.length) {
    out.night = 0
    out.rain = 0
    return
  }
  let night = vibeDef(s[0].vibe).night
  let rain = vibeDef(s[0].vibe).rain
  for (let i = 1; i < s.length; i++) {
    const fade = Math.max(0.001, s[i].fade ?? VIBE_FADE)
    const t0 = s[i].at - fade / 2
    if (at <= t0) break
    const raw = Math.min(1, (at - t0) / fade)
    const t = raw * raw * (3 - 2 * raw)
    const v = vibeDef(s[i].vibe)
    night = lerp(night, v.night, t)
    rain = lerp(rain, v.rain, t)
    if (raw < 1) break
  }
  out.night = night
  out.rain = rain
}

export function vibeAt(stops: readonly VibeStop[], at: number): VibeDef {
  if (!stops.length) return VIBES.day
  const s = ordered(stops)
  let cur = vibeDef(s[0].vibe)
  for (let i = 1; i < s.length; i++) {
    const stop = s[i]
    const fade = Math.max(0.001, stop.fade ?? VIBE_FADE)
    const t0 = stop.at - fade / 2
    if (at <= t0) break
    const next = vibeDef(stop.vibe)
    const t = Math.min(1, (at - t0) / fade)
    cur = blendVibe(cur, next, t * t * (3 - 2 * t))
    if (t >= 1) continue
    break
  }
  return cur
}

/** Grade one scene colour by a vibe: darken, then pull toward the vibe's tint. */
export function gradeColor(c: number, v: VibeDef): number {
  const r = Math.min(255, ((c >> 16) & 255) * v.mul)
  const g = Math.min(255, ((c >> 8) & 255) * v.mul)
  const b = Math.min(255, (c & 255) * v.mul)
  const dim = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
  return mixRgb(dim, v.tint, v.tintAmount)
}

/**
 * The palette the renderer should use: the scene's own ground colours graded by
 * the vibe, under the vibe's sky. Signage and lane paint keep more of their own
 * colour than the land does — at night a white line still reads as white.
 */
export function paletteFor(scene: Palette, v: VibeDef): Palette {
  const g = (c: number) => gradeColor(c, v)
  const half: VibeDef = { ...v, mul: (v.mul + 1) / 2, tintAmount: v.tintAmount * 0.5 }
  const gh = (c: number) => gradeColor(c, half)
  const out: Palette = {
    skyTop: v.skyTop,
    skyBottom: v.skyBottom,
    sun: v.sun,
    fog: v.fog,
    grassA: g(scene.grassA),
    grassB: g(scene.grassB),
    roadA: g(scene.roadA),
    roadB: g(scene.roadB),
    rumbleA: gh(scene.rumbleA),
    rumbleB: gh(scene.rumbleB),
    lane: gh(scene.lane),
    far: g(scene.far),
    near: g(scene.near),
    shoulder: g(scene.shoulder),
    rail: gh(scene.rail),
    clouds: v.clouds,
    sunPos: v.sunPos,
    sunSize: v.sunSize,
  }
  if (scene.sand !== undefined) out.sand = g(scene.sand)
  if (scene.water !== undefined) out.water = g(scene.water)
  return out
}

/** Blend two palettes end to end (for a scene change part-way along a track). */
export function blendPalette(a: Palette, b: Palette, t: number): Palette {
  if (t <= 0) return a
  if (t >= 1) return b
  const out = {} as Palette
  const keys = Object.keys(a) as (keyof Palette)[]
  for (const k of keys) {
    const av = a[k]
    const bv = b[k]
    if (k === 'sunPos') {
      const p = (av ?? [0.7, 0.62]) as [number, number]
      const q = (bv ?? [0.7, 0.62]) as [number, number]
      out.sunPos = [lerp(p[0], q[0], t), lerp(p[1], q[1], t)]
    } else if (k === 'sunSize') out.sunSize = lerp((av as number) ?? 1, (bv as number) ?? 1, t)
    else if (typeof av === 'number' && typeof bv === 'number') (out[k] as number) = mixRgb(av, bv, t)
    else if (typeof av === 'number') (out[k] as number) = av
  }
  return out
}
