// The asset library's Buildings tab: which materials each class of building is drawn from.
//
// Rich, 2026-10-10: "We also need a tab in assets to assign textures to classes of buildings. We
// need to be able to have random textures feed a single building type so we can get variety, e.g.
// brick and siding textures -> single family home, bricks and cinder blocks -> apartments, cinder
// blocks, bricks and pale bricks -> commercial building, glass -> skyscraper. Need to be able to
// assign reflectiveness for cases like skyscrapers."
//
// "BUILDINGS", NOT "FACADES". A facade is what this draws, but a building class is what a person is
// choosing for — "what do apartments look like here" — and the tab sits beside Vehicles, Actors
// and Weapons, which are named for the thing too. The word on the screen is the one in the ask.
//
// One group per class (src/world/facades.ts): the wall pool and the roof pool — library materials,
// each with a weight, shown as a strip at their shares so the mix reads at a glance — and how the
// walls take the light. Two scopes, as the fixtures and the catalog have: the SHARED DEFAULT
// (the library's `/facades`, every world) and THIS WORLD (its `surfaces.json`, which wins).
// Nothing is written until Save; the game reads it on the next load of the world.

import { el, button, toast, type Tab } from '../../ui/shell'
import { icon } from '../../ui/icons'
import { bodyOf, empty, group, segmented, select, slider, toggle } from '../../ui/controls'
import type { AssetExtension } from './assets'
import { assetsvc, type Material } from '../../assets/assetsvc'
import { loadSurfacesDoc, saveSurfacesDoc, type SurfacesDoc } from '../../assets/surfacesdoc'
import { BUILTIN_FACADES, facadeSources, resolveFacades, type FacadeClass, type FacadeEntry, type FacadePatch } from '../../world/facades'
import './buildscreen.css'

export interface BuildingsTabOpts {
  /** the world that is open, or null */
  world: () => string | null
  /** a world's classes were saved: the page that has a live scene hands it the document */
  onWorldSaved?: (doc: SurfacesDoc) => void
}

type Scope = 'shared' | 'world'
type Shared = FacadePatch & { id: string }
/** a class's pending edit; null is "drop this world's own and use the shared default" */
type Draft = Record<string, FacadePatch | null>

export function buildingsExtension(o: BuildingsTabOpts): AssetExtension {
  /*
   * ONE SCREEN, REMOUNTED. The library rebuilds every tab when it refreshes (its catalog landed, an
   * item was saved), and a fresh screen would drop an edit nobody has saved yet. The screen keeps
   * its draft and is mounted into the new panel; it re-reads the library only when it has nothing
   * of its own to lose.
   */
  let screen: BuildingsTab | null = null
  const tab: Tab = { id: 'buildings', label: 'Buildings', icon: 'swatch', build: (panel) => { screen ??= new BuildingsTab(o); screen.mount(panel) } }
  return { tabs: [tab] }
}

class BuildingsTab {
  private o: BuildingsTabOpts
  private materials: Material[] = []
  private shared: Shared[] = []
  private worldDoc: SurfacesDoc | null = null
  private scope: Scope
  private draft: Draft = {}
  private scroll = el('div', 'lib-scroll')
  private foot = el('div', 'lib-foot')

  /** the world the data was read for: a different one open now means read again */
  private loadedFor: string | null | undefined = undefined

  constructor(o: BuildingsTabOpts) {
    this.o = o
    this.scope = o.world() ? 'world' : 'shared'
  }

  mount(panel: HTMLElement): void {
    // the panel starts the scroll chain, with Save in a foot that stays put (buildscreen.css)
    panel.replaceChildren(this.scroll, this.foot)
    panel.classList.add('lib-screen', 'bcl-screen')
    if (this.dirty && this.loadedFor === this.o.world()) { this.render(); return }
    this.draft = {}
    void this.load()
  }

