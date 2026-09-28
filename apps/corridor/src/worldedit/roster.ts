// What you can put in a world, and putting it there.
//
// Rich, 2026-09-28: "The roster form still makes no sense - why is that even a thing? We should be
// able to preview and place assets from the roster (needs a search too for big lists) but we
// already have a generate interface, this is so confusing. We should be able to drag from the
// roster, place it on the map, set the pose, that's it."
//
// He is right, and the confusion was structural: the Assets panel held a SECOND generation
// interface — a list of roster specs, a prompt, a draw button, a reconstruct button — beside the
// catalog dialog that does all of that properly. Two ways to generate and no way to place.
//
// So this panel is about placing, and nothing else:
//
//   SEARCH, because a catalog is a hundred rows and the reason you opened this is that you want
//   the gas station.
//   A PREVIEW, because a name and a footprint do not tell you whether it is the right barn.
//   DRAG, onto the scene, which is the gesture — the asset and the place arrive together.
//
// Generation is one button at the top, which opens the thing that generates.
import { button, el, toast } from '../ui/shell'
import { bodyOf, empty, group, readout } from '../ui/controls'
import { icon } from '../ui/icons'
import { MeshView } from '../ui/meshview'
import { api } from './api'

export interface PlaceableAsset {
  id: string
  name: string
  category: string
  glb?: string
  footprint_m: [number, number]
  height_m: number
}

export interface RosterOpts {
  host: HTMLElement
  /** open the catalog and generation dialog — the OTHER interface, reached deliberately */
  openCatalog: () => void
  /** turn a finished mesh into a placeable entry */
  openAdopt: () => void
  /**
   * Arm one for the next click on the ground, and show the scene if it is not showing.
   *
   * Returns false when there is no world open, which is the one state where placing means nothing
   * and the panel has to say so rather than appearing to work.
   */
  place: (assetId: string) => boolean
  /** is a world open and its scene on screen? */
  ready: () => boolean
  /**
   * Bring the world up, because a drag has started and it has to land on something.
   *
   * The roster is its own tab, so the scene is not on screen when you pick a row up — and a drop
   * onto a hidden canvas raycasts nothing and quietly places nothing. Switching on `dragstart`
   * puts the ground under the cursor before the pointer gets there; the drag itself survives the
   * DOM changing underneath it, which is a thing HTML drag-and-drop is specified to do.
   */
  showScene: () => void
}

export class RosterPanel {
  private o: RosterOpts
  private assets: PlaceableAsset[] = []
  private find = ''
  private selected: string | null = null
  private view: MeshView | null = null
  private viewFor: string | null = null
  private loaded = false

  constructor(o: RosterOpts) {
    this.o = o
  }

  async load() {
    try {
      this.assets = (await api.catalog()).assets as PlaceableAsset[]
      this.loaded = true
    } catch (e) {
      this.assets = []
      this.loaded = true
      toast(`catalog: ${(e as Error).message}`, 'warn', 5000)
    }
    this.render()
  }

  /** Leaving the tab: the preview stops drawing, but keeps what it loaded. */
  stop() {
    this.view?.stop()
  }

  private matches(a: PlaceableAsset): boolean {
    const q = this.find.trim().toLowerCase()
    if (!q) return true
    return `${a.id} ${a.name} ${a.category}`.toLowerCase().includes(q)
  }

