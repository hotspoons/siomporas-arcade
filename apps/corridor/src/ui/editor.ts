// The editor's chrome. Same shell, same tokens, same icons as the viewer — the two apps are one
// product and used to look like two.
//
// The split that matters here is different from the viewer's, because the editor has a working
// surface the viewer does not:
//
//   TOP BAR     which site, which MODE, and the two verbs that commit work (save, preview).
//               The dirty state lives here too, because "have I lost anything" is a question you
//               ask of the whole app, not of a panel.
//   MODE RAIL   areas / place / grow / structures, as a segmented control in the bar. Four modes
//               is a segmented control, not four buttons that happen to sit together.
//   INSPECTOR   a docked panel on the right: what is selected, and its fields. This one stays
//               pinned rather than living in a dialog, because it IS the work — you edit a value,
//               look at the scene, edit another. A dialog you must reopen every time would be
//               worse than what was there before.
//   SETTINGS    layers, appearance, keys. A dialog, as in the viewer.
import { Dialog, Drawer, Tabs, button, el, type Tab } from './shell'
import { icon } from './icons'
import { bodyOf, group, layerToggle, segmented, select } from './controls'
import type { IndexEntry } from '../site'

export type Mode = 'areas' | 'place' | 'grow' | 'structures'

const MODES: { value: Mode; label: string; icon: 'pencil-square' | 'map-pin' | 'sparkles' | 'rectangle-group'; key: string }[] = [
  { value: 'areas', label: 'Areas', icon: 'pencil-square', key: '1' },
  { value: 'place', label: 'Place', icon: 'map-pin', key: '2' },
  { value: 'grow', label: 'Grow', icon: 'sparkles', key: '3' },
  { value: 'structures', label: 'Structures', icon: 'rectangle-group', key: '4' },
]

export const EDITOR_LAYERS: { title: string; layers: { id: string; label: string; on: boolean }[] }[] = [
  {
    title: 'Reference',
    layers: [
      { id: 'imagery', label: 'Aerial imagery', on: true },
      { id: 'spine', label: 'Centreline', on: true },
      { id: 'horizon', label: 'Far hills', on: false },
      { id: 'trees', label: 'Trees', on: false },
    ],
  },
  {
    title: 'What you are editing',
    layers: [
      { id: 'areas', label: 'Adjustment areas', on: true },
      { id: 'placements', label: 'Placements', on: true },
      { id: 'structures', label: 'Structures', on: true },
      { id: 'authored', label: 'Authored geometry', on: true },
    ],
  },
]

/** Per-mode keyboard reference. The old footer carried all of it at once, for every mode. */
const KEYS: Record<Mode | 'general', [string, string][]> = {
  general: [
    ['drag', 'orbit · wheel zooms'],
    ['T', 'top down'],
    ['F', 'fly to the selection'],
    ['V', 'preview — saves everything and rebuilds'],
    ['Ctrl S', 'save this mode’s file'],
    ['1 2 3 4', 'switch mode'],
  ],
  areas: [
    ['N', 'draw a new area'],
    ['click', 'add a vertex'],
    ['Enter', 'close the ring (or click the first vertex)'],
    ['Esc', 'cancel the drawing'],
    ['drag', 'nudge a handle'],
    ['Del', 'remove'],
  ],
  place: [
    ['pick', 'choose an asset, then click the ground'],
    ['drag', 'move'],
    ['Q E', 'rotate (or shift+wheel)'],
    ['[ ]', 'scale'],
    ['Del', 'remove'],
  ],
  grow: [
    ['G', 'generate from the bake’s footprints'],
    ['edit', 'editing a generated item locks it'],
    ['Del', 'a deleted item stays deleted through a regenerate'],
  ],
  structures: [
    ['N', 'then click the road twice — start, then end'],
    ['drag', 'move an end sphere'],
    ['Q E', 'turn a bridge'],
    ['Del', 'remove'],
  ],
}

export interface EditorUIOpts {
  onSite: (slug: string) => void
  onMode: (m: Mode) => void
  onLayers: () => void
  onSave: () => void
  onPreview: () => void
}

export class EditorUI {
  bar = el('header', 'topbar')
  drawer = new Drawer('corridor editor', 'areas, placements, structures')
  settings: Dialog
  /** where the per-mode panels render — the old `#body` */
  inspector = el('div', 'inspector-body')
  /** the mode rail, so roadwidth.ts can mount its control beside the modes as it did before */
  modeHost = el('div', 'mode-host')

  private aside = el('aside', 'inspector')
  private siteSel = el('div', 'topbar-site')
  private dirtyEl = el('span', 'dirty')
  private saveBtn: HTMLButtonElement
  private layerState: Record<string, boolean> = {}
  private settingsTabs: Tabs
  private current = ''
  private mode: Mode = 'areas'
  private o: EditorUIOpts

