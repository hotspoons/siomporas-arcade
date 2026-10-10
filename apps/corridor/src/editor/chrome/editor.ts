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
import { Dialog, Drawer, Tabs, button, el, type Tab } from '../../ui/shell'
import { icon } from '../../ui/icons'
import { bodyOf, group, layerToggle, segmented, select } from '../../ui/controls'
import type { IndexEntry } from '../../world/site'

export type Mode = 'areas' | 'place' | 'structures' | 'traffic' | 'stunts' | 'points' | 'world'

const MODES: { value: Mode; label: string; icon: 'pencil-square' | 'map-pin' | 'sparkles' | 'rectangle-group' | 'map' | 'bolt' | 'flag' | 'adjustments-horizontal'; key: string }[] = [
  { value: 'areas', label: 'Areas', icon: 'pencil-square', key: '1' },
  { value: 'place', label: 'Place', icon: 'map-pin', key: '2' },
  // Grow is a tab inside Place now (src/editor/place.ts `growTab`): it writes placements
  { value: 'structures', label: 'Structures', icon: 'rectangle-group', key: '3' },
  // Traffic zones (src/editor/zones.ts): the same polygon tool, a different document. Painted with
  // the map colours everybody reads, because the fill IS the value.
  { value: 'traffic', label: 'Traffic', icon: 'map', key: '4' },
  // Stunt fixtures (src/editor/stuntmode.ts): a loop, a corkscrew or a jump standing on the road,
  // with its two ends linked back to the tarmac by a bezier.
  { value: 'stunts', label: 'Stunts', icon: 'bolt', key: '5' },
  // Points (src/editor/pointmode.ts): where a world opens, where a level starts and ends, named,
  // driving, walking or flying. The race courses (src/editor/coursemode.ts) are its third tab.
  { value: 'points', label: 'Points', icon: 'flag', key: '6' },
  // The world's own settings — the road cross-section, the surfaces it is drawn with. It was a
  // floating "road" button that overlaid every mode; Rich: "maybe this needs to be world settings".
  { value: 'world', label: 'World', icon: 'adjustments-horizontal', key: '7' },
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
    ['drag', 'grab the ground and slide it'],
    ['wheel', 'zoom toward the cursor'],
    ['right-drag', 'zoom about the point pressed'],
    ['middle-drag', 'orbit and tilt about the point · or shift+drag'],
    ['W A S D', 'slide the view · shift faster'],
    ['Q E', 'turn left and right'],
    ['R F', 'rise and drop'],
    ['+ −', 'zoom about the centre'],
    ['Home', 'north up, straight down'],
    ['T', 'frame the whole world'],
    ['C', 'centre on the selection'],
    ['V', 'preview — saves everything and rebuilds'],
    ['Ctrl S', 'save this mode’s file'],
    ['1 … 7', 'switch mode'],
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
    ['drag', 'the gizmo handles — move, or turn'],
    ['G', 'cycle the gizmo: move, turn, size'],
    ['Z X', 'rotate (or shift+wheel)'],
    ['[ ]', 'scale'],
    ['Del', 'remove'],
    ['Grow tab · G', 'generate from the bake’s footprints, with the assets you ticked'],
    ['Grow tab', 'editing a generated item locks it; a deleted one stays deleted through a regenerate'],
  ],
  world: [
    ['sliders', 'the road cross-section: lane and shoulder widths, then apply to rebuild'],
  ],
  structures: [
    ['N', 'then click the road twice — start, then end'],
    ['drag', 'move an end sphere'],
    ['Z X', 'turn a bridge'],
    ['Del', 'remove'],
  ],
  points: [
    ['drag / click', 'place a home, a start, a finish, a checkpoint or a spot'],
    ['Z X', 'turn the heading'],
    ['Del', 'remove'],
    ['Courses tab', 'the race gates, as before'],
    ['pick', 'a gate kind, then click the road — it is laid square across it'],
    ['arrow', 'which way counts; "turn it round" flips it'],
    ['drag', 'a post moves that end'],
    ['Del', 'remove the selected gate'],
  ],
  stunts: [
    ['pick', 'choose a piece, then click the road'],
    ['drag', 'the orange spheres move where it joins the road'],
    ['Z X', 'turn it'],
    ['Esc', 'put the piece back'],
    ['Del', 'remove'],
  ],
  traffic: [
    ['N', 'draw a zone over a stretch of road'],
    ['click', 'add a vertex'],
    ['Enter', 'close the ring (or click the first vertex)'],
    ['colour', 'clear · light · heavy · slow · jammed'],
    ['Del', 'remove'],
  ],
}

