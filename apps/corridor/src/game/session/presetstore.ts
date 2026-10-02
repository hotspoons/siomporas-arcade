// Where a world's presets live: `tools/corridor/data/sites/<slug>/presets.json`, beside the
// site's `tuning.json` and written through the same dev middleware and world-editor volume.
//
// Not a service. A preset is a property of a world, it is a few kilobytes, and it has to survive
// a fresh clone the same way the world's `look` does.
//
// SEPARATE FROM presets.ts, which is deliberately pure: `site.ts` reads `location.search` at
// module scope, so importing it drags a browser into every test that so much as mentions a
// preset. This is the file that knows about the network.
import { DATA_BASE } from '../../world/site'
import type { PresetDoc } from './presets'


export async function loadPresets(slug: string): Promise<PresetDoc | null> {
  try {
    const r = await fetch(`${DATA_BASE}/sites/${slug}/presets.json`, { cache: 'no-cache' })
    if (!r.ok) return null
    // the dev middleware answers a missing optional file with a 404 and the cluster's static
    // server may answer with index.html; a body that is not JSON is "no file", not a corrupt one
    const text = (await r.text()).trimStart()
    if (!text.startsWith('{')) return null
    const doc = JSON.parse(text) as PresetDoc
    return Array.isArray(doc?.presets) ? doc : null
  } catch {
    return null
  }
}

export async function savePresets(slug: string, doc: PresetDoc): Promise<{ bytes: number; count: number }> {
  const body = JSON.stringify(doc, null, 1)
  const r = await fetch(`/sites/${slug}/presets.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; bytes?: number; error?: string }
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return { bytes: j.bytes ?? body.length, count: doc.presets.length }
}