  constructor(o: EditorUIOpts) {
    this.o = o
    for (const g of EDITOR_LAYERS) for (const l of g.layers) this.layerState[l.id] = l.on

    const hamburger = button({ icon: 'bars-3', variant: 'ghost', title: 'menu', onClick: () => this.drawer.toggle() })
    const rail = segmented<Mode>({
      value: this.mode,
      options: MODES.map((m) => ({ value: m.value, label: m.label, icon: m.icon, key: m.key })),
      onChange: (m) => {
        this.mode = m
        this.o.onMode(m)
        this.settingsTabs.invalidate('keys')
      },
    })
    this.modeHost.append(rail)

    this.saveBtn = button({ label: 'Save', icon: 'document-arrow-down', key: 'Ctrl S', onClick: () => this.o.onSave() })
    this.bar.append(
      hamburger,
      this.siteSel,
      this.modeHost,
      el('div', 'topbar-spacer'),
      this.dirtyEl,
      this.saveBtn,
      button({ label: 'Preview', icon: 'eye', variant: 'primary', key: 'V', onClick: () => this.o.onPreview() }),
      button({ icon: 'cog-6-tooth', title: 'settings', onClick: () => this.settings.open() }),
    )
    document.body.append(this.bar)

    // the docked inspector
    const head = el('header', 'inspector-head')
    head.append(el('h2', '', 'Inspector'))
    this.aside.append(head, this.inspector)
    document.body.append(this.aside)

    const tabs: Tab[] = [
      { id: 'layers', label: 'Layers', icon: 'squares-2x2', build: (h) => this.buildLayers(h) },
      { id: 'keys', label: 'Keys', icon: 'information-circle', build: (h) => this.buildKeys(h) },
    ]
    this.settingsTabs = new Tabs(tabs)
    this.settings = new Dialog({ title: 'Settings', icon: 'cog-6-tooth', size: 'md' })
    this.settings.body.append(this.settingsTabs.root)

    this.buildDrawer()
  }

  private buildDrawer() {
    const nav = this.drawer.section('')
    this.drawer.item(nav, { id: 'settings', label: 'Settings', icon: 'cog-6-tooth', hint: 'layers and keys', onClick: () => this.settings.open() })
    this.drawer.item(nav, { id: 'viewer', label: 'Viewer', icon: 'globe-alt', hint: 'the read-only view', onClick: () => (location.href = '/') })

    const act = this.drawer.section('This site')
    this.drawer.item(act, { id: 'save', label: 'Save', icon: 'document-arrow-down', key: 'Ctrl S', onClick: () => this.o.onSave() })
    this.drawer.item(act, { id: 'preview', label: 'Preview', icon: 'eye', hint: 'saves everything, then rebuilds', key: 'V', onClick: () => this.o.onPreview() })

    const look = this.drawer.section('Appearance')
    this.drawer.custom(
      look,
      select({
        label: 'Theme',
        value: (localStorage.getItem('corridor.theme') as 'dark' | 'light') ?? 'dark',
        options: [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ],
        onChange: (v) => {
          document.documentElement.dataset.theme = v
          try {
            localStorage.setItem('corridor.theme', v)
          } catch {
            /* ignore */
          }
        },
      }),
    )
  }

  private buildLayers(host: HTMLElement) {
    for (const g of EDITOR_LAYERS) {
      const sec = group(g.title)
      const body = bodyOf(sec)
      body.classList.add('layer-list')
      for (const l of g.layers) {
        body.append(
          layerToggle({
            label: l.label,
            value: this.layerState[l.id],
            onChange: (v) => {
              this.layerState[l.id] = v
              this.o.onLayers()
            },
          }),
        )
      }
      host.append(sec)
    }
  }

  private buildKeys(host: HTMLElement) {
    const show = (title: string, rows: [string, string][]) => {
      const g = group(title)
      const body = bodyOf(g)
      body.classList.add('keys')
      for (const [k, what] of rows) {
        const row = el('div', 'key-row')
        const ks = el('span', 'key-keys')
        for (const part of k.split(' ')) ks.append(el('kbd', '', part))
        row.append(ks, el('span', 'key-what', what))
        body.append(row)
      }
      host.append(g)
    }
    show(MODES.find((m) => m.value === this.mode)!.label, KEYS[this.mode])
    show('Anywhere', KEYS.general)
  }

  // ---- handles -------------------------------------------------------------------------------

  setSites(sites: IndexEntry[], current: string) {
    this.current = current
    this.renderSitePicker()
    const sec = this.drawer.section('Sites')
    for (const s of sites) {
      const ident = s.ident ? Object.values(s.ident)[0] : '?'
      this.drawer.item(sec, {
        id: s.slug,
        label: s.slug,
        icon: 'map-pin',
        hint: `${ident} · ${(s.length_m / 1000).toFixed(1)} km`,
        onClick: () => this.o.onSite(s.slug),
      })
    }
  }

  private renderSitePicker() {
    this.siteSel.replaceChildren()
    const b = el('button', 'site-button')
    b.append(el('span', 'site-name', this.current || 'loading…'), icon('chevron-down', 14))
    b.onclick = () => this.drawer.set(true)
    this.siteSel.append(b)
  }

  setSite(slug: string) {
    this.current = slug
    this.renderSitePicker()
  }

  layers(): Record<string, boolean> {
    return { ...this.layerState }
  }

  /**
   * Set the rail from outside — a hash like `#site:grow` on load, or a keyboard shortcut.
   *
   * Matching is on `data-value`, not on the button's label: the first cut compared lowercased
   * label text, which happens to work for these four words and quietly breaks the day a mode is
   * renamed or one label becomes a substring of another.
   */
  setMode(m: Mode) {
    this.mode = m
    for (const b of this.modeHost.querySelectorAll<HTMLButtonElement>('.seg')) {
      b.classList.toggle('on', b.dataset.value === m)
    }
    this.settingsTabs.invalidate('keys')
  }

  /** The save button reflects whether there is anything to save, and for which mode. */
  setDirty(dirty: boolean, label = 'Save') {
    this.dirtyEl.textContent = dirty ? 'unsaved edits' : ''
    this.dirtyEl.classList.toggle('on', dirty)
    this.saveBtn.replaceChildren(icon('document-arrow-down', 16), el('span', 'btn-label', label))
    this.saveBtn.disabled = !dirty
  }
}