export interface EditorUIOpts {
  onSite: (slug: string) => void
  onMode: (m: Mode) => void
  onLayers: () => void
  onSave: () => void
  onPreview: () => void
  /** open the generated-asset catalog (ui/assets.ts) */
  onAssets: () => void
}

/**
 * Where this editor's chrome goes.
 *
 * ABSORBED, NOT LINKED. The site editor used to be its own page, reached by opening a new tab
 * (Rich, 2026-09-27: "why are we just linking to a place editor — I thought the world editor was
 * the place editor ... it isn't dumping you into new tabs, very amateurish"). It is now a mode of
 * the world editor, which means it can no longer own the top bar, the drawer or the inspector —
 * the host page has those, along with the world picker that used to be duplicated here as a site
 * picker.
 *
 * So: given mount points, this builds no chrome of its own and puts its mode rail, its panels and
 * its buttons where it is told. Given none, it behaves exactly as it always did, which is what
 * keeps editor.html working as a page in its own right.
 */
export interface EditorMounts {
  /** where the areas/place/structures/grow rail goes */
  rail: HTMLElement
  /** where the per-mode panels render */
  inspector: HTMLElement
  /** where Save / Preview / Settings go */
  actions: HTMLElement
}

export class EditorUI {
  bar = el('header', 'topbar')
  drawer = new Drawer('corridor editor', 'areas, placements, structures')
  settings: Dialog
  /** where the per-mode panels render — the old `#body`, or the host's when embedded */
  inspector: HTMLElement = el('div', 'inspector-body')
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
  /** null when this owns the page, set when it is a panel inside another one */
  readonly mounts: EditorMounts | null

  constructor(o: EditorUIOpts, mounts: EditorMounts | null = null) {
    this.o = o
    this.mounts = mounts
    if (mounts) this.inspector = mounts.inspector
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
    const preview = button({ label: 'Preview', icon: 'eye', variant: 'primary', key: 'V', onClick: () => this.o.onPreview() })
    const settings = button({ icon: 'cog-6-tooth', title: 'settings', onClick: () => this.settings.open() })

    if (mounts) {
      // No bar, no aside, no drawer, and no site picker: the host owns all four, and a second
      // picker for the same thing under a different name is how somebody ends up with the world
      // editor pointed at one place and the site editor at another.
      mounts.rail.append(this.modeHost)
      mounts.actions.append(this.dirtyEl, this.saveBtn, preview, settings)
    } else {
      this.bar.append(
        hamburger,
        this.siteSel,
        this.modeHost,
        el('div', 'topbar-spacer'),
        this.dirtyEl,
        this.saveBtn,
        preview,
        button({ icon: 'cube', title: 'generated assets', onClick: () => this.o.onAssets() }),
        settings,
      )
      document.body.append(this.bar)

      // the docked inspector
      const head = el('header', 'inspector-head')
      head.append(el('h2', '', 'Inspector'))
      this.aside.append(head, this.inspector)
      document.body.append(this.aside)
    }

    const tabs: Tab[] = [
      { id: 'layers', label: 'Layers', icon: 'squares-2x2', build: (h) => this.buildLayers(h) },
      { id: 'keys', label: 'Keys', icon: 'information-circle', build: (h) => this.buildKeys(h) },
    ]
    this.settingsTabs = new Tabs(tabs)
    this.settings = new Dialog({ title: 'Settings', icon: 'cog-6-tooth', size: 'md' })
    this.settings.body.append(this.settingsTabs.root)

    if (!mounts) this.buildDrawer()
  }

  private buildDrawer() {
    const nav = this.drawer.section('')
    this.drawer.item(nav, { id: 'settings', label: 'Settings', icon: 'cog-6-tooth', hint: 'layers and keys', onClick: () => this.settings.open() })
    this.drawer.item(nav, { id: 'assets', label: 'Assets', icon: 'cube', hint: 'generate props in 2D, then in 3D', onClick: () => this.o.onAssets() })
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
