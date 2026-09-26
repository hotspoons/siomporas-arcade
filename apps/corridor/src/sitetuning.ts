// Per-site knob overrides: tools/corridor/data/sites/<slug>/tuning.json.
//
// A corridor is not one look. Sideling Hill is closed forest on a mountain grade; Bowie is a
// suburban arterial; Ecola is a coast. The same GRASS_RADIUS or TREE_NEAR_RADIUS cannot be right
// for all of them, and the alternative to per-site numbers is one compromise that is wrong
// everywhere.
//
// PRECEDENCE, because there are two stores and they can disagree. The engine's TunePanel already
// persists every knob per browser in localStorage, restored when the panel is constructed — that
// is Rich's scratch pad while he drives. A site file is the committed answer, so it is applied
// AFTER the panel restores, and wins. Copy JSON in the panel is how a scratch value is promoted
// into a file.
//
// And the file is UNDONE when you leave the site. Without that, a value from site A leaks into
// site B for the rest of the session and looks like a bug in B — so the pre-file value of every
// knob the file touched is captured on apply and restored on the next load.
import { DATA_BASE } from './site'

export interface SiteTuning {
  version: 1
  values: Record<string, number>
  /** what the world's author chose it to open with; the URL's ?style / ?season win over it */
  look?: { style?: string; season?: string }
}

export interface TuneAccess {
  get: (name: string) => number | undefined
  set: (name: string, v: number) => boolean
  names: () => string[]
}

/** What the site file overwrote, so leaving the site can put it back. */
let applied: { slug: string; before: Record<string, number> } | null = null

export async function loadSiteTuning(slug: string): Promise<SiteTuning | null> {
  try {
    const r = await fetch(`${DATA_BASE}/sites/${slug}/tuning.json`, { cache: 'no-cache' })
    if (!r.ok) return null
    // the dev middleware answers a missing file by falling through; a body that is not JSON is
    // "no file", not a corrupt one
    const text = (await r.text()).trimStart()
    if (!text.startsWith('{')) return null
    const doc = JSON.parse(text) as SiteTuning
    return doc && typeof doc.values === 'object' ? doc : null
  } catch {
    return null
  }
}

/**
 * Restore whatever the last site's file overwrote, then apply this site's. Returns what happened,
 * for the status line — silence about an override that did not take is how a knob gets tuned
 * twice.
 */
export async function applySiteTuning(slug: string, tune: TuneAccess): Promise<{ applied: number; restored: number; unknown: string[]; look?: SiteTuning['look'] }> {
  let restored = 0
  if (applied) {
    for (const [k, v] of Object.entries(applied.before)) if (tune.set(k, v)) restored++
    applied = null
  }
  const doc = await loadSiteTuning(slug)
  if (!doc) return { applied: 0, restored, unknown: [] }
  const look = doc.look && typeof doc.look === 'object' ? doc.look : undefined
  const known = new Set(tune.names())
  const before: Record<string, number> = {}
  const unknown: string[] = []
  let n = 0
  for (const [k, v] of Object.entries(doc.values)) {
    if (!known.has(k)) {
      // a knob that has been renamed or removed since the file was written
      unknown.push(k)
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const was = tune.get(k)
    if (was !== undefined) before[k] = was
    if (tune.set(k, v)) n++
  }
  applied = { slug, before }
  return { applied: n, restored, unknown, look }
}

/**
 * Write the knobs that differ from `baseline` to the site's file. Only the differences: a file of
 * all 112 knobs is unreadable and turns every future default change into a merge conflict.
 */
export async function saveSiteTuning(slug: string, tune: TuneAccess, baseline: Record<string, number>): Promise<{ bytes: number; count: number }> {
  const values: Record<string, number> = {}
  for (const name of tune.names()) {
    const v = tune.get(name)
    if (v === undefined) continue
    if (baseline[name] === undefined || Math.abs(baseline[name] - v) > 1e-9) values[name] = v
  }
  const body: SiteTuning = { version: 1, values }
  // the world editor writes the site's look into this same file; the knob save keeps it
  const prev = await loadSiteTuning(slug)
  if (prev?.look) body.look = prev.look
  const r = await fetch(`/sites/${slug}/tuning.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, null, 1) })
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; bytes?: number; error?: string }
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status} — is "tuning" in the PUT whitelist in vite.config.ts?`)
  return { bytes: j.bytes ?? 0, count: Object.keys(values).length }
}
