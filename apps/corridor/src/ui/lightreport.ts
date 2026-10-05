// What the lighting panel reports, and the order it reports it in.
//
// Rich, 2026-10-05: *"I wanted a new panel ... that includes lighting reports, not just a new
// lights testing mode."* The performance panel says what the frame costs; this says what the
// LIGHTS are. Four reports, from the top down:
//
//   THE SCENE'S REAL INVENTORY. How many of each light are actually in the graph and how many are
//   switched on, how many cast shadows and at what resolution, and how many programs the renderer
//   has compiled — because a light that toggles changes the SHADER, and the count of programs is
//   how you see that happen.
//
//   THE FORWARD LOOP. three builds its `NUM_SPOT_LIGHTS` and friends from the visible
//   directional/spot/point count, so that total is the size of the per-fragment loop.
//
//   EACH TUNABLE FAMILY. Hero head, hero tail, traffic, fake flood: what mode each is in, how many
//   lamps it is actually running, and what it measured when it was last ablated.
//
//   EVERY LIGHT. One row per actual `Light` object, so a stray or a duplicate is visible.
//
// This file is pure — no DOM, no three — so the panel can be tested without a renderer, the same
// way `perf.ts` is.

export interface LightCount {
  /** `dir` | `spot` | `point` | `hemi` | `ambient` | `area` */
  type: string
  n: number
  on: number
}

export interface LightEntry {
  type: string
  family: string
  on: boolean
  intensity: number
  /** metres; 0 for a light with no range (directional, hemisphere) */
  distance: number
  /** degrees, spot cones only; 0 otherwise */
  angle: number
  shadow: boolean
}

export interface LightFamily {
  name: string
  /** `off` | `real` | `merged` | `fake` | `on` */
  mode: string
  lamps: number
  /** measured milliseconds, or null before the ablation has run */
  cost: number | null
}

export interface LightReport {
  counts: LightCount[]
  shadowCasters: number
  /** the largest shadow map among the casters, in texels per side */
  shadowMap: number
  programs: number
  families: LightFamily[]
  /** the whole composed frame's GPU time at the last ablation, or null */
  all: number | null
  measuredAt: number | null
  /** why the budget line has no number, when it has none */
  note: string | null
  lights: LightEntry[]
}

const TYPE_ORDER = ['dir', 'spot', 'point', 'hemi', 'ambient', 'area']
const ms = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} ms`)

/** The fixed part of the panel: everything but the per-light dump. */
export function lightLines(r: LightReport): string[] {
  const out: string[] = []

  const counts = [...r.counts].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
  const inv = counts.filter((c) => c.n > 0).map((c) => `${c.n} ${c.type}${c.on !== c.n ? ` (${c.on} on)` : ''}`)
  out.push(inv.length ? inv.join(' · ') : 'no lights in the scene')

  out.push(`shadow ${r.shadowCasters} caster${r.shadowCasters === 1 ? '' : 's'} · map ${r.shadowMap}² · ${r.programs} programs`)

  // three's forward loop is built from the visible directional + spot + point count, so this is the
  // size of the per-fragment light loop the standard materials actually run.
  const fwd = counts.filter((c) => c.type === 'dir' || c.type === 'spot' || c.type === 'point')
  const total = fwd.reduce((a, c) => a + c.on, 0)
  out.push(`loop ${fwd.map((c) => `${c.on} ${c.type}`).join(' + ') || '0'} = ${total} forward light${total === 1 ? '' : 's'}`)

  for (const f of r.families) {
    out.push(`${f.name.padEnd(7)} ${f.mode} · ${f.lamps} lamp${f.lamps === 1 ? '' : 's'} · ${ms(f.cost)}`)
  }

  if (r.all !== null) {
    const sum = r.families.reduce((a, f) => a + Math.max(0, f.cost ?? 0), 0)
    const share = r.all > 0 ? Math.round((sum / r.all) * 100) : 0
    const at = r.measuredAt ? new Date(r.measuredAt).toLocaleTimeString() : ''
    out.push(`budget ${r.all.toFixed(1)} ms all · ${sum.toFixed(1)} ms lights (${share}%)${at ? ` · ${at}` : ''}`)
  } else {
    out.push(`budget ${r.note ?? 'not measured — press measure'}`)
  }
  return out
}

/** One row per `Light` object. The panel scrolls it; this just formats. */
export function lightDumpRows(r: LightReport): string[] {
  return r.lights.map((l) => {
    const cone = l.type === 'spot' ? ` a${Math.round(l.angle)}°` : ''
    const dist = l.distance > 0 ? ` d${l.distance.toFixed(0)}` : ''
    return `${l.on ? '●' : '○'} ${l.type.padEnd(5)} ${(l.family || '—').padEnd(12)} i${l.intensity.toFixed(2)}${dist}${cone}${l.shadow ? ' shadow' : ''}`
  })
}
