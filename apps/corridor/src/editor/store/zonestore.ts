// Reading and writing `sites/<slug>/zones.json`.
//
// Its own file rather than two more lines in `editor/schema.ts` for one reason: `schema.ts` is the
// ADJUSTMENT schema — its `load`/`save` are private to it and its types are the bake's corrections.
// A zone is a different document with a different lifetime, and bolting it on would make the next
// person reading `schema.ts` believe the two are the same kind of thing. The transport is
// deliberately identical, including the "a missing file is not an error" rule.

import type { ZoneDoc } from '../../game/world/zones'

/**
 * A published viewer is read-only, so authoring is off there.
 *
 * The same rule as `CAN_SAVE` in `schema.ts`, restated here rather than imported so this file does
 * not pull the adjustment schema in: `?data=` pointed at a bucket means somebody is looking at a
 * published world, and a PUT would 403 in a way that reads as a bug in the editor.
 */
const base = new URLSearchParams(location.search).get('data') ?? ''
export const CAN_SAVE_ZONES = base === ''

export async function loadZones(slug: string): Promise<ZoneDoc> {
  const empty: ZoneDoc = { version: 1, zones: [] }
  const r = await fetch(`${base}/sites/${slug}/zones.json`, { cache: 'no-cache' })
  if (r.status === 404) return empty // never authored: that is the normal case, not an error
  if (!r.ok) throw new Error(`zones.json: HTTP ${r.status}`)
  /*
   * SNIFF THE BODY. In dev a file that does not exist does NOT come back as a 404 — the bake
   * middleware calls next(), Vite's SPA fallback answers with index.html, and `r.json()` dies on a
   * tag. A body that opens with `{` and still fails to parse is a real file we have corrupted, and
   * that must throw: returning `empty` there would silently overwrite the author's zones on the
   * next save. Same reasoning, and the same words, as `schema.ts`.
   */
  const text = (await r.text()).trimStart()
  if (!text.startsWith('{')) return empty
  return JSON.parse(text) as ZoneDoc
}

export async function saveZones(slug: string, doc: ZoneDoc): Promise<number> {
  if (!CAN_SAVE_ZONES) throw new Error('read-only: this viewer is pointed at a published bucket')
  const r = await fetch(`/sites/${slug}/zones.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc, null, 1),
  })
  const j = (await r.json()) as { ok: boolean; bytes?: number; error?: string }
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j.bytes ?? 0
}
