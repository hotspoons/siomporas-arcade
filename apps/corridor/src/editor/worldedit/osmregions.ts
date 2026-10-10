// The OSM data dialog's pure parts: the Geofabrik catalogue as a tree a person can search, what a
// world's routing says in a sentence, and the small formatting the rows need. No DOM here, so
// test/osmdata.test.ts can hold all of it to the real catalogue's quirks.

export interface GeofabrikRegion {
  id: string
  name: string
  parent: string | null
  pbf: string | null
  updates: string | null
}

export interface RegionNode extends GeofabrikRegion {
  label: string
  children: RegionNode[]
}

/**
 * A region's name for a person. Geofabrik's index names the US states BY THEIR ID — `"name":
 * "us/virginia"` — so a name with a slash in it is an id, and its last part is the name. Kept in
 * step with `regionLabel` in tools/worldeditor/coverage.mjs, which names the runs.
 */
export function regionLabel(r: { id?: string; name?: string | null }): string {
  const n = String(r.name ?? r.id ?? '')
  if (!n.includes('/')) return n
  return n
    .split('/')
    .pop()!
    .split('-')
    .map((w) => (w === 'of' ? w : w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

/**
 * The catalogue as a tree.
 *
 * NOT BY `parent` ALONE. The index files every US state under `north-america` — beside `us`, not
 * in it — and a tree built from `parent` puts fifty-one states at the same level as Canada and
 * Mexico. An id with a slash in it (`us/virginia`) belongs under the region its prefix names when
 * that region exists, which is what a person means by the hierarchy.
 */
export function buildRegionTree(list: GeofabrikRegion[]): RegionNode[] {
  const byId = new Map<string, RegionNode>()
  for (const r of list) byId.set(r.id, { ...r, label: regionLabel(r), children: [] })
  const roots: RegionNode[] = []
  for (const n of byId.values()) {
    const prefix = n.id.includes('/') ? n.id.slice(0, n.id.lastIndexOf('/')) : null
    const up = (prefix && byId.get(prefix)) || (n.parent ? byId.get(n.parent) : undefined)
    if (up && up !== n) up.children.push(n)
    else roots.push(n)
  }
  const sort = (xs: RegionNode[]) => {
    xs.sort((a, b) => a.label.localeCompare(b.label))
    for (const x of xs) sort(x.children)
  }
  sort(roots)
  return roots
}

/**
 * The regions matching a search, best first: a name that starts with the text, then one with a
 * word that does, then the id containing it. Empty text matches nothing — the tree is the browse.
 */
export function searchRegions(list: GeofabrikRegion[], text: string, limit = 40): GeofabrikRegion[] {
  const q = text.trim().toLowerCase()
  if (q.length < 2) return []
  const scored: [number, GeofabrikRegion][] = []
  for (const r of list) {
    const label = regionLabel(r).toLowerCase()
    const id = r.id.toLowerCase()
    let s = -1
    if (label === q || id === q) s = 0
    else if (label.startsWith(q)) s = 1
    else if (label.split(/[\s-]+/).some((w) => w.startsWith(q))) s = 2
    else if (id.includes(q)) s = 3
    if (s >= 0) scored.push([s, r])
  }
  return scored.sort((a, b) => a[0] - b[0] || regionLabel(a[1]).localeCompare(regionLabel(b[1]))).slice(0, limit).map((x) => x[1])
}

/** One colour per upstream, stable by position, distinct from the danger red the uncovered get. */
const PALETTE = ['#4aa8e8', '#56b982', '#d9a441', '#b48ce0', '#4fc1b5', '#e08ab4']
export const upstreamColour = (i: number): string => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]

export interface WorldRouting {
  slug: string
  name: string
  placed: boolean
  upstream?: string | null
  route?: string[]
  verdicts?: { name: string; covered: boolean; outside: number; exact: boolean; claims: string }[]
  fences?: { upstream: string | null; outside: number | null } | null
}

/**
 * What the dialog says about one world, and whether it is a problem.
 *
 *   ok        an instance of ours holds all of it
 *   mirrors   none does: it is baked from the public mirrors (slow, and somebody else's limits)
 *   misrouted the old fence rule sends it to an instance that does NOT hold all of it — the
 *             dc-metro-take-2 failure, shown while a fence is still on a URL
 */
export function worldVerdict(w: WorldRouting): { kind: 'ok' | 'mirrors' | 'misrouted' | 'unplaced'; text: string } {
  if (!w.placed) return { kind: 'unplaced', text: 'no centre to route by' }
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`
  if (w.fences?.upstream && w.fences.outside != null && w.fences.outside > 0) {
    return {
      kind: 'misrouted',
      text: `the URL fences send it to ${w.fences.upstream}, whose extract leaves ${pct(w.fences.outside)} of it out${w.upstream ? ` — routed to ${w.upstream} instead` : ''}`,
    }
  }
  if (w.upstream) return { kind: 'ok', text: `${w.upstream}${(w.route?.length ?? 0) > 1 ? `, then ${w.route!.slice(1).join(', ')}` : ''}` }
  const near = (w.verdicts ?? []).filter((v) => v.claims === 'regions').sort((a, b) => a.outside - b.outside)[0]
  return { kind: 'mirrors', text: `no instance of ours holds all of it${near ? ` (closest: ${near.name}, ${pct(near.outside)} outside)` : ''} — public mirrors` }
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '?'
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GiB`
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MiB`
  return `${Math.round(n / 1024)} KiB`
}

/** "3 h old", "2 d old" — how stale an instance's data is, from its replication timestamp. */
export function fmtAge(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return 'unknown'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min old`
  if (hours < 48) return `${Math.round(hours)} h old`
  return `${Math.round(hours / 24)} d old`
}
