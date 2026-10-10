// Reading and writing `sites/<slug>/courses.json` — the circuits and stages of one world.
//
// The fourth of the authored documents, and separate from the other three for the same reason they
// are separate from each other: adjustments correct the bake, zones describe a level's traffic,
// stunts are structures that replace road, and a course is a route through all of it. A world can
// carry a dozen stages and no stunts, or the other way round.

import type { CourseDoc } from '../../game/race/races'
import { param } from '../../url'

const base = param('data') ?? ''
export const CAN_SAVE_COURSES = base === ''

export async function loadCourses(slug: string): Promise<CourseDoc> {
  const empty: CourseDoc = { version: 1, courses: [] }
  const r = await fetch(`${base}/sites/${slug}/courses.json`, { cache: 'no-cache' })
  if (r.status === 404) return empty
  if (!r.ok) throw new Error(`courses.json: HTTP ${r.status}`)
  // a missing file is not a 404 in dev — Vite's SPA fallback answers with index.html. Sniff it.
  const text = (await r.text()).trimStart()
  if (!text.startsWith('{')) return empty
  return JSON.parse(text) as CourseDoc
}

export async function saveCourses(slug: string, doc: CourseDoc): Promise<number> {
  if (!CAN_SAVE_COURSES) throw new Error('read-only: this viewer is pointed at a published bucket')
  const r = await fetch(`/sites/${slug}/courses.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc, null, 1),
  })
  const j = (await r.json()) as { ok: boolean; bytes?: number; error?: string }
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j.bytes ?? 0
}