  render() {
    const host = this.o.host
    host.replaceChildren()

    const flow = el('div', 'panel-actions')
    flow.append(
      button({ label: 'Catalog & generate', icon: 'sparkles', title: 'describe, draw and mesh new assets', onClick: () => void this.o.openCatalog() }),
      button({ label: 'Make placeable', icon: 'cube', title: 'turn a finished mesh into a catalog entry a level can place', onClick: () => void this.o.openAdopt() }),
    )
    host.append(flow)

    if (!this.loaded) {
      host.append(empty('Reading the catalog…'))
      return
    }
    if (!this.assets.length) {
      host.append(empty('Nothing placeable yet. “Catalog & generate” makes one; “Make placeable” adopts a finished mesh.'))
      return
    }

    /* the search */
    const search = el('div', 'tree-filter')
    const input = el('input', 'input wide') as HTMLInputElement
    input.type = 'search'
    input.placeholder = `find one of ${this.assets.length}`
    input.value = this.find
    input.oninput = () => {
      this.find = input.value
      this.render()
      const again = host.querySelector<HTMLInputElement>('.tree-filter input')
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length) }
    }
    search.append(icon('magnifying-glass', 14), input)
    host.append(search)

    if (!this.o.ready()) {
      host.append(el('p', 'panel-hint', 'Open a world in Place to put these anywhere.'))
    }

    /* the roster, by category */
    const shown = this.assets.filter((a) => this.matches(a))
    if (!shown.length) {
      host.append(empty(`Nothing matching “${this.find.trim()}”.`))
      return
    }
    const byCategory = new Map<string, PlaceableAsset[]>()
    for (const a of shown) byCategory.set(a.category, [...(byCategory.get(a.category) ?? []), a])
    for (const [cat, items] of [...byCategory].sort()) {
      const g = group(`${cat.replace(/_/g, ' ')} (${items.length})`, { collapsed: false })
      const b = bodyOf(g)
      for (const a of items) b.append(this.row(a))
      host.append(g)
    }
  }

  /**
   * One asset: a name, its size, and a handle to drag.
   *
   * THE WHOLE ROW IS THE DRAG SOURCE. `draggable` plus a plain string on the dataTransfer, which
   * is what `editor/main.ts` reads on drop — no shared object, because the two live in different
   * modules and a drag that only works while one of them happens to hold a reference is a drag
   * that stops working when a panel is rebuilt mid-gesture.
   */
  private row(a: PlaceableAsset): HTMLElement {
    const row = el('div', `row roster-row${a.id === this.selected ? ' on' : ''}`)
    row.draggable = true
    row.title = `${a.id} — drag onto the world, or press Place`
    row.append(
      el('span', 'row-name', a.name),
      el('span', 'row-note', `${a.footprint_m[0]}×${a.footprint_m[1]} m${a.glb ? '' : ' · box'}`),
    )
    row.ondragstart = (e) => {
      e.dataTransfer?.setData('text/apex-asset', a.id)
      e.dataTransfer?.setData('text/plain', a.id)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
      row.classList.add('dragging')
      // the world, now, so there is ground under the cursor when it arrives
      this.o.showScene()
    }
    row.ondragend = () => row.classList.remove('dragging')
    row.onclick = () => {
      this.selected = this.selected === a.id ? null : a.id
      this.render()
    }
    if (a.id === this.selected) {
      const wrap = el('div', 'roster-detail')
      wrap.append(this.preview(a))
      wrap.append(readout('id', a.id), readout('height', `${a.height_m} m`))
      wrap.append(button({
        label: 'Place',
        icon: 'map-pin',
        variant: 'primary',
        title: 'arm it, then click the ground',
        onClick: () => {
          if (!this.o.place(a.id)) toast('open a world in Place first', 'warn', 4000)
        },
      }))
      const holder = el('div', 'roster-row-wrap')
      holder.append(row, wrap)
      return holder
    }
    return row
  }

  /**
   * The model, small.
   *
   * ONE VIEWER, REUSED. A WebGL context per row would exhaust the browser's supply in one scroll
   * of a hundred-row catalog — so there is one, and it is moved to whichever row is open and
   * reloaded only when the asset changes.
   */
  private preview(a: PlaceableAsset): HTMLElement {
    if (!a.glb) {
      const none = el('p', 'panel-hint')
      none.append(icon('information-circle', 14), el('span', '', 'No model — it places as a box of the right size.'))
      return none
    }
    this.view ??= new MeshView({ remember: 'roster' })
    const view = this.view
    ;(window as unknown as { __rosterview?: MeshView }).__rosterview = view
    if (this.viewFor !== a.id) {
      this.viewFor = a.id
      // the same resolution `editor/catalog.ts` uses: the catalog stores a site-root-relative path
      void view.load(`/${a.glb.replace(/^\/+/, '')}`)
    }
    view.start()
    return view.root
  }
}
