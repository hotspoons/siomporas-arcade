// Mode 3: run the autogen rules over the corridor, then override whatever they got wrong.
//
// The rules are in `autogen.ts`; this is the loop around them. What makes it a loop rather than a
// one-shot is the bookkeeping, and it is the whole point of the mode:
//
//   a generated item has a `g-` id derived from its SOURCE BUILDING, so it lands on the same id
//   every run;  touching one sets `locked` and regeneration leaves it alone;  deleting one is
//   remembered in `autogen.deleted` so regeneration does not put it back.
//
// So the answer to "I generated, fixed six of them, and want to try a different density" is:
// change the knob and press generate. Your six survive. Nothing you did by hand is ever at risk,
// because hand-placed items have `p-` ids and are not touched at all.
import type { CatalogEntry } from './catalog'
import { DEFAULTS, generate, type Params } from './autogen'
import { isGenerated, type Placement } from './schema'
import type { PlaceMode } from './place'
import type { Site } from '../scene'
import { el, slider } from './ui'

const KNOBS: [keyof Params, string, number, number, number, string][] = [
  ['max_lat_m', 'corridor ±m', 40, 300, 10, 'ignore footprints further than this from the centreline; the bake only reaches 300 m'],
  ['keepout_m', 'keep-out m', 0, 40, 1, 'nothing is placed within this of a pavement edge'],
  ['min_area_m2', 'min m²', 10, 300, 5, 'below this a footprint is map noise, not a building — the first decile is 13 m²'],
  ['max_items', 'max items', 100, 15000, 100, 'ceiling on generated items. The editor draws one object per placement, and crofton-crownsville has 12,287 footprints inside its corridor'],
  ['scale_min', 'fit min ×', 0.3, 1, 0.05, 'how far DOWN a catalog asset may be scaled to match a footprint before it is the wrong object'],
  ['scale_max', 'fit max ×', 1, 3, 0.05, 'how far UP a catalog asset may be scaled before it is the wrong object'],
  ['invent_spacing_m', 'invent every m', 30, 200, 5, 'mean frontage gap when inventing; jittered per site'],
  ['invent_near_m', 'full mix within m', 100, 1200, 50, 'within this of an INTERCHANGE (motorway link, trunk, primary, secondary) every slot is taken and the mix is commercial'],
  ['invent_rural_chance', 'rural density', 0, 1, 0.05, 'how often a slot near a minor road junction is taken. A farm track is not a strip; 56 farmhouses down a forested interstate is what happens at 1'],
  ['invent_falloff_m', 'nothing past m', 400, 3000, 100, 'beyond this from any junction, nothing is invented'],
]

export class GrowMode {
  params: Params = { ...DEFAULTS }
  private last: { placed: number; skipped: Record<string, number>; byCategory: Record<string, number> } | null = null
  private place: PlaceMode
  private onChange: (structural?: boolean) => void

  constructor(place: PlaceMode, onChange: (structural?: boolean) => void) {
    this.place = place
    this.onChange = onChange
  }

  /** Parameters ride in the placements file, so a site reopens with the knobs you left it on. */
  adopt() {
    const saved = this.place.doc.autogen?.params
    if (saved) for (const k of Object.keys(this.params) as (keyof Params)[]) {
      const v = saved[k as string]
      if (typeof v === typeof this.params[k]) (this.params as unknown as Record<string, unknown>)[k] = v
    }
    this.last = null
  }

  private get deleted(): string[] {
    this.place.doc.autogen ??= { params: {}, deleted: [] }
    return this.place.doc.autogen.deleted
  }

  async run(site: Site, catalog: CatalogEntry[]) {
    const doc = this.place.doc
    const kept = doc.items.filter((p) => !isGenerated(p) || p.locked)
    const keptIds = new Set(kept.map((p) => p.id))
    const dead = new Set(this.deleted)
    const r = generate(site.manifest, site, catalog, this.params)
    // A proposal whose id is already a locked item, or which the human deleted, is not re-made.
    const fresh = r.items.filter((p) => !keptIds.has(p.id) && !dead.has(p.id))
    doc.items = [...kept, ...fresh]
    doc.autogen = {
      params: { ...this.params } as unknown as Record<string, number | boolean>,
      deleted: this.deleted,
      ran: new Date().toISOString(),
    }
    this.last = { placed: fresh.length, skipped: r.skipped, byCategory: r.byCategory }
    this.place.dirty = true
    await this.place.respawn()
    this.onChange()
  }

  /** Throw away every generated item, locks and tombstones included: a clean slate. */
  async clear() {
    const doc = this.place.doc
    doc.items = doc.items.filter((p) => !isGenerated(p))
    doc.autogen = { params: { ...this.params } as unknown as Record<string, number | boolean>, deleted: [] }
    this.last = null
    this.place.dirty = true
    await this.place.respawn()
    this.onChange()
  }

  private counts() {
    const items = this.place.doc.items
    const gen = items.filter(isGenerated)
    return { total: items.length, gen: gen.length, locked: gen.filter((p) => p.locked).length, hand: items.length - gen.length, deleted: this.deleted.length }
  }