  async load(): Promise<void> {
    this.scroll.replaceChildren(el('p', 'dim', 'reading the library…'))
    const slug = this.o.world()
    const [mats, shared, doc] = await Promise.all([
      assetsvc.materials().then((r) => r.materials).catch(() => null),
      assetsvc.builds<Shared>('facades').catch(() => [] as Shared[]),
      slug ? loadSurfacesDoc(slug) : Promise.resolve(null),
    ])
    this.loadedFor = slug
    if (!mats) {
      this.scroll.replaceChildren(empty('The asset service is not answering, so there are no materials to choose from. The game draws the built-in pools where it can.'))
      return
    }
    this.materials = mats
    this.shared = shared
    this.worldDoc = doc
    if (!slug) this.scope = 'shared'
    this.render()
  }

  private get dirty(): boolean {
    return Object.keys(this.draft).length > 0
  }

  /** The classes as the chosen scope stands, before the draft. */
  private base(): FacadeClass[] {
    return resolveFacades(this.shared, this.scope === 'world' ? this.worldDoc?.buildings : null)
  }

  /** One class with the draft laid over it. */
  private effective(c: FacadeClass): FacadeClass {
    const d = this.draft[c.id]
    if (d === null) return resolveFacades(this.shared, null).find((x) => x.id === c.id)!
    return { ...c, ...(d ?? {}) }
  }

  /** Stage a change. A slider passes `redraw: false` — rebuilding the pane mid-drag drops the drag. */
  private edit(id: string, patch: FacadePatch, redraw = true): void {
    const cur = this.draft[id]
    this.draft[id] = { ...(cur ?? {}), ...patch }
    if (redraw) this.render()
    else this.renderFoot()
  }

  private render(): void {
    const top = this.scroll.scrollTop
    this.scroll.replaceChildren()
    const slug = this.o.world()
    const head = el('div', 'bcl-head')
    if (slug) {
      head.append(segmented<Scope>({
        value: this.scope,
        options: [
          { value: 'world', label: `${slug} only` },
          { value: 'shared', label: 'shared default — every world' },
        ],
        onChange: (v) => {
          if (v === this.scope) return
          if (this.dirty) { toast('save or discard first: those edits belong to the other scope', 'warn'); this.render(); return }
          this.scope = v
          this.render()
        },
      }))
    }
    const say = el('p', 'dim bcl-say')
    say.textContent = this.scope === 'world'
      ? `What ${slug} draws. A class you change here stops following the shared default for what you changed; the rest still follows it.`
      : 'What every world draws unless it says otherwise. Each building picks one wall and one roof from its class, the same one on every load; a weight of 2 is picked twice as often as 1.'
    head.append(say)
    this.scroll.append(head)
    const legacy = this.scope === 'world' && (this.worldDoc?.buildings?.walls?.length || this.worldDoc?.buildings?.roofs?.length)
    if (legacy) {
      const w = el('div', 'panel-hint warn')
      w.append(icon('exclamation-triangle', 14), el('span', '', 'This world also has one pool for every building (the editor’s World tab). It beats the shared default for every class that has no pool of its own here.'))
      this.scroll.append(w)
    }

    const byId = new Map(this.materials.map((m) => [m.id, m]))
    for (const c0 of this.base()) {
      const c = this.effective(c0)
      const src = facadeSources(c.id, this.shared, this.scope === 'world' ? this.worldDoc?.buildings : null)
      const own = this.scope === 'world' && !!this.worldDoc?.buildings?.classes?.[c.id] && this.draft[c.id] !== null
      const changed = this.draft[c.id] !== undefined
      const g = group(`${c.label}${changed ? ' •' : ''}`, { note: `${c.note}. OSM building=${c.osm.slice(0, 5).join(', ')}${c.osm.length > 5 ? '…' : ''}` })
      g.dataset.cls = c.id
      g.classList.add('bcl-class')
      const b = bodyOf(g)
      b.append(this.pool(c, 'walls', 'Walls', byId, src.walls), this.pool(c, 'roofs', 'Roofs', byId, src.roofs))
      const surf = el('div', 'bcl-surface')
      surf.append(
        slider({ label: 'Reflectiveness', value: c.metalness, min: 0, max: 1, step: 0.05, neutral: 0, note: 'how much the walls mirror the sky — a glass tower is about 0.85', onInput: (v) => this.edit(c.id, { metalness: v }, false) }),
        slider({ label: 'Roughness', value: c.roughness, min: 0.02, max: 1, step: 0.02, neutral: 0.9, note: '1 is chalk, 0.05 a mirror', onInput: (v) => this.edit(c.id, { roughness: v }, false) }),
      )
      const masked = c.walls.some((e) => !!byId.get(e.material)?.glass_mask)
      surf.append(toggle({
        label: masked ? 'Glass panes from the material’s mask' : 'Glass panes (no material in the pool has a pane mask)',
        value: c.glass,
        note: 'inside a pane the wall is as smooth as the material’s glass; the mullions keep the roughness above. A glazed class is not given house windows.',
        onChange: (v) => this.edit(c.id, { glass: v }),
      }))
      const from = el('div', 'bcl-from')
      from.append(el('span', 'dim', 'reflectiveness from'), el('span', `asset-src src-${src.metalness}`, src.metalness === 'world' ? 'this world' : src.metalness))
      surf.append(from)
      b.append(surf)
      if (own) {
        const acts = el('div', 'panel-actions')
        acts.append(button({ label: 'Use the shared default', icon: 'arrow-uturn-left', variant: 'ghost', title: `drop ${slug}’s own choices for this class`, onClick: () => { this.draft[c.id] = null; this.render() } }))
        b.append(acts)
      }
      this.scroll.append(g)
    }
    this.scroll.scrollTop = top
    this.renderFoot()
  }

