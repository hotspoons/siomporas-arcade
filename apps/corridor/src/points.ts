// Points: the named places a game starts, ends and passes through — and where a world opens.
//
// Rich, 2026-09-30: "we need the ability to set the home point for the world by default as well
// as home points per scenario — maybe replace races tab with something more generic to cover
// additional game fixtures like level start points and end points (make it so we can name them)
// where driving or walking or flying (in 3 dimensions so we can support flying levels, default to
// ground)".
//
// `sites/<slug>/points.json` holds them. A point is a place in the site frame (x east, y north,
// metres), a heading, a kind, and how you are there: driving, walking or flying. Its height is
// the ground unless it says otherwise — `lift_m` above the ground for a flying start, or an
// absolute `z` for a place in the air. `home` names the point the world opens at when no level
// says; a level's `start` names its own. The viewer's `startPose` resolves level → home → the
// bake's photo station, which is where every world has always opened.

import type { FrameStamp } from './editor/schema'

export const POINT_KINDS = ['home', 'start', 'finish', 'checkpoint', 'spot'] as const
export type PointKind = (typeof POINT_KINDS)[number]
export const POINT_MODES = ['drive', 'walk', 'fly'] as const
export type PointMode = (typeof POINT_MODES)[number]

export interface Point {
  id: string
  name: string
  kind: PointKind
  /** how you are there. Absent: the level's mode, else driving */
  mode?: PointMode
  /** site frame, metres: x east, y north */
  at: [number, number]
  /** metres above the ground here; a flying start hovers */
  lift_m?: number
  /** an absolute height, metres, when the ground is not the reference (a point in the air over a valley) */
  z?: number | null
  /** degrees anticlockwise from east, the way the road's `yaw_deg` is written everywhere else */
  yaw_deg: number
  /** what the level shows on arrival, for a finish or a checkpoint */
  note?: string
}

export interface PointsDoc {
  version: 1
  frame?: FrameStamp
  /** the point the world opens at when no level names one */
  home?: string | null
  points: Point[]
}

export const EMPTY_POINTS: PointsDoc = { version: 1, points: [] }

const dataBase = () => (typeof location === 'undefined' ? '' : (new URLSearchParams(location.search).get('data') ?? ''))

export async function loadPoints(slug: string, base = dataBase()): Promise<PointsDoc> {
  try {
    const r = await fetch(`${base}/sites/${slug}/points.json`, { cache: 'no-cache' })
    if (!r.ok) return { ...EMPTY_POINTS, points: [] }
    const text = (await r.text()).trimStart()
    if (!text.startsWith('{')) return { ...EMPTY_POINTS, points: [] }
    const doc = JSON.parse(text) as PointsDoc
    return { ...doc, version: 1, points: doc.points ?? [] }
  } catch {
    return { ...EMPTY_POINTS, points: [] }
  }
}

export async function savePoints(slug: string, doc: PointsDoc): Promise<number> {
  const r = await fetch(`/sites/${slug}/points.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc, null, 1) })
  const j = (await r.json()) as { ok: boolean; bytes?: number; error?: string }
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j.bytes ?? 0
}

/** The world's home point, if it has one. */
export function homeOf(doc: PointsDoc | null | undefined): Point | null {
  if (!doc) return null
  const byId = doc.home ? doc.points.find((p) => p.id === doc.home) : null
  return byId ?? doc.points.find((p) => p.kind === 'home') ?? null
}

/** The point a level starts at: its own, else the world's home. */
export function startOf(doc: PointsDoc | null | undefined, levelStart: string | null | undefined): Point | null {
  if (!doc) return null
  if (levelStart) {
    const p = doc.points.find((x) => x.id === levelStart)
    if (p) return p
  }
  return homeOf(doc)
}

/** Every problem with a document, in words; empty is valid. */
export function validatePoints(doc: PointsDoc): string[] {
  const out: string[] = []
  const ids = new Set<string>()
  for (const [i, p] of doc.points.entries()) {
    const at = `points[${i}]`
    if (!p.id) out.push(`${at} has no id`)
    else if (ids.has(p.id)) out.push(`${at}: id ${p.id} is used twice`)
    ids.add(p.id)
    if (!(POINT_KINDS as readonly string[]).includes(p.kind)) out.push(`${at}: kind ${JSON.stringify(p.kind)} is not one of ${POINT_KINDS.join(', ')}`)
    if (p.mode !== undefined && !(POINT_MODES as readonly string[]).includes(p.mode)) out.push(`${at}: mode ${JSON.stringify(p.mode)} is not one of ${POINT_MODES.join(', ')}`)
    if (!Array.isArray(p.at) || p.at.length !== 2 || !p.at.every((v) => Number.isFinite(v))) out.push(`${at}: at is [x, y] metres`)
    if (!Number.isFinite(p.yaw_deg)) out.push(`${at}: yaw_deg is a number`)
    if (p.lift_m !== undefined && !(Number.isFinite(p.lift_m) && p.lift_m >= 0)) out.push(`${at}: lift_m is metres above the ground`)
  }
  if (doc.home && !ids.has(doc.home)) out.push(`home names ${doc.home}, which is not a point`)
  return out
}