  panel(root: HTMLElement, site: Site | null, catalog: CatalogEntry[], go: (pts: [number, number][]) => void) {
    root.replaceChildren()
    const buildings = ((site?.manifest as unknown as { buildings?: unknown[] })?.buildings ?? []).length
    const pois = ((site?.manifest as unknown as { pois?: unknown[] })?.pois ?? []).length
    const landuse = ((site?.manifest as unknown as { landuse?: unknown[] })?.landuse ?? []).length

    root.append(el('h2', '', 'what the bake measured'))
    if (!buildings) {
      root.append(el('p', 'dim', 'This site has no `buildings` in its manifest — re-export it (`python -m corridor export <slug>`) and reload.'))
      return
    }
    root.append(el('p', 'dim', `${buildings} footprints · ${landuse} land-use polygons · ${pois} points of interest`))

    const tools = el('div', 'row')
    const gen = el('button', 'primary')
    gen.textContent = 'generate (G)'
    gen.onclick = () => site && void this.run(site, catalog)
    const clr = el('button', 'danger')
    clr.textContent = 'clear generated'
    clr.onclick = () => { if (confirm('Throw away every generated item, including ones you locked?')) void this.clear() }
    tools.append(gen, clr)
    root.append(tools)

    const c = this.counts()
    const tally = el('div', 'tally')
    tally.append(
      el('span', '', `${c.gen} generated`),
      el('span', c.locked ? 'hot' : '', `${c.locked} locked`),
      el('span', '', `${c.hand} by hand`),
      el('span', c.deleted ? 'hot' : '', `${c.deleted} deleted`),
    )
    root.append(tally)
    if (c.deleted) {
      const undo = el('button')
      undo.textContent = `restore ${c.deleted} deleted`
      undo.onclick = () => {
        this.deleted.length = 0
        this.place.dirty = true
        this.onChange()
      }
      const unlock = el('button')
      unlock.textContent = 'unlock all'
      unlock.onclick = () => {
        for (const p of this.place.doc.items) if (isGenerated(p)) delete p.locked
        this.place.dirty = true
        this.onChange()
      }
      const row = el('div', 'row')
      row.append(undo, unlock)
      root.append(row)
    }

    if (this.last) {
      root.append(el('h2', '', `last run — ${this.last.placed} placed`))
      const by = el('div', 'list')
      for (const [k, v] of Object.entries(this.last.byCategory).sort((a, b) => b[1] - a[1])) {
        const row = el('div', 'item')
        row.append(el('span', 'nm', k), el('span', 'mono', String(v)))
        row.onclick = () => this.frame(k, go)
        by.append(row)
      }
      root.append(by)
      const skipped = Object.entries(this.last.skipped).sort((a, b) => b[1] - a[1])
      if (skipped.length) {
        // The honest column: it matters WHY a footprint did not become a building, because
        // "no catalog asset fits" is a job for the catalog and "on or beside the pavement" is not.
        root.append(el('h2', '', 'not placed'))
        const sk = el('div', 'list')
        for (const [k, v] of skipped) {
          const row = el('div', 'item')
          row.append(el('span', 'nm dim', k), el('span', 'mono', String(v)))
          sk.append(row)
        }
        root.append(sk)
      }
    }

    root.append(el('h2', '', 'rules'))
    const inv = el('label', 'field')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = this.params.invent
    cb.onchange = () => { this.params.invent = cb.checked; this.onChange() }
    inv.append(el('span', '', 'invent frontage'), cb)
    inv.title = 'AUTOGEN.md R5: where the corridor is bare, seed buildings along both verges — commercial near a junction, rural away from one. Off by default: it makes up a town that is not there.'
    root.append(inv)
    for (const [key, label, min, max, step, note] of KNOBS) {
      if (key.startsWith('invent') && !this.params.invent) continue
      root.append(slider(label, this.params[key] as number, min, max, step, DEFAULTS[key] as number, note, (v) => {
        ;(this.params as unknown as Record<string, number>)[key] = v
      }))
    }
    const seed = el('div', 'row')
    const reseed = el('button')
    reseed.textContent = `reseed (${this.params.seed})`
    reseed.onclick = () => { this.params.seed = Math.floor(Math.random() * 9999); this.onChange() }
    reseed.title = 'Only the invented frontage is random; footprints from the bake are the same every run.'
    seed.append(reseed)
    root.append(seed)
  }

  /** Frame everything of one category, so a click on "big_box 4" shows you the four. */
  private frame(category: string, go: (pts: [number, number][]) => void) {
    const pts = this.place.doc.items.filter((p) => p.tags?.includes(category)).map((p) => [p.x, p.y] as [number, number])
    if (pts.length) go(pts)
  }

  key(e: KeyboardEvent, site: Site | null, catalog: CatalogEntry[]): boolean {
    if ((e.key === 'g' || e.key === 'G') && site) {
      void this.run(site, catalog)
      return true
    }
    return false
  }
}

export type { Placement }
