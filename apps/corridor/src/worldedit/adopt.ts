// From a finished reconstruction to something the editor can place.
//
// assetsvc already owns the generation — describe it, draw it, mesh it, finish it — and
// `src/ui/assets.ts` is the UI for that; neither is rebuilt here. What was missing is the last
// step: a finished `.glb` in assetsvc's catalog is not yet a PLACEABLE asset, because
// `apps/corridor/public/assets/catalog.json` is what `editor/place.ts` reads and it wants a
// footprint, a height and a category as well as a file.
//
// CATALOG.JSON IS MERGED, NEVER REPLACED. It carries every lane's assets and has been clobbered
// once by a whole-file write. The backend's only catalog write is a merge by id (store.mjs
// mergeCatalog) — there is no endpoint that can replace the file, which is the point.
//
// THE NUMBERS ARE THE TRUTH, THE MESH IS A SKIN. `editor/catalog.ts` rescales whatever the
// reconstructor returned to `height_m` (or, with `fit: "span"`, so the long axis is
// `footprint_m[0]`). So the footprint and height typed here are what the world will actually be
// built at, and a reconstruction that came back at some arbitrary scale does not matter. That is
// why this asks for them rather than measuring the glb: the glb's scale is not evidence.
import { Dialog, button, el, toast } from '../ui/shell'
import { bodyOf, empty, group, readout, select, textField } from '../ui/controls'
import { icon } from '../ui/icons'
import { assetsvc, type AssetItem } from '../assetsvc'
import { api } from './api'

/** The vocabulary `editor/autogen.ts` classifies into and `editor/catalog.ts` tints by. */
const CATEGORIES = [
  'shed', 'house', 'house_large', 'townhouse', 'apartments', 'restaurant', 'retail_unit',
  'strip_mall', 'big_box', 'gas_station', 'hotel', 'office', 'warehouse', 'school', 'church',
  'barn', 'utility', 'sign', 'bridge',
]

export class AdoptDialog {
  dialog: Dialog
  private host = el('div', 'adopt-body')
  private items: AssetItem[] = []
  private placed = new Set<string>()
  private reachable = false

  constructor() {
    this.dialog = new Dialog({ title: 'Place generated assets', icon: 'cube', size: 'lg' })
    this.dialog.body.append(this.host)
  }

  async open() {
    this.dialog.open()
    await this.refresh()
  }

  async refresh() {
    this.reachable = await assetsvc.health()
    this.items = this.reachable ? await assetsvc.list().catch(() => []) : []
    this.placed = new Set((await api.catalog().catch(() => ({ assets: [] }))).assets.map((a) => a.id))
    this.render()
  }

  private render() {
    this.host.replaceChildren()
    if (!this.reachable) {
      this.host.append(
        empty('assetsvc is not reachable'),
        note('generation is off by default and corridor works completely without it. Turn the chart on with `--set enabled=true`, and point this pod at it with WORLDEDITOR_ASSETSVC.'),
      )
      this.dialog.footer(button({ label: 'Retry', icon: 'arrow-path', onClick: () => void this.refresh() }))
      return
    }
    const finished = this.items.filter((i) => i.state === 'finished')
    this.dialog.footer(
      button({ label: 'Refresh', icon: 'arrow-path', onClick: () => void this.refresh() }),
      button({
        label: 'Generate…',
        icon: 'sparkles',
        title: 'the generation UI — describe a prop, draw it, mesh it',
        onClick: () => toast('open Assets from the menu to describe and generate; come back here to place what it finishes', 'info', 6000),
      }),
    )
    if (!finished.length) {
      this.host.append(
        empty(`${this.items.length} item(s) in assetsvc, none finished yet`),
        note('an item becomes placeable once it has a finished mesh: spec → drawn → meshed → ready. The state is derived from which files exist, so it cannot go stale.'),
      )
      return
    }
    for (const item of finished) this.host.append(this.card(item))
  }

  private card(item: AssetItem): HTMLElement {
    const already = this.placed.has(item.id)
    const g = group(`${item.subject || item.id}${already ? ' — already placeable' : ''}`, { collapsed: already })
    const b = bodyOf(g)

    if (item.chosen) {
      const img = el('img', 'adopt-view')
      img.src = assetsvc.fileUrl(item.id, `views/${item.chosen}`)
      img.alt = `${item.id} — the view that was reconstructed`
      b.append(img)
    }
    b.append(readout('id', item.id), readout('mesh', item.finished ? `${(item.finished / 1024).toFixed(0)} kB finished` : '—'))

    const draft = { id: item.id, name: item.subject || item.id, category: 'house', w: 10, d: 8, h: 6, fit: 'height' as 'height' | 'span' }
    b.append(
      textField({ label: 'name', value: draft.name, onChange: (v) => (draft.name = v) }),
      select({ label: 'category', value: draft.category, options: CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, ' ') })), onChange: (v) => (draft.category = v) }),
      textField({ label: 'footprint long (m)', value: String(draft.w), type: 'number', step: 0.5, onChange: (v) => (draft.w = Number(v)) }),
      textField({ label: 'footprint short (m)', value: String(draft.d), type: 'number', step: 0.5, onChange: (v) => (draft.d = Number(v)) }),
      textField({ label: 'height (m)', value: String(draft.h), type: 'number', step: 0.5, onChange: (v) => (draft.h = Number(v)) }),
      select({
        label: 'fit',
        value: draft.fit,
        options: [
          { value: 'height', label: 'scale to the height' },
          { value: 'span', label: 'scale to the long axis' },
        ],
        onChange: (v) => (draft.fit = v),
      }),
      note('a bridge is laid across the road and it is its LENGTH that has to be right, not its height — that is what “span” is for.'),
    )

    const acts = el('div', 'panel-actions')
    acts.append(
      button({
        label: already ? 'Update the entry' : 'Make it placeable',
        icon: 'plus',
        variant: 'primary',
        onClick: async () => {
          try {
            const res = await api.mergeCatalog([
              {
                id: draft.id,
                name: draft.name,
                category: draft.category,
                // The glb is served by assetsvc through this pod's proxy, so the catalog entry is
                // a path on THIS origin and the viewer needs no second host either.
                glb: `assetsvc/catalog/${encodeURIComponent(item.id)}/file/mesh.finished.glb`,
                footprint_m: [draft.w, draft.d],
                height_m: draft.h,
                fit: draft.fit,
              },
            ])
            toast(`catalog: ${res.added.length ? 'added' : 'updated'} ${draft.id} — ${res.total} assets`, 'ok')
            this.placed.add(draft.id)
          } catch (e) {
            toast((e as Error).message, 'danger', 8000)
          }
        },
      }),
      button({
        label: 'Open the mesh',
        icon: 'arrow-top-right-on-square',
        onClick: () => window.open(assetsvc.fileUrl(item.id, 'mesh.finished.glb'), '_blank'),
      }),
    )
    b.append(acts)
    return g
  }
}

function note(text: string): HTMLElement {
  const p = el('p', 'panel-hint')
  p.append(icon('information-circle', 14), el('span', '', text))
  return p
}