  private renderFoot(): void {
    const slug = this.o.world()
    this.foot.replaceChildren(
      button({
        label: this.scope === 'world' ? `Save for ${slug}` : 'Save the shared default',
        icon: 'document-arrow-down',
        variant: 'primary',
        onClick: () => void this.save(),
      }),
      button({ label: 'Discard', icon: 'arrow-uturn-left', variant: 'ghost', onClick: () => { this.draft = {}; this.render() } }),
      el('span', 'dim', this.dirty ? `${Object.keys(this.draft).length} class${Object.keys(this.draft).length === 1 ? '' : 'es'} changed, not saved` : 'the game draws these on the next load of a world'),
    )
    const save = this.foot.querySelector('button') as HTMLButtonElement
    save.disabled = !this.dirty
  }

  /** One pool: the strip at its shares, a row per material with its weight, and an Add. */
  private pool(c: FacadeClass, key: 'walls' | 'roofs', title: string, byId: Map<string, Material>, from: string): HTMLElement {
    const list = c[key]
    const wrap = el('div', 'bcl-pool')
    wrap.dataset.pool = key
    const h = el('div', 'bcl-pool-head')
    h.append(el('strong', '', title), el('span', `asset-src src-${from}`, from === 'world' ? 'this world' : from))
    wrap.append(h)
    const total = list.reduce((s, e) => s + e.weight, 0) || 1
    if (list.length) {
      // THE MIX, at a glance: each material as wide as its share of the draws
      const strip = el('div', 'bcl-strip')
      for (const e of list) {
        const m = byId.get(e.material)
        const seg = el('div', `bcl-seg${m ? '' : ' missing'}`)
        seg.style.flexGrow = String(e.weight)
        if (m) seg.style.backgroundImage = `url("${assetsvc.materialUrl(m.id, m.albedo)}")`
        seg.title = `${m?.name ?? e.material} — ${Math.round((e.weight / total) * 100)}%`
        strip.append(seg)
      }
      wrap.append(strip)
    } else {
      wrap.append(el('p', 'dim bcl-none', key === 'roofs' ? 'no roof pool — the roof keeps the palette colour' : 'no wall pool — these walls keep the palette colour'))
    }
    const set = (next: FacadeEntry[]) => this.edit(c.id, { [key]: next })
    list.forEach((e, i) => {
      const m = byId.get(e.material)
      const row = el('div', 'bcl-entry')
      const sw = el('img', 'material-swatch') as HTMLImageElement
      if (m) sw.src = assetsvc.materialUrl(m.id, m.albedo)
      sw.alt = ''
      const name = el('div', 'bcl-entry-name')
      name.append(el('span', '', m?.name ?? e.material), el('span', 'dim', m ? `${m.category.replace(/_/g, ' ')} · ${m.metres_per_tile} m tile${m.glass_mask ? ' · glass mask' : ''}` : 'not in the library — skipped'))
      const w = el('input', 'input bcl-weight') as HTMLInputElement
      w.type = 'number'
      w.min = '0.1'
      w.step = '0.5'
      w.value = String(e.weight)
      w.title = 'weight — relative share of the draws'
      w.onchange = () => {
        const n = Number(w.value)
        if (!(n > 0)) { w.value = String(e.weight); return }
        set(list.map((x, j) => (j === i ? { ...x, weight: n } : x)))
      }
      const pct = el('span', 'bcl-pct', `${Math.round((e.weight / total) * 100)}%`)
      const rm = button({ icon: 'x-mark', variant: 'ghost', title: `take ${m?.name ?? e.material} out of the pool`, onClick: () => set(list.filter((_, j) => j !== i)) })
      row.append(sw, name, w, pct, rm)
      wrap.append(row)
    })
    // the library's materials, the likely ones first: walls for walls, roofs for roofs
    const likely = (mm: Material) => (key === 'roofs' ? /^roof/.test(mm.category) : /^(wall|glazing)/.test(mm.category))
    const opts = [...this.materials].filter((mm) => !list.some((e) => e.material === mm.id))
      .sort((a, b) => Number(likely(b)) - Number(likely(a)) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    wrap.append(select<string>({
      value: '',
      options: [{ value: '', label: `add a ${key === 'roofs' ? 'roof' : 'wall'} material…` }, ...opts.map((mm) => ({ value: mm.id, label: `${mm.name} — ${mm.category.replace(/_/g, ' ')}, ${mm.metres_per_tile} m` }))],
      onChange: (v) => { if (v) set([...list, { material: v, weight: 1 }]) },
    }))
    return wrap
  }

  private async save(): Promise<void> {
    if (!this.dirty) return
    const slug = this.o.world()
    try {
      if (this.scope === 'shared') {
        for (const [id, patch] of Object.entries(this.draft)) {
          if (!patch) continue
          await assetsvc.saveBuild('facades', id, patch as Record<string, unknown>)
        }
        this.shared = await assetsvc.builds<Shared>('facades')
        toast(`saved the shared default for ${Object.keys(this.draft).length} class${Object.keys(this.draft).length === 1 ? '' : 'es'}`, 'ok')
      } else {
        if (!slug) throw new Error('no world is open')
        // READ, MERGE, WRITE: surfaces.json carries the world's roads and grass too, and another
        // screen (the editor's World tab) writes them — a stale copy of the whole file would undo it
        const fresh = await loadSurfacesDoc(slug)
        const classes = { ...(fresh.buildings?.classes ?? {}) }
        for (const [id, patch] of Object.entries(this.draft)) {
          if (patch === null) delete classes[id]
          else classes[id] = { ...(classes[id] ?? {}), ...patch }
        }
        fresh.buildings = { ...(fresh.buildings ?? {}), classes }
        if (!Object.keys(classes).length) delete fresh.buildings.classes
        await saveSurfacesDoc(slug, fresh)
        this.worldDoc = fresh
        this.o.onWorldSaved?.(fresh)
        toast(`saved ${slug}’s building classes — the game draws them on the next load`, 'ok')
      }
      this.draft = {}
      this.render()
    } catch (e) {
      toast(`buildings: ${(e as Error).message}`, 'danger', 8000)
    }
  }
}

/** for the MCP tools' tests and the vocabulary: the class ids the tab lists */
export const BUILDING_CLASS_IDS = BUILTIN_FACADES.map((c) => c.id)
