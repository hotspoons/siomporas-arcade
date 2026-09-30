// Reading and writing `sites/<slug>/stunts.json`.
//
// The same shape as `zonestore.ts`, and separate from it for the same reason both are separate from
// `schema.ts`: three documents with three lifetimes. Adjustments correct the bake, zones describe a
// level's traffic, and stunts are structures that replace a stretch of road. A re-bake that fixes
// the canopy must not touch anybody's loop.

import type { StuntDoc } from '../stunts'

/** A published viewer is read-only, so authoring is off there — the rule `schema.ts` calls CAN_SAVE. */
const base = new URLSearchParams(location.search).get('data') ?? ''
export const CAN_SAVE_STUNTS = base === ''

export async function loadStunts(slug: string): Promise<StuntDoc> {
  const empty: StuntDoc = { version: 1, fixtures: [] }
  const r = await fetch(`${base}/sites/${slug}/stunts.json`, { cache: 'no-cache' })
  if (r.status === 404) return empty // never authored: the normal case, not an error
  if (!r.ok) throw new Error(`stunts.json: HTTP ${r.status}`)
  /*
   * SNIFF THE BODY. In dev a missing file is not a 404 — the bake middleware calls next(), Vite's
   * SPA fallback answers with index.html, and `r.json()` dies on a tag. A body that opens with `{`
   * and still fails to parse is a real file we have corrupted, and that must throw: returning
   * `empty` there would silently overwrite the author's work on the next save.
   */
  const text = (await r.text()).trimStart()
  if (!text.startsWith('{')) return empty
  return JSON.parse(text) as StuntDoc
}

export async function saveStunts(slug: string, doc: StuntDoc): Promise<number> {
  if (!CAN_SAVE_STUNTS) throw new Error('read-only: this viewer is pointed at a published bucket')
  const r = await fetch(`/sites/${slug}/stunts.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc, null, 1),
  })
  const j = (await r.json()) as { ok: boolean; bytes?: number; error?: string }
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j.bytes ?? 0
}
